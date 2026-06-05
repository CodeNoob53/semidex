import { generate } from '../../core/ollama.js';
import { runBatched } from '../batch.js';

const MODEL = process.env.CONTEXT_MODEL || 'gemma3:4b';
const BATCH_SIZE = parseInt(process.env.LLM_BATCH_SIZE || '3');

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
