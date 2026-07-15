import { generate } from '../../core/ollama.js';
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

export async function processChunks(chunks) {
  return runBatched(chunks, BATCH_SIZE, addContext);
}
