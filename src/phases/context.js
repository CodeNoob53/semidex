import { generate } from '../lib/ollama.js';
import { runBatched } from '../lib/batch.js';

const MODEL = process.env.CONTEXT_MODEL || 'gemma3';
const BATCH_SIZE = parseInt(process.env.LLM_BATCH_SIZE || '3');

// generates 1-2 sentence context for a chunk
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

// checks if two adjacent chunks should be merged
// returns true if they belong to the same logical thought
export async function shouldMerge(chunkA, chunkB) {
  const prompt = `You are a document chunker. Given two adjacent text fragments, decide if they belong to the same logical thought or if the second fragment starts a new topic.

Answer with only "merge" or "split".

Fragment A (end):
${chunkA.text.slice(-300)}

Fragment B (start):
${chunkB.text.slice(0, 300)}`;

  const answer = await generate(MODEL, prompt);
  return answer.trim().toLowerCase().includes('merge');
}

// process chunks: check boundaries, merge if needed, add context
export async function processChunks(chunks) {
  // step 1: check boundaries and merge where needed
  const merged = [];
  let i = 0;
  while (i < chunks.length) {
    const current = chunks[i];
    if (current.needsBoundaryCheck && i > 0 && merged.length > 0) {
      const prev = merged.at(-1);
      const merge = await shouldMerge(prev, current);
      if (merge) {
        // merge into previous
        merged[merged.length - 1] = {
          ...prev,
          text: prev.text + '\n' + current.text,
          totalChunks: chunks.length,
        };
        i++;
        continue;
      }
    }
    merged.push(current);
    i++;
  }

  // re-index after merges
  const reindexed = merged.map((c, i) => ({ ...c, chunkIndex: i, totalChunks: merged.length }));

  // step 2: add context in parallel batches
  return runBatched(reindexed, BATCH_SIZE, addContext);
}
