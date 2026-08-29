// Tests for the hand-written response validators consumed by the Overview
// v2 vertical slice (design plan §5.1, §8.2, §13 S1):
// shared/api/contracts/{health,generation,capabilities,collections}.js.
// Plain ESM imports, no DOM dependency — same convention as
// ui-contracts-operations.test.js for the sibling operations validators.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../../../src/shared/admin/ui-src/shared/api/client.js';
import { validateHealthResponse } from '../../../src/shared/admin/ui-src/shared/api/contracts/health.js';
import { validateGenerationStatusResponse } from '../../../src/shared/admin/ui-src/shared/api/contracts/generation.js';
import { validateCapabilitiesResponse } from '../../../src/shared/admin/ui-src/shared/api/contracts/capabilities.js';
import { validateCollectionsListResponse } from '../../../src/shared/admin/ui-src/shared/api/contracts/collections.js';

function assertContractError(fn) {
  assert.throws(fn, (err) => err instanceof ApiError && err.kind === 'contract');
}

describe('validateHealthResponse()', () => {
  const valid = { ok: true, storage: { backend: 'qdrant', ok: true, detail: null } };

  it('passes a valid payload through unchanged', () => {
    assert.deepEqual(validateHealthResponse(valid), valid);
  });

  it('accepts a string detail too', () => {
    const body = { ok: false, storage: { backend: 'qdrant', ok: false, detail: 'connection refused' } };
    assert.deepEqual(validateHealthResponse(body), body);
  });

  it('rejects a non-object body', () => assertContractError(() => validateHealthResponse(null)));
  it('rejects a missing "ok" field', () => assertContractError(() => validateHealthResponse({ storage: valid.storage })));
  it('rejects a wrong-typed "ok" field', () => assertContractError(() => validateHealthResponse({ ok: 'yes', storage: valid.storage })));
  it('rejects a missing "storage" object', () => assertContractError(() => validateHealthResponse({ ok: true })));
  it('rejects an empty storage.backend', () => assertContractError(() => validateHealthResponse({ ok: true, storage: { backend: '', ok: true, detail: null } })));
  it('rejects a wrong-typed storage.ok', () => assertContractError(() => validateHealthResponse({ ok: true, storage: { backend: 'qdrant', ok: 'yes', detail: null } })));
  it('rejects a wrong-typed storage.detail', () => assertContractError(() => validateHealthResponse({ ok: true, storage: { backend: 'qdrant', ok: true, detail: 42 } })));
});

describe('validateGenerationStatusResponse()', () => {
  const valid = {
    backend: 'ollama', model: 'qwen2.5', ready: true, reason: null, numCtx: 4096,
    capabilities: { streaming: true, clientAbort: true, upstreamCancellation: false },
    devicePolicy: { value: 'auto', supported: ['auto', 'cpu', 'gpu'] },
    configuration: { backend: { source: 'env' } },
  };

  it('passes a valid ready payload through unchanged', () => {
    assert.deepEqual(validateGenerationStatusResponse(valid), valid);
  });

  it('passes a valid not-ready (config error) payload — null backend/model/numCtx/configuration is legitimate', () => {
    const body = {
      backend: null, model: null, ready: false, reason: 'ASK_BACKEND is not configured',
      numCtx: null, capabilities: { streaming: false, clientAbort: false, upstreamCancellation: false },
      devicePolicy: { value: null, supported: ['auto', 'cpu', 'gpu'] },
      configuration: null,
    };
    assert.deepEqual(validateGenerationStatusResponse(body), body);
  });

  it('rejects a non-object body', () => assertContractError(() => validateGenerationStatusResponse(undefined)));
  it('rejects a missing "ready" field', () => assertContractError(() => validateGenerationStatusResponse({ ...valid, ready: undefined })));
  it('rejects a wrong-typed "ready" field', () => assertContractError(() => validateGenerationStatusResponse({ ...valid, ready: 'true' })));
  it('rejects a wrong-typed "reason" field', () => assertContractError(() => validateGenerationStatusResponse({ ...valid, reason: 42 })));
  it('rejects a non-finite numCtx', () => assertContractError(() => validateGenerationStatusResponse({ ...valid, numCtx: NaN })));
  it('rejects a missing "capabilities" object', () => assertContractError(() => validateGenerationStatusResponse({ ...valid, capabilities: undefined })));
  it('rejects a missing "devicePolicy" object', () => assertContractError(() => validateGenerationStatusResponse({ ...valid, devicePolicy: undefined })));
  it('rejects devicePolicy.supported not being an array of strings', () => assertContractError(() => validateGenerationStatusResponse({ ...valid, devicePolicy: { value: 'auto', supported: [1, 2] } })));
  it('rejects a wrong-typed "configuration" field', () => assertContractError(() => validateGenerationStatusResponse({ ...valid, configuration: 'nope' })));
});

describe('validateCapabilitiesResponse()', () => {
  const valid = { backend: 'qdrant', capabilities: { namedVectors: true, sparseVectors: true, aliases: false } };

  it('passes a valid payload through unchanged', () => {
    assert.deepEqual(validateCapabilitiesResponse(valid), valid);
  });

  it('tolerates an unknown capability key, as long as its value is boolean (forward compatibility)', () => {
    const body = { backend: 'qdrant', capabilities: { neverSeenBefore: true } };
    assert.deepEqual(validateCapabilitiesResponse(body), body);
  });

  it('rejects a non-object body', () => assertContractError(() => validateCapabilitiesResponse([])));
  it('rejects an empty backend string', () => assertContractError(() => validateCapabilitiesResponse({ backend: '', capabilities: {} })));
  it('rejects a missing "capabilities" object', () => assertContractError(() => validateCapabilitiesResponse({ backend: 'qdrant' })));
  it('rejects a non-boolean capability value', () => assertContractError(() => validateCapabilitiesResponse({ backend: 'qdrant', capabilities: { namedVectors: 'yes' } })));
});

describe('validateCollectionsListResponse()', () => {
  const validCollection = {
    name: 'my-docs', pointCount: 42, vectorSchema: 'named',
    provider: { denseProvider: 'ollama', denseModel: 'bge-m3', sparseProvider: 'hashed-tf' },
    embeddingProfileState: 'valid', description: null,
  };

  it('passes a valid payload through unchanged', () => {
    const body = { collections: [validCollection] };
    assert.deepEqual(validateCollectionsListResponse(body), body);
  });

  it('passes an empty collections array (legitimate empty state)', () => {
    assert.deepEqual(validateCollectionsListResponse({ collections: [] }), { collections: [] });
  });

  it('rejects a non-object body', () => assertContractError(() => validateCollectionsListResponse('nope')));
  it('rejects a non-array "collections" field', () => assertContractError(() => validateCollectionsListResponse({ collections: {} })));
  it('rejects a collection missing "name"', () => assertContractError(() => validateCollectionsListResponse({ collections: [{ ...validCollection, name: undefined }] })));
  it('rejects a non-finite pointCount', () => assertContractError(() => validateCollectionsListResponse({ collections: [{ ...validCollection, pointCount: 'lots' }] })));
  it('rejects an empty vectorSchema string', () => assertContractError(() => validateCollectionsListResponse({ collections: [{ ...validCollection, vectorSchema: '' }] })));
  it('rejects a missing "provider" object', () => assertContractError(() => validateCollectionsListResponse({ collections: [{ ...validCollection, provider: undefined }] })));
  it('rejects a wrong-typed provider.denseProvider', () => assertContractError(() => validateCollectionsListResponse({ collections: [{ ...validCollection, provider: { ...validCollection.provider, denseProvider: 7 } }] })));
  it('rejects an empty embeddingProfileState', () => assertContractError(() => validateCollectionsListResponse({ collections: [{ ...validCollection, embeddingProfileState: '' }] })));
  it('rejects a wrong-typed description', () => assertContractError(() => validateCollectionsListResponse({ collections: [{ ...validCollection, description: 7 }] })));
  it('reports the index of the first malformed entry in the error message', () => {
    assert.throws(
      () => validateCollectionsListResponse({ collections: [validCollection, { ...validCollection, name: '' }] }),
      (err) => err instanceof ApiError && err.kind === 'contract' && err.message.includes('collections[1]'),
    );
  });
});
