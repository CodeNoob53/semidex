// validate-qrels.mjs — offline. The headline test (audit 2026-09-06):
// content corruption at a STABLE chunkId must fail validation, which the
// v3 "does this chunkId exist" check could never catch.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkContentHash, validateQrelsAgainstFrozenCorpus,
  validateLiveCollectionMatchesFrozen, loadFrozenCorpus, loadV4Qrels,
} from './validate-qrels.mjs';

const MANIFEST = { corpusHash: 'test-corpus-hash' };

function frozenIndex(chunks) {
  return new Map(chunks.map((c) => [c.chunkId, c]));
}

describe('validateQrelsAgainstFrozenCorpus — real files on disk', () => {
  it('the committed queries.v4.json validates against the committed frozen corpus', () => {
    const { ok, errors } = validateQrelsAgainstFrozenCorpus();
    assert.equal(ok, true, errors.join('\n'));
  });
});

describe('validateQrelsAgainstFrozenCorpus — synthetic', () => {
  const byChunkId = frozenIndex([
    { chunkId: 'a.md#0', contentHash: chunkContentHash({ text: 'original text', rawContent: null }) },
    { chunkId: 'a.md#1', contentHash: chunkContentHash({ text: 'row A | row B', rawContent: '| row A | row B |' }) },
  ]);

  it('passes when every chunkId exists and every content hash matches', () => {
    const qrels = {
      corpusHash: 'test-corpus-hash',
      queries: [{ id: 'q1', relevantChunks: [
        { chunkId: 'a.md#0', relevance: 3, contentHash: byChunkId.get('a.md#0').contentHash },
      ] }],
    };
    const { ok } = validateQrelsAgainstFrozenCorpus({ qrels, byChunkId, manifest: MANIFEST });
    assert.equal(ok, true);
  });

  it('FAILS when a chunkId still exists but its content changed — the v3 existence check would have passed this', () => {
    const qrels = {
      corpusHash: 'test-corpus-hash',
      queries: [{ id: 'q1', relevantChunks: [
        // hash of the text the label was ORIGINALLY assigned to…
        { chunkId: 'a.md#0', relevance: 3, contentHash: chunkContentHash({ text: 'the text as it was when reviewed', rawContent: null }) },
      ] }],
    };
    const { ok, errors } = validateQrelsAgainstFrozenCorpus({ qrels, byChunkId, manifest: MANIFEST });
    assert.equal(ok, false);
    assert.match(errors[0], /content changed/);
    assert.match(errors[0], /re-review/);
  });

  it('fails when a chunkId is gone entirely', () => {
    const qrels = {
      corpusHash: 'test-corpus-hash',
      queries: [{ id: 'q1', relevantChunks: [{ chunkId: 'a.md#99', relevance: 3, contentHash: 'x' }] }],
    };
    const { ok, errors } = validateQrelsAgainstFrozenCorpus({ qrels, byChunkId, manifest: MANIFEST });
    assert.equal(ok, false);
    assert.match(errors[0], /not in the frozen corpus/);
  });

  it('fails when qrels.corpusHash disagrees with the manifest', () => {
    const qrels = { corpusHash: 'STALE', queries: [] };
    const { ok, errors } = validateQrelsAgainstFrozenCorpus({ qrels, byChunkId, manifest: MANIFEST });
    assert.equal(ok, false);
    assert.match(errors[0], /reviewed against a different corpus build/);
  });

  it('fails on an out-of-range relevance grade', () => {
    const qrels = {
      corpusHash: 'test-corpus-hash',
      queries: [{ id: 'q1', relevantChunks: [{ chunkId: 'a.md#0', relevance: 4, contentHash: byChunkId.get('a.md#0').contentHash }] }],
    };
    const { ok, errors } = validateQrelsAgainstFrozenCorpus({ qrels, byChunkId, manifest: MANIFEST });
    assert.equal(ok, false);
    assert.match(errors.join(), /must be 1, 2, or 3/);
  });

  it('fails when requiredEvidence names a chunk not in relevantChunks', () => {
    const qrels = {
      corpusHash: 'test-corpus-hash',
      queries: [{
        id: 'q1',
        relevantChunks: [{ chunkId: 'a.md#0', relevance: 3, contentHash: byChunkId.get('a.md#0').contentHash }],
        requiredEvidence: [['a.md#1']],
      }],
    };
    const { ok, errors } = validateQrelsAgainstFrozenCorpus({ qrels, byChunkId, manifest: MANIFEST });
    assert.equal(ok, false);
    assert.match(errors.join(), /requiredEvidence names "a.md#1"/);
  });
});

describe('validateLiveCollectionMatchesFrozen — skip-index guard', () => {
  const corpus = {
    files: {
      'a.md': { chunks: [
        { chunkId: 'a.md#0', contentHash: chunkContentHash({ text: 'chunk zero', rawContent: null }) },
        { chunkId: 'a.md#1', contentHash: chunkContentHash({ text: 'chunk one', rawContent: null }) },
      ] },
    },
  };

  it('ok when the live collection reproduces the frozen per-file hash sequence', async () => {
    const getFileChunksFn = async () => ([
      { payload: { chunk_index: 0, text: 'chunk zero' } },
      { payload: { chunk_index: 1, text: 'chunk one' } },
    ]);
    const { ok } = await validateLiveCollectionMatchesFrozen({ corpus, getFileChunksFn });
    assert.equal(ok, true);
  });

  it('rejects a live collection whose chunk content drifted (same count)', async () => {
    const getFileChunksFn = async () => ([
      { payload: { chunk_index: 0, text: 'chunk zero EDITED' } },
      { payload: { chunk_index: 1, text: 'chunk one' } },
    ]);
    const { ok, errors } = await validateLiveCollectionMatchesFrozen({ corpus, getFileChunksFn });
    assert.equal(ok, false);
    assert.match(errors[0], /same count, content differs/);
  });

  it('rejects a live collection with a different chunk count', async () => {
    const getFileChunksFn = async () => ([{ payload: { chunk_index: 0, text: 'chunk zero' } }]);
    const { ok, errors } = await validateLiveCollectionMatchesFrozen({ corpus, getFileChunksFn });
    assert.equal(ok, false);
    assert.match(errors[0], /1 chunks \/ frozen has 2/);
  });
});
