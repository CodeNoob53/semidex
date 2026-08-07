// The one real CloudEmbeddingCapability implementation — a thin factory
// wrapping qdrant-cloud-catalog.js's own four exported functions
// (checkEmbedInputFits, fitContextToBudget, buildCloudQueryInputs,
// resolveEmbeddingBudget) plus a getCloudTokenCounter() built from
// qdrant-cloud-tokenizer.js's own loadQdrantCloudTokenizer()/
// qdrantCloudTokenCount(), into the shape core/embedding-profile/
// cloud-embedding-capability.js declares. This is the ONE file a
// composition root (Full or Lite) imports to obtain the real capability
// — every shared consumer (core/embeddings.js, core/retrieval/search.js,
// core/token-count.js, indexer/run.js) receives the returned object as an
// injected parameter, never importing this file, qdrant-cloud-catalog.js,
// or qdrant-cloud-tokenizer.js directly.
//
// getCloudTokenCounter() returns a RAW, uncached (text) => Promise<number>
// counter — per-text memoization is core/token-count.js's own
// responsibility (it already caches its BGE-M3-mode counter results the
// same way, in the same _tokenCountCache), so this factory does not
// duplicate that cache here. loadQdrantCloudTokenizer() itself already
// caches the loaded Tokenizer per model id internally, so repeated calls
// for the same model never re-download or re-parse.
//
// No instance-scoped state exists here to isolate (unlike the local ONNX
// embedding capability) — every wrapped function is either pure or reads
// from qdrant-cloud-tokenizer.js's own internal per-model cache, which is
// already safe to share across calls within one process (a tokenizer's
// own parse result for a given model id never changes mid-process). A
// fresh object is still returned per call, matching every other
// capability factory's own convention, so two composition roots never
// share the same OBJECT reference even though the underlying functions
// are the same stateless imports either way.
import {
  checkEmbedInputFits, fitContextToBudget, buildCloudQueryInputs, resolveEmbeddingBudget,
} from './qdrant-cloud-catalog.js';
import { loadQdrantCloudTokenizer, qdrantCloudTokenCount } from './qdrant-cloud-tokenizer.js';

async function getCloudTokenCounter(modelId, { localFilesOnly = false } = {}) {
  const tok = await loadQdrantCloudTokenizer(modelId, { localFilesOnly });
  return async function cloudCount(text) {
    return qdrantCloudTokenCount(tok, text);
  };
}

/**
 * @returns {import('../../core/embedding-profile/cloud-embedding-capability.js').CloudEmbeddingCapability}
 */
export function createCloudEmbeddingCapability() {
  return { checkEmbedInputFits, fitContextToBudget, buildCloudQueryInputs, resolveEmbeddingBudget, getCloudTokenCounter };
}
