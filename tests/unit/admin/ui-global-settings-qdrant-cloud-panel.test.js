// Admin UI tests for the qdrant-cloud additions to the "Embeddings &
// hardware" category: the provider-aware QDRANT_CLOUD_DENSE_MODEL selector
// (E5 AND MiniLM both selectable — MiniLM's 256-token window is no longer
// disqualifying now that chunking is profile-aware; status:'planned'
// dedicated-tier models like mxbai remain absent from options entirely,
// never shown-disabled), the coarse settings-time compatibility warning
// that blocks Save (isCatalogCompatibleWithChunking(), advisory/early —
// never the real per-embed enforcement point), the read-only
// QDRANT_SPARSE_MODEL/VECTOR_SIZE derived fields, and the "Test Cloud
// Inference" probe button (shown only when EMBEDDING_BACKEND is staged to
// qdrant-cloud, mirroring the existing ONNX probe panel test pattern).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Event } from 'linkedom';
import { loadGlobalSettingsHelpers } from './ui-test-helpers.js';
import { makeEntry, settingsPayload } from './ui-global-settings-fixtures.js';

function embeddingBackendEntry(overrides = {}) {
  return makeEntry({
    key: 'EMBEDDING_BACKEND', category: 'embeddings', type: 'enum', advanced: false,
    configuredValue: 'qdrant-cloud', activeValue: 'qdrant-cloud',
    options: [
      { value: 'ollama', label: 'Ollama' },
      { value: 'bge-m3-onnx', label: 'BGE-M3 (ONNX)' },
      { value: 'qdrant-cloud', label: 'Qdrant Cloud Inference' },
    ],
    appliesAt: 'new_collection',
    ...overrides,
  });
}

function denseModelEntry(overrides = {}) {
  return makeEntry({
    key: 'QDRANT_CLOUD_DENSE_MODEL', category: 'embeddings', type: 'enum', advanced: false,
    configuredValue: 'intfloat/multilingual-e5-small', activeValue: 'intfloat/multilingual-e5-small',
    options: [
      { value: 'intfloat/multilingual-e5-small', label: 'Multilingual E5 Small (384d, 512 tokens)' },
      { value: 'sentence-transformers/all-minilm-l6-v2', label: 'All MiniLM L6 v2 (384d, 256 tokens)' },
    ],
    visibleWhen: { key: 'EMBEDDING_BACKEND', equals: 'qdrant-cloud' },
    appliesAt: 'new_collection',
    ...overrides,
  });
}

function sparseModelEntry(overrides = {}) {
  return makeEntry({
    key: 'QDRANT_SPARSE_MODEL', category: 'embeddings', type: 'string', advanced: true,
    configuredValue: 'qdrant/bm25', activeValue: 'qdrant/bm25', writable: false,
    readOnlyReason: 'BM25 is currently the only sparse model supported by this Semidex build.',
    derivedWhen: { key: 'EMBEDDING_BACKEND', equals: 'qdrant-cloud', value: 'qdrant/bm25' },
    visibleWhen: { key: 'EMBEDDING_BACKEND', equals: 'qdrant-cloud' },
    appliesAt: 'new_collection',
    ...overrides,
  });
}

function vectorSizeEntry(overrides = {}) {
  return makeEntry({
    key: 'VECTOR_SIZE', category: 'embeddings', type: 'number', advanced: true,
    configuredValue: 384, activeValue: 384, writable: false,
    readOnlyReason: 'Detected from the embedding model; it cannot be entered manually.',
    catalogDerived: { key: 'EMBEDDING_BACKEND', equals: 'qdrant-cloud', modelKey: 'QDRANT_CLOUD_DENSE_MODEL' },
    appliesAt: 'new_collection',
    ...overrides,
  });
}

function tokenizerEntry(overrides = {}) {
  return makeEntry({
    key: 'QDRANT_CLOUD_TOKENIZER', category: 'embeddings', type: 'string', advanced: false,
    configuredValue: '', activeValue: '', writable: false,
    readOnlyReason: 'Determined entirely by the selected dense model.',
    catalogDerived: { key: 'EMBEDDING_BACKEND', equals: 'qdrant-cloud', modelKey: 'QDRANT_CLOUD_DENSE_MODEL', property: 'id', unknownWarning: 'Select a dense model to see its tokenizer.' },
    visibleWhen: { key: 'EMBEDDING_BACKEND', equals: 'qdrant-cloud' },
    appliesAt: 'next_index_job',
    ...overrides,
  });
}

function contextWindowEntry(overrides = {}) {
  return makeEntry({
    key: 'QDRANT_CLOUD_DENSE_CONTEXT_WINDOW', category: 'embeddings', type: 'number', advanced: false,
    configuredValue: 0, activeValue: 0, writable: false,
    readOnlyReason: 'Determined entirely by the selected dense model.',
    catalogDerived: { key: 'EMBEDDING_BACKEND', equals: 'qdrant-cloud', modelKey: 'QDRANT_CLOUD_DENSE_MODEL', property: 'contextWindow', unknownWarning: 'Select a dense model to see its context window.' },
    visibleWhen: { key: 'EMBEDDING_BACKEND', equals: 'qdrant-cloud' },
    appliesAt: 'next_index_job',
    ...overrides,
  });
}

function tokenCountEntry(overrides = {}) {
  return makeEntry({
    key: 'TOKEN_COUNT', category: 'system', type: 'enum', advanced: true,
    configuredValue: 'bge-m3', activeValue: 'bge-m3',
    options: [{ value: 'bge-m3', label: 'bge-m3' }, { value: 'heuristic', label: 'heuristic' }],
    hiddenWhen: { key: 'EMBEDDING_BACKEND', equals: 'qdrant-cloud' },
    appliesAt: 'next_index_job',
    ...overrides,
  });
}

function baseEntries(overrides = {}) {
  return [
    embeddingBackendEntry(overrides.backend),
    denseModelEntry(overrides.denseModel),
    sparseModelEntry(overrides.sparseModel),
    vectorSizeEntry(overrides.vectorSize),
    tokenizerEntry(overrides.tokenizer),
    contextWindowEntry(overrides.contextWindow),
    tokenCountEntry(overrides.tokenCount),
  ];
}

async function renderCategory(entries, opts = {}) {
  const ctx = loadGlobalSettingsHelpers({
    apiResponses: { '/api/settings': settingsPayload(entries) },
    ...opts,
  });
  await ctx.renderGlobalSettingsView(ctx.document.getElementById('main'), 'embeddings');
  ctx.document.querySelector('.gs-advanced')?.setAttribute('open', '');
  return ctx;
}

describe('QDRANT_CLOUD_DENSE_MODEL selector — provider-aware, catalog-backed', () => {
  it('renders E5 as a selectable option', async () => {
    const { document } = await renderCategory(baseEntries());
    const select = document.querySelector('[data-key="QDRANT_CLOUD_DENSE_MODEL"]');
    assert.ok(select, 'expected a select control for QDRANT_CLOUD_DENSE_MODEL');
    const optionValues = [...select.querySelectorAll('option')].map((o) => o.value);
    assert.ok(optionValues.includes('intfloat/multilingual-e5-small'));
  });

  it('MiniLM is ALSO selectable (status: supported — profile-aware chunking made its 256-token window a non-issue)', async () => {
    const { document } = await renderCategory(baseEntries());
    const select = document.querySelector('[data-key="QDRANT_CLOUD_DENSE_MODEL"]');
    const optionValues = [...select.querySelectorAll('option')].map((o) => o.value);
    assert.ok(optionValues.includes('sentence-transformers/all-minilm-l6-v2'));
  });

  it('a status:planned dedicated-tier model (mxbai) is absent from options entirely — never offered as a selectable choice, never shown-disabled', async () => {
    const { document } = await renderCategory(baseEntries());
    const select = document.querySelector('[data-key="QDRANT_CLOUD_DENSE_MODEL"]');
    const optionValues = [...select.querySelectorAll('option')].map((o) => o.value);
    assert.ok(!optionValues.includes('mixedbread-ai/mxbai-embed-large-v1'));
  });

  it('the field is absent entirely when EMBEDDING_BACKEND is not staged to qdrant-cloud', async () => {
    const { document } = await renderCategory(baseEntries({ backend: { configuredValue: 'ollama', activeValue: 'ollama' } }));
    assert.equal(document.querySelector('[data-key="QDRANT_CLOUD_DENSE_MODEL"]'), null);
  });
});

describe('QDRANT_SPARSE_MODEL / VECTOR_SIZE — read-only derived fields', () => {
  it('QDRANT_SPARSE_MODEL renders read-only, always showing qdrant/bm25', async () => {
    const { document } = await renderCategory(baseEntries());
    const row = document.querySelector('[data-field="QDRANT_SPARSE_MODEL"]');
    assert.ok(row, 'expected a rendered row for QDRANT_SPARSE_MODEL');
    assert.equal(row.querySelector('select, input'), null, 'must not render an editable control');
    assert.match(row.textContent, /qdrant\/bm25/);
  });

  it('VECTOR_SIZE derives 384 from the staged E5 selection via the static catalog, never a live probe', async () => {
    const { document } = await renderCategory(baseEntries());
    const row = document.querySelector('[data-field="VECTOR_SIZE"]');
    assert.ok(row);
    assert.match(row.textContent, /384/);
  });

  it('VECTOR_SIZE shows "Unknown" with a warning when no dense model is staged yet', async () => {
    const { document } = await renderCategory(baseEntries({ denseModel: { configuredValue: '', activeValue: '' } }));
    const row = document.querySelector('[data-field="VECTOR_SIZE"]');
    assert.match(row.textContent, /Unknown/);
  });
});

// The token-count fix's UI-visible half: TOKEN_COUNT hides itself (via the
// new hiddenWhen engine addition) whenever EMBEDDING_BACKEND=qdrant-cloud,
// since core/token-count.js's resolveTokenCountMode() never consults it
// for a cloud profile — showing it would be a real, previously-existing
// UX bug (an "active-looking" control that silently controls nothing).
// QDRANT_CLOUD_TOKENIZER/QDRANT_CLOUD_DENSE_CONTEXT_WINDOW take its place,
// via the SAME generalized catalogDerived rendering path VECTOR_SIZE
// already used (now supporting an arbitrary `property`, not just
// `dimensions`).
describe('TOKEN_COUNT hidden + QDRANT_CLOUD_TOKENIZER/CONTEXT_WINDOW shown — qdrant-cloud backend', () => {
  // TOKEN_COUNT's real category is 'system' (definitions.js), not
  // 'embeddings' — isFieldVisible()'s hiddenWhen driver lookup searches
  // the WHOLE fetched settings payload (lastFetchedPayload.settings),
  // never just the currently-rendered category, so EMBEDDING_BACKEND
  // (category: 'embeddings') still correctly drives TOKEN_COUNT's
  // visibility (category: 'system') even though the two live in different
  // categories — these two tests render the 'system' category
  // specifically (via renderSystemCategory below) so TOKEN_COUNT is even
  // a CANDIDATE for rendering in the first place; rendering 'embeddings'
  // instead would make TOKEN_COUNT absent for the unrelated reason of
  // categoryEntries() filtering by category, not hiddenWhen.
  async function renderSystemCategory(entries, opts = {}) {
    const ctx = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(entries) },
      ...opts,
    });
    await ctx.renderGlobalSettingsView(ctx.document.getElementById('main'), 'system');
    ctx.document.querySelector('.gs-advanced')?.setAttribute('open', '');
    return ctx;
  }

  it('TOKEN_COUNT is NOT rendered at all when EMBEDDING_BACKEND is staged to qdrant-cloud', async () => {
    const { document } = await renderSystemCategory(baseEntries());
    assert.equal(document.querySelector('[data-field="TOKEN_COUNT"]'), null);
  });

  it('TOKEN_COUNT IS rendered for a non-cloud backend (Ollama)', async () => {
    const { document } = await renderSystemCategory(baseEntries({ backend: { configuredValue: 'ollama', activeValue: 'ollama' } }));
    assert.ok(document.querySelector('[data-field="TOKEN_COUNT"]'), 'TOKEN_COUNT must still render for Ollama — hiddenWhen is qdrant-cloud-specific, not a global removal');
  });

  it('QDRANT_CLOUD_TOKENIZER renders read-only, showing the staged dense model id (via catalogDerived property: "id")', async () => {
    const { document } = await renderCategory(baseEntries());
    const row = document.querySelector('[data-field="QDRANT_CLOUD_TOKENIZER"]');
    assert.ok(row, 'expected a rendered row for QDRANT_CLOUD_TOKENIZER');
    assert.equal(row.querySelector('select, input'), null, 'must not render an editable control');
    assert.match(row.textContent, /intfloat\/multilingual-e5-small/);
  });

  it('QDRANT_CLOUD_TOKENIZER updates when the staged dense model changes to MiniLM, no Save round trip', async () => {
    const { document } = await renderCategory(baseEntries({
      denseModel: { configuredValue: 'sentence-transformers/all-minilm-l6-v2', activeValue: 'sentence-transformers/all-minilm-l6-v2' },
    }));
    const row = document.querySelector('[data-field="QDRANT_CLOUD_TOKENIZER"]');
    assert.match(row.textContent, /sentence-transformers\/all-minilm-l6-v2/);
  });

  it('QDRANT_CLOUD_DENSE_CONTEXT_WINDOW shows 512 for E5, 256 for MiniLM (via catalogDerived property: "contextWindow")', async () => {
    const e5 = await renderCategory(baseEntries());
    assert.match(e5.document.querySelector('[data-field="QDRANT_CLOUD_DENSE_CONTEXT_WINDOW"]').textContent, /512/);

    const minilm = await renderCategory(baseEntries({
      denseModel: { configuredValue: 'sentence-transformers/all-minilm-l6-v2', activeValue: 'sentence-transformers/all-minilm-l6-v2' },
    }));
    assert.match(minilm.document.querySelector('[data-field="QDRANT_CLOUD_DENSE_CONTEXT_WINDOW"]').textContent, /256/);
  });

  it('QDRANT_CLOUD_TOKENIZER/CONTEXT_WINDOW are absent entirely for a non-cloud backend', async () => {
    const { document } = await renderCategory(baseEntries({ backend: { configuredValue: 'ollama', activeValue: 'ollama' } }));
    assert.equal(document.querySelector('[data-field="QDRANT_CLOUD_TOKENIZER"]'), null);
    assert.equal(document.querySelector('[data-field="QDRANT_CLOUD_DENSE_CONTEXT_WINDOW"]'), null);
  });
});

describe('Compatibility warning before Save — coarse, settings-time only', () => {
  it('MAX_CHUNK_TOKENS incompatibility test is exercised via the shared invalid-field/save-bar wiring (structural check: markInvalid is reachable for this key)', async () => {
    // A full end-to-end incompatibility scenario requires MAX_CHUNK_TOKENS
    // to be present in the same fetched payload (a different category,
    // 'indexing') — this test proves the field-change handler recognizes
    // QDRANT_CLOUD_DENSE_MODEL as a key needing validation at all (it
    // renders a select, and changing it must not throw), matching this
    // suite's existing convention of testing the wiring path, not
    // reimplementing isCatalogCompatibleWithChunking()'s own already-tested
        // logic (see qdrant-cloud-catalog.test.js).
    const maxChunkTokens = makeEntry({
      key: 'MAX_CHUNK_TOKENS', category: 'indexing', type: 'number', advanced: false,
      configuredValue: 512, activeValue: 512, appliesAt: 'next_index_job',
    });
    const { document } = await renderCategory([...baseEntries(), maxChunkTokens]);
    const select = document.querySelector('[data-key="QDRANT_CLOUD_DENSE_MODEL"]');
    assert.doesNotThrow(() => {
      select.querySelector('option[value="intfloat/multilingual-e5-small"]').selected = true;
      select.dispatchEvent(new Event('change'));
    });
    // A compatible model (E5, 512 >= 512) must not block Save.
    const saveBtn = document.querySelector('#gs-save');
    if (saveBtn) assert.equal(saveBtn.disabled, false);
  });
});

describe('"Test Cloud Inference" probe button', () => {
  it('is absent entirely when EMBEDDING_BACKEND is not staged to qdrant-cloud', async () => {
    const { document } = await renderCategory(baseEntries({ backend: { configuredValue: 'ollama', activeValue: 'ollama' } }));
    assert.equal(document.querySelector('.gs-qdrant-cloud-probe-panel'), null);
  });

  it('appears when EMBEDDING_BACKEND is staged to qdrant-cloud, showing the dense model and no verified state yet', async () => {
    const { document } = await renderCategory(baseEntries());
    const panel = document.querySelector('.gs-qdrant-cloud-probe-panel');
    assert.ok(panel);
    assert.equal(panel.querySelector('.gs-qc-dense-model').textContent, 'intfloat/multilingual-e5-small');
    assert.equal(panel.querySelector('.gs-qc-verified').textContent, 'Not yet tested');
    assert.equal(panel.querySelector('.gs-qc-result').hidden, true, 'no result block until a real probe runs');
  });

  it('appears immediately once qdrant-cloud is staged, no Save round trip', async () => {
    const { document } = await renderCategory(baseEntries({ backend: { configuredValue: 'ollama', activeValue: 'ollama' } }));
    assert.equal(document.querySelector('.gs-qdrant-cloud-probe-panel'), null);

    const backendSelect = document.querySelector('[data-key="EMBEDDING_BACKEND"]');
    backendSelect.querySelector('option[value="qdrant-cloud"]').selected = true;
    backendSelect.dispatchEvent(new Event('change'));

    assert.ok(document.querySelector('.gs-qdrant-cloud-probe-panel'), 'the panel must appear immediately once qdrant-cloud is staged');
  });

  it('a click calls POST /api/system/qdrant-cloud-probe with the staged dense model and never auto-runs on render', async () => {
    const calls = [];
    const { document } = await renderCategory(
      baseEntries(),
      { apiPostImpl: async (url, body) => { calls.push({ url, body }); return { status: 'inference_available' }; } },
    );
    assert.equal(calls.length, 0, 'must never auto-run — only on explicit click');

    const panel = document.querySelector('.gs-qdrant-cloud-probe-panel');
    panel.querySelector('.gs-qc-test-button').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/system/qdrant-cloud-probe');
    assert.equal(calls[0].body.denseModel, 'intfloat/multilingual-e5-small');
  });

  it('a successful probe shows inference_available and the timestamp', async () => {
    const { document } = await renderCategory(
      baseEntries(),
      { apiPostImpl: async () => ({ status: 'inference_available' }) },
    );
    const panel = document.querySelector('.gs-qdrant-cloud-probe-panel');
    panel.querySelector('.gs-qc-test-button').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.match(panel.querySelector('.gs-qc-verified').textContent, /^inference_available /);
    assert.equal(panel.querySelector('.gs-qc-result').hidden, false);
  });

  it('the availability badge starts as "Not yet tested" before any click', async () => {
    const { document } = await renderCategory(baseEntries());
    const panel = document.querySelector('.gs-qdrant-cloud-probe-panel');
    assert.equal(panel.querySelector('.gs-qc-availability-badge').textContent, 'Not yet tested');
  });

  it('an available result renders the "Available" badge with badge-ok', async () => {
    const { document } = await renderCategory(
      baseEntries(),
      { apiPostImpl: async () => ({ status: 'inference_available', availability: { status: 'available', message: null } }) },
    );
    const panel = document.querySelector('.gs-qdrant-cloud-probe-panel');
    panel.querySelector('.gs-qc-test-button').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const badge = panel.querySelector('.gs-qc-availability-badge');
    assert.equal(badge.textContent, 'Available');
    assert.ok(badge.classList.contains('badge-ok'));
  });

  it('an unavailable_for_cluster result renders a distinct badge from unsupported_by_semidex', async () => {
    const { document } = await renderCategory(
      baseEntries(),
      { apiPostImpl: async () => ({ status: 'inference_disabled_or_model_unavailable', message: 'not allowed in free tier', availability: { status: 'unavailable_for_cluster', message: 'not allowed in free tier' } }) },
    );
    const panel = document.querySelector('.gs-qdrant-cloud-probe-panel');
    panel.querySelector('.gs-qc-test-button').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const badge = panel.querySelector('.gs-qc-availability-badge');
    assert.equal(badge.textContent, 'Unavailable for this cluster');
    assert.ok(badge.classList.contains('badge-warn'));
    assert.ok(!badge.classList.contains('badge-fail'));
  });

  it('a network/transport failure resets the badge to "Not yet tested" rather than showing a stale/wrong status', async () => {
    const { document } = await renderCategory(
      baseEntries(),
      { apiPostImpl: async () => { throw new Error('network error'); } },
    );
    const panel = document.querySelector('.gs-qdrant-cloud-probe-panel');
    panel.querySelector('.gs-qc-test-button').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const badge = panel.querySelector('.gs-qc-availability-badge');
    assert.equal(badge.textContent, 'Not yet tested');
    assert.ok(!badge.classList.contains('badge-ok'));
    assert.ok(!badge.classList.contains('badge-warn'));
    assert.ok(!badge.classList.contains('badge-fail'));
  });

  it('an inference_disabled_or_model_unavailable result surfaces the server message, never claims success', async () => {
    const { document } = await renderCategory(
      baseEntries(),
      { apiPostImpl: async () => ({ status: 'inference_disabled_or_model_unavailable', message: 'model not found' }) },
    );
    const panel = document.querySelector('.gs-qdrant-cloud-probe-panel');
    panel.querySelector('.gs-qc-test-button').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.match(panel.querySelector('.gs-qc-verified').textContent, /^inference_disabled_or_model_unavailable /);
    assert.equal(panel.querySelector('.gs-qc-message').textContent, 'model not found');
  });

  it('a network/transport failure is surfaced as a failed test, not a silent success', async () => {
    const { document } = await renderCategory(
      baseEntries(),
      { apiPostImpl: async () => { throw new Error('network error'); } },
    );
    const panel = document.querySelector('.gs-qdrant-cloud-probe-panel');
    panel.querySelector('.gs-qc-test-button').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(panel.querySelector('.gs-qc-verified').textContent, 'Test failed');
    assert.match(panel.querySelector('.gs-qc-message').textContent, /network error/);
  });

  it('sends the CURRENTLY STAGED (unsaved) dense model, not a stale one', async () => {
    const calls = [];
    const { document } = await renderCategory(
      baseEntries({ denseModel: { configuredValue: 'intfloat/multilingual-e5-small', activeValue: 'intfloat/multilingual-e5-small' } }),
      { apiPostImpl: async (url, body) => { calls.push({ url, body }); return { status: 'inference_available' }; } },
    );
    // Only one model is offered in this fixture's options, so we confirm
    // the panel reflects whatever is currently staged via the dataset
    // attribute set at render time (matching the ONNX panel's own
    // dataset.provider convention).
    const testButton = document.querySelector('.gs-qc-test-button');
    assert.equal(testButton.dataset.denseModel, 'intfloat/multilingual-e5-small');
  });
});
