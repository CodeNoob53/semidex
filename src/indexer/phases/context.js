import { validateOllamaGenerateCapability } from '../../core/generation/ollama-capability.js';
import { runBatched } from '../batch.js';

// let (not const): CONTEXT_MODEL/LLM_BATCH_SIZE are next_index_job settings
// (core/settings/definitions.js) — a fresh indexer process re-resolves them
// once via applyContextSettings() below, called by indexer/index.js right
// after constructing its SettingsService. Mirrors chunk.js's
// applyChunkingSettings() pattern exactly.
let MODEL = process.env.CONTEXT_MODEL || 'gemma3:4b';
let BATCH_SIZE = parseInt(process.env.LLM_BATCH_SIZE || '3');

/**
 * Re-resolves MODEL/BATCH_SIZE from a SettingsService. Call once, at
 * indexer process startup, before contextualizing any chunk.
 * @param {Object} settingsService
 */
export function applyContextSettings(settingsService) {
  MODEL = settingsService.getActiveValue('CONTEXT_MODEL');
  BATCH_SIZE = settingsService.getActiveValue('LLM_BATCH_SIZE');
}

// Capability injection (Phase 8B Step 1, revised round 4) — this module
// never imports core/ollama.js, not even indirectly through a *-lazy.js
// re-export used as a default value. It depends only on the narrow
// OllamaGenerateCapability contract (core/generation/ollama-capability.js)
// — a single-method generate-only slice of Ollama's surface (this file's
// only real call is generate(); it never calls generateStream/
// getModelContextLength/isThinkingModel, so it doesn't depend on a
// contract wide enough to require them). `_ollama` starts unset (null) —
// indexer/index.js's own applyAllCapabilities() call (made unconditionally
// for both editions before run() ever executes) is the one real caller
// that populates it. addContext() itself is never reached in Lite
// regardless (CONTEXT_MODE=deterministic hard pin), but this module no
// longer needs a real-module default to make that provably true — the
// capability is simply never there to call.
let _ollama = null;

/**
 * Composition-time seam: inject the Ollama capability addContext() calls
 * through. Call once, at process composition time (mirrors
 * applyContextSettings()) — never per-request.
 * @param {import('../../core/generation/ollama-capability.js').OllamaGenerateCapability} capability
 */
export function applyContextCapability(capability) {
  validateOllamaGenerateCapability(capability);
  _ollama = capability;
}

// CONTEXT_MODE=deterministic|llm (default llm — full Semidex unchanged).
// Semidex Lite pins deterministic so legacy (non-skeleton) chunking never
// calls Ollama. Mirrors isOnnxTagProvider()'s (tag-onnx.js) DI-friendly
// style — env passed explicitly so callers/tests never depend on a global.
export function isDeterministicContextMode(env = process.env) {
  return env.CONTEXT_MODE === 'deterministic';
}

export async function addContext(chunk) {
  const prompt = `You are a document indexer. Given a text chunk from a file, write 1-2 sentences describing what this chunk is about and where it fits in the document. Be concise. Output only the context, nothing else.

File: ${chunk.source_file}
Section: ${chunk.section || 'unknown'}
Chunk ${chunk.chunkIndex + 1} of ${chunk.totalChunks}

Text:
${chunk.text.slice(0, 1000)}`;

  if (!_ollama) throw new Error('phases/context.js: no ollama capability injected — call applyContextCapability() or applyAllCapabilities() before indexing.');
  const context = await _ollama.generate(MODEL, prompt);
  return { ...chunk, context: context.trim() };
}

// Deterministic (zero-LLM) counterpart to addContext(), for legacy
// (non-skeleton) chunks under CONTEXT_MODE=deterministic. Mirrors the
// skeleton chunker's own deterministic context — proseContext(headingPath)
// = headingPath.join(' › ') (skeleton-chunk.js) — but legacy chunks carry
// no headingPath array, only a flat `section` string, so the equivalent
// deterministic signal here is "source_file — section". Same async
// signature and return shape as addContext() so every call site can swap
// the two functions without any other change.
//
// Why this exists: chunk.js deliberately routes PDF/Pandoc/plain-text
// through the legacy chunker (a documented scope boundary — no synthetic-
// skeleton-root representation exists for non-Markdown input), and
// addContext() is a hard Ollama dependency with no non-LLM fallback. A
// cloud-only deployment (Semidex Lite) that indexes a PDF must never
// attempt to reach a local Ollama server — this function is what makes
// that indexing path genuinely LLM-free rather than merely "usually
// skipped."
export async function addContextDeterministic(chunk) {
  const parts = [];
  if (chunk.source_file) parts.push(chunk.source_file);
  if (chunk.section) parts.push(chunk.section);
  return { ...chunk, context: parts.join(' › ') };
}

export async function processChunks(chunks) {
  return runBatched(chunks, BATCH_SIZE, addContext);
}
