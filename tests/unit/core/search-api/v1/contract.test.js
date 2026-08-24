// Pure unit tests for the Search API v1 wire contract — no HTTP, no I/O.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  API_VERSION, SEARCH_PATH, ERROR_CODES, isRetryableCode,
  projectResult, projectWindowChunk, projectSearchResponse,
  projectErrorPayload, projectErrorResponseBody,
} from '../../../../../src/core/search-api/v1/contract.js';

describe('Search API v1 contract — constants', () => {
  it('API_VERSION and SEARCH_PATH are stable', () => {
    assert.equal(API_VERSION, 'v1');
    assert.equal(SEARCH_PATH, '/api/v1/search');
  });
});

describe('isRetryableCode()', () => {
  it('embedding_failed and internal_error are retryable', () => {
    assert.equal(isRetryableCode(ERROR_CODES.EMBEDDING_FAILED), true);
    assert.equal(isRetryableCode(ERROR_CODES.INTERNAL_ERROR), true);
  });

  it('bad_request/not_found/forbidden/not_implemented/embedding_unresolved/embedding_unsupported are not retryable', () => {
    for (const code of [
      ERROR_CODES.BAD_REQUEST, ERROR_CODES.NOT_FOUND, ERROR_CODES.FORBIDDEN,
      ERROR_CODES.NOT_IMPLEMENTED, ERROR_CODES.EMBEDDING_UNRESOLVED, ERROR_CODES.EMBEDDING_UNSUPPORTED,
    ]) {
      assert.equal(isRetryableCode(code), false, `${code} must not be retryable`);
    }
  });

  it('an unknown code is not retryable (fail closed, never throws)', () => {
    assert.equal(isRetryableCode('made_up_code'), false);
  });
});

describe('projectResult()', () => {
  const CHUNK = {
    sourceFile: 'docs/en/configuration.md', chunkIndex: 4, totalChunks: 10, section: 'Qdrant',
    text: 'QDRANT_URL points at the Qdrant instance.', context: 'Env var reference.',
    tags: ['configuration'], score: 0.0312, nodeId: 'n1', nodePath: 'configuration.md#qdrant', nodeType: 'section',
    isMatch: true,
  };

  it('projects an explicit, documented field set — an unexpected extra field never leaks through', () => {
    const withExtra = { ...CHUNK, internalQdrantPointId: 'point-123', __proto__internal: 'x' };
    const projected = projectResult(withExtra);
    assert.deepEqual(Object.keys(projected).sort(), [
      'chunkIndex', 'context', 'isMatch', 'nodeId', 'nodePath', 'nodeType',
      'score', 'section', 'sourceFile', 'tags', 'text', 'totalChunks',
    ].sort());
    assert.ok(!('internalQdrantPointId' in projected));
  });

  it('normalizes missing/malformed fields to safe defaults rather than throwing', () => {
    const projected = projectResult({});
    assert.equal(projected.sourceFile, null);
    assert.equal(projected.chunkIndex, null);
    assert.equal(projected.totalChunks, null);
    assert.equal(projected.section, '');
    assert.equal(projected.text, null);
    assert.equal(projected.context, null);
    assert.deepEqual(projected.tags, []);
    assert.equal(projected.score, null);
    assert.equal(projected.nodeId, null);
    assert.equal(projected.isMatch, false);
  });

  it('includes windowChunks only when present on the source hit', () => {
    assert.ok(!('windowChunks' in projectResult(CHUNK)));
    const withWindows = { ...CHUNK, windowChunks: [{ sourceFile: 'a', chunkIndex: 1, section: 's', isMatch: true, textSnippet: 'x' }] };
    const projected = projectResult(withWindows);
    assert.equal(projected.windowChunks.length, 1);
    assert.equal(projected.windowChunks[0].textSnippet, 'x');
  });
});

describe('projectWindowChunk()', () => {
  it('preserves textSnippet (compact) without inventing a text field', () => {
    const p = projectWindowChunk({ sourceFile: 'a.md', chunkIndex: 2, section: 's', isMatch: false, textSnippet: 'abc...' });
    assert.equal(p.textSnippet, 'abc...');
    assert.ok(!('text' in p));
  });

  it('preserves text (full) without inventing a textSnippet field', () => {
    const p = projectWindowChunk({ sourceFile: 'a.md', chunkIndex: 2, section: 's', isMatch: true, text: 'full body' });
    assert.equal(p.text, 'full body');
    assert.ok(!('textSnippet' in p));
  });
});

describe('projectSearchResponse()', () => {
  it('wraps results and carries apiVersion', () => {
    const body = projectSearchResponse({
      collection: 'docs', query: 'auth', top: 3, window: 0, windowFormat: null, searchMode: 'hybrid',
      results: [{ sourceFile: 'a.md', chunkIndex: 0, isMatch: true }],
    });
    assert.equal(body.apiVersion, 'v1');
    assert.equal(body.collection, 'docs');
    assert.equal(body.searchMode, 'hybrid');
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].sourceFile, 'a.md');
  });

  it('normalizes a null/undefined searchMode explicitly', () => {
    const body = projectSearchResponse({ collection: 'c', query: 'q', top: 1, window: 0, windowFormat: null, searchMode: undefined, results: [] });
    assert.equal(body.searchMode, null);
  });
});

describe('projectErrorPayload() / projectErrorResponseBody()', () => {
  it('carries apiVersion, code, message, retryable', () => {
    const payload = projectErrorPayload(ERROR_CODES.EMBEDDING_FAILED, 'boom');
    assert.deepEqual(payload, { apiVersion: 'v1', code: 'embedding_failed', message: 'boom', retryable: true });
  });

  it('response body nests under error', () => {
    const body = projectErrorResponseBody(ERROR_CODES.NOT_FOUND, 'no such collection');
    assert.deepEqual(body, { error: { apiVersion: 'v1', code: 'not_found', message: 'no such collection', retryable: false } });
  });
});
