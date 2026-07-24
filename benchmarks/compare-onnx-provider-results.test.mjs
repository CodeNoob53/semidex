import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareProviderOutputs,
  compareVectors,
} from './compare-onnx-provider-results.mjs';

test('compareVectors reports exact equality', () => {
  assert.deepEqual(compareVectors([1, 2], [1, 2]), {
    cosine: 1,
    maxAbsDelta: 0,
    meanAbsDelta: 0,
  });
});

test('compareVectors reports cosine and absolute error', () => {
  const result = compareVectors([1, 0], [0, 1]);
  assert.equal(result.cosine, 0);
  assert.equal(result.maxAbsDelta, 1);
  assert.equal(result.meanAbsDelta, 1);
});

test('compareVectors rejects mismatched lengths', () => {
  assert.throws(() => compareVectors([1], [1, 2]), /length mismatch/);
});

test('compareProviderOutputs summarizes dense and sparse outputs independently', () => {
  const left = {
    outputs: [
      { dense: [1, 0], sparse: [0, 2] },
      { dense: [0, 1], sparse: [3, 0] },
    ],
  };
  const right = {
    outputs: [
      { dense: [1, 0], sparse: [0, 2] },
      { dense: [0, 1], sparse: [3, 0] },
    ],
  };
  const result = compareProviderOutputs(left, right);
  assert.equal(result.textCount, 2);
  assert.equal(result.dense.minCosine, 1);
  assert.equal(result.sparse.maxAbsDelta, 0);
});
