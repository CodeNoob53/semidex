// Ollama reachability/model-list logic lives in src/core/ollama.js, shared
// with the admin API's pre-job-start check (src/admin/api/jobs.js) — this
// file only adds the indexer-specific "throw with an actionable CLI message"
// framing around that shared logic.
//
// Imported via ollama-lazy.js (dynamic) rather than statically from
// core/ollama.js: this file is on the indexer import graph (run.js imports
// it), and a cloud-only Semidex Lite deployment must never pull
// core/ollama.js into the module graph. checkOllamaPreflight() only ever
// RUNS when a local Ollama model is actually required (run.js gates it
// behind !skeletonNoLlm and never calls it in cloud/deterministic mode), so
// deferring the import to first call costs nothing observable.
import { isOllamaReachable, listOllamaModels, validateOllamaModels } from '../core/ollama-lazy.js';

// Impure: fetches /api/version and /api/tags, throws with actionable message on failure.
export async function checkOllamaPreflight(ollamaUrl, contextModel, tagModel) {
  const base = ollamaUrl.replace(/\/$/, '');

  // 1. Reachability check
  if (!(await isOllamaReachable(base))) {
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
    available = await listOllamaModels(base);
  } catch (err) {
    throw new Error(`[preflight] Could not list Ollama models from ${base}/api/tags: ${err.message}`);
  }

  const missing = await validateOllamaModels([contextModel, tagModel], available);
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
