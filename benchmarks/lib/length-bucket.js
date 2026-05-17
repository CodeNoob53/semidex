// Pure length-bucketing helper for ONNX batch embedding.
// No ONNX/model dependencies — safe to import in npm run smoke.
//
// Bucket boundaries (token count upper bounds, inclusive):
//   <=16, <=32, <=64, <=128, <=256, >256 (unbounded)
//
// Token count is estimated as Math.ceil(charLength / 4) — fast, no tokenizer needed.
// Actual token counts will differ slightly; the estimate is conservative (overestimates
// for CJK/emoji-heavy text). For bucketing purposes, slight overestimation is acceptable
// because it puts texts in a larger bucket rather than splitting them across boundaries.

export const BUCKET_BOUNDARIES = [16, 32, 64, 128, 256, Infinity];

// Estimate token count from character length (chars/4, rounded up).
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// Return the bucket index (0–5) for a given estimated token count.
export function bucketIndex(tokenCount) {
  for (let i = 0; i < BUCKET_BOUNDARIES.length; i++) {
    if (tokenCount <= BUCKET_BOUNDARIES[i]) return i;
  }
  return BUCKET_BOUNDARIES.length - 1;
}

// Group an array of texts into length-bucketed batches.
// Returns batches in the order needed to process all texts, each batch carrying
// the original indices so output can be restored to input order.
//
// Arguments:
//   texts   — string[]
//   maxBatch — max texts per batch (default 8)
//
// Returns:
//   Array<{ indices: number[], texts: string[] }>
//   where indices[i] is the position in the original `texts` array.
//
// Output order guarantee: after collecting results[batch.indices[i]] = batchResult[i]
// for every batch, `results` is aligned to the original `texts` array.
export function bucketBatches(texts, maxBatch = 8) {
  // Assign each text to a bucket along with its original index.
  const buckets = Array.from({ length: BUCKET_BOUNDARIES.length }, () => []);
  for (let i = 0; i < texts.length; i++) {
    const bi = bucketIndex(estimateTokens(texts[i]));
    buckets[bi].push(i);
  }

  // Slice each bucket into batches of at most maxBatch.
  const batches = [];
  for (const bucket of buckets) {
    for (let start = 0; start < bucket.length; start += maxBatch) {
      const indices = bucket.slice(start, start + maxBatch);
      batches.push({ indices, texts: indices.map(i => texts[i]) });
    }
  }
  return batches;
}

// Convenience: embed all texts with a provided embedBatch function, preserving order.
// embedBatch: (texts: string[]) => Promise<Array<{ dense, sparse }>>
export async function embedBucketed(texts, embedBatch, maxBatch = 8) {
  if (!texts.length) return [];
  const batches = bucketBatches(texts, maxBatch);
  const results = new Array(texts.length);
  for (const batch of batches) {
    const batchResults = await embedBatch(batch.texts);
    if (batchResults.length !== batch.texts.length) {
      throw new Error(`embedBucketed: embedBatch returned ${batchResults.length} results for ${batch.texts.length} inputs`);
    }
    for (let i = 0; i < batch.indices.length; i++) {
      results[batch.indices[i]] = batchResults[i];
    }
  }
  return results;
}
