// In-memory indexing job registry. Spawns the existing indexer CLI as a
// child process — no indexer library refactor, no in-process import (design
// doc §9: process isolation, natural log capture, zero indexer changes).
//
// MVP concurrency: ONE active indexing job at a time, globally (not
// per-collection) — matches the task spec exactly. A second start attempt
// while a job is running/queued is rejected by the API layer with 409, not
// silently queued.
import { randomUUID } from 'node:crypto';
import { sanitiseErrorMessage } from '../../core/doctor-checks.js';
import { parseProgressLine } from '../../indexer/progress-event.js';

// This file itself is edition-neutral (code review, round 4) — it never
// imports node:child_process, never names an indexer entry path, never
// imports spawn-indexer-full.js/spawn-indexer-lite.js, and never branches
// on an 'edition' string. createJobRegistry() REQUIRES a caller-supplied
// `spawnIndexer({ args, env, stdio, windowsHide }) -> ChildProcess`
// callback — there is no default. This is deliberate, not an oversight: a
// default importing spawn-indexer-full.js would put the literal path to
// index-full.js (a file EXCLUDED from the Lite package) back into this
// shared file's own source, which packages/lite/build.mjs's closure
// validator staged for Lite too — exactly the structural edge this whole
// split exists to remove. Full's own composition root
// (admin/server-full.js) passes spawn-indexer-full.js's own spawnIndexer
// explicitly; Lite's own composition root (admin/composition/lite.js)
// passes spawn-indexer-lite.js's own spawnIndexer explicitly. Each of
// those two tiny sibling files owns BOTH its own literal indexer entry
// path AND the actual node:child_process spawn() call — see
// spawn-indexer-full.js's own header comment for why that pairing (not
// just the path) has to live outside this shared file. Job state,
// logging, progress parsing, and cancellation stay exactly this ONE
// shared implementation for both editions — only which function gets
// called to actually launch the child process differs, and only because
// each composition root injects a different one. Tests pass their own
// fake spawnIndexer (or a fake jobRegistry entirely) — never a real
// child_process spawn.

const MAX_LOG_LINES = 2000;
const STATES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  CANCELLING: 'cancelling',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

/**
 * Translate the typed options object from the API request into env var
 * strings. Never composed by the UI — only here, at spawn time (design doc
 * §9). PRUNE_STALE/TAG_GEN are set only when true (task spec: "PRUNE_STALE=1
 * only when true", "TAG_GEN=1 only when true" — omitted otherwise, matching
 * how the indexer already treats an unset var as off). `llmSummaries` maps
 * to SKELETON_SUMMARY=llm (the indexer's existing opt-in for LLM-generated
 * nav-node summaries instead of deterministic ones) — omitted when false,
 * same "unset = off" convention as the other optional flags. Skeleton-first
 * chunking and navigation-point generation are unconditional architecture,
 * not job options — no env vars are set for them here.
 *
 * @param {{ onnxEmbed?: boolean, llmSummaries?: boolean, pruneStale?: boolean, tagGen?: boolean }} options
 */
export function buildJobEnv(collection, options = {}) {
  const env = {
    COLLECTION: collection,
    ONNX_EMBED: options.onnxEmbed ? '1' : '0',
  };
  if (options.llmSummaries) env.SKELETON_SUMMARY = 'llm';
  if (options.pruneStale) env.PRUNE_STALE = '1';
  if (options.tagGen) env.TAG_GEN = '1';
  return env;
}

// Redacts QDRANT_KEY (if set) and any URL with embedded credentials/query
// string before a line is ever stored — the indexer/Qdrant/Ollama can print
// secrets to stdout/stderr on error paths this registry doesn't control, and
// job.log is served back through the API verbatim, so redaction has to
// happen at capture time, not just at response time.
//
// [semidex:progress] lines are parsed into job.progress and never pushed to
// job.log at all — they're machine-readable state, not something a user
// reads as a log line, and duplicating them into the log would just be
// console-like noise fighting the progress UI they're meant to replace.
// Clamps an intra-file progress fraction to the 0..1 range a percent
// calculation can trust. A non-number (missing field, bad JSON value, NaN)
// becomes null — "unknown", not "zero" — so the API layer can tell "no
// intra-file estimate yet" apart from "just started".
function clampFileProgress(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function appendLine(job, stream, line) {
  const progress = parseProgressLine(line);
  if (progress) {
    job.progress = {
      processedFiles: Number.isInteger(progress.processedFiles) ? progress.processedFiles : null,
      totalFiles: Number.isInteger(progress.totalFiles) ? progress.totalFiles : null,
      currentFile: typeof progress.currentFile === 'string' ? progress.currentFile : null,
      currentStep: typeof progress.currentStep === 'string' ? progress.currentStep : null,
      currentFileProgress: clampFileProgress(progress.currentFileProgress),
    };
    return;
  }
  const sanitised = sanitiseErrorMessage(line, process.env.QDRANT_KEY);
  job.log.push({ stream, line: sanitised });
  if (job.log.length > MAX_LOG_LINES) {
    job.log.splice(0, job.log.length - MAX_LOG_LINES);
  }
}

// child_process stdout/stderr 'data' events are not guaranteed to align
// with line boundaries — a single JSON progress line can arrive split
// across two chunks. This buffers partial trailing text per stream and
// only hands complete lines to appendLine(), so parseProgressLine() never
// sees a truncated JSON body.
//
// The last line of output very often has no trailing newline at all (the
// child process just exits right after writing it) — write() alone would
// leave that final line stuck in `carry` forever. Callers must call
// flush() once the child has exited, which sends any remaining buffered
// text through appendLine() as a line of its own. An empty carry (nothing
// buffered, or already flushed) is a no-op.
function makeLineSplitter(job, stream) {
  let carry = '';
  return {
    write(chunk) {
      carry += chunk.toString('utf-8');
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() ?? '';
      for (const line of lines) {
        if (line === '') continue;
        appendLine(job, stream, line);
      }
    },
    flush() {
      if (carry === '') return;
      appendLine(job, stream, carry);
      carry = '';
    },
  };
}

/**
 * Create a job registry. `spawnIndexer` is a REQUIRED dependency — no
 * default (code review, round 4: a default importing spawn-indexer-full.js
 * would put the literal path to a Lite-excluded file back into this
 * shared, Lite-staged file's own source; see this module's own header
 * comment). Tests pass a fake that returns an EventEmitter-shaped stub
 * instead of launching a real indexer process — never a real
 * child_process spawn.
 *
 * `baseEnv` is the env object spread as the FIRST layer under
 * buildJobEnv()'s own explicit overrides when spawning the indexer child
 * (see startIndexJob() below). Defaults to live process.env for backwards
 * compatibility, but the real admin entry point (bootstrap.js) MUST pass
 * its own pre-applyEnvWriteBack() snapshot instead — code review finding:
 * admin/bootstrap.js calls applyEnvWriteBack(settingsService) against the
 * real process.env so its OWN in-process code (e.g. core/qdrant/client.js)
 * observes resolved settings.json values; if that same mutated process.env
 * were spread into a spawned indexer job's env here, every settings-
 * registry field admin resolved at ITS OWN startup (including
 * next_index_job fields like MAX_CHUNK_TOKENS, frozen at whatever value
 * was true when admin started) would look like genuine os_env overrides to
 * the child's own SettingsService — permanently shadowing settings.json
 * until admin itself restarts, defeating next_index_job's entire "next job
 * picks up the new value with no restart needed" contract. baseEnv must be
 * the environment as it looked right after bootstrapEnv() but BEFORE
 * applyEnvWriteBack() ever touched it, so the child's own bootstrapEnv()/
 * SettingsService resolves settings.json fresh, uncontaminated by admin's
 * own resolved values — buildJobEnv()'s explicit per-job overrides
 * (ONNX_EMBED, etc., set from the actual job-start request) still apply
 * on top, unaffected by this change.
 *
 * @param {{ spawnIndexer: (opts: { args: string[], env: NodeJS.ProcessEnv }) => import('node:child_process').ChildProcess, baseEnv?: NodeJS.ProcessEnv }} options
 *   spawnIndexer (REQUIRED, code review, round 4): launches the indexer
 *   child process and returns the real ChildProcess (this registry
 *   attaches its own stdout/stderr/exit/error listeners to whatever is
 *   returned — the injected function owns only WHICH FILE gets spawned,
 *   never the listener wiring). admin/server-full.js's createApp() passes
 *   spawn-indexer-full.js's own spawnIndexer; admin/composition/lite.js's
 *   createLiteApp() passes spawn-indexer-lite.js's own spawnIndexer.
 * @throws {TypeError} if spawnIndexer is missing or not a function
 */
export function createJobRegistry({ spawnIndexer, baseEnv = process.env } = {}) {
  if (typeof spawnIndexer !== 'function') {
    throw new TypeError('createJobRegistry: spawnIndexer is required and must be a function — see this file\'s own header comment for why no default is provided.');
  }
  const jobs = new Map(); // id -> job record, insertion order = start order
  let activeJobId = null;

  function isActive(job) {
    return job.state === STATES.QUEUED || job.state === STATES.RUNNING || job.state === STATES.CANCELLING;
  }

  function getActiveJob() {
    if (!activeJobId) return null;
    const job = jobs.get(activeJobId);
    return job && isActive(job) ? job : null;
  }

  /**
   * @param {{ collection: string, path: string, options?: object, kind?: 'index' | 'reindex' }} params
   * @returns {{ id: string }}
   * @throws if a job is already queued/running
   */
  function startIndexJob({ collection, path, options = {}, kind = 'index' }) {
    const active = getActiveJob();
    if (active) {
      const err = new Error(`An indexing job is already ${active.state} (id: ${active.id}). Only one job may run at a time.`);
      err.code = 'JOB_ALREADY_RUNNING';
      throw err;
    }

    const id = randomUUID();
    const job = {
      id,
      collection,
      path,
      options,
      // 'index' (a brand-new collection) vs 'reindex' (an existing one,
      // e.g. from settings-view.js's reindex form) — purely a display-label
      // distinction for the operation modal (Phase 3S); both run through
      // the exact same indexer spawn/env/progress-parsing path below, no
      // behavioral difference at all.
      kind,
      state: STATES.QUEUED,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      log: [],
      // null until the first [semidex:progress] line arrives — the indexer
      // may not emit one at all (e.g. zero files found), so "no progress
      // data yet" must stay distinguishable from "progress at 0/0".
      progress: null,
      child: null,
    };
    jobs.set(id, job);
    activeJobId = id;

    const env = { ...baseEnv, ...buildJobEnv(collection, options) };
    // spawnIndexer owns the actual node:child_process call and its own
    // literal entry-file target (see createJobRegistry()'s own header
    // comment) — this file itself never decides which edition's entry
    // point to spawn, only the composition root that constructed this
    // registry instance does, by choosing which spawnIndexer to inject.
    const child = spawnIndexer({ args: [path], env });
    job.child = child;
    job.state = STATES.RUNNING;

    const stdoutSplitter = makeLineSplitter(job, 'stdout');
    const stderrSplitter = makeLineSplitter(job, 'stderr');
    child.stdout?.on('data', (chunk) => stdoutSplitter.write(chunk));
    child.stderr?.on('data', (chunk) => stderrSplitter.write(chunk));

    child.on('error', (err) => {
      // spawn-level failure (e.g. ENOENT) — never reached a real exit. stdout/
      // stderr are unlikely to have emitted anything at this point, but flush
      // defensively so a partial line is never silently dropped either way.
      stdoutSplitter.flush();
      stderrSplitter.flush();
      job.state = STATES.FAILED;
      job.finishedAt = new Date().toISOString();
      job.exitCode = null;
      appendLine(job, 'stderr', `[job] failed to start: ${err.message}`);
      if (activeJobId === id) activeJobId = null;
    });

    child.on('exit', (code, signal) => {
      // The child is done writing by the time 'exit' fires — flush before
      // deciding the final state so a last line with no trailing newline
      // (very common: the process just exits right after writing it) still
      // makes it into job.log/job.progress instead of being stuck in the
      // splitter's internal buffer forever.
      stdoutSplitter.flush();
      stderrSplitter.flush();
      job.finishedAt = new Date().toISOString();
      job.exitCode = code;
      if (job.state === STATES.CANCELLING) {
        // cancelJob() already requested the kill; this exit event is the
        // real end of the process — only NOW is the slot actually free.
        job.state = STATES.CANCELLED;
      } else if (signal) {
        job.state = STATES.FAILED;
        appendLine(job, 'stderr', `[job] terminated by signal ${signal}`);
      } else {
        job.state = code === 0 ? STATES.SUCCEEDED : STATES.FAILED;
      }
      if (activeJobId === id) activeJobId = null;
    });

    return { id };
  }

  /**
   * Best-effort cancel (design doc §9): child.kill() first; a resumable,
   * not corrupted, collection is expected either way since the indexer
   * commits per-file with deterministic point IDs.
   *
   * The job moves to `cancelling` (still counted as active — see isActive())
   * rather than straight to `cancelled`, because `child.kill()` only sends a
   * signal; the process may still be writing to Qdrant for some time after
   * this call returns. Only the child's own `exit` event proves it actually
   * stopped, at which point the slot is freed and the state becomes
   * `cancelled`. Without this, a second startIndexJob() right after
   * cancelJob() could run concurrently with the still-alive first process.
   */
  function cancelJob(id) {
    const job = jobs.get(id);
    if (!job) return null;
    if (!isActive(job)) return job;

    job.state = STATES.CANCELLING;
    appendLine(job, 'stderr', '[job] cancel requested');
    job.child?.kill();
    return job;
  }

  function getJob(id) {
    return jobs.get(id) ?? null;
  }

  /** Newest first. */
  function listJobs() {
    return [...jobs.values()].reverse();
  }

  return { startIndexJob, cancelJob, getJob, listJobs, getActiveJob, STATES };
}
