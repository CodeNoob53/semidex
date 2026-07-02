// Migrated from src/smoke/sections/08-compact-window.js
import '../../helpers/setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assembleWindowChunks } from '../../../src/mcp/tools/search.js';

const MATCH_IDX = 5;
const matchText = 'Payload Indexes: source_file is indexed as keyword for fast filter lookups. getStoredMeta is the primary caller.';
const neighborText = 'Fields: file_hash, dense_provider, dense_model, sparse_provider, embedding_schema_version, vector_size. getStoredMeta scrolls one point matching source_file and returns these six reindex discriminator fields from its payload.';

const points = () => [
  { payload: { source_file: 'qdrant.md', chunk_index: MATCH_IDX, section: 'Payload Indexes', text: matchText } },
  { payload: { source_file: 'qdrant.md', chunk_index: MATCH_IDX + 1, section: 'getStoredMeta', text: neighborText } },
];

describe('assembleWindowChunks — compact mode', () => {
  const compact = assembleWindowChunks(points(), MATCH_IDX, 'compact');

  it('returns both window chunks with correct is_match flags', () => {
    assert.equal(compact.length, 2);
    assert.equal(compact[0].is_match, true);
    assert.equal(compact[1].is_match, false);
  });

  it('emits text_snippet and never a full text field', () => {
    for (const chunk of compact) {
      assert.equal(typeof chunk.text_snippet, 'string');
      assert.ok(!Object.hasOwn(chunk, 'text'), 'compact chunk must not carry full text');
    }
  });

  it('long neighbor snippet is truncated to 150 chars + "..."', () => {
    assert.ok(compact[1].text_snippet.length <= 153);
    assert.ok(compact[1].text_snippet.endsWith('...'));
  });

  it('snippet keeps the leading exact identifiers', () => {
    for (const token of ['file_hash', 'dense_provider', 'dense_model', 'sparse_provider', 'embedding_schema_version', 'vector_size']) {
      assert.ok(compact[1].text_snippet.includes(token), `missing ${token}`);
    }
  });
});

describe('assembleWindowChunks — full mode', () => {
  const full = assembleWindowChunks(points(), MATCH_IDX, 'full');

  it('neighbor carries untruncated text and no snippet', () => {
    assert.equal(full[1].text, neighborText);
    assert.ok(!Object.hasOwn(full[1], 'text_snippet'));
  });
});

describe('assembleWindowChunks — edge cases', () => {
  it('empty input → empty array', () => {
    assert.deepEqual(assembleWindowChunks([], MATCH_IDX, 'compact'), []);
  });

  it('duplicate non-match neighbor is emitted once', () => {
    const withDup = [...points(), points()[1]];
    const result = assembleWindowChunks(withDup, MATCH_IDX, 'compact');
    assert.equal(result.length, 2);
  });
});
