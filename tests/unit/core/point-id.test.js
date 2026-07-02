// Migrated from src/smoke/sections/32-deterministic-point-id.js
import '../../helpers/setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makePointId } from '../../../src/core/point-id.js';

const base = {
  collection: 'test-col',
  sourceFile: 'docs/intro.md',
  chunkIndex: 0,
  embeddingSchemaVersion: 2,
};

describe('makePointId — determinism and format', () => {
  it('same inputs produce the same ID', () => {
    assert.equal(makePointId(base), makePointId(base));
  });

  it('result is a UUID string', () => {
    assert.match(
      makePointId(base),
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('version nibble is 5 (uuidv5)', () => {
    assert.equal(makePointId(base)[14], '5');
  });

  it('variant bits are set (8, 9, a, or b)', () => {
    assert.ok('89ab'.includes(makePointId(base)[19]));
  });
});

describe('makePointId — identity axes', () => {
  it('different chunkIndex → different ID', () => {
    assert.notEqual(makePointId(base), makePointId({ ...base, chunkIndex: 1 }));
  });

  it('different sourceFile → different ID', () => {
    assert.notEqual(makePointId(base), makePointId({ ...base, sourceFile: 'docs/other.md' }));
  });

  it('different collection → different ID', () => {
    assert.notEqual(makePointId(base), makePointId({ ...base, collection: 'other-col' }));
  });

  it('different embeddingSchemaVersion → different ID', () => {
    assert.notEqual(makePointId(base), makePointId({ ...base, embeddingSchemaVersion: 3 }));
  });
});

describe('makePointId — excluded fields must not change the ID', () => {
  it('file_hash is ignored', () => {
    assert.equal(makePointId({ ...base, file_hash: 'deadbeef' }), makePointId(base));
  });

  it('tags are ignored', () => {
    assert.equal(makePointId({ ...base, tags: ['a', 'b'] }), makePointId(base));
  });

  it('context is ignored', () => {
    assert.equal(makePointId({ ...base, context: 'some context text' }), makePointId(base));
  });
});

describe('makePointId — path normalisation', () => {
  it('Windows backslash path equals forward-slash path', () => {
    assert.equal(makePointId({ ...base, sourceFile: 'docs\\intro.md' }), makePointId(base));
  });
});
