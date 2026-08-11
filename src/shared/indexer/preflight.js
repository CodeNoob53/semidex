// Ollama reachability/model-list logic lives in src/local/core/ollama.js,
// shared with the admin API's pre-job-start check (src/admin/api/jobs.js)
// — this file only adds the indexer-specific "throw with an actionable CLI
// message" framing around that shared logic.
//
// Depends on the narrow OllamaDiscoveryCapability CONTRACT
// (core/generation/ollama-capability.js) only — never imports
// local/core/ollama.js directly, not even indirectly through a *-lazy.js default.
// Capability injection (Phase 8B Step 3 — instance-scoped, no module-scope
// setter): checkOllamaPreflight()/ensureOllamaPreflight() take their
// capability as a real function parameter — indexer/run.js resolves its
// own capability once per run() and passes it explicitly here, the same
// way it does for every other phase module. checkOllamaPreflight() only
// ever RUNS when a local Ollama model is actually required (run.js gates
// it behind !skeletonNoLlm and never calls it in cloud/deterministic mode).
import { validateOllamaDiscoveryCapability } from '../../core/generation/ollama-capability.js';

// Shared reachability + installed-model-listing logic — the ONE place
// that fetches /api/version and /api/tags and frames a failure with an
// actionable CLI message. Both checkOllamaPreflight() (always fresh) and
// ensureOllamaPreflight()'s cache builder (below) call this, so the two
// can never drift onto two different error-message/hint implementations.
async function fetchReachabilityAndModels(base, capability) {
  if (!(await capability.isOllamaReachable(base))) {
    const isLocalhost = /localhost/i.test(base);
    const hint = isLocalhost
      ? `\n  Tip: on Windows, Node.js may route localhost through a proxy.\n  Try: OLLAMA_URL=http://127.0.0.1:11434`
      : '';
    throw new Error(
      `[preflight] Ollama unreachable at ${base}\n` +
      `  Start Ollama with: ollama serve${hint}`
    );
  }
  try {
    return await capability.listOllamaModels(base);
  } catch (err) {
    throw new Error(`[preflight] Could not list Ollama models from ${base}/api/tags: ${err.message}`);
  }
}

function throwIfMissingModels(missing) {
  const cmds = missing.map(m => `  ollama pull ${m}`).join('\n');
  throw new Error(
    `[preflight] Required Ollama model(s) not pulled:\n${cmds}\n` +
    `  Then retry indexing.`
  );
}

/**
 * Impure: fetches /api/version and /api/tags, throws with actionable
 * message on failure. Always performs a FRESH reachability + model-list
 * call — never cached. See ensureOllamaPreflight() below for the
 * process-lifetime-cached variant real indexer callers actually use.
 * @param {string} ollamaUrl
 * @param {string[]} requiredModels — the EXACT, minimal set of model
 *   names this run will actually call (see run.js's own
 *   resolveRequiredOllamaModels() — code review finding, P1: an earlier
 *   version of this function always took a flat contextModel+tagModel
 *   pair and checked both unconditionally, even when one of them was
 *   never going to be called this run — e.g. CONTEXT_MODE=deterministic
 *   never calls CONTEXT_MODEL, but preflight still required it to be
 *   pulled). An empty array means this run makes zero Ollama calls;
 *   callers should prefer shouldSkipOllamaPreflight() to skip this
 *   function entirely in that case rather than relying on an empty-array
 *   no-op, since checkOllamaPreflight() still performs the reachability
 *   check unconditionally.
 * @param {import('../../core/generation/ollama-capability.js').OllamaDiscoveryCapability} capability
 *   — required; no module-scope fallback exists.
 */
export async function checkOllamaPreflight(ollamaUrl, requiredModels, capability) {
  if (!capability) throw new Error('preflight.js: checkOllamaPreflight() requires a capability argument (an OllamaDiscoveryCapability) — no module-scope capability exists to fall back to.');
  validateOllamaDiscoveryCapability(capability);
  const base = ollamaUrl.replace(/\/$/, '');
  const available = await fetchReachabilityAndModels(base, capability);
  const missing = await capability.validateOllamaModels(requiredModels, available);
  if (missing) throwIfMissingModels(missing);
}

// Process-level cache — REVISED (code review finding, P1): reachability
// and the installed-model LIST are legitimately expensive/stable enough
// to cache per (capability instance, ollamaUrl) for the lifetime of this
// process, but requiredModels is per-FILE (run.js's own
// resolveRequiredOllamaModels() — a Markdown file may need only
// TAG_MODEL, the next PDF may need CONTEXT_MODEL) and must be validated
// against that cached list on EVERY call, never itself memoized.
//
// The earlier version of this cache stored a single module-scope
// `_preflightPromise` for the ENTIRE resolved checkOllamaPreflight()
// call, including the model-availability check — so once file 1's
// (Markdown, TAG_MODEL-only) preflight resolved, file 2's (PDF,
// CONTEXT_MODEL-only) call just awaited that same stale promise and
// never actually validated CONTEXT_MODEL at all. A missing CONTEXT_MODEL
// would then only surface mid-run, deep inside stageB, instead of
// failing fast at preflight — exactly the class of bug this whole
// preflight module exists to prevent.
//
// Keyed on the capability INSTANCE itself (a WeakMap, not a derived
// string key — code review finding, P2: a plain Map would hold a strong
// reference to every capability instance, and everything its closure
// captures, for the entire process lifetime, even after the run() that
// constructed it has long finished — a real leak in any long-lived host
// that constructs fresh capabilities per job, e.g. an Admin server
// spawning repeated indexer-style work in one process. WeakMap lets a
// capability (and its cache entry) be collected once nothing else
// references it) plus ollamaUrl — never assume two different run()
// invocations in the same process (e.g. two sequential CLI-style calls,
// or two concurrent jobs) share the same Ollama instance or reachability
// state; each capability object gets its own independent cache entry, so
// a capability swapped out between calls (different Ollama URL, a fake
// in a test, a genuinely different instance) never reads another
// capability's cached reachability/model-list.
const _availabilityCache = new WeakMap(); // capability -> Map<url, Promise<string[]>>

function getOrCreateAvailabilityPromise(ollamaUrl, capability) {
  let byUrl = _availabilityCache.get(capability);
  if (!byUrl) {
    byUrl = new Map();
    _availabilityCache.set(capability, byUrl);
  }
  const base = ollamaUrl.replace(/\/$/, '');
  let promise = byUrl.get(base);
  if (!promise) {
    promise = fetchReachabilityAndModels(base, capability);
    // A failed reachability/listing attempt must not permanently poison
    // this cache entry for the rest of the process — e.g. a transient
    // network blip on file 1 should not doom every later file once
    // Ollama recovers. Only a SUCCESSFUL resolution is kept cached.
    promise.catch(() => { byUrl.delete(base); });
    byUrl.set(base, promise);
  }
  return promise;
}

// Known, accepted concurrency nuance (code review): several files can
// concurrently discover the SAME missing model and each independently
// evict+re-fetch (ensureOllamaPreflight()'s own eviction-on-missing
// below), so a burst of concurrent preflight calls after a real missing-
// model failure can cause more than one redundant /api/tags request.
// This never produces a WRONG validation result — every in-flight fetch
// still resolves to a real, correct list, and requiredModels is always
// checked fresh against whichever one a given call ends up awaiting —
// it only means slightly more network traffic than the theoretical
// minimum in that one scenario. Not worth adding request coalescing for.

/**
 * @param {string} ollamaUrl
 * @param {string[]} requiredModels — validated fresh against the cached
 *   available-models list on EVERY call, never itself cached — see the
 *   module-header comment above for why this must stay per-call.
 * @param {import('../../core/generation/ollama-capability.js').OllamaDiscoveryCapability} capability — required, see checkOllamaPreflight().
 */
export async function ensureOllamaPreflight(ollamaUrl, requiredModels, capability) {
  if (!capability) throw new Error('preflight.js: ensureOllamaPreflight() requires a capability argument (an OllamaDiscoveryCapability) — no module-scope capability exists to fall back to.');
  validateOllamaDiscoveryCapability(capability);
  const available = await getOrCreateAvailabilityPromise(ollamaUrl, capability);
  const missing = await capability.validateOllamaModels(requiredModels, available);
  // Code review finding (P2): a stale cached model list must not survive
  // a real "missing model" report for the rest of the process — a user
  // who sees this error, runs `ollama pull <model>`, and retries within
  // the SAME process (e.g. a long-lived Admin-triggered job, or two
  // sequential CLI invocations sharing a process) would otherwise keep
  // failing against the old list forever, even though the model is now
  // genuinely installed. Evicting the entry here makes the very next
  // call re-fetch a fresh list — self-healing, no TTL timer, no explicit
  // reset API a caller has to remember to invoke.
  if (missing) {
    const byUrl = _availabilityCache.get(capability);
    byUrl?.delete(ollamaUrl.replace(/\/$/, ''));
    throwIfMissingModels(missing);
  }
}
