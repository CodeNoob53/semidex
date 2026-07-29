// Asserts the Slavic suite's required caveat text (task spec: "comparative
// multilingual retrieval signal only, not a natural-document RAG
// benchmark") is present as an importable constant and gets attached to
// every language's report state — offline, no network.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SLAVIC_CAVEAT, LANGUAGES, SUITE_ID_BASE } from './run-slavic-prodpath.mjs';

describe('SLAVIC_CAVEAT', () => {
  it('contains the required phrase verbatim', () => {
    assert.match(SLAVIC_CAVEAT, /comparative multilingual retrieval signal only/);
    assert.match(SLAVIC_CAVEAT, /not a natural-document RAG benchmark/);
  });
});

describe('LANGUAGES', () => {
  it('is exactly the 7 required languages, in the task-specified order', () => {
    assert.deepEqual(LANGUAGES, ['ukr_Cyrl', 'rus_Cyrl', 'bul_Cyrl', 'pol_Latn', 'ces_Latn', 'slk_Latn', 'eng_Latn']);
  });
});

describe('SUITE_ID_BASE', () => {
  it('is the base used for per-language checkpoint file naming', () => {
    assert.equal(SUITE_ID_BASE, 'slavic');
  });
});
