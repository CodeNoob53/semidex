// Tests for src/core/assembly/cursor.js — opaque, versioned, deterministic
// pagination cursors. Pure: no assembly, no adapter, no network.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCursor, decodeCursor, cursorMatchesRequest } from '../../../../src/core/assembly/cursor.js';

function payload(overrides = {}) {
  return {
    v: 1, collection: 'c', scope: 'file', sourceKey: 'a.md  entity_refs',
    anchorNodeId: 'n1', totalSegments: 10, dir: 'after', edgeIndex: 5,
    ...overrides,
  };
}

describe('encodeCursor / decodeCursor — round trip', () => {
  it('decodes exactly what was encoded', () => {
    const p = payload();
    const cursor = encodeCursor(p);
    assert.equal(typeof cursor, 'string');
    assert.deepEqual(decodeCursor(cursor), p);
  });

  it('is opaque: not plain JSON, not directly readable without decoding', () => {
    const cursor = encodeCursor(payload());
    assert.doesNotMatch(cursor, /"collection"/, 'the raw cursor string must not contain readable JSON');
  });

  it('two encodes of the identical payload produce the identical cursor (deterministic)', () => {
    const c1 = encodeCursor(payload());
    const c2 = encodeCursor(payload());
    assert.equal(c1, c2);
  });

  it('encodes null anchorNodeId correctly (file-scope-without-anchor edge case)', () => {
    const p = payload({ anchorNodeId: null });
    assert.deepEqual(decodeCursor(encodeCursor(p)), p);
  });
});

describe('decodeCursor — rejects malformed input', () => {
  it('rejects a non-string', () => {
    assert.equal(decodeCursor(undefined), null);
    assert.equal(decodeCursor(null), null);
    assert.equal(decodeCursor(42), null);
  });

  it('rejects a string with the wrong prefix', () => {
    assert.equal(decodeCursor('not-a-cursor'), null);
    assert.equal(decodeCursor(Buffer.from(JSON.stringify(payload())).toString('base64url')), null);
  });

  it('rejects invalid base64url after the prefix', () => {
    assert.equal(decodeCursor('ac1.!!!not-base64!!!'), null);
  });

  it('rejects a payload that is valid base64url but not JSON', () => {
    const garbage = 'ac1.' + Buffer.from('not json', 'utf-8').toString('base64url');
    assert.equal(decodeCursor(garbage), null);
  });

  it('rejects JSON that is not an object', () => {
    const arr = 'ac1.' + Buffer.from('[1,2,3]', 'utf-8').toString('base64url');
    assert.equal(decodeCursor(arr), null);
    const str = 'ac1.' + Buffer.from('"hello"', 'utf-8').toString('base64url');
    assert.equal(decodeCursor(str), null);
  });

  for (const [field, badValue] of [
    ['v', 'not-a-number'],
    ['collection', 42],
    ['collection', ''],
    ['scope', 'chunk'],
    ['sourceKey', 42],
    ['anchorNodeId', 42],
    ['totalSegments', -1],
    ['totalSegments', 1.5],
    ['totalSegments', 'ten'],
    ['dir', 'sideways'],
    ['edgeIndex', 'five'],
    ['edgeIndex', 1.5],
  ]) {
    it(`rejects a tampered "${field}" field (${JSON.stringify(badValue)})`, () => {
      const tampered = encodeCursor(payload({ [field]: badValue }));
      assert.equal(decodeCursor(tampered), null);
    });
  }

  it('accepts a null anchorNodeId (explicitly allowed) but rejects other non-string values', () => {
    assert.notEqual(decodeCursor(encodeCursor(payload({ anchorNodeId: null }))), null);
  });
});

// Code review (P2): decodeCursor() previously only checked that edgeIndex
// WAS an integer, never that it was a real position for its own declared
// totalSegments — a structurally well-formed cursor claiming edgeIndex=999
// against a 3-segment scope was accepted and silently produced an empty
// "successful" page instead of being rejected as the tampered/stale value
// it obviously is.
describe('decodeCursor — rejects an edgeIndex out of range for its own totalSegments (code review, P2)', () => {
  it('the exact reported repro: edgeIndex=999 against totalSegments=3', () => {
    const tampered = encodeCursor(payload({ totalSegments: 3, edgeIndex: 999 }));
    assert.equal(decodeCursor(tampered), null);
  });

  it('rejects a negative edgeIndex', () => {
    assert.equal(decodeCursor(encodeCursor(payload({ totalSegments: 10, edgeIndex: -1 }))), null);
  });

  it('accepts edgeIndex at the legitimate in-range values (0 and totalSegments - 1)', () => {
    // edgeIndex is always a REAL segment array index; the last valid value
    // is totalSegments - 1 (code review, P2 round 2: the earlier version
    // wrongly accepted edgeIndex === totalSegments as a "boundary").
    assert.notEqual(decodeCursor(encodeCursor(payload({ totalSegments: 10, edgeIndex: 0 }))), null);
    assert.notEqual(decodeCursor(encodeCursor(payload({ totalSegments: 10, edgeIndex: 9 }))), null);
  });

  it('rejects edgeIndex === totalSegments (one past the last real index — never legitimately minted)', () => {
    assert.equal(decodeCursor(encodeCursor(payload({ totalSegments: 10, edgeIndex: 10 }))), null);
  });

  it('rejects edgeIndex === totalSegments + 1', () => {
    assert.equal(decodeCursor(encodeCursor(payload({ totalSegments: 10, edgeIndex: 11 }))), null);
  });
});

describe('cursorMatchesRequest — binds a cursor to the exact request it was minted for', () => {
  const request = {
    version: 1, collection: 'c', scope: 'file', sourceKey: 'a.md  entity_refs',
    anchorNodeId: 'n1', totalSegments: 10,
  };

  it('matches when every field is identical', () => {
    const decoded = decodeCursor(encodeCursor(payload()));
    assert.equal(cursorMatchesRequest(decoded, request), true);
  });

  it('returns false for a null decoded cursor', () => {
    assert.equal(cursorMatchesRequest(null, request), false);
  });

  for (const field of ['collection', 'scope', 'sourceKey', 'anchorNodeId', 'totalSegments']) {
    it(`rejects a mismatched "${field}" (bound request identity changed)`, () => {
      const decoded = decodeCursor(encodeCursor(payload()));
      const mismatched = { ...request, [field]: field === 'totalSegments' ? 999 : 'different-value' };
      assert.equal(cursorMatchesRequest(decoded, mismatched), false);
    });
  }

  it('rejects a version mismatch (a cursor minted by a future/past cursor format)', () => {
    const decoded = decodeCursor(encodeCursor(payload({ v: 2 })));
    assert.equal(cursorMatchesRequest(decoded, request), false);
  });
});
