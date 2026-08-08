// Local Ollama capability factory (Phase 8B Step 8 — replaces the
// transitional core/ollama-lazy.js dynamic-loader wrapper, now removed).
// The one place in the codebase that statically imports local/core/ollama.js
// — every Full-only composition root (admin/bootstrap.js,
// admin/server-full.js, indexer/index-full.js, backfill-tags.js,
// mcp/server.js) imports THIS file instead, never local/core/ollama.js
// directly, so a future consumer never has to remember that ollama.js
// itself carries a static `import 'dotenv/config'` side effect that must
// not leak into Lite's module graph.
//
// Unlike local/core/onnx-embed.js/local/indexer/phases/tag-onnx.js (which
// own real session/worker lifecycle and need instance-scoped state), plain
// function exports in ollama.js hold no mutable state at all — there is
// nothing to isolate between two independently-constructed capabilities,
// so these factories are simple object literals, not closures over private
// state. Each one returns only the narrow method subset its own contract
// (src/core/generation/ollama-capability.js) declares — never the full
// ollama.js namespace — so a consumer can never accidentally reach a method
// outside what it declared it needs.
import {
  generate, embed, getModelContextLength, isThinkingModel, getOllamaEmbeddingDimension,
  isOllamaReachable, listOllamaModels, validateOllamaModels, generateStream,
} from './ollama.js';

/** @returns {import('../../core/generation/ollama-capability.js').OllamaGenerateCapability} */
export function createOllamaGenerateCapability() {
  return { generate };
}

/** @returns {import('../../core/generation/ollama-capability.js').OllamaSummaryCapability} */
export function createOllamaSummaryCapability() {
  return { generate, getModelContextLength, isThinkingModel };
}

/** @returns {import('../../core/generation/ollama-capability.js').OllamaEmbedCapability} */
export function createOllamaEmbedCapability() {
  return { embed, getOllamaEmbeddingDimension };
}

/** @returns {import('../../core/generation/ollama-capability.js').OllamaDiscoveryCapability} */
export function createOllamaDiscoveryCapability() {
  return { isOllamaReachable, listOllamaModels, validateOllamaModels };
}

// generateStream has no capability contract of its own (see
// core/generation/ollama-capability.js's own header comment — its one real
// consumer, core/generation/ollama-provider.js, already has its own
// separate per-method DI unrelated to these contracts) — re-exported here,
// individually, for admin/bootstrap.js's own generationRuntime wiring,
// which needs it alongside three OllamaDiscoveryCapability-shaped methods
// but is not itself consuming a single bundled capability object.
export { generateStream, isOllamaReachable, listOllamaModels, validateOllamaModels, getModelContextLength };
