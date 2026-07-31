import { generate } from '../../core/ollama-lazy.js';
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

  const context = await generate(MODEL, prompt);
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
