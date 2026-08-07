// Legacy LLM merge helpers kept only for historical merge-strategy diagnostics.
// Production chunking finalizes deterministic short-fragment merges in chunk.js.

import { generate } from '../../src/local/core/ollama.js';
import { OVERLAP_SENTENCES, splitSentences } from '../../src/shared/indexer/phases/chunk.js';

const MODEL = process.env.CONTEXT_MODEL || 'gemma3:4b';

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

export async function mergeChunksDeterministic(chunks) {
  return mergeChunksWithDecisions(chunks, async () => false);
}
