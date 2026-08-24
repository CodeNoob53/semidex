// Pure unit tests for Search API v1 request parsing — no HTTP, no I/O.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchRequestV1 } from '../../../../../src/core/search-api/v1/request.js';

describe('parseSearchRequestV1() — delegates field validation to the shared parser', () => {
  it('accepts a minimal valid body, applying the same defaults as /api/search', () => {
    const parsed = parseSearchRequestV1({ collection: 'docs', query: 'how does auth work?' });
    assert.equal(parsed.collection, 'docs');
    assert.equal(parsed.query, 'how does auth work?');
    assert.equal(parsed.top, 3);
    assert.equal(parsed.window, 0);
    assert.equal(parsed.windowFormat, null);
    assert.equal(parsed.sourceFile, null);
    assert.equal(parsed.tags, null);
  });

  it('accepts every documented field', () => {
    const parsed = parseSearchRequestV1({
      collection: 'docs', query: 'q', top: 5, window: 2, windowFormat: 'full', sourceFile: 'a.md', tags: ['x'],
    });
    assert.equal(parsed.top, 5);
    assert.equal(parsed.window, 2);
    assert.equal(parsed.windowFormat, 'full');
    assert.equal(parsed.sourceFile, 'a.md');
    assert.deepEqual(parsed.tags, ['x']);
  });

  it('rejects a non-object body', () => {
    assert.throws(() => parseSearchRequestV1('nope'), /must be a JSON object/);
    assert.throws(() => parseSearchRequestV1(null), /must be a JSON object/);
    assert.throws(() => parseSearchRequestV1([]), /must be a JSON object/);
  });

  it('rejects missing collection/query the same way the shared parser does', () => {
    assert.throws(() => parseSearchRequestV1({ query: 'q' }), /"collection"/);
    assert.throws(() => parseSearchRequestV1({ collection: 'c' }), /"query"/);
  });

  it('rejects out-of-range top/window the same way the shared parser does', () => {
    assert.throws(() => parseSearchRequestV1({ collection: 'c', query: 'q', top: 21 }), /"top"/);
    assert.throws(() => parseSearchRequestV1({ collection: 'c', query: 'q', window: 6 }), /"window"/);
  });
});

describe('parseSearchRequestV1() — public-contract-only tightening: unknown root fields are rejected', () => {
  it('rejects a field /api/search would silently ignore', () => {
    assert.throws(
      () => parseSearchRequestV1({ collection: 'c', query: 'q', unexpectedField: 'x' }),
      /Unknown body field\(s\): unexpectedField/,
    );
  });

  it('the error message enumerates every accepted field', () => {
    try {
      parseSearchRequestV1({ collection: 'c', query: 'q', bogus: 1 });
      assert.fail('expected a throw');
    } catch (err) {
      for (const field of ['collection', 'query', 'top', 'window', 'windowFormat', 'sourceFile', 'tags']) {
        assert.match(err.message, new RegExp(`"${field}"`), `expected the accepted-fields list to mention "${field}"`);
      }
    }
  });
});
