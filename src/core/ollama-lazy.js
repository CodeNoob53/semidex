// Lazy accessor for local/core/ollama.js (Phase 8B Step 3 — physically
// relocated from core/ to local/core/; this file's own dynamic-import
// specifier below is the only thing that changed). Every indexer/retrieval
// module that talks to a local Ollama server reaches its Ollama functions
// THROUGH this module's dynamic loader instead of statically `import`ing
// ollama.js directly — so that merely importing such a module never pulls
// ollama.js (and its `import 'dotenv/config'` + fetch client) into the
// module graph.
//
// Why this matters: Semidex Lite is a cloud-only distribution that must
// provably never load or contact a local Ollama. local/core/ollama.js is a
// light dotenv+fetch client (no heavy native dep), but it is still a LOCAL
// provider Lite does not ship. With the static edges cut and replaced by
// these lazy loaders, ollama.js enters the module graph ONLY when a local
// Ollama call is actually about to run — which in Lite (cloud providers,
// deterministic context, tags off, no Ollama preflight) never happens,
// making the import-isolation guarantee real.
//
// Full-Semidex behavior is observably unchanged: the same functions run,
// resolved one dynamic-import hop later; the module is cached after first
// load so there is no per-call overhead. Ollama-native modules
// (generation/ollama-provider.js, admin/system/ollama.js) keep their direct
// static imports — they are not on the Lite graph and legitimately depend
// on Ollama, including its one synchronous helper (validateOllamaModels).

let _mod = null;

async function loadOllama() {
  if (!_mod) _mod = await import('../local/core/ollama.js');
  return _mod;
}

export async function generate(...args) {
  return (await loadOllama()).generate(...args);
}

export async function embed(...args) {
  return (await loadOllama()).embed(...args);
}

export async function getModelContextLength(...args) {
  return (await loadOllama()).getModelContextLength(...args);
}

export async function isThinkingModel(...args) {
  return (await loadOllama()).isThinkingModel(...args);
}

export async function getOllamaEmbeddingDimension(...args) {
  return (await loadOllama()).getOllamaEmbeddingDimension(...args);
}

export async function isOllamaReachable(...args) {
  return (await loadOllama()).isOllamaReachable(...args);
}

export async function listOllamaModels(...args) {
  return (await loadOllama()).listOllamaModels(...args);
}

export async function generateStream(...args) {
  return (await loadOllama()).generateStream(...args);
}

// validateOllamaModels is synchronous in ollama.js (a pure array
// comparison). Wrapped here it returns a Promise. Ollama-native callers
// keep the direct sync import.
export async function validateOllamaModels(...args) {
  return (await loadOllama()).validateOllamaModels(...args);
}
