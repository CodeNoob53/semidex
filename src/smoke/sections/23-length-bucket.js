export default async function ({ ok }) {
  console.log('\n[23] length-bucket — pure helpers');

  const { BUCKET_BOUNDARIES, estimateTokens, bucketIndex, bucketBatches, embedBucketed }
    = await import('../../core/length-bucket.js');

  // 23a. estimateTokens
  ok('estimateTokens("")   = 0',  estimateTokens('') === 0);
  ok('estimateTokens("ab") = 1',  estimateTokens('ab') === 1);
  ok('estimateTokens("abcd") = 1', estimateTokens('abcd') === 1);
  ok('estimateTokens("abcde") = 2', estimateTokens('abcde') === 2);
  ok('estimateTokens(64 chars) = 16', estimateTokens('a'.repeat(64)) === 16);
  ok('estimateTokens(65 chars) = 17', estimateTokens('a'.repeat(65)) === 17);

  // 23b. bucketIndex boundaries
  ok('bucketIndex(0)   → bucket 0 (<=16)',   bucketIndex(0)   === 0);
  ok('bucketIndex(16)  → bucket 0 (<=16)',   bucketIndex(16)  === 0);
  ok('bucketIndex(17)  → bucket 1 (<=32)',   bucketIndex(17)  === 1);
  ok('bucketIndex(32)  → bucket 1 (<=32)',   bucketIndex(32)  === 1);
  ok('bucketIndex(33)  → bucket 2 (<=64)',   bucketIndex(33)  === 2);
  ok('bucketIndex(128) → bucket 3 (<=128)',  bucketIndex(128) === 3);
  ok('bucketIndex(129) → bucket 4 (<=256)',  bucketIndex(129) === 4);
  ok('bucketIndex(256) → bucket 4 (<=256)',  bucketIndex(256) === 4);
  ok('bucketIndex(257) → bucket 5 (>256)',   bucketIndex(257) === 5);
  ok('bucketIndex boundaries count', BUCKET_BOUNDARIES.length === 6);

  // 23c. bucketBatches — empty input
  {
    const batches = bucketBatches([], 4);
    ok('empty input → no batches', batches.length === 0);
  }

  // 23d. bucketBatches — single item
  {
    const batches = bucketBatches(['hello'], 4);
    ok('single item → one batch', batches.length === 1);
    ok('single item → one index', batches[0].indices.length === 1);
    ok('single item → index is 0', batches[0].indices[0] === 0);
    ok('single item → text preserved', batches[0].texts[0] === 'hello');
  }

  // 23e. bucketBatches — maxBatch splitting within a bucket
  {
    // 5 short texts (all <=16 tok bucket), maxBatch=2 → 3 batches
    const texts = ['a', 'b', 'c', 'd', 'e'];
    const batches = bucketBatches(texts, 2);
    ok('5 items maxBatch=2 → 3 batches', batches.length === 3);
    ok('batch sizes 2+2+1', batches[0].indices.length === 2 && batches[1].indices.length === 2 && batches[2].indices.length === 1);
  }

  // 23f. bucketBatches — output order restoration
  {
    // Mix of short (<=16 tok) and long (>128 tok) texts at alternating positions.
    const short = 'x'.repeat(4);                  // ~1 tok
    const long  = 'y'.repeat(600);                // ~150 tok → bucket 4
    const texts = [short, long, short, long, short];
    const batches = bucketBatches(texts, 8);

    // Collect indices across all batches — must cover 0..4 exactly once.
    const seen = batches.flatMap(b => b.indices).sort((a, b) => a - b);
    ok('all 5 indices covered', seen.length === 5 && seen.every((v, i) => v === i));

    // Simulate results and verify order restoration.
    const results = new Array(texts.length);
    for (const batch of batches) {
      const fakeResults = batch.texts.map(t => ({ len: t.length }));
      for (let i = 0; i < batch.indices.length; i++) results[batch.indices[i]] = fakeResults[i];
    }
    ok('order restoration: pos 0 is short', results[0].len === short.length);
    ok('order restoration: pos 1 is long',  results[1].len === long.length);
    ok('order restoration: pos 4 is short', results[4].len === short.length);
  }

  // 23g. embedBucketed — order preservation with sync stub
  {
    const texts = ['alpha', 'beta', 'gamma'];
    const stub = async (ts) => ts.map(t => ({ dense: [t.length], sparse: {} }));
    const results = await embedBucketed(texts, stub, 8);
    ok('embedBucketed returns correct length', results.length === 3);
    ok('embedBucketed order: pos 0', results[0].dense[0] === 'alpha'.length);
    ok('embedBucketed order: pos 1', results[1].dense[0] === 'beta'.length);
    ok('embedBucketed order: pos 2', results[2].dense[0] === 'gamma'.length);
  }

  // 23h. embedBucketed — empty input
  {
    const stub = async (ts) => ts.map(() => ({ dense: [], sparse: {} }));
    const results = await embedBucketed([], stub, 8);
    ok('embedBucketed empty → []', Array.isArray(results) && results.length === 0);
  }
}
