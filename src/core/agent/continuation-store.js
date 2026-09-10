// Instance-scoped, in-memory continuation store for agent runs.
//
// WHAT A "RUN" IS
// ---------------
// One agent conversation: frozen instructions/tools/model/budget, the
// accumulated private provider state, and the set of tool calls currently
// awaiting results. The APPLICATION owns the execution loop; this store owns
// only the server-side state that makes the next model step correct.
//
// EXPLICIT NON-GUARANTEES (documented, not discovered later)
// ---------------------------------------------------------
//  - PROCESS-LOCAL and NON-DURABLE. A restart invalidates every run id
//    honestly: the id simply is not found (410 run_not_found), never
//    silently resumed against reconstructed state.
//  - NOT an exactly-once delivery mechanism for external side effects. A
//    tool result claimed here means "this process accepted it once"; whether
//    the executor's own side effect happened exactly once is the executor's
//    problem, and the plan requires this be stated rather than implied.
//
// CONCURRENCY
// -----------
// `claim()` is synchronous and mutates state before returning, so JS's
// single-threaded event loop makes check-and-claim atomic by construction
// (the same argument core/auth/token-budget.js's reserve() relies on). Two
// concurrent continuations for one run: exactly one wins, the other is told
// the results were already consumed. There is no `await` between reading
// `status` and writing it.
//
// IDENTITY BINDING
// ----------------
// Every run records the principal identity that created it. A continuation
// presented by a DIFFERENT principal is reported as not found — never as
// "forbidden", which would confirm the id exists to someone who should not
// know that.
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const RUN_STATUS = Object.freeze({
  READY: 'ready',           // awaiting tool results from the application
  IN_FLIGHT: 'in_flight',   // a model step is running for this run right now
  COMPLETED: 'completed',   // terminal
  CLOSED: 'closed',         // terminal (error/abort/expiry)
});

export const STORE_LIMITS = Object.freeze({
  ttlMs: 10 * 60_000,          // 10 minutes of inactivity
  maxActiveRuns: 100,          // process-wide
  maxRunsPerPrincipal: 10,
  maxRunBytes: 1_000_000,      // ~1MB of accumulated provider state per run
  maxTotalBytes: 20_000_000,   // ~20MB across all runs
});

export class ContinuationError extends Error {
  /** @param {'run_not_found'|'run_gone'|'run_busy'|'results_mismatch'|'store_full'|'run_too_large'} code */
  constructor(code, message) {
    super(message);
    this.name = 'ContinuationError';
    this.code = code;
  }
}

/** Opaque, unguessable id. 32 bytes of CSPRNG output, base64url. */
function newRunId() {
  return randomBytes(32).toString('base64url');
}

/** Constant-time comparison for the principal binding, so a mismatch leaks no timing signal. */
function identityMatches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function approximateBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY; // unserializable state is never storable
  }
}

/**
 * @param {{ now?: () => number, limits?: Partial<typeof STORE_LIMITS>, idFactory?: () => string }} [opts]
 *   `now`/`idFactory` are DI seams for deterministic tests only; production
 *   callers pass neither.
 */
export function createContinuationStore({ now = () => Date.now(), limits = {}, idFactory = newRunId } = {}) {
  const cfg = { ...STORE_LIMITS, ...limits };
  /** @type {Map<string, Object>} */
  const runs = new Map();
  let totalBytes = 0;

  /**
   * Drops expired runs. Piggybacked on real calls rather than a timer — no
   * interval keeps the process alive, and a store nobody touches costs
   * nothing (same discipline as rate-limiter.js's lazy sweep).
   */
  /**
   * Removes ONE run and returns its bytes to the pool. The single place a
   * run leaves the map, so its size is subtracted exactly once no matter
   * which path (expiry, close, release, or an over-size rejection) drops it.
   *
   * `run.bytes` is zeroed on the way out: if a second path later reaches the
   * same object — the exact bug this replaces, where sweep() deleted an
   * IN_FLIGHT run and the in-flight release() then subtracted its size a
   * second time, driving totalBytes negative (reproduced: totalBytes: -15)
   * — it subtracts 0 instead of double-counting.
   */
  function dropRun(id, run) {
    if (!runs.has(id)) return;
    totalBytes -= run.bytes;
    run.bytes = 0;
    run.status = RUN_STATUS.CLOSED;
    runs.delete(id);
  }

  /**
   * Drops expired runs. Piggybacked on real calls rather than a timer — no
   * interval keeps the process alive.
   *
   * An IN_FLIGHT run is NEVER swept: a model step is running against it
   * right now, and its own release() is the one thing that knows whether the
   * run continues or ends. Sweeping it would both corrupt the byte
   * accounting and race a live step. Its TTL is instead re-evaluated when
   * that step releases (release() refreshes expiresAt on the READY path, and
   * frees the run on every terminal path), so an abandoned in-flight run
   * still cannot leak: the step either finishes or throws, and both release.
   */
  function sweep() {
    const t = now();
    for (const [id, run] of runs) {
      if (run.status === RUN_STATUS.IN_FLIGHT) continue;
      if (run.expiresAt <= t) dropRun(id, run);
    }
  }

  function requireRun(runId, identity) {
    sweep();
    const run = runs.get(runId);
    // A missing run and a run belonging to someone else are reported
    // IDENTICALLY — a different message would confirm the id exists.
    if (!run || !identityMatches(run.identity, identity)) {
      throw new ContinuationError('run_not_found', 'No active agent run matches this continuation id.');
    }
    return run;
  }

  return {
    /**
     * Creates a run and returns its id. Called only AFTER the first model
     * step returned `requires_action` — a completed first step never
     * allocates a run.
     *
     * @param {{
     *   identity: string,
     *   context: Object,     frozen instructions/tools/model/limits for this run
     *   providerState: unknown,
     *   pendingCalls: Array<{ id: string, name: string }>,
     *   usage: { modelSteps: number, toolCalls: number, reservedTokens: number },
     * }} args
     */
    create({ identity, context, providerState, pendingCalls, usage }) {
      sweep();
      if (runs.size >= cfg.maxActiveRuns) {
        throw new ContinuationError('store_full', 'The agent run store is at capacity. Retry shortly.');
      }
      let mine = 0;
      for (const run of runs.values()) if (identityMatches(run.identity, identity)) mine += 1;
      if (mine >= cfg.maxRunsPerPrincipal) {
        throw new ContinuationError('store_full', 'This key has too many concurrent agent runs. Complete or abandon one first.');
      }

      const bytes = approximateBytes(providerState);
      if (bytes > cfg.maxRunBytes) {
        throw new ContinuationError('run_too_large', 'The accumulated agent run state exceeds the per-run size limit.');
      }
      if (totalBytes + bytes > cfg.maxTotalBytes) {
        throw new ContinuationError('store_full', 'The agent run store is at its memory limit. Retry shortly.');
      }

      const id = idFactory();
      runs.set(id, {
        identity,
        context,
        providerState,
        // NEUTRAL pending calls — {id, name} pairs owned by this store, NOT
        // read back out of the opaque providerState. The runtime used to
        // recover tool names by walking Gemini's own
        // nativeContents[].parts[].functionCall shape, which made the
        // "transport-neutral" core silently Gemini-specific: any provider
        // with a differently-shaped opaque state started a run fine and then
        // failed every continuation with results_mismatch (reproduced).
        pendingCalls: pendingCalls.map((c) => ({ id: c.id, name: c.name })),
        usage: { ...usage },
        status: RUN_STATUS.READY,
        bytes,
        expiresAt: now() + cfg.ttlMs,
      });
      totalBytes += bytes;
      return id;
    },

    /**
     * ATOMICALLY claims a run for one continuation step, after verifying the
     * supplied results match the pending calls EXACTLY (same set, no missing,
     * no extra, no duplicates).
     *
     * Validation happens BEFORE the claim, so a malformed continuation never
     * burns the run: the caller may correct it and retry. Once claimed, the
     * run is IN_FLIGHT and a concurrent replay loses.
     *
     * @param {{ runId: string, identity: string, results: Array<{ callId: string }> }} args
     * @returns {{ context: Object, providerState: unknown, usage: Object, release: (next?: Object) => void }}
     */
    claim({ runId, identity, results }) {
      const run = requireRun(runId, identity);

      if (run.status === RUN_STATUS.IN_FLIGHT) {
        throw new ContinuationError('run_busy', 'A model step is already running for this agent run.');
      }
      if (run.status !== RUN_STATUS.READY) {
        throw new ContinuationError('run_gone', 'This agent run has already finished.');
      }

      // Exact-match check — never a partial continuation.
      const pending = new Set(run.pendingCalls.map((c) => c.id));
      const seen = new Set();
      for (const result of results) {
        if (!pending.has(result.callId)) {
          throw new ContinuationError('results_mismatch',
            'A tool result was supplied for a call id this run is not waiting on.');
        }
        if (seen.has(result.callId)) {
          throw new ContinuationError('results_mismatch', 'Duplicate tool results were supplied for the same call id.');
        }
        seen.add(result.callId);
      }
      if (seen.size !== pending.size) {
        throw new ContinuationError('results_mismatch',
          `This run is waiting on ${pending.size} tool result(s); ${seen.size} were supplied. Partial continuation is not supported.`);
      }

      // ── The claim. Synchronous, no await above this line. ──
      run.status = RUN_STATUS.IN_FLIGHT;

      let released = false;
      return {
        context: run.context,
        providerState: run.providerState,
        usage: { ...run.usage },
        pendingCalls: run.pendingCalls.map((c) => ({ ...c })),
        /**
         * Ends the in-flight step. `next` either advances the run (new
         * providerState + pendingCalls + usage) or, when omitted, marks it
         * terminal and frees its memory.
         */
        release(next) {
          if (released) return;
          released = true;
          // The run may already be gone: close() (client disconnect/abort)
          // or an over-size rejection can remove it WHILE this step is still
          // running. Every branch below either frees bytes or re-adds them,
          // so acting on a record the store no longer holds corrupts the
          // pool — reproduced as claim -> close -> release(READY) leaving
          // runs: 0 but totalBytes: 7, silently consuming the memory limit
          // with each repetition. After removal, release is a strict no-op.
          if (!runs.has(runId)) return;
          if (!next || next.status === RUN_STATUS.COMPLETED || next.status === RUN_STATUS.CLOSED) {
            dropRun(runId, run);
            return;
          }
          const bytes = approximateBytes(next.providerState);
          if (bytes > cfg.maxRunBytes || totalBytes - run.bytes + bytes > cfg.maxTotalBytes) {
            dropRun(runId, run);
            throw new ContinuationError('run_too_large', 'The accumulated agent run state exceeds the configured size limit.');
          }
          totalBytes = totalBytes - run.bytes + bytes;
          run.bytes = bytes;
          run.providerState = next.providerState;
          run.pendingCalls = next.pendingCalls.map((c) => ({ id: c.id, name: c.name }));
          run.usage = { ...next.usage };
          run.status = RUN_STATUS.READY;
          run.expiresAt = now() + cfg.ttlMs;
        },
      };
    },

    /** Read-only inspection for a caller that must reject before claiming (never mutates status). */
    peek({ runId, identity }) {
      const run = requireRun(runId, identity);
      return {
        status: run.status,
        context: run.context,
        usage: { ...run.usage },
        pendingCalls: run.pendingCalls.map((c) => ({ ...c })),
      };
    },

    /** Explicitly drops a run (abort/disconnect/terminal error), freeing its memory. */
    close({ runId, identity }) {
      sweep();
      const run = runs.get(runId);
      if (!run || !identityMatches(run.identity, identity)) return false;
      dropRun(runId, run);
      return true;
    },

    /** Test/diagnostic hook. Never used by request paths. */
    stats() {
      sweep();
      return { runs: runs.size, totalBytes };
    },
  };
}
