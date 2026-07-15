import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rerankResults } from '../../../src/core/rerank.js';

function fakeResult(sourceFile, text, chunkIndex = 1) {
  return { score: 0.5, payload: { source_file: sourceFile, section: '', text, chunk_index: chunkIndex } };
}

function fakeSettingsService(overrides) {
  return { getActiveValue: (key) => overrides[key] };
}

describe('rerankResults — settingsService extraction (consumed, not copied)', () => {
  test('without a settingsService, behavior is unchanged from the module-level env defaults', () => {
    const results = [fakeResult('a.md', 'no matching tokens here'), fakeResult('b.md', 'database sql normalization')];
    const out = rerankResults(results, 'database', {});
    assert.equal(out.length, 2);
  });

  test('a settingsService-supplied RERANK_BOOST_SOURCE_FILE actually changes ranking output', () => {
    const results = [
      fakeResult('unrelated.md', 'nothing relevant', 0),
      fakeResult('database-guide.md', 'nothing relevant either', 1),
    ];
    // With boost=0, source-file token matches contribute nothing extra —
    // rank stays purely on RRF position (original order).
    const zeroBoost = fakeSettingsService({
      RERANK_BOOST_SOURCE_FILE: 0, RERANK_BOOST_SECTION: 0, RERANK_BOOST_TAGS: 0, RERANK_BOOST_TEXT: 0,
      RERANK_BASE_WEIGHT: 1, RERANK_PROTECT_TOP1_DELTA: 0, RERANK_BOOST_TEXT_LEAD: 0, RERANK_TEXT_LEAD_CHARS: 200,
      RERANK_PENALTY_INTRO_CHUNK: 0, RERANK_INTRO_CHUNK_TECH_MIN: 2,
    });
    const outZero = rerankResults(results, 'database', {}, { settingsService: zeroBoost });
    assert.equal(outZero[0].payload.source_file, 'unrelated.md', 'with zero boost, original RRF order wins (unrelated.md was rank 0)');

    // With a large source-file boost, "database-guide.md" (matches the query
    // token "database" in its filename) must overtake "unrelated.md".
    const bigBoost = fakeSettingsService({
      RERANK_BOOST_SOURCE_FILE: 5, RERANK_BOOST_SECTION: 0, RERANK_BOOST_TAGS: 0, RERANK_BOOST_TEXT: 0,
      RERANK_BASE_WEIGHT: 1, RERANK_PROTECT_TOP1_DELTA: 0, RERANK_BOOST_TEXT_LEAD: 0, RERANK_TEXT_LEAD_CHARS: 200,
      RERANK_PENALTY_INTRO_CHUNK: 0, RERANK_INTRO_CHUNK_TECH_MIN: 2,
    });
    const outBig = rerankResults(results, 'database', {}, { settingsService: bigBoost });
    assert.equal(outBig[0].payload.source_file, 'database-guide.md', 'a large settingsService-supplied boost must actually change the winner');
  });

  test('a settingsService-supplied PROTECT_TOP1_DELTA of 0 allows displacing the original RRF rank-0 result', () => {
    const results = [
      fakeResult('weak-match.md', 'irrelevant text', 0),
      fakeResult('database.md', 'database database database', 1),
    ];
    const svc = fakeSettingsService({
      RERANK_BOOST_SOURCE_FILE: 0, RERANK_BOOST_SECTION: 0, RERANK_BOOST_TAGS: 0, RERANK_BOOST_TEXT: 1,
      RERANK_BASE_WEIGHT: 0.01, RERANK_PROTECT_TOP1_DELTA: 0, RERANK_BOOST_TEXT_LEAD: 0, RERANK_TEXT_LEAD_CHARS: 200,
      RERANK_PENALTY_INTRO_CHUNK: 0, RERANK_INTRO_CHUNK_TECH_MIN: 2,
    });
    const out = rerankResults(results, 'database', {}, { settingsService: svc });
    assert.equal(out[0].payload.source_file, 'database.md');
  });
});
