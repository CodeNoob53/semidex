// src/local/core/onnx-embed.js — real BGE-M3 tokenizer integration proof.
// Proves the REAL tokenizer (loadRealTokenizer(), exported from
// onnx-embed.js) still produces correctly-shaped output when paired with
// a fake ONNX InferenceSession, after the instance-scoped capability
// refactor — never the real ~2.3GB model.onnx/model.onnx.data (only the
// tokenizer's own small tokenizer.json/tokenizer_config.json files).
//
// EXPLICITLY OUT OF `npm test`'s own glob (tests/unit/**/*.test.js) and
// gated behind an explicit opt-in env var — this test makes a real
// network request to HuggingFace whenever the tokenizer files are not
// already cached locally under ./models/, which a fresh CI checkout
// never has. Run it deliberately via:
//   npm run test:integration:onnx-tokenizer
// Skips itself (does not fail) when the opt-in var is unset, so it can
// never accidentally run as a side effect of a broader
// `tests/**/*.test.js` glob someone points at this directory later.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createOnnxEmbeddingCapability, loadRealTokenizer } from '../../src/local/core/onnx-embed.js';

const OPT_IN_VAR = 'SEMIDEX_RUN_ONNX_TOKENIZER_INTEGRATION';
const optedIn = process.env[OPT_IN_VAR] === '1';

function makeFakeSession({ denseFill = 0.1, sparseFill = 0.2 } = {}) {
  return {
    outputNames: ['dense_vecs', 'sparse_vecs'],
    async run(feeds) {
      const seqLen = feeds.input_ids.dims[1];
      const batchSize = feeds.input_ids.dims[0];
      return {
        dense_vecs: { data: new Float32Array(batchSize * 1024).fill(denseFill) },
        sparse_vecs: { data: new Float32Array(batchSize * seqLen).fill(sparseFill) },
      };
    },
    async release() {},
  };
}

function makeFakeOrt() {
  return {
    InferenceSession: { async create() { return makeFakeSession(); } },
    Tensor: class FakeTensor {
      constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
    },
  };
}

describe('createOnnxEmbeddingCapability() — real tokenizer, fake session (integration, opt-in)', { skip: !optedIn && `set ${OPT_IN_VAR}=1 to run — this test downloads the real BGE-M3 tokenizer files from HuggingFace if not already cached locally` }, () => {
  test('a real tokenizer encode + a fake session produces correctly dense/sparse-shaped output', async () => {
    const cap = createOnnxEmbeddingCapability({
      ortFactory: () => makeFakeOrt(),
      loadTokenizerAndModel: async () => ({ tokenizer: await loadRealTokenizer() }), // real tokenizer, fake session, NEVER the real model
    });
    const embed = await cap.loadOnnx();
    const result = await embed('hello world, this is a real tokenizer integration check');
    assert.equal(result.dense.length, 1024);
    assert.ok(result.sparse.indices.length > 0, 'the real tokenizer must produce real, non-empty token ids for the fake session to weight');
    await cap.shutdown();
  });
});
