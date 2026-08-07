// Parity tests proving core/bge-tokenizer.js (backed by
// @huggingface/tokenizers) produces byte-for-byte identical token IDs/
// counts to the previous @huggingface/transformers AutoTokenizer-based
// implementation core/token-count.js used before this task's process-
// isolation work (see that module's own header comment for why
// @huggingface/transformers must never load in a process that may also
// load the custom CUDA onnxruntime-node build).
//
// Fixture token IDs below were captured by running BOTH tokenizers side by
// side against the real cached aapot/bge-m3-onnx tokenizer files
// (models/aapot/bge-m3-onnx/tokenizer.json + tokenizer_config.json) and
// confirming exact agreement — see this task's implementation notes. These
// tests pin that already-verified agreement as a permanent regression
// guard using ONLY the new implementation (never re-imports
// @huggingface/transformers, which is exactly what this module exists to
// avoid loading).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadBgeTokenizer, bgeTokenCount } from '../../../src/shared/core/bge-tokenizer.js';
import { ONNX_CACHE_DIR, ONNX_DENSE_MODEL_ID } from '../../../src/shared/core/onnx-paths.js';

const TOKENIZER_DIR = join(ONNX_CACHE_DIR, ...ONNX_DENSE_MODEL_ID.split('/'));
const CACHE_AVAILABLE = existsSync(join(TOKENIZER_DIR, 'tokenizer.json'))
  && existsSync(join(TOKENIZER_DIR, 'tokenizer_config.json'));

// Each fixture's expectedIds/expectedCount were captured from the PRIOR
// AutoTokenizer(@huggingface/transformers)-based implementation, run
// against the same real cached tokenizer files this test also uses.
const FIXTURES = [
  {
    label: 'empty string',
    text: '',
    expectedCount: 2,
    expectedIds: [0, 2],
  },
  {
    label: 'single ASCII char',
    text: 'a',
    expectedCount: 3,
  },
  {
    label: 'short ASCII sentence',
    text: 'Hello world, this is a test sentence for tokenizer parity checking.',
    expectedCount: 18,
    expectedIds: [0, 35378, 8999, 4, 903, 83, 10, 3034, 149357, 100, 47, 1098, 52825, 366, 2481, 175199, 5, 2],
  },
  {
    label: 'Cyrillic (Ukrainian) sentence',
    text: 'Тестовий текст українською мовою для перевірки токенізації.',
    expectedCount: 13,
  },
  {
    label: 'long repeated ASCII (3000 chars)',
    text: 'A'.repeat(3000),
    expectedCount: 1502,
  },
  {
    label: 'multi-line text with tabs/newlines',
    text: 'Multi\nline\ntext\nwith\nnewlines\tand\ttabs',
    expectedCount: 11,
  },
];

describe('bge-tokenizer parity vs. the previous AutoTokenizer implementation', () => {
  it('local tokenizer cache is available for this parity check', (t) => {
    if (!CACHE_AVAILABLE) t.skip(`tokenizer cache not present at ${TOKENIZER_DIR}`);
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.label}: count matches the prior implementation exactly`, async (t) => {
      if (!CACHE_AVAILABLE) return t.skip('tokenizer cache absent');
      const tokenizer = await loadBgeTokenizer({ localFilesOnly: true });
      const count = bgeTokenCount(tokenizer, fixture.text);
      assert.equal(count, fixture.expectedCount, `token count mismatch for "${fixture.label}"`);
    });

    if (fixture.expectedIds) {
      it(`${fixture.label}: token IDs match the prior implementation exactly`, async (t) => {
        if (!CACHE_AVAILABLE) return t.skip('tokenizer cache absent');
        const tokenizer = await loadBgeTokenizer({ localFilesOnly: true });
        const encoding = tokenizer.encode(fixture.text, { return_token_type_ids: false });
        assert.deepEqual(Array.from(encoding.ids), fixture.expectedIds, `token IDs mismatch for "${fixture.label}"`);
      });
    }
  }

  it('BOS/EOS special tokens (0/2) are present exactly as the prior implementation counted them', async (t) => {
    if (!CACHE_AVAILABLE) return t.skip('tokenizer cache absent');
    const tokenizer = await loadBgeTokenizer({ localFilesOnly: true });
    const encoding = tokenizer.encode('hello', { return_token_type_ids: false });
    assert.equal(encoding.ids[0], 0, 'expected BOS token id 0 at the start');
    assert.equal(encoding.ids.at(-1), 2, 'expected EOS token id 2 at the end');
  });

  it('the tokenizer singleton is reused across repeated loadBgeTokenizer() calls (promise-guarded)', async (t) => {
    if (!CACHE_AVAILABLE) return t.skip('tokenizer cache absent');
    const a = await loadBgeTokenizer({ localFilesOnly: true });
    const b = await loadBgeTokenizer({ localFilesOnly: true });
    assert.strictEqual(a, b);
  });

  it('never imports @huggingface/transformers — no import/require statement referencing it anywhere in its module source (module-header PROSE may still name it, to explain what is deliberately avoided)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../../src/shared/core/bge-tokenizer.js', import.meta.url), 'utf-8');
    assert.doesNotMatch(src, /(?:import|require)\s*\(?[^)\n]*@huggingface\/transformers/);
  });
});
