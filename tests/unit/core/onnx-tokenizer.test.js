import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTokenizerBatch,
  truncateTokenizerEncoding,
} from '../../../src/local/core/onnx-embed.js';

test('truncateTokenizerEncoding preserves a terminal EOS token', () => {
  assert.deepEqual(
    truncateTokenizerEncoding({
      ids: [0, 10, 11, 12, 2],
      attention_mask: [1, 1, 1, 1, 1],
      token_type_ids: [0, 0, 0, 0, 0],
    }, 4),
    {
      ids: [0, 10, 11, 2],
      attentionMask: [1, 1, 1, 1],
      tokenTypeIds: [0, 0, 0, 0],
    },
  );
});

test('buildTokenizerBatch pads shorter encodings with the BGE-M3 pad token', () => {
  assert.deepEqual(
    buildTokenizerBatch([
      { ids: [0, 10, 2], attention_mask: [1, 1, 1], token_type_ids: [0, 0, 0] },
      { ids: [0, 20, 21, 2], attention_mask: [1, 1, 1, 1], token_type_ids: [0, 0, 0, 0] },
    ]),
    {
      dims: [2, 4],
      inputIds: [0, 10, 2, 1, 0, 20, 21, 2],
      attentionMask: [1, 1, 1, 0, 1, 1, 1, 1],
      tokenTypeIds: [0, 0, 0, 0, 0, 0, 0, 0],
    },
  );
});

