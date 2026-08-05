import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sourceUrl = new URL('../../../src/local/core/onnx-embed.js', import.meta.url);

describe('BGE-M3 retrieval output selection', () => {
  it('requests only dense and sparse outputs from both inference paths', async () => {
    const source = await readFile(sourceUrl, 'utf-8');
    const selectiveRuns = source.match(/session\.run\(feeds, RETRIEVAL_OUTPUT_NAMES\)/g) ?? [];

    assert.equal(selectiveRuns.length, 2);
    assert.match(
      source,
      /RETRIEVAL_OUTPUT_NAMES\s*=\s*Object\.freeze\(\['dense_vecs', 'sparse_vecs'\]\)/,
    );
  });

  it('does not read or return the ColBERT tensor in dense+sparse APIs', async () => {
    const source = await readFile(sourceUrl, 'utf-8');

    assert.doesNotMatch(source, /outputs\s*\[\s*names\s*\[\s*2\s*\]\s*\]/);
    assert.doesNotMatch(source, /outputs\.colbert_vecs/);
  });
});
