// Semidex Lite indexer CLI entry point (code review, round 4, P1 — see
// index-full.js's own header comment for why this is a SEPARATE file
// rather than a branch inside one shared entry point). Never imports
// core/ollama-lazy.js, core/onnx-embed-lazy.js, or
// indexer/phases/tag-onnx-lazy.js — not statically, not dynamically, not
// even inside an unreached branch. Builds its own typed-unavailable
// capability objects explicitly and shares the actual CLI/indexing flow
// with index-full.js via index-runtime.js's runIndexerCli().
//
// Deliberately does NOT import core/ollama-lazy.lite.js/
// core/onnx-embed-lazy.lite.js/phases/tag-onnx-lazy.lite.js either — those
// files are dead code now (packages/lite/build.mjs no longer does any
// *-lazy.js content substitution at all; core/ollama-lazy.js/
// core/onnx-embed-lazy.js/indexer/phases/tag-onnx-lazy.js and their
// .lite.js siblings are simply excluded from the Lite package outright,
// like any other local-only file — see build.mjs's own EXCLUDE_FILES
// comment). The typed error classes below are therefore small, local,
// throwaway classes — mirroring admin/composition/lite.js's own identical
// unavailableOllamaEmbedCapability()/unavailableOnnxEmbedCapability()
// pattern — not a reuse of any *-lazy.lite.js shim's own class.
//
// admin/jobs/spawn-indexer-lite.js's own spawnIndexer selects THIS file
// as the spawn target — admin/jobs/registry.js itself has no `edition`
// concept and no default spawnIndexer; Lite's composition roots
// (admin/composition/lite.js's createLiteApp(), packages/lite/lite-src/
// serve-lite.js, packages/lite/lite-src/index-lite.js) each inject
// spawn-indexer-lite.js's spawnIndexer explicitly.
//
// Usage: COLLECTION=my-collection node src/indexer/index-lite.js <file|folder>
import { isIndexerMainModule, runIndexerCli } from './index-runtime.js';
// createCloudEmbeddingCapability() (code review, Phase 8B Step 6): unlike
// ollama/onnxEmbed above (Lite builds typed-unavailable stubs for both —
// local providers Lite never ships), Lite genuinely NEEDS the real Qdrant
// Cloud Inference embedding-budget/tokenizer capability — Lite is
// cloud-only by design, so this is the ONE real implementation it
// constructs directly. A real `composition root -> cloud` edge, explicitly
// allowed by the task's own dependency rules.
import { createCloudEmbeddingCapability } from '../cloud/embedding/cloud-embedding-provider.js';

class OllamaNotAvailableInLiteIndexerError extends Error {
  constructor(fnName) {
    super(`${fnName}() is not available in Semidex Lite — Ollama is a local-only provider and is not included in this package.`);
    this.name = 'OllamaNotAvailableInLiteError';
    this.code = 'not_available_in_lite';
  }
}

class OnnxEmbedNotAvailableInLiteIndexerError extends Error {
  constructor(fnName) {
    super(`${fnName}() is not available in Semidex Lite — the local ONNX embedding runtime is not included in this package.`);
    this.name = 'OnnxEmbedNotAvailableInLiteError';
    this.code = 'not_available_in_lite';
  }
}

class TagOnnxNotAvailableInLiteIndexerError extends Error {
  constructor(fnName) {
    super(`${fnName}() is not available in Semidex Lite — the ONNX tag generation worker is not included in this package.`);
    this.name = 'TagOnnxNotAvailableInLiteError';
    this.code = 'not_available_in_lite';
  }
}

function unavailableOllama(fnName) {
  return async () => { throw new OllamaNotAvailableInLiteIndexerError(fnName); };
}

// Satisfies OllamaGenerateCapability/OllamaSummaryCapability/
// OllamaEmbedCapability/OllamaDiscoveryCapability all at once (one object,
// four contracts — same as the real ollama-lazy.js module's own export
// surface, which also satisfies all four from one namespace object).
function unavailableOllamaCapability() {
  return {
    generate: unavailableOllama('generate'),
    embed: unavailableOllama('embed'),
    getModelContextLength: unavailableOllama('getModelContextLength'),
    isThinkingModel: unavailableOllama('isThinkingModel'),
    getOllamaEmbeddingDimension: unavailableOllama('getOllamaEmbeddingDimension'),
    isOllamaReachable: unavailableOllama('isOllamaReachable'),
    listOllamaModels: unavailableOllama('listOllamaModels'),
    validateOllamaModels: unavailableOllama('validateOllamaModels'),
  };
}

function unavailableOnnxEmbedCapability() {
  return {
    loadOnnx: async () => { throw new OnnxEmbedNotAvailableInLiteIndexerError('loadOnnx'); },
    loadOnnxBatch: async () => { throw new OnnxEmbedNotAvailableInLiteIndexerError('loadOnnxBatch'); },
    // shutdown is DIFFERENT from loadOnnx/loadOnnxBatch: unconditional
    // cleanup, called from run.js's own `finally` block on every indexing
    // run regardless of whether ONNX embedding was ever used — mirrors
    // unavailableTagOnnxCapability()'s own shutdownOnnxTagWorker() no-op
    // just below, and the real local/core/onnx-embed.js's own
    // shutdown()'s documented safe-no-op-when-no-session-exists contract.
    async shutdown() { /* no-op: no ONNX session is ever created in Semidex Lite */ },
  };
}

// shutdownOnnxTagWorker MUST resolve, never throw, even though no worker is
// ever spawned in Lite (TAG_GEN=0 hard pin) — this is a load-bearing
// behavioral requirement (see tag-onnx-capability.js's own header comment)
// — run.js calls this unconditionally in its own `finally` block on EVERY
// indexing run, and a real live-indexing run against Qdrant Cloud crashed
// on this exact call before that contract was established.
function unavailableTagOnnxCapability() {
  return {
    addTagsOnnxBatch: async () => { throw new TagOnnxNotAvailableInLiteIndexerError('addTagsOnnxBatch'); },
    async shutdownOnnxTagWorker() { /* no-op: no worker is ever started in Semidex Lite */ },
  };
}

// Run only when executed directly, not when imported for testing.
if (isIndexerMainModule(import.meta.url)) {
  await runIndexerCli({
    ollamaGenerate: unavailableOllamaCapability(),
    ollamaSummary: unavailableOllamaCapability(),
    ollamaEmbed: unavailableOllamaCapability(),
    ollamaDiscovery: unavailableOllamaCapability(),
    onnxEmbed: unavailableOnnxEmbedCapability(),
    tagOnnx: unavailableTagOnnxCapability(),
    cloudEmbed: createCloudEmbeddingCapability(),
  });
}
