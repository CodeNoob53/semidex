// Migrated from src/smoke/sections/23-length-bucket.js
import '../../helpers/setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUCKET_BOUNDARIES,
  estimateTokens,
  bucketIndex,
  bucketBatches,
  embedBucketed,
} from '../../../src/local/core/length-bucket.js';

describe('estimateTokens', () => {
  const cases = [
    ['', 0],
    ['ab', 1],
    ['abcd', 1],
    ['abcde', 2],
    ['a'.repeat(64), 16],
    ['a'.repeat(65), 17],
  ];
  for (const [text, expected] of cases) {
    it(`${JSON.stringify(text.slice(0, 8))}${text.length > 8 ? `…(${text.length})` : ''} → ${expected}`, () => {
      assert.equal(estimateTokens(text), expected);
    });
  }
});

describe('bucketIndex boundaries', () => {
  const cases = [
    [0, 0], [16, 0],       // <=16
    [17, 1], [32, 1],      // <=32
    [33, 2],               // <=64
    [128, 3],              // <=128
    [129, 4], [256, 4],    // <=256
    [257, 5],              // >256
  ];
  for (const [tokens, bucket] of cases) {
    it(`${tokens} tokens → bucket ${bucket}`, () => {
      assert.equal(bucketIndex(tokens), bucket);
    });
  }

  it('there are exactly 6 bucket boundaries', () => {
    assert.equal(BUCKET_BOUNDARIES.length, 6);
  });
});

describe('bucketBatches', () => {
  it('empty input → no batches', () => {
    assert.equal(bucketBatches([], 4).length, 0);
  });

  it('single item → one batch with index 0 and text preserved', () => {
    const batches = bucketBatches(['hello'], 4);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].indices, [0]);
    assert.equal(batches[0].texts[0], 'hello');
  });

  it('maxBatch splits within a bucket (5 items, maxBatch=2 → 2+2+1)', () => {
    const batches = bucketBatches(['a', 'b', 'c', 'd', 'e'], 2);
    assert.equal(batches.length, 3);
    assert.deepEqual(batches.map(b => b.indices.length), [2, 2, 1]);
  });

  it('covers every input index exactly once and restores order', () => {
    const short = 'x'.repeat(4);   // ~1 tok  → bucket 0
    const long = 'y'.repeat(600);  // ~150 tok → bucket 4
    const texts = [short, long, short, long, short];
    const batches = bucketBatches(texts, 8);

    const seen = batches.flatMap(b => b.indices).sort((a, b) => a - b);
    assert.deepEqual(seen, [0, 1, 2, 3, 4]);

    const results = new Array(texts.length);
    for (const batch of batches) {
      batch.texts.forEach((t, i) => { results[batch.indices[i]] = { len: t.length }; });
    }
    assert.equal(results[0].len, short.length);
    assert.equal(results[1].len, long.length);
    assert.equal(results[4].len, short.length);
  });
});

describe('embedBucketed', () => {
  it('preserves input order with an async stub', async () => {
    const texts = ['alpha', 'beta', 'gamma'];
    const stub = async (ts) => ts.map(t => ({ dense: [t.length], sparse: {} }));
    const results = await embedBucketed(texts, stub, 8);
    assert.equal(results.length, 3);
    assert.deepEqual(results.map(r => r.dense[0]), [5, 4, 5]);
  });

  it('empty input → empty array', async () => {
    const stub = async (ts) => ts.map(() => ({ dense: [], sparse: {} }));
    assert.deepEqual(await embedBucketed([], stub, 8), []);
  });
});
