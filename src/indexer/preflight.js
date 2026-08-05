// Ollama reachability/model-list logic lives in src/core/ollama.js, shared
// with the admin API's pre-job-start check (src/admin/api/jobs.js) — this
// file only adds the indexer-specific "throw with an actionable CLI message"
// framing around that shared logic.
//
// Depends on the narrow OllamaDiscoveryCapability CONTRACT
// (core/generation/ollama-capability.js) only — never imports
// core/ollama.js directly, not even indirectly through a *-lazy.js default
// (Phase 8B Step 1, revised round 4; see indexer/phases/context.js's own
// header comment for the full rationale). `_ollama` starts unset (null) —
// indexer/index.js's own applyAllCapabilities() call (made unconditionally
// for both editions before run() ever executes) is the one real caller
// that populates it. checkOllamaPreflight() only ever RUNS when a local
// Ollama model is actually required (run.js gates it behind
// !skeletonNoLlm and never calls it in cloud/deterministic mode).
import { validateOllamaDiscoveryCapability } from '../core/generation/ollama-capability.js';

let _ollama = null;

/**
 * Composition-time seam: inject the Ollama capability preflight checks
 * call through. Call once, at process composition time — never per-request.
 * @param {import('../core/generation/ollama-capability.js').OllamaDiscoveryCapability} capability
 */
export function applyPreflightCapability(capability) {
  validateOllamaDiscoveryCapability(capability);
  _ollama = capability;
}

// Impure: fetches /api/version and /api/tags, throws with actionable message on failure.
export async function checkOllamaPreflight(ollamaUrl, contextModel, tagModel) {
  if (!_ollama) throw new Error('preflight.js: no ollama capability injected — call applyPreflightCapability() or applyAllCapabilities() before indexing.');
  const base = ollamaUrl.replace(/\/$/, '');

  // 1. Reachability check
  if (!(await _ollama.isOllamaReachable(base))) {
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
    available = await _ollama.listOllamaModels(base);
  } catch (err) {
    throw new Error(`[preflight] Could not list Ollama models from ${base}/api/tags: ${err.message}`);
  }

  const missing = await _ollama.validateOllamaModels([contextModel, tagModel], available);
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
// instead of each launching their own fetch (safe under Promise.all).
let _preflightPromise = null;
export async function ensureOllamaPreflight(ollamaUrl, contextModel, tagModel) {
  if (!_preflightPromise) {
    _preflightPromise = checkOllamaPreflight(ollamaUrl, contextModel, tagModel);
  }
  await _preflightPromise;
}
