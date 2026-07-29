// core/collapse.mjs — offline, pure function, no I/O. Hits use the REAL
// runHybridSearch() shape — adapter Chunk objects (toChunk() in
// src/core/storage/qdrant-adapter.js: camelCase, flat, sourceFile
// directly on the object) — never a raw {payload:{...}} Qdrant point
// shape. An earlier version of both collapse.mjs and this test file used
// the wrong {payload:{source_file}} shape, which made every offline test
// pass while a live run against real Chunk objects silently misrouted
// every hit into unmappedHits (caught only by a live smoke run, not by
// any offline test — this file's fixtures are now pinned to the real
// shape specifically so that regression can never recur silently).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collapseHitsToDocuments, COLLAPSE_STRATEGY } from './core/collapse.mjs';

describe('collapseHitsToDocuments()', () => {
  it('collapses multiple chunk hits from the same document into one entry, keeping the MAX score', () => {
    const hits = [
      { sourceFile: 'doc-1.md', score: 0.5 },
      { sourceFile: 'doc-1.md', score: 0.9 },
      { sourceFile: 'doc-1.md', score: 0.3 },
    ];
    const map = new Map([['doc-1.md', 'scifact-1']]);
    const { rankedDocs, unmappedHits } = collapseHitsToDocuments(hits, map);
    assert.equal(rankedDocs.length, 1);
    assert.equal(rankedDocs[0].docId, 'scifact-1');
    assert.equal(rankedDocs[0].score, 0.9);
    assert.equal(rankedDocs[0].chunkCount, 3);
    assert.deepEqual(unmappedHits, []);
  });

  it('ranks distinct documents by descending score', () => {
    const hits = [
      { sourceFile: 'doc-a.md', score: 0.2 },
      { sourceFile: 'doc-b.md', score: 0.8 },
      { sourceFile: 'doc-c.md', score: 0.5 },
    ];
    const map = new Map([['doc-a.md', 'a'], ['doc-b.md', 'b'], ['doc-c.md', 'c']]);
    const { rankedDocs } = collapseHitsToDocuments(hits, map);
    assert.deepEqual(rankedDocs.map((d) => d.docId), ['b', 'c', 'a']);
  });

  it('a hit whose sourceFile has no docId mapping is tracked in unmappedHits, never silently dropped', () => {
    const hits = [
      { sourceFile: 'known.md', score: 0.9 },
      { sourceFile: 'totally-unknown.md', score: 0.7 },
    ];
    const map = new Map([['known.md', 'doc-1']]);
    const { rankedDocs, unmappedHits } = collapseHitsToDocuments(hits, map);
    assert.equal(rankedDocs.length, 1);
    assert.equal(unmappedHits.length, 1);
    assert.equal(unmappedHits[0].sourceFile, 'totally-unknown.md');
    assert.equal(unmappedHits[0].score, 0.7);
  });

  it('a hit with sourceFile null/undefined (matching Chunk\'s own null-default shape) is also tracked as unmapped, not thrown/crashed on', () => {
    const hits = [{ sourceFile: null, score: 0.4 }, { score: 0.1 }];
    const { rankedDocs, unmappedHits } = collapseHitsToDocuments(hits, new Map());
    assert.equal(rankedDocs.length, 0);
    assert.equal(unmappedHits.length, 2);
  });

  it('REGRESSION: a hit shaped like a raw Qdrant point ({payload:{source_file}}) — the WRONG shape — is correctly treated as unmapped, never silently matched via the wrong field', () => {
    const hits = [{ payload: { source_file: 'doc-1.md' }, score: 0.9 }];
    const map = new Map([['doc-1.md', 'd1']]);
    const { rankedDocs, unmappedHits } = collapseHitsToDocuments(hits, map);
    assert.equal(rankedDocs.length, 0, 'a {payload:{...}} shaped object has no top-level sourceFile — must never accidentally match');
    assert.equal(unmappedHits.length, 1);
  });

  it('empty hits array produces empty rankedDocs and empty unmappedHits', () => {
    const { rankedDocs, unmappedHits } = collapseHitsToDocuments([], new Map());
    assert.deepEqual(rankedDocs, []);
    assert.deepEqual(unmappedHits, []);
  });

  it('never mutates the input hits array or the sourceFileToDocId map', () => {
    const hits = [{ sourceFile: 'doc-1.md', score: 0.5 }];
    const map = new Map([['doc-1.md', 'd1']]);
    const hitsCopy = JSON.parse(JSON.stringify(hits));
    const mapCopy = new Map(map);
    collapseHitsToDocuments(hits, map);
    assert.deepEqual(hits, hitsCopy);
    assert.deepEqual([...map], [...mapCopy]);
  });

  it('exports COLLAPSE_STRATEGY as the literal "max" — the fairness-relevant parameter every report must log', () => {
    assert.equal(COLLAPSE_STRATEGY, 'max');
  });
});
