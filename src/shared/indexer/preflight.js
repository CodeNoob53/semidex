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

/**
 * Impure: fetches /api/version and /api/tags, throws with actionable
 * message on failure.
 * @param {string} ollamaUrl
 * @param {string} contextModel
 * @param {string} tagModel
 * @param {import('../../core/generation/ollama-capability.js').OllamaDiscoveryCapability} capability
 *   — required; no module-scope fallback exists.
 */
export async function checkOllamaPreflight(ollamaUrl, contextModel, tagModel, capability) {
  if (!capability) throw new Error('preflight.js: checkOllamaPreflight() requires a capability argument (an OllamaDiscoveryCapability) — no module-scope capability exists to fall back to.');
  validateOllamaDiscoveryCapability(capability);
  const base = ollamaUrl.replace(/\/$/, '');

  // 1. Reachability check
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

  // 2. Model availability check
  let available;
  try {
    available = await capability.listOllamaModels(base);
  } catch (err) {
    throw new Error(`[preflight] Could not list Ollama models from ${base}/api/tags: ${err.message}`);
  }

  const missing = await capability.validateOllamaModels([contextModel, tagModel], available);
  if (missing) {
    const cmds = missing.map(m => `  ollama pull ${m}`).join('\n');
    throw new Error(
      `[preflight] Required Ollama model(s) not pulled:\n${cmds}\n` +
      `  Then retry indexing.`
    );
  }
}

// Process-level cache: runs preflight at most once per indexer invocation.
// Stores the in-flight Promise so concurrent callers await the same check
// instead of each launching their own fetch (safe under Promise.all). This
// is a memoization cache keyed to "has THIS process already checked," not
// a capability-holding binding — it holds no reference to which Ollama
// implementation answered, only the settled result of asking once.
let _preflightPromise = null;
/**
 * @param {string} ollamaUrl
 * @param {string} contextModel
 * @param {string} tagModel
 * @param {import('../../core/generation/ollama-capability.js').OllamaDiscoveryCapability} capability — required, see checkOllamaPreflight().
 */
export async function ensureOllamaPreflight(ollamaUrl, contextModel, tagModel, capability) {
  if (!_preflightPromise) {
    _preflightPromise = checkOllamaPreflight(ollamaUrl, contextModel, tagModel, capability);
  }
  await _preflightPromise;
}
