import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMiniSet,
  miniSetCachePath,
  parseTrecRun,
  seededShuffle,
  selectQueryIds,
  validateMiniSet,
  SELECTION_SHUFFLE_SEED,
} from './build-rrf-mini-set.mjs';

describe('seededShuffle / selectQueryIds', () => {
  test('seededShuffle is a pure function of (items order, seed): same array + same seed always reproduces', () => {
    const items = ['q1', 'q2', 'q3', 'q4', 'q5'];
    const a = seededShuffle(items, 'seed-a');
    const b = seededShuffle(items, 'seed-a');
    assert.deepEqual(a, b);
  });

  test('different seeds produce different orders (sanity — not a proof of randomness quality)', () => {
    const items = Array.from({ length: 50 }, (_, i) => `q${i}`);
    const a = seededShuffle(items, 'seed-a');
    const b = seededShuffle(items, 'seed-b');
    assert.notDeepEqual(a, b);
  });

  test('shuffle is a permutation: same multiset of items, no duplicates, no drops', () => {
    const items = Array.from({ length: 300 }, (_, i) => `q${i}`);
    const shuffled = seededShuffle(items, SELECTION_SHUFFLE_SEED);
    assert.equal(shuffled.length, items.length);
    assert.deepEqual([...shuffled].sort(), [...items].sort());
  });

  test('selectQueryIds does not depend on the caller-supplied array order', () => {
    const ids = Array.from({ length: 300 }, (_, i) => String(i).padStart(3, '0'));
    const sortedOrder = selectQueryIds(ids, 100);
    const reversedInput = [...ids].reverse();
    const fromReversed = selectQueryIds(reversedInput, 100);
    assert.deepEqual(sortedOrder, fromReversed);
  });

  test('selectQueryIds(..., 100) does not degenerate to a lexicographic-sort-order slice', () => {
    // The original bug: allQueryIds.slice(0, 100) on Map insertion order
    // (which tracks qrels/test.tsv row order, i.e. query-ID sort order)
    // always returns the lexicographically-first 100 IDs. A correct fix
    // must NOT reproduce that same set.
    const ids = Array.from({ length: 300 }, (_, i) => String(i).padStart(3, '0'));
    const selected = new Set(selectQueryIds(ids, 100));
    const lexFirst100 = new Set([...ids].sort().slice(0, 100));
    assert.notDeepEqual([...selected].sort(), [...lexFirst100].sort());
  });
});

function makeFixtureDataset() {
  // 6 queries, each judged relevant for exactly one document, so the
  // relevant-document union size is easy to reason about (<=6, exactly 6
  // here since all docIds are distinct).
  const corpus = new Map([
    ['docR1', { title: 'r1', text: 'relevant one' }],
    ['docR2', { title: 'r2', text: 'relevant two' }],
    ['docR3', { title: 'r3', text: 'relevant three' }],
    ['docN1', { title: 'n1', text: 'negative one' }],
    ['docN2', { title: 'n2', text: 'negative two' }],
    ['docN3', { title: 'n3', text: 'negative three' }],
    ['docN4', { title: 'n4', text: 'negative four' }],
  ]);
  const queries = new Map([
    ['q1', 'query one'],
    ['q2', 'query two'],
    ['q3', 'query three'],
  ]);
  const qrels = new Map([
    ['q1', new Map([['docR1', 1]])],
    ['q2', new Map([['docR2', 1]])],
    ['q3', new Map([['docR3', 1]])],
  ]);
  return { corpus, queries, qrels };
}

describe('buildMiniSet: no qrels leakage', () => {
  test('every mini-set qrels row references a document present in the mini corpus', () => {
    const { corpus, queries, qrels } = makeFixtureDataset();
    const trecRunsByFile = [
      new Map([
        ['q1', [{ docId: 'docN1', rank: 1 }, { docId: 'docN2', rank: 2 }]],
        ['q2', [{ docId: 'docN3', rank: 1 }]],
        ['q3', [{ docId: 'docN4', rank: 1 }]],
      ]),
    ];
    const result = buildMiniSet({ corpus, queries, qrels, trecRunsByFile, queryCount: 3, corpusSize: 5 });
    assert.equal(result.stats.danglingQrelsRefs.length, 0);
    for (const [, docsMap] of result.qrels) {
      for (const docId of docsMap.keys()) assert.ok(result.corpus.has(docId), `${docId} missing from mini corpus`);
    }
  });

  test('relevant documents are included even if the hard-negative TREC pool never mentions them', () => {
    const { corpus, queries, qrels } = makeFixtureDataset();
    const trecRunsByFile = [new Map()]; // empty pool — no negatives available at all
    const result = buildMiniSet({ corpus, queries, qrels, trecRunsByFile, queryCount: 3, corpusSize: 3 });
    assert.equal(result.stats.relevantDocCount, 3);
    assert.ok(result.corpus.has('docR1'));
    assert.ok(result.corpus.has('docR2'));
    assert.ok(result.corpus.has('docR3'));
    assert.equal(result.stats.danglingQrelsRefs.length, 0);
  });
});

describe('buildMiniSet: exhaustion / shortfall', () => {
  test('padding continues past a round with only duplicate candidates when unique candidates remain deeper', () => {
    const { corpus, queries, qrels } = makeFixtureDataset();
    // q1's file-0 list immediately repeats a doc already added as relevant
    // (docR1) for its first 3 entries before offering a real unique
    // negative at position 4. If termination were keyed on "did this ROUND
    // add a doc" instead of "did any cursor advance", a naive
    // implementation could still work here since q2/q3 supply negatives
    // the same round — so this test targets the more precise regression:
    // every query's list is duplicate-only for several rounds while ONE
    // query's list holds a unique candidate far down its list.
    const trecRunsByFile = [
      new Map([
        ['q1', [
          { docId: 'docR1', rank: 1 }, { docId: 'docR1', rank: 2 }, { docId: 'docR1', rank: 3 },
          { docId: 'docR1', rank: 4 }, { docId: 'docN1', rank: 5 },
        ]],
        ['q2', [{ docId: 'docR2', rank: 1 }, { docId: 'docR2', rank: 2 }, { docId: 'docR2', rank: 3 }]],
        ['q3', [{ docId: 'docR3', rank: 1 }, { docId: 'docR3', rank: 2 }, { docId: 'docR3', rank: 3 }]],
      ]),
    ];
    const result = buildMiniSet({ corpus, queries, qrels, trecRunsByFile, queryCount: 3, corpusSize: 4 });
    assert.ok(result.corpus.has('docN1'), 'docN1 should have been reached after several duplicate-only rounds on q1');
    assert.equal(result.stats.totalCorpusSize, 4);
    assert.equal(result.stats.shortfall, 0);
  });

  test('reports a positive shortfall (not silently truncated) when the pool is exhausted before reaching corpusSize', () => {
    const { corpus, queries, qrels } = makeFixtureDataset();
    const trecRunsByFile = [new Map([['q1', [{ docId: 'docN1', rank: 1 }]]])]; // only 1 negative available total
    const result = buildMiniSet({ corpus, queries, qrels, trecRunsByFile, queryCount: 3, corpusSize: 100 });
    // 3 relevant + 1 negative = 4, far short of the requested 100.
    assert.equal(result.stats.totalCorpusSize, 4);
    assert.equal(result.stats.shortfall, 96);
  });

  test('terminates (does not hang) once every cursor is exhausted', () => {
    const { corpus, queries, qrels } = makeFixtureDataset();
    const trecRunsByFile = [new Map()]; // no negatives at all
    const result = buildMiniSet({ corpus, queries, qrels, trecRunsByFile, queryCount: 3, corpusSize: 1000 });
    assert.equal(result.stats.totalCorpusSize, 3); // only the 3 relevant docs
    assert.equal(result.stats.shortfall, 997);
  });
});

describe('miniSetCachePath: content-addressed, not path-addressed', () => {
  test('same TREC file path with DIFFERENT content hashes produces a different cache path', () => {
    const base = { datasetMd5: 'x', queryCount: 100, corpusSize: 1000, selectionSeed: SELECTION_SHUFFLE_SEED };
    const pathA = miniSetCachePath({ ...base, sourceHashes: [{ path: 'a.trec', sha256: 'hash-1' }] });
    const pathB = miniSetCachePath({ ...base, sourceHashes: [{ path: 'a.trec', sha256: 'hash-2' }] });
    assert.notEqual(pathA, pathB);
  });

  test('changing the selection seed produces a different cache path (selection params are part of the key)', () => {
    const base = { datasetMd5: 'x', queryCount: 100, corpusSize: 1000, sourceHashes: [{ path: 'a.trec', sha256: 'hash-1' }] };
    const pathA = miniSetCachePath({ ...base, selectionSeed: 'seed-a' });
    const pathB = miniSetCachePath({ ...base, selectionSeed: 'seed-b' });
    assert.notEqual(pathA, pathB);
  });

  test('identical inputs produce the identical cache path (stable, reusable cache)', () => {
    const args = { datasetMd5: 'x', queryCount: 100, corpusSize: 1000, selectionSeed: SELECTION_SHUFFLE_SEED, sourceHashes: [{ path: 'a.trec', sha256: 'hash-1' }] };
    assert.equal(miniSetCachePath(args), miniSetCachePath({ ...args }));
  });
});

describe('validateMiniSet: cached artifact integrity', () => {
  function validMiniSet() {
    return {
      corpus: new Map([['doc1', { title: 'one', text: 'body' }]]),
      queries: new Map([['q1', 'query']]),
      qrels: new Map([['q1', new Map([['doc1', 1]])]]),
      stats: {
        selectedQueryCount: 1,
        relevantDocCount: 1,
        negativeDocCount: 0,
        totalCorpusSize: 1,
        requestedCorpusSize: 1,
        shortfall: 0,
        danglingQrelsRefs: [],
      },
    };
  }

  test('accepts a complete mini-set whose computed structure matches its stats', () => {
    assert.deepEqual(validateMiniSet(validMiniSet(), { queryCount: 1, corpusSize: 1 }), []);
  });

  test('rejects a truncated cached corpus even when its stored manifest would still match', () => {
    const miniSet = validMiniSet();
    miniSet.corpus.clear();
    const errors = validateMiniSet(miniSet, { queryCount: 1, corpusSize: 1 });
    assert.ok(errors.some((message) => message.includes('corpus size is 0')));
    assert.ok(errors.some((message) => message.includes('qrels rows reference documents absent')));
  });

  test('rejects stale stats and a non-zero shortfall', () => {
    const miniSet = validMiniSet();
    miniSet.stats.selectedQueryCount = 100;
    miniSet.stats.totalCorpusSize = 1000;
    miniSet.stats.requestedCorpusSize = 1000;
    miniSet.stats.shortfall = 999;
    const errors = validateMiniSet(miniSet, { queryCount: 1, corpusSize: 1 });
    assert.ok(errors.some((message) => message.includes('stats.selectedQueryCount')));
    assert.ok(errors.some((message) => message.includes('stats.totalCorpusSize')));
    assert.ok(errors.some((message) => message.includes('stats.requestedCorpusSize')));
    assert.ok(errors.some((message) => message.includes('corpus shortfall is 999')));
  });
});

describe('parseTrecRun', () => {
  test('parses standard TREC rows and sorts each query by rank ascending', () => {
    const text = [
      '1\tQ0\tdocB\t2\t0.5\trun-tag',
      '1\tQ0\tdocA\t1\t0.9\trun-tag',
      '2\tQ0\tdocC\t1\t0.7\trun-tag',
    ].join('\n');
    const parsed = parseTrecRun(text);
    assert.deepEqual(parsed.get('1').map((r) => r.docId), ['docA', 'docB']);
    assert.deepEqual(parsed.get('2').map((r) => r.docId), ['docC']);
  });

  test('ignores blank lines and malformed rows', () => {
    const text = '1\tQ0\tdocA\t1\t0.9\trun-tag\n\nmalformed line\n';
    const parsed = parseTrecRun(text);
    assert.equal(parsed.get('1').length, 1);
  });
});
