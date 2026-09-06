// Benchmark-owned query-embedding composition — the ONE place a benchmark
// runner obtains the real embedding capabilities that runHybridSearch()
// needs on its CLIENT-execution (local ONNX/Ollama) and QDRANT_CLOUD
// branches.
//
// Why this exists
// ---------------
// runHybridSearch() (src/core/retrieval/search.js) never constructs an
// embedding capability itself — every production caller
// (admin/api/search.js, core/ask/evidence.js, mcp/tools/search.js) threads
// its OWN composition root's `embedQuery` (via embedForSearch's
// `capabilities` option) and `cloudEmbed` through explicitly. A benchmark
// runner is just another composition root, and before this module the
// production-path suite's queryOne() passed NEITHER — so every local query
// hit "no onnxEmbed capability available" and every cloud query hit "no
// cloudEmbed capability was supplied" (audit 2026-09-06, finding P1).
//
// Contract
// --------
//  - createBenchmarkQueryEmbedder() returns a fresh instance per call
//    (parity with every capability factory in src/) with its OWN lazily
//    constructed ONNX capability — never a process-wide singleton, never
//    applyEmbeddingCapabilities(). Two instances never share a session.
//  - `embedQuery(profile, text)` is the function to pass to
//    runHybridSearch({ embedQuery }). It dispatches on the resolved
//    profile's dense provider: bge-m3-onnx -> the instance's own ONNX
//    capability (built on first use only, so a cloud-only run never loads
//    onnxruntime-node); ollama/hashed-tf -> embedForSearch's own module
//    default (the real Ollama capability applyEmbeddingCapabilities()
//    installs at process start for a local Ollama run). It is ONLY called
//    by runHybridSearch() on the CLIENT branch — a qdrant-cloud profile
//    never reaches it.
//  - `cloudEmbed` is the real CloudEmbeddingCapability, passed straight to
//    runHybridSearch({ cloudEmbed }). Stateless wrapper over the cloud
//    catalog/tokenizer — safe to hold for the whole run.
//  - `shutdown()` releases the ONNX InferenceSession if one was ever
//    created (idempotent, safe when none was). Call it in a finally.
//
// This module performs NO model download or generation at import time —
// the ONNX capability is only constructed when `embedQuery` is first
// called for a bge-m3-onnx profile, and even then it only loads a cached
// model (a benchmark run against an un-cached model is a setup error the
// caller surfaces, never a silent background download this module hides).
import { embedForSearch } from '../../src/shared/core/embeddings.js';
import { createOnnxEmbeddingCapability } from '../../src/local/core/onnx-embed.js';
import { createCloudEmbeddingCapability } from '../../src/cloud/embedding/cloud-embedding-provider.js';

/**
 * @param {{
 *   onnxCapabilityFactory?: () => { loadOnnx: Function, shutdown: () => Promise<void> },
 *   cloudCapabilityFactory?: () => import('../../src/core/embedding-profile/cloud-embedding-capability.js').CloudEmbeddingCapability,
 *   embedForSearchFn?: typeof embedForSearch,
 * }} [overrides] — test-only seams; real runners pass nothing. Every
 *   override defaults to the real production factory/function.
 * @returns {{
 *   embedQuery: (profile: Object, text: string) => Promise<{ dense: number[], sparse: Object }>,
 *   getClientCapabilities: (profile: Object) => { onnxEmbed?: Object } — the
 *     `capabilities` object to pass to embedForIndex()/embedForIndexBatch()
 *     for a CLIENT-execution profile (constructs the ONNX capability on
 *     first call for a bge-m3-onnx profile, same instance embedQuery uses;
 *     an empty object for ollama/hashed-tf). Only meaningful for a
 *     benchmark that also indexes in-process; the production-path suite
 *     indexes via a real CLI subprocess and never needs this.
 *   cloudEmbed: import('../../src/core/embedding-profile/cloud-embedding-capability.js').CloudEmbeddingCapability,
 *   shutdown: () => Promise<void>,
 * }}
 */
export function createBenchmarkQueryEmbedder({
  onnxCapabilityFactory = createOnnxEmbeddingCapability,
  cloudCapabilityFactory = createCloudEmbeddingCapability,
  embedForSearchFn = embedForSearch,
} = {}) {
  // Instance-scoped — private to this call's returned object. Constructed
  // on first bge-m3-onnx query only.
  let onnxCapability = null;
  let shutdownCalled = false;

  function denseProviderOf(profile) {
    return profile?.embedding?.dense?.provider ?? null;
  }

  function ensureOnnx() {
    if (shutdownCalled) {
      throw new Error('createBenchmarkQueryEmbedder: used after shutdown() — construct a new embedder instead of reusing one.');
    }
    if (!onnxCapability) onnxCapability = onnxCapabilityFactory();
    return onnxCapability;
  }

  function getClientCapabilities(profile) {
    // ONNX capability only for a bge-m3-onnx profile; an ollama/hashed-tf
    // profile gets an empty object and falls back to embedForIndex's own
    // module default (installed by applyEmbeddingCapabilities() for a
    // local Ollama run).
    if (denseProviderOf(profile) === 'bge-m3-onnx') return { onnxEmbed: ensureOnnx() };
    return {};
  }

  async function embedQuery(profile, text) {
    if (shutdownCalled) {
      throw new Error('createBenchmarkQueryEmbedder: embedQuery called after shutdown() — construct a new embedder instead of reusing one.');
    }
    if (denseProviderOf(profile) === 'bge-m3-onnx') {
      return embedForSearchFn(profile, text, { capabilities: { onnxEmbed: ensureOnnx() } });
    }
    // ollama / hashed-tf — embedForSearch's own module-scope default
    // (the real Ollama capability, installed once by
    // applyEmbeddingCapabilities() at process start for a local Ollama run).
    return embedForSearchFn(profile, text);
  }

  async function shutdown() {
    shutdownCalled = true;
    if (onnxCapability) {
      const c = onnxCapability;
      onnxCapability = null;
      await c.shutdown();
    }
  }

  return {
    embedQuery,
    getClientCapabilities,
    cloudEmbed: cloudCapabilityFactory(),
    shutdown,
  };
}
