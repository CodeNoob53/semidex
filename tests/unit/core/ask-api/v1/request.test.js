import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAskRequestV1 } from '../../../../../src/core/ask-api/v1/request.js';
import { HttpError } from '../../../../../src/core/http/http.js';

function assertBadRequest(fn) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, 'bad_request');
    return true;
  });
}

describe('parseAskRequestV1 — exact request normalization', () => {
  it('the minimal valid shape { collection, question } normalizes to exactly those two fields', () => {
    const result = parseAskRequestV1({ collection: 'company-docs', question: 'How are refunds approved?' });
    assert.deepEqual(result, { collection: 'company-docs', question: 'How are refunds approved?' });
  });

  it('collection and question are required non-empty strings', () => {
    assertBadRequest(() => parseAskRequestV1({ question: 'q' }));
    assertBadRequest(() => parseAskRequestV1({ collection: 'c' }));
    assertBadRequest(() => parseAskRequestV1({ collection: '', question: 'q' }));
    assertBadRequest(() => parseAskRequestV1({ collection: '   ', question: 'q' }));
    assertBadRequest(() => parseAskRequestV1({ collection: 'c', question: '' }));
    assertBadRequest(() => parseAskRequestV1({ collection: 123, question: 'q' }));
    assertBadRequest(() => parseAskRequestV1({ collection: 'c', question: null }));
  });

  it('the body must be a JSON object, not a string/array/null', () => {
    assertBadRequest(() => parseAskRequestV1('not an object'));
    assertBadRequest(() => parseAskRequestV1(null));
    assertBadRequest(() => parseAskRequestV1(['collection', 'question']));
  });
});

describe('parseAskRequestV1 — optional scope', () => {
  it('scope is optional — omitting it entirely is valid', () => {
    const result = parseAskRequestV1({ collection: 'c', question: 'q' });
    assert.equal('sourceFile' in result, false);
  });

  it('scope: null is rejected — the contract requires scope to be an object when present', () => {
    assertBadRequest(() => parseAskRequestV1({ collection: 'c', question: 'q', scope: null }));
  });

  it('scope.sourceFile maps to the coordinator\'s sourceFile argument', () => {
    const result = parseAskRequestV1({ collection: 'c', question: 'q', scope: { sourceFile: 'returns.md' } });
    assert.deepEqual(result, { collection: 'c', question: 'q', sourceFile: 'returns.md' });
  });

  it('scope: {} (sourceFile omitted within scope) is valid and produces no sourceFile field', () => {
    const result = parseAskRequestV1({ collection: 'c', question: 'q', scope: {} });
    assert.equal('sourceFile' in result, false);
  });

  it('scope must be an object, not a string/array', () => {
    assertBadRequest(() => parseAskRequestV1({ collection: 'c', question: 'q', scope: 'returns.md' }));
    assertBadRequest(() => parseAskRequestV1({ collection: 'c', question: 'q', scope: ['returns.md'] }));
  });

  it('scope.sourceFile must be a non-empty string when provided', () => {
    assertBadRequest(() => parseAskRequestV1({ collection: 'c', question: 'q', scope: { sourceFile: '' } }));
    assertBadRequest(() => parseAskRequestV1({ collection: 'c', question: 'q', scope: { sourceFile: '   ' } }));
    assertBadRequest(() => parseAskRequestV1({ collection: 'c', question: 'q', scope: { sourceFile: 42 } }));
  });

  it('scope.sourceFile is currently the ONLY supported scope field — any other key is rejected', () => {
    assertBadRequest(() => parseAskRequestV1({ collection: 'c', question: 'q', scope: { tags: ['a'] } }));
    assertBadRequest(() => parseAskRequestV1({ collection: 'c', question: 'q', scope: { sourceFile: 'x.md', tags: ['a'] } }));
  });
});

describe('parseAskRequestV1 — rejects the obsolete pre-v1 contract fields', () => {
  it('root-level "sourceFile" is rejected outright, not silently accepted as a second contract', () => {
    assertBadRequest(() => parseAskRequestV1({ collection: 'c', question: 'q', sourceFile: 'returns.md' }));
  });

  it('root-level "top" is rejected outright — retrieval count is an internal setting, not a client control', () => {
    assertBadRequest(() => parseAskRequestV1({ collection: 'c', question: 'q', top: 5 }));
  });

  it('the rejection message for sourceFile points the caller at the real "scope" field', () => {
    try {
      parseAskRequestV1({ collection: 'c', question: 'q', sourceFile: 'x.md' });
      assert.fail('expected a throw');
    } catch (err) {
      assert.match(err.message, /scope/);
    }
  });
});

describe('parseAskRequestV1 — rejects unknown root-level fields (Ask is stateless)', () => {
  it('an unknown field like "sessionId" is rejected, not silently ignored', () => {
    assertBadRequest(() => parseAskRequestV1({ collection: 'c', question: 'q', sessionId: 'abc123' }));
  });

  it('the rejection message names the offending field', () => {
    try {
      parseAskRequestV1({ collection: 'c', question: 'q', sessionId: 'abc123' });
      assert.fail('expected a throw');
    } catch (err) {
      assert.match(err.message, /sessionId/);
    }
  });

  it('multiple unknown fields are all named in the rejection', () => {
    try {
      parseAskRequestV1({ collection: 'c', question: 'q', sessionId: 'abc', foo: 1 });
      assert.fail('expected a throw');
    } catch (err) {
      assert.match(err.message, /sessionId/);
      assert.match(err.message, /foo/);
    }
  });
});
