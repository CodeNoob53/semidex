// Multi-condition visibleWhen (AND-composed array) — ONNX_BATCH_SIZE
// (DML-only), ONNXRUNTIME_NODE_PATH (CUDA-only), ONNX_CUDA_STRICT
// (CUDA-only). Each requires BOTH "BGE-M3 ONNX selected" AND a specific
// ONNX_EXECUTION_PROVIDER value — proving isFieldVisible() genuinely ANDs
// every condition in the array, not just the first/last one.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Event } from 'linkedom';
import { loadGlobalSettingsHelpers } from './ui-test-helpers.js';
import { makeEntry, settingsPayload } from './ui-global-settings-fixtures.js';

function embeddingBackendEntry(overrides = {}) {
  return makeEntry({
    key: 'EMBEDDING_BACKEND', category: 'embeddings', type: 'enum', advanced: false,
    configuredValue: 'bge-m3-onnx', activeValue: 'bge-m3-onnx',
    options: [{ value: 'ollama', label: 'Ollama' }, { value: 'bge-m3-onnx', label: 'BGE-M3 (ONNX)' }],
    appliesAt: 'new_collection',
    ...overrides,
  });
}

function onnxExecutionProviderEntry(overrides = {}) {
  return makeEntry({
    key: 'ONNX_EXECUTION_PROVIDER', category: 'embeddings', type: 'enum', advanced: true,
    configuredValue: 'cpu', activeValue: 'cpu',
    options: [{ value: 'cpu', label: 'cpu' }, { value: 'dml', label: 'dml' }, { value: 'cuda', label: 'cuda' }],
    visibleWhen: { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx' },
    appliesAt: 'next_restart',
    ...overrides,
  });
}

function onnxBatchSizeEntry(overrides = {}) {
  return makeEntry({
    key: 'ONNX_BATCH_SIZE', category: 'embeddings', type: 'number', advanced: true,
    configuredValue: 4, activeValue: 4, min: 1, max: 64,
    visibleWhen: [
      { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx' },
      { key: 'ONNX_EXECUTION_PROVIDER', equals: 'dml' },
    ],
    appliesAt: 'next_index_job',
    ...overrides,
  });
}

function onnxCudaStrictEntry(overrides = {}) {
  return makeEntry({
    key: 'ONNX_CUDA_STRICT', category: 'embeddings', type: 'boolean', advanced: true,
    configuredValue: false, activeValue: false,
    visibleWhen: [
      { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx' },
      { key: 'ONNX_EXECUTION_PROVIDER', equals: 'cuda' },
    ],
    appliesAt: 'next_restart',
    ...overrides,
  });
}

function onnxRuntimeNodePathEntry(overrides = {}) {
  return makeEntry({
    key: 'ONNXRUNTIME_NODE_PATH', category: 'embeddings', type: 'string', advanced: true,
    configuredValue: '', activeValue: '', allowEmpty: true,
    visibleWhen: [
      { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx' },
      { key: 'ONNX_EXECUTION_PROVIDER', equals: 'cuda' },
    ],
    pathPicker: true,
    appliesAt: 'next_restart',
    ...overrides,
  });
}

function allEntries(overrides = {}) {
  return [
    embeddingBackendEntry(overrides.backend),
    onnxExecutionProviderEntry(overrides.provider),
    onnxBatchSizeEntry(overrides.batchSize),
    onnxCudaStrictEntry(overrides.cudaStrict),
    onnxRuntimeNodePathEntry(overrides.runtimePath),
  ];
}

async function renderWith(entries) {
  const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
    apiResponses: { '/api/settings': settingsPayload(entries) },
  });
  await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');
  document.querySelector('.gs-advanced')?.setAttribute('open', '');
  return document;
}

describe('visibleWhen array (AND) — ONNX hardware controls', () => {
  it('CPU provider: hides ONNX_BATCH_SIZE, ONNX_CUDA_STRICT, and ONNXRUNTIME_NODE_PATH (neither DML nor CUDA)', async () => {
    const document = await renderWith(allEntries({ provider: { configuredValue: 'cpu', activeValue: 'cpu' } }));
    assert.equal(document.querySelector('[data-key="ONNX_BATCH_SIZE"]'), null);
    assert.equal(document.querySelector('[data-key="ONNX_CUDA_STRICT"]'), null);
    assert.equal(document.querySelector('[data-key="ONNXRUNTIME_NODE_PATH"]'), null);
    assert.ok(document.querySelector('[data-key="ONNX_EXECUTION_PROVIDER"]'), 'the provider selector itself stays visible for BGE-M3 ONNX');
  });

  it('DML provider: shows ONNX_BATCH_SIZE, hides ONNX_CUDA_STRICT and ONNXRUNTIME_NODE_PATH (CUDA-only fields)', async () => {
    const document = await renderWith(allEntries({ provider: { configuredValue: 'dml', activeValue: 'dml' } }));
    assert.ok(document.querySelector('[data-key="ONNX_BATCH_SIZE"]'), 'batch size must be visible for DML');
    assert.equal(document.querySelector('[data-key="ONNX_CUDA_STRICT"]'), null);
    assert.equal(document.querySelector('[data-key="ONNXRUNTIME_NODE_PATH"]'), null);
  });

  it('CUDA provider: shows ONNX_CUDA_STRICT and ONNXRUNTIME_NODE_PATH, hides ONNX_BATCH_SIZE (DML-only, not implemented for CUDA)', async () => {
    const document = await renderWith(allEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }));
    assert.equal(document.querySelector('[data-key="ONNX_BATCH_SIZE"]'), null, 'CUDA batching is not implemented — batch size must not appear');
    assert.ok(document.querySelector('[data-key="ONNX_CUDA_STRICT"]'), 'strict CUDA toggle must be visible for CUDA');
    assert.ok(document.querySelector('[data-key="ONNXRUNTIME_NODE_PATH"]'), 'custom runtime path must be visible for CUDA');
  });

  it('EMBEDDING_BACKEND=ollama: every ONNX-specific field is hidden regardless of ONNX_EXECUTION_PROVIDER staged value (both AND conditions must hold, not just one)', async () => {
    const document = await renderWith(allEntries({
      backend: { configuredValue: 'ollama', activeValue: 'ollama' },
      provider: { configuredValue: 'cuda', activeValue: 'cuda' }, // even with provider=cuda staged
    }));
    assert.equal(document.querySelector('[data-key="ONNX_EXECUTION_PROVIDER"]'), null);
    assert.equal(document.querySelector('[data-key="ONNX_BATCH_SIZE"]'), null);
    assert.equal(document.querySelector('[data-key="ONNX_CUDA_STRICT"]'), null);
    assert.equal(document.querySelector('[data-key="ONNXRUNTIME_NODE_PATH"]'), null);
  });

  it('switching ONNX_EXECUTION_PROVIDER from cpu to cuda via a STAGED (unsaved) change immediately reveals CUDA-only controls, no Save round trip', async () => {
    const document = await renderWith(allEntries({ provider: { configuredValue: 'cpu', activeValue: 'cpu' } }));
    assert.equal(document.querySelector('[data-key="ONNX_CUDA_STRICT"]'), null);

    const providerSelect = document.querySelector('[data-key="ONNX_EXECUTION_PROVIDER"]');
    providerSelect.querySelector('option[value="cuda"]').selected = true;
    providerSelect.dispatchEvent(new Event('change'));

    document.querySelector('.gs-advanced')?.setAttribute('open', '');
    assert.ok(document.querySelector('[data-key="ONNX_CUDA_STRICT"]'), 'strict CUDA toggle must appear immediately after the staged change');
    assert.ok(document.querySelector('[data-key="ONNXRUNTIME_NODE_PATH"]'), 'runtime path must appear immediately after the staged change');
    assert.equal(document.querySelector('[data-key="ONNX_BATCH_SIZE"]'), null, 'batch size must remain hidden (DML-only)');
  });

  it('switching ONNX_EXECUTION_PROVIDER from cuda to dml via a STAGED change swaps which controls are visible', async () => {
    const document = await renderWith(allEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }));
    assert.ok(document.querySelector('[data-key="ONNX_CUDA_STRICT"]'));
    assert.equal(document.querySelector('[data-key="ONNX_BATCH_SIZE"]'), null);

    const providerSelect = document.querySelector('[data-key="ONNX_EXECUTION_PROVIDER"]');
    providerSelect.querySelector('option[value="dml"]').selected = true;
    providerSelect.dispatchEvent(new Event('change'));

    document.querySelector('.gs-advanced')?.setAttribute('open', '');
    assert.equal(document.querySelector('[data-key="ONNX_CUDA_STRICT"]'), null, 'strict CUDA toggle must disappear for DML');
    assert.equal(document.querySelector('[data-key="ONNXRUNTIME_NODE_PATH"]'), null, 'runtime path must disappear for DML');
    assert.ok(document.querySelector('[data-key="ONNX_BATCH_SIZE"]'), 'batch size must appear for DML');
  });

  it('a driver missing from the payload fails OPEN for that condition (never hides a field it cannot evaluate) — matches the single-condition contract exactly', async () => {
    // Omit ONNX_EXECUTION_PROVIDER from the payload entirely; only
    // EMBEDDING_BACKEND is present. ONNX_CUDA_STRICT's second condition
    // (driver ONNX_EXECUTION_PROVIDER) cannot be evaluated, so it must
    // fail open for THAT condition — but the first condition
    // (EMBEDDING_BACKEND=bge-m3-onnx) is still evaluated normally.
    const entries = [embeddingBackendEntry(), onnxCudaStrictEntry()];
    const document = await renderWith(entries);
    assert.ok(document.querySelector('[data-key="ONNX_CUDA_STRICT"]'), 'missing driver must fail open for that one condition, not hide the field');
  });
});
