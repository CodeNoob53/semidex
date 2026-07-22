import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  seededShuffle,
  selectQueryIds,
  selectSubsetDocIds,
  assembleSubset,
  validateSubset,
  subsetCachePath,
  SELECTION_SHUFFLE_SEED,
  SUBSET_QUERY_COUNT,
} from './build-miracl-subset.mjs';

describe('seededShuffle / selectQueryIds — deterministic, order-independent selection', () => {
  test('same seed + same array always reproduces the same order', () => {
    const items = ['0', '2', '3', '5', '9'];
    const a = seededShuffle(items, 'seed-a');
    const b = seededShuffle(items, 'seed-a');
    assert.deepEqual(a, b);
  });

  test('selectQueryIds does not depend on the caller-supplied input array order', () => {
    const ids = Array.from({ length: 1252 }, (_, i) => String(i));
    const forward = selectQueryIds(ids, 100);
    const reversed = selectQueryIds([...ids].reverse(), 100);
    const shuffledInput = selectQueryIds(seededShuffle(ids, 'unrelated-seed'), 100);
    assert.deepEqual(forward, reversed);
    assert.deepEqual(forward, shuffledInput);
  });

  test('is a real shuffle, not a lexicographic-order slice', () => {
    const ids = Array.from({ length: 1252 }, (_, i) => String(i));
    const selected = new Set(selectQueryIds(ids, 100));
    const lexFirst100 = new Set([...ids].sort().slice(0, 100));
    assert.notDeepEqual([...selected].sort(), [...lexFirst100].sort());
  });

  test('the default MIRACL seed selects exactly SUBSET_QUERY_COUNT distinct IDs from a 1252-ID pool', () => {
    const ids = Array.from({ length: 1252 }, (_, i) => String(i));
    const selected = selectQueryIds(ids, SUBSET_QUERY_COUNT, SELECTION_SHUFFLE_SEED);
    assert.equal(selected.length, SUBSET_QUERY_COUNT);
    assert.equal(new Set(selected).size, SUBSET_QUERY_COUNT);
  });
});

function makeFixtureDataset({ queryCount = 4, negativesPerQuery = 5 } = {}) {
  const queries = new Map();
  const qrels = new Map();
  for (let i = 0; i < queryCount; i++) {
    const qid = `q${i}`;
    queries.set(qid, `query text ${i}`);
    const docsMap = new Map();
    docsMap.set(`pos-${qid}`, 1); // exactly one positive per query, distinct docids
    for (let n = 0; n < negativesPerQuery; n++) docsMap.set(`neg-${qid}-${n}`, 0);
    qrels.set(qid, docsMap);
  }
  return { queries, qrels };
}

describe('selectSubsetDocIds: no missing positives, round-robin negatives', () => {
  test('every positive passage for a selected query is included, regardless of corpus size target', () => {
    const { queries, qrels } = makeFixtureDataset({ queryCount: 4, negativesPerQuery: 5 });
    const selection = selectSubsetDocIds({ queries, qrels, queryCount: 4, corpusSize: 8 });
    for (let i = 0; i < 4; i++) assert.ok(selection.subsetDocIds.includes(`pos-q${i}`));
    assert.equal(selection.stats.positiveDocCount, 4);
  });

  test('exact corpus-size enforcement: stats.totalCorpusSize equals the requested corpusSize when the pool suffices', () => {
    const { queries, qrels } = makeFixtureDataset({ queryCount: 4, negativesPerQuery: 5 });
    const selection = selectSubsetDocIds({ queries, qrels, queryCount: 4, corpusSize: 10 });
    assert.equal(selection.stats.totalCorpusSize, 10);
    assert.equal(selection.stats.shortfall, 0);
    assert.equal(selection.subsetDocIds.length, 10);
  });

  test('reports a positive shortfall (not silent truncation) when the annotated-negative pool is exhausted', () => {
    const { queries, qrels } = makeFixtureDataset({ queryCount: 2, negativesPerQuery: 1 });
    // 2 positives + 2 negatives = 4 max possible, requesting 100.
    const selection = selectSubsetDocIds({ queries, qrels, queryCount: 2, corpusSize: 100 });
    assert.equal(selection.stats.totalCorpusSize, 4);
    assert.equal(selection.stats.shortfall, 96);
  });

  test('round-robin distributes negatives across queries rather than draining one query first', () => {
    const { queries, qrels } = makeFixtureDataset({ queryCount: 3, negativesPerQuery: 10 });
    // Request just enough to pull 2 negatives per query (3 positives + 6 negatives = 9).
    const selection = selectSubsetDocIds({ queries, qrels, queryCount: 3, corpusSize: 9 });
    const negByQuery = { q0: 0, q1: 0, q2: 0 };
    for (const docId of selection.subsetDocIds) {
      const m = docId.match(/^neg-(q\d)-/);
      if (m) negByQuery[m[1]] += 1;
    }
    // Round-robin (one per query per round) means each query contributes
    // the SAME count here, not one query fully drained (10) while others
    // get 0 — that would indicate a per-query-exhaustive (not round-robin)
    // selection order.
    assert.deepEqual(negByQuery, { q0: 2, q1: 2, q2: 2 });
  });

  test('terminates without hanging once every query\'s negative list is exhausted', () => {
    const { queries, qrels } = makeFixtureDataset({ queryCount: 2, negativesPerQuery: 0 });
    const selection = selectSubsetDocIds({ queries, qrels, queryCount: 2, corpusSize: 1000 });
    assert.equal(selection.stats.totalCorpusSize, 2); // only the 2 positives
    assert.equal(selection.stats.shortfall, 998);
  });
});

describe('assembleSubset: no dangling qrels, missing-text detection', () => {
  test('every qrels row in the assembled subset references a passage present in the subset corpus', () => {
    const { queries, qrels } = makeFixtureDataset({ queryCount: 3, negativesPerQuery: 3 });
    const selection = selectSubsetDocIds({ queries, qrels, queryCount: 3, corpusSize: 6 });
    const corpusPassages = new Map(selection.subsetDocIds.map((id) => [id, { title: '', text: `text for ${id}` }]));
    const subset = assembleSubset({ selection, corpusPassages });
    assert.equal(subset.stats.danglingQrelsRefs.length, 0);
    for (const [, docsMap] of subset.qrels) {
      for (const docId of docsMap.keys()) assert.ok(subset.corpus.has(docId));
    }
  });

  test('detects passages selected but never fetched (missing text) instead of silently shrinking the corpus', () => {
    const { queries, qrels } = makeFixtureDataset({ queryCount: 2, negativesPerQuery: 2 });
    const selection = selectSubsetDocIds({ queries, qrels, queryCount: 2, corpusSize: 4 });
    const corpusPassages = new Map(); // nothing fetched at all
    const subset = assembleSubset({ selection, corpusPassages });
    assert.equal(subset.corpus.size, 0);
    assert.equal(subset.stats.missingPassageTextCount, 4);
  });
});

describe('validateSubset: cache/artifact integrity', () => {
  function validSubset({ queryCount = 2, corpusSize = 4 } = {}) {
    const { queries, qrels } = makeFixtureDataset({ queryCount, negativesPerQuery: corpusSize });
    const selection = selectSubsetDocIds({ queries, qrels, queryCount, corpusSize });
    const corpusPassages = new Map(selection.subsetDocIds.map((id) => [id, { title: '', text: 'x' }]));
    return assembleSubset({ selection, corpusPassages });
  }

  test('a correctly built subset passes validation with zero errors', () => {
    const subset = validSubset({ queryCount: 2, corpusSize: 4 });
    const errors = validateSubset(subset, { queryCount: 2, corpusSize: 4 });
    assert.deepEqual(errors, []);
  });

  test('flags a corpus size mismatch', () => {
    const subset = validSubset({ queryCount: 2, corpusSize: 4 });
    const errors = validateSubset(subset, { queryCount: 2, corpusSize: 999 });
    assert.ok(errors.some((e) => e.includes('corpus size')));
  });

  test('flags a query count mismatch', () => {
    const subset = validSubset({ queryCount: 2, corpusSize: 4 });
    const errors = validateSubset(subset, { queryCount: 999, corpusSize: 4 });
    assert.ok(errors.some((e) => e.includes('query count')));
  });

  test('flags a nonzero shortfall recorded in stats', () => {
    const subset = validSubset({ queryCount: 2, corpusSize: 4 });
    subset.stats.shortfall = 3;
    const errors = validateSubset(subset, { queryCount: 2, corpusSize: 4 });
    assert.ok(errors.some((e) => e.includes('shortfall')));
  });

  test('flags a corrupted/incomplete cached artifact (missing Map fields)', () => {
    const errors = validateSubset({ corpus: null, queries: new Map(), qrels: new Map(), stats: {} }, { queryCount: 2, corpusSize: 4 });
    assert.ok(errors.some((e) => e.includes('corpus is not a Map')));
  });

  test('flags a query with qrels entirely missing from the subset (P2 regression test)', () => {
    const subset = validSubset({ queryCount: 2, corpusSize: 4 });
    const [firstQid] = [...subset.queries.keys()];
    subset.qrels.delete(firstQid);
    const errors = validateSubset(subset, { queryCount: 2, corpusSize: 4 });
    assert.ok(errors.some((e) => e.includes('qrels cover')));
    assert.ok(errors.some((e) => e.includes(firstQid) && e.includes('no qrels at all')));
  });

  test('flags a query whose qrels contain only relevance=0 rows (no positive passage) (P2 regression test)', () => {
    const subset = validSubset({ queryCount: 2, corpusSize: 4 });
    const [firstQid] = [...subset.queries.keys()];
    const docsMap = subset.qrels.get(firstQid);
    for (const docId of docsMap.keys()) docsMap.set(docId, 0); // demote every judgment to non-relevant
    const errors = validateSubset(subset, { queryCount: 2, corpusSize: 4 });
    assert.ok(errors.some((e) => e.includes(firstQid) && e.includes('no positive')));
  });

  test('a query with an empty qrels Map (present but zero entries) is flagged, not silently accepted', () => {
    const subset = validSubset({ queryCount: 2, corpusSize: 4 });
    const [firstQid] = [...subset.queries.keys()];
    subset.qrels.set(firstQid, new Map());
    const errors = validateSubset(subset, { queryCount: 2, corpusSize: 4 });
    assert.ok(errors.some((e) => e.includes(firstQid) && e.includes('no qrels at all')));
  });
});

describe('subsetCachePath: content/revision-addressed, not path-addressed', () => {
  test('changing the topics/qrels revision produces a different cache path (cache invalidates on dataset revision change)', () => {
    const base = { corpusRevision: 'c1', queryCount: 100, corpusSize: 1000, selectionSeed: SELECTION_SHUFFLE_SEED };
    const pathA = subsetCachePath({ ...base, topicsQrelsRevision: 'rev-a' });
    const pathB = subsetCachePath({ ...base, topicsQrelsRevision: 'rev-b' });
    assert.notEqual(pathA, pathB);
  });

  test('changing the corpus revision produces a different cache path', () => {
    const base = { topicsQrelsRevision: 't1', queryCount: 100, corpusSize: 1000, selectionSeed: SELECTION_SHUFFLE_SEED };
    const pathA = subsetCachePath({ ...base, corpusRevision: 'rev-a' });
    const pathB = subsetCachePath({ ...base, corpusRevision: 'rev-b' });
    assert.notEqual(pathA, pathB);
  });

  test('changing the selection seed produces a different cache path', () => {
    const base = { topicsQrelsRevision: 't1', corpusRevision: 'c1', queryCount: 100, corpusSize: 1000 };
    const pathA = subsetCachePath({ ...base, selectionSeed: 'seed-a' });
    const pathB = subsetCachePath({ ...base, selectionSeed: 'seed-b' });
    assert.notEqual(pathA, pathB);
  });

  test('identical inputs produce an identical cache path', () => {
    const args = { topicsQrelsRevision: 't1', corpusRevision: 'c1', queryCount: 100, corpusSize: 1000, selectionSeed: SELECTION_SHUFFLE_SEED };
    assert.equal(subsetCachePath(args), subsetCachePath({ ...args }));
  });
});
