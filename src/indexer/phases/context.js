import { generate } from '../../core/ollama.js';
import { runBatched } from '../batch.js';
import { OVERLAP_SENTENCES, splitSentences } from './chunk.js';

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

function sameMergeScope(chunkA, chunkB) {
  return (
    chunkA?.source_file === chunkB?.source_file &&
    (chunkA?.section || '') === (chunkB?.section || '')
  );
}

function overlapPrefixFrom(text) {
  if (OVERLAP_SENTENCES <= 0) return '';
  return splitSentences(text).slice(-OVERLAP_SENTENCES).join(' ').trim();
}

function addSplitOverlap(chunks) {
  return chunks.map((chunk, idx) => {
    if (idx === 0 || !chunk.needsBoundaryCheck) {
      return { ...chunk, needsBoundaryCheck: false };
    }

    const prev = chunks[idx - 1];
    if (!sameMergeScope(prev, chunk)) {
      return { ...chunk, needsBoundaryCheck: false };
    }

    const prefix = overlapPrefixFrom(prev.text);
    if (!prefix || chunk.text.startsWith(prefix)) {
      return { ...chunk, needsBoundaryCheck: false };
    }

    return {
      ...chunk,
      text: `${prefix} ${chunk.text}`,
      needsBoundaryCheck: false,
    };
  });
}

// Merge boundary-flagged adjacent chunks and reindex. No per-chunk context generation
// (addContext is not called). shouldMerge() LLM calls still happen for boundary chunks.
// Used directly by the combined path so it can skip the addContext step.
export async function mergeChunksWithDecisions(chunks, decideMerge) {
  const merged = [];
  let i = 0;
  while (i < chunks.length) {
    const current = chunks[i];
    if (current.needsBoundaryCheck && i > 0 && merged.length > 0) {
      const prev = merged.at(-1);
      const merge = sameMergeScope(prev, current) ? await decideMerge(prev, current) : false;
      if (merge) {
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
  return addSplitOverlap(merged).map((c, idx) => ({ ...c, chunkIndex: idx, totalChunks: merged.length }));
}

export async function mergeChunks(chunks) {
  return mergeChunksWithDecisions(chunks, shouldMerge);
}

export async function mergeChunksDeterministic(chunks) {
  return mergeChunksWithDecisions(chunks, async () => false);
}

export async function processChunks(chunks) {
  const reindexed = await mergeChunks(chunks);
  return runBatched(reindexed, BATCH_SIZE, addContext);
}
