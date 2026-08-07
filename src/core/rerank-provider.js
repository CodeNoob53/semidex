// The one real RerankCapability implementation (code review, Phase 8B
// Step 6 second pass, P1 fix) — a thin factory wrapping rerank.js's
// deterministic rerankResults() and ce-rerank.js's cross-encoder
// ceRerank()/withCETimeout()/getCeRerankConfig() into the shape
// core/rerank-capability.js declares. Mirrors core/ollama-lazy.js's own
// role: this file is the ONE place a composition root (currently only
// src/mcp/server.js) imports directly to obtain the real capability — a
// shared consumer (mcp/tools/search.js) never imports rerank.js or
// ce-rerank.js itself, only this factory's OUTPUT, injected explicitly.
//
// Declared 'mixed' in the architecture manifest (not 'shared'): it
// directly imports ce-rerank.js, a 'local'-classified module (spawns a
// persistent child process running @huggingface/transformers) — this file
// IS the deliberate seam, the same role ollama-lazy.js/onnx-embed-lazy.js
// already play for their own local implementations.
import { rerankResults } from './rerank.js';
import { ceRerank, withCETimeout, getCeRerankConfig } from './ce-rerank.js';

/**
 * @returns {import('./rerank-capability.js').RerankCapability}
 */
export function createRerankCapability() {
  return { rerankResults, ceRerank, withCETimeout, getCeRerankConfig };
}
