// core/pilot-subset.mjs — offline, no network. Uses a small SYNTHETIC
// SciFact-shaped dataset (never the real fetched corpus) sized just large
// enough to satisfy PILOT_QUERY_COUNT/PILOT_CORPUS_SIZE, so these tests
// run fast and never touch the network/dataset cache.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScifactPilotSubset, validatePilotSubset, pilotFingerprint,
  buildAndCachePilotSubset, loadCachedPilotSubset,
  PILOT_QUERY_COUNT, PILOT_CORPUS_SIZE,
} from './core/pilot-subset.mjs';

function buildSyntheticDataset({ queryCount = 40, corpusSize = 400 } = {}) {
  const corpus = new Map();
  for (let i = 0; i < corpusSize; i++) {
    corpus.set(`doc-${i}`, { title: `Title ${i}`, text: `Body text for document ${i}.` });
  }
  const queries = new Map();
  const qrels = new Map();
  for (let i = 0; i < queryCount; i++) {
    queries.set(`q-${i}`, `Query text ${i}?`);
    // Each query has exactly one positive doc — realistic SciFact shape
    // (binary, positive-only qrels, mostly one relevant doc per query).
    const qr = new Map();
    qr.set(`doc-${i}`, 1);
    qrels.set(`q-${i}`, qr);
  }
  return { corpus, queries, qrels };
}

describe('buildScifactPilotSubset()', () => {
  it('selects exactly PILOT_QUERY_COUNT queries and pads to exactly PILOT_CORPUS_SIZE docs', () => {
    const dataset = buildSyntheticDataset({ queryCount: 100, corpusSize: 1000 });
    const subset = buildScifactPilotSubset(dataset);
    assert.equal(subset.queries.size, PILOT_QUERY_COUNT);
    assert.equal(subset.corpus.size, PILOT_CORPUS_SIZE);
  });

  it('is fully deterministic — same input always produces the exact same subset (byte-identical query/doc ID sets)', () => {
    const dataset = buildSyntheticDataset({ queryCount: 100, corpusSize: 1000 });
    const a = buildScifactPilotSubset(dataset);
    const b = buildScifactPilotSubset(dataset);
    assert.deepEqual([...a.queries.keys()].sort(), [...b.queries.keys()].sort());
    assert.deepEqual([...a.corpus.keys()].sort(), [...b.corpus.keys()].sort());
  });

  it('every selected query\'s positive doc is included in the subset corpus — positives are never subsampled', () => {
    const dataset = buildSyntheticDataset({ queryCount: 100, corpusSize: 1000 });
    const subset = buildScifactPilotSubset(dataset);
    for (const [qid, qr] of subset.qrels.entries()) {
      for (const [docId, rel] of qr.entries()) {
        if (rel > 0) assert.ok(subset.corpus.has(docId), `positive doc ${docId} for query ${qid} missing from subset corpus`);
      }
    }
  });

  it('throws (hard-fails) when the full corpus is too small to reach PILOT_CORPUS_SIZE', () => {
    const dataset = buildSyntheticDataset({ queryCount: 30, corpusSize: 50 });
    assert.throws(() => buildScifactPilotSubset(dataset), /could not reach the required pilot corpus size/);
  });

  it('qrels are rescoped — no row references a doc outside the subset corpus', () => {
    const dataset = buildSyntheticDataset({ queryCount: 100, corpusSize: 1000 });
    const subset = buildScifactPilotSubset(dataset);
    for (const qr of subset.qrels.values()) {
      for (const docId of qr.keys()) {
        assert.ok(subset.corpus.has(docId));
      }
    }
  });
});

describe('validatePilotSubset()', () => {
  it('returns no errors for a well-formed subset', () => {
    const dataset = buildSyntheticDataset({ queryCount: 100, corpusSize: 1000 });
    const subset = buildScifactPilotSubset(dataset);
    assert.deepEqual(validatePilotSubset(subset), []);
  });

  it('flags a query with zero positives among its qrels', () => {
    const dataset = buildSyntheticDataset({ queryCount: 100, corpusSize: 1000 });
    const subset = buildScifactPilotSubset(dataset);
    const [firstQid] = subset.queries.keys();
    // Corrupt: set the one qrels row for this query to relevance 0.
    const qr = subset.qrels.get(firstQid);
    for (const docId of qr.keys()) qr.set(docId, 0);
    const errors = validatePilotSubset(subset);
    assert.ok(errors.some((e) => e.includes(firstQid) && e.includes('no positive')));
  });

  it('flags a query with no qrels at all', () => {
    const dataset = buildSyntheticDataset({ queryCount: 100, corpusSize: 1000 });
    const subset = buildScifactPilotSubset(dataset);
    const [firstQid] = subset.queries.keys();
    subset.qrels.delete(firstQid);
    const errors = validatePilotSubset(subset);
    assert.ok(errors.some((e) => e.includes(firstQid) && e.includes('no qrels')));
  });

  it('flags a dangling qrels reference (doc not in subset corpus)', () => {
    const dataset = buildSyntheticDataset({ queryCount: 100, corpusSize: 1000 });
    const subset = buildScifactPilotSubset(dataset);
    const [firstQid] = subset.queries.keys();
    subset.qrels.get(firstQid).set('doc-not-in-corpus-at-all', 1);
    const errors = validatePilotSubset(subset);
    assert.ok(errors.some((e) => e.includes('dangling qrels')));
  });
});

describe('pilotFingerprint()', () => {
  it('is a stable, deterministic hex string', () => {
    assert.equal(pilotFingerprint(), pilotFingerprint());
    assert.match(pilotFingerprint(), /^[0-9a-f]{16}$/);
  });
});

describe('datasetAwarePilotFingerprint() — cache-key collision safety', () => {
  it('two DIFFERENT datasets never produce the same cache-key fingerprint, even with identical PILOT_SEED/PILOT_QUERY_COUNT/PILOT_CORPUS_SIZE constants', async () => {
    const { datasetAwarePilotFingerprint } = await import('./core/pilot-subset.mjs');
    const datasetA = buildSyntheticDataset({ queryCount: 100, corpusSize: 1000 });
    const datasetB = buildSyntheticDataset({ queryCount: 200, corpusSize: 2000 });
    assert.notEqual(datasetAwarePilotFingerprint(datasetA), datasetAwarePilotFingerprint(datasetB));
  });

  it('the SAME dataset always produces the SAME cache-key fingerprint', async () => {
    const { datasetAwarePilotFingerprint } = await import('./core/pilot-subset.mjs');
    const dataset = buildSyntheticDataset({ queryCount: 100, corpusSize: 1000 });
    assert.equal(datasetAwarePilotFingerprint(dataset), datasetAwarePilotFingerprint(dataset));
  });
});

describe('buildAndCachePilotSubset() / loadCachedPilotSubset()', () => {
  it('caches the built subset, and a second call reuses the cache without rebuilding differently', () => {
    const dataset = buildSyntheticDataset({ queryCount: 100, corpusSize: 1000 });
    const first = buildAndCachePilotSubset(dataset);
    const second = buildAndCachePilotSubset(dataset);
    assert.deepEqual([...first.corpus.keys()].sort(), [...second.corpus.keys()].sort());
    // loadCachedPilotSubset is strictly offline — must find the same cache
    // (now dataset-aware, so it needs the same dataset identity to derive
    // the same cache key).
    const loaded = loadCachedPilotSubset(dataset);
    assert.ok(loaded);
    assert.equal(loaded.fingerprint, first.fingerprint);
  });
});
