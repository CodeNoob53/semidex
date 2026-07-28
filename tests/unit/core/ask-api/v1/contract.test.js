import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  API_VERSION, ASK_PATH, SSE_EVENTS, ERROR_CODES, isRetryableCode,
  projectSource, projectSourcesEvent, projectAnswerDeltaEvent, projectDoneEvent, projectErrorPayload,
  projectErrorResponseBody, isStructuralNodeType,
} from '../../../../../src/core/ask-api/v1/contract.js';

describe('Ask API v1 contract — constants', () => {
  it('API_VERSION is "v1"', () => {
    assert.equal(API_VERSION, 'v1');
  });

  it('ASK_PATH is the canonical versioned path', () => {
    assert.equal(ASK_PATH, '/api/v1/ask');
  });

  it('SSE_EVENTS uses exactly sources/answer_delta/done/error — never the pre-v1 "token" name', () => {
    assert.deepEqual(SSE_EVENTS, {
      SOURCES: 'sources',
      ANSWER_DELTA: 'answer_delta',
      DONE: 'done',
      ERROR: 'error',
    });
    assert.equal(Object.values(SSE_EVENTS).includes('token'), false);
  });
});

describe('Ask API v1 contract — ERROR_CODES', () => {
  it('includes not_implemented and embedding_failed (the pre-stream retrieval-error codes route.js maps to statuses)', () => {
    assert.equal(ERROR_CODES.NOT_IMPLEMENTED, 'not_implemented');
    assert.equal(ERROR_CODES.EMBEDDING_FAILED, 'embedding_failed');
  });
});

describe('Ask API v1 contract — isRetryableCode', () => {
  it('bad_request and not_found are not retryable', () => {
    assert.equal(isRetryableCode(ERROR_CODES.BAD_REQUEST), false);
    assert.equal(isRetryableCode(ERROR_CODES.NOT_FOUND), false);
  });

  it('busy, dependency_unavailable, embedding_failed, retrieval_failed, generation_failed, internal_error are retryable', () => {
    assert.equal(isRetryableCode(ERROR_CODES.BUSY), true);
    assert.equal(isRetryableCode(ERROR_CODES.DEPENDENCY_UNAVAILABLE), true);
    assert.equal(isRetryableCode(ERROR_CODES.EMBEDDING_FAILED), true);
    assert.equal(isRetryableCode(ERROR_CODES.RETRIEVAL_FAILED), true);
    assert.equal(isRetryableCode(ERROR_CODES.GENERATION_FAILED), true);
    assert.equal(isRetryableCode(ERROR_CODES.INTERNAL_ERROR), true);
  });

  it('stream_aborted is not retryable (client-initiated cancellation, not a transient server condition)', () => {
    assert.equal(isRetryableCode(ERROR_CODES.STREAM_ABORTED), false);
  });

  it('not_implemented is not retryable (structural backend limitation, will not resolve on retry)', () => {
    assert.equal(isRetryableCode(ERROR_CODES.NOT_IMPLEMENTED), false);
  });

  it('an unknown code is not retryable (fail closed, not open)', () => {
    assert.equal(isRetryableCode('made_up_code'), false);
  });
});

function source(overrides = {}) {
  return {
    n: 1, sourceFile: 'docs/x.md', chunkIndex: 3, section: 'Intro',
    snippet: 'some evidence text', nodeId: 'node-1', nodePath: 'docs/x.md#intro',
    nodeType: 'paragraph', truncated: false,
    ...overrides,
  };
}

describe('Ask API v1 contract — projectSource', () => {
  it('passes through every documented public field', () => {
    const projected = projectSource(source());
    assert.deepEqual(projected, {
      n: 1, sourceFile: 'docs/x.md', chunkIndex: 3, section: 'Intro',
      nodeId: 'node-1', nodePath: 'docs/x.md#intro', nodeType: 'paragraph',
      snippet: 'some evidence text', truncated: false,
    });
  });

  it('normalizes undefined optional fields to null, never omits or leaves undefined', () => {
    const projected = projectSource({ n: 2, snippet: 'x', truncated: true });
    assert.equal(projected.sourceFile, null);
    assert.equal(projected.chunkIndex, null);
    assert.equal(projected.section, null);
    assert.equal(projected.nodeId, null);
    assert.equal(projected.nodePath, null);
    assert.equal(projected.nodeType, null);
  });

  it('never includes an internal "score" or other field beyond the documented public shape', () => {
    const projected = projectSource({ ...source(), score: 0.9, internalDebugFlag: true });
    assert.deepEqual(
      Object.keys(projected).sort(),
      ['chunkIndex', 'n', 'nodeId', 'nodePath', 'nodeType', 'section', 'snippet', 'sourceFile', 'truncated']
    );
  });
});

describe('Ask API v1 contract — projectSourcesEvent', () => {
  it('includes apiVersion, searchMode, and projected sources', () => {
    const payload = projectSourcesEvent({ searchMode: 'hybrid', sources: [source()] });
    assert.equal(payload.apiVersion, 'v1');
    assert.equal(payload.searchMode, 'hybrid');
    assert.equal(payload.sources.length, 1);
    assert.equal(payload.sources[0].n, 1);
  });

  it('normalizes a null/undefined searchMode to null, never omits the field', () => {
    const payload = projectSourcesEvent({ searchMode: undefined, sources: [] });
    assert.equal(payload.searchMode, null);
  });

  it('an empty sources array projects to an empty array, not null/undefined', () => {
    const payload = projectSourcesEvent({ searchMode: 'hybrid', sources: [] });
    assert.deepEqual(payload.sources, []);
  });
});

describe('Ask API v1 contract — projectAnswerDeltaEvent', () => {
  it('includes apiVersion and the raw text fragment, nothing else', () => {
    const payload = projectAnswerDeltaEvent('hello');
    assert.deepEqual(payload, { apiVersion: 'v1', text: 'hello' });
  });
});

describe('Ask API v1 contract — projectDoneEvent', () => {
  it('includes every documented public field', () => {
    const payload = projectDoneEvent({
      text: 'The answer is 42 [1].',
      citations: [1],
      nodeReferences: ['docs/x.md#table-1'],
      refused: false,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      tokensIn: 100,
      tokensOut: 20,
      evidenceCount: 1,
      elapsedMs: 1234,
    });
    assert.deepEqual(payload, {
      apiVersion: 'v1',
      answer: 'The answer is 42 [1].',
      citations: [1],
      entityRefs: ['docs/x.md#table-1'],
      refused: false,
      refusalReason: null,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      usage: { promptTokens: 100, completionTokens: 20 },
      timing: { elapsedMs: 1234 },
      evidenceCount: 1,
    });
  });

  it('never includes invalidCitations or strippedMarkers even when present on the input object', () => {
    const payload = projectDoneEvent({
      text: 'x', citations: [], nodeReferences: [], refused: false, evidenceCount: 0, elapsedMs: 1,
      invalidCitations: [2, 3], strippedMarkers: ['bad/path'],
    });
    assert.equal('invalidCitations' in payload, false);
    assert.equal('strippedMarkers' in payload, false);
  });

  it('a refusal carries refusalReason and an empty answer/citations, still the full documented shape', () => {
    const payload = projectDoneEvent({
      text: '', citations: [], nodeReferences: [], refused: true, refusalReason: 'no_evidence', evidenceCount: 0, elapsedMs: 5,
    });
    assert.equal(payload.refused, true);
    assert.equal(payload.refusalReason, 'no_evidence');
    assert.equal(payload.answer, '');
    assert.deepEqual(payload.citations, []);
  });

  it('missing provider/model/tokensIn/tokensOut normalize to null, never undefined or omitted', () => {
    const payload = projectDoneEvent({ text: '', citations: [], nodeReferences: [], refused: true, refusalReason: 'no_evidence', evidenceCount: 0, elapsedMs: 1 });
    assert.equal(payload.provider, null);
    assert.equal(payload.model, null);
    assert.deepEqual(payload.usage, { promptTokens: null, completionTokens: null });
  });
});

describe('Ask API v1 contract — projectErrorPayload', () => {
  it('includes apiVersion, code, message, and a derived retryable boolean', () => {
    const payload = projectErrorPayload(ERROR_CODES.GENERATION_FAILED, 'The model failed to respond.');
    assert.deepEqual(payload, {
      apiVersion: 'v1',
      code: 'generation_failed',
      message: 'The model failed to respond.',
      retryable: true,
    });
  });

  it('a not-retryable code produces retryable: false', () => {
    const payload = projectErrorPayload(ERROR_CODES.BAD_REQUEST, 'bad input');
    assert.equal(payload.retryable, false);
  });

  it('does not perform redaction itself — the message is passed through verbatim (caller\'s responsibility)', () => {
    const payload = projectErrorPayload(ERROR_CODES.GENERATION_FAILED, 'already-redacted-by-caller [REDACTED]');
    assert.equal(payload.message, 'already-redacted-by-caller [REDACTED]');
  });
});

describe('Ask API v1 contract — projectErrorResponseBody', () => {
  it('wraps projectErrorPayload in the standard { error: ... } envelope', () => {
    const body = projectErrorResponseBody(ERROR_CODES.NOT_FOUND, 'Collection "x" not found');
    assert.deepEqual(body, {
      error: {
        apiVersion: 'v1',
        code: 'not_found',
        message: 'Collection "x" not found',
        retryable: false,
      },
    });
  });

  it('carries the same apiVersion/retryable fields a mid-stream error SSE event would carry', () => {
    const body = projectErrorResponseBody(ERROR_CODES.BUSY, 'busy');
    assert.equal(body.error.apiVersion, 'v1');
    assert.equal(body.error.retryable, true);
  });
});

describe('Ask API v1 contract — isStructuralNodeType', () => {
  it('table, code_block, and checklist are structural', () => {
    assert.equal(isStructuralNodeType('table'), true);
    assert.equal(isStructuralNodeType('code_block'), true);
    assert.equal(isStructuralNodeType('checklist'), true);
  });

  it('paragraph and other node types are not structural', () => {
    assert.equal(isStructuralNodeType('paragraph'), false);
    assert.equal(isStructuralNodeType('section'), false);
    assert.equal(isStructuralNodeType(null), false);
    assert.equal(isStructuralNodeType(undefined), false);
  });
});
