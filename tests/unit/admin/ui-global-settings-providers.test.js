// Provider-aware model discovery and embedding settings behavior.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Event } from 'linkedom';
import { loadGlobalSettingsHelpers } from './ui-test-helpers.js';
import { makeEntry, settingsPayload } from './ui-global-settings-fixtures.js';

// ── Provider-aware model discovery (visibleWhen/dynamicOptions/derivedWhen) ─

const OLLAMA_MODELS_MIXED = {
  available: true, reason: null,
  models: [
    { name: 'gemma3:4b', capabilities: ['completion'], embeddingDimension: null, parameterSize: '4.3B', family: 'gemma3' },
    { name: 'llama3.2:3b', capabilities: ['completion'], embeddingDimension: null, parameterSize: '3.2B', family: 'llama' },
    { name: 'nomic-embed-text', capabilities: ['embedding'], embeddingDimension: 768, parameterSize: '137M', family: 'nomic-bert' },
  ],
};

const OLLAMA_MODELS_UNREACHABLE = {
  available: false, reason: 'Ollama is not reachable at http://localhost:11434. Start it with "ollama serve".', models: [],
};

function tagProviderEntry(overrides = {}) {
  return makeEntry({
    key: 'TAG_PROVIDER', category: 'ai', type: 'enum', advanced: false,
    configuredValue: 'ollama', activeValue: 'ollama',
    options: [{ value: 'ollama', label: 'ollama' }, { value: 'onnx', label: 'onnx' }],
    appliesAt: 'next_index_job', requiresBackfill: true,
    ...overrides,
  });
}

function tagModelEntry(overrides = {}) {
  return makeEntry({
    key: 'TAG_MODEL', category: 'ai', type: 'string', advanced: true,
    configuredValue: 'gemma3:4b', activeValue: 'gemma3:4b', allowEmpty: false,
    visibleWhen: { key: 'TAG_PROVIDER', equals: 'ollama' },
    dynamicOptions: { source: 'ollama_models', capability: 'generation' },
    appliesAt: 'next_index_job', requiresBackfill: true,
    ...overrides,
  });
}

function tagOnnxModelEntry(overrides = {}) {
  return makeEntry({
    key: 'TAG_ONNX_MODEL', category: 'ai', type: 'string', advanced: true,
    configuredValue: 'onnx-community/Qwen2.5-Coder-1.5B-Instruct', activeValue: 'onnx-community/Qwen2.5-Coder-1.5B-Instruct',
    allowEmpty: false,
    visibleWhen: { key: 'TAG_PROVIDER', equals: 'onnx' },
    appliesAt: 'next_index_job', requiresBackfill: true,
    ...overrides,
  });
}

function embeddingBackendEntry(overrides = {}) {
  return makeEntry({
    key: 'EMBEDDING_BACKEND', category: 'embeddings', type: 'enum', advanced: false,
    configuredValue: 'ollama', activeValue: 'ollama',
    options: [{ value: 'ollama', label: 'Ollama' }, { value: 'bge-m3-onnx', label: 'BGE-M3 (ONNX)' }],
    appliesAt: 'new_collection',
    ...overrides,
  });
}

function embedModelEntry(overrides = {}) {
  return makeEntry({
    key: 'EMBED_MODEL', category: 'embeddings', type: 'string', advanced: false,
    configuredValue: 'bge-m3', activeValue: 'bge-m3', allowEmpty: false,
    visibleWhen: { key: 'EMBEDDING_BACKEND', equals: 'ollama' },
    dynamicOptions: { source: 'ollama_models', capability: 'embedding' },
    appliesAt: 'new_collection',
    ...overrides,
  });
}

function denseModelEntry(overrides = {}) {
  return makeEntry({
    key: 'DENSE_MODEL', category: 'embeddings', type: 'string', advanced: true,
    configuredValue: 'bge-m3', activeValue: 'bge-m3', allowEmpty: false,
    visibleWhen: { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx' },
    derivedWhen: { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx', value: 'aapot/bge-m3-onnx' },
    appliesAt: 'new_collection',
    ...overrides,
  });
}

function vectorSizeEntry(overrides = {}) {
  return makeEntry({
    key: 'VECTOR_SIZE', category: 'embeddings', type: 'number', advanced: true,
    configuredValue: 1024, activeValue: 1024, min: 1, max: 100000,
    derivedWhen: { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx', value: 1024 },
    dynamicDerived: {
      key: 'EMBEDDING_BACKEND', equals: 'ollama', source: 'ollama_models',
      modelKey: 'EMBED_MODEL', property: 'embeddingDimension',
    },
    writable: false,
    readOnlyReason: 'Detected from the embedding model.',
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

describe('visibleWhen — TAG_PROVIDER drives TAG_MODEL/TAG_ONNX_MODEL', () => {
  it('TAG_PROVIDER=ollama (last-fetched): shows TAG_MODEL, hides TAG_ONNX_MODEL', async () => {
    const settings = [tagProviderEntry(), tagModelEntry(), tagOnnxModelEntry()];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    assert.ok(document.querySelector('[data-key="TAG_MODEL"]'));
    assert.equal(document.querySelector('[data-key="TAG_ONNX_MODEL"]'), null);
  });

  it('TAG_PROVIDER=onnx (last-fetched): shows TAG_ONNX_MODEL, hides TAG_MODEL', async () => {
    const settings = [tagProviderEntry({ configuredValue: 'onnx', activeValue: 'onnx' }), tagModelEntry(), tagOnnxModelEntry()];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    assert.ok(document.querySelector('[data-key="TAG_ONNX_MODEL"]'));
    assert.equal(document.querySelector('[data-key="TAG_MODEL"]'), null);
  });

  it('switching TAG_PROVIDER via a STAGED (unsaved) change immediately swaps visibility, no Save round trip', async () => {
    const settings = [tagProviderEntry(), tagModelEntry(), tagOnnxModelEntry()];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    assert.ok(document.querySelector('[data-key="TAG_MODEL"]'));

    document.querySelector('.gs-advanced').open = true;
    const providerSelect = document.querySelector('[data-key="TAG_PROVIDER"]');
    providerSelect.querySelector('option[value="onnx"]').selected = true;
    providerSelect.dispatchEvent(new Event('change'));

    document.querySelector('.gs-advanced')?.setAttribute('open', '');
    assert.equal(document.querySelector('[data-key="TAG_MODEL"]'), null, 'TAG_MODEL must disappear immediately after the staged change');
    assert.ok(document.querySelector('[data-key="TAG_ONNX_MODEL"]'), 'TAG_ONNX_MODEL must appear immediately after the staged change');
  });
});

describe('visibleWhen/derivedWhen — EMBEDDING_BACKEND drives embeddings fields', () => {
  it('EMBEDDING_BACKEND=ollama: EMBED_MODEL is editable and VECTOR_SIZE is detected read-only', async () => {
    const settings = [
      embeddingBackendEntry(),
      embedModelEntry({ configuredValue: 'nomic-embed-text', activeValue: 'nomic-embed-text' }),
      denseModelEntry(),
      vectorSizeEntry(),
      onnxExecutionProviderEntry(),
    ];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');

    assert.ok(document.querySelector('[data-key="EMBED_MODEL"]'), 'EMBED_MODEL must be visible for the ollama backend');
    assert.equal(document.querySelector('[data-key="DENSE_MODEL"]'), null, 'DENSE_MODEL must be entirely hidden for the ollama backend');
    assert.equal(document.querySelector('[data-key="ONNX_EXECUTION_PROVIDER"]'), null);

    assert.equal(document.querySelector('[data-key="VECTOR_SIZE"]'), null,
      'VECTOR_SIZE must not be a manually editable control');
    assert.match(document.querySelector('[data-field="VECTOR_SIZE"]').textContent, /768/);
  });

  it('EMBEDDING_BACKEND=bge-m3-onnx: EMBED_MODEL hidden, DENSE_MODEL/VECTOR_SIZE read-only-derived, ONNX fields visible', async () => {
    const settings = [
      embeddingBackendEntry({ configuredValue: 'bge-m3-onnx', activeValue: 'bge-m3-onnx' }),
      embedModelEntry(), denseModelEntry(), vectorSizeEntry(), onnxExecutionProviderEntry(),
    ];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');

    assert.equal(document.querySelector('[data-key="EMBED_MODEL"]'), null, 'EMBED_MODEL ("Embedding model (Ollama)") must be absent when ONNX is active');

    document.querySelector('.gs-advanced').open = true;
    assert.equal(document.querySelector('[data-key="DENSE_MODEL"]'), null, 'DENSE_MODEL renders as read-only info, not an editable control, for ONNX');
    assert.match(document.getElementById('gs-content').textContent, /aapot\/bge-m3-onnx/);

    assert.equal(document.querySelector('[data-key="VECTOR_SIZE"]'), null, 'VECTOR_SIZE renders as read-only info, not an editable control, for ONNX');
    assert.match(document.getElementById('gs-content').textContent, /1024/);

    assert.ok(document.querySelector('[data-key="ONNX_EXECUTION_PROVIDER"]'), 'ONNX-only fields become visible');
  });

  it('switching EMBEDDING_BACKEND via a STAGED change immediately hides EMBED_MODEL and switches VECTOR_SIZE to read-only, without Save', async () => {
    const settings = [embeddingBackendEntry(), embedModelEntry(), denseModelEntry(), vectorSizeEntry(), onnxExecutionProviderEntry()];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');
    assert.ok(document.querySelector('[data-key="EMBED_MODEL"]'));

    const backendSelect = document.querySelector('[data-key="EMBEDDING_BACKEND"]');
    backendSelect.querySelector('option[value="bge-m3-onnx"]').selected = true;
    backendSelect.dispatchEvent(new Event('change'));

    assert.equal(document.querySelector('[data-key="EMBED_MODEL"]'), null, 'EMBED_MODEL disappears immediately');
    assert.equal(document.querySelector('input[data-key="VECTOR_SIZE"]'), null, 'VECTOR_SIZE is no longer an editable input');
  });
});

describe('dynamicOptions — Ollama model selects', () => {
  it('ASK_MODEL renders as a select containing only generation-capable installed models', async () => {
    const askModel = makeEntry({
      key: 'ASK_MODEL', category: 'ai', type: 'string', advanced: false,
      configuredValue: 'gemma3:4b', activeValue: 'gemma3:4b', allowEmpty: false,
      appliesAt: 'next_restart', dynamicOptions: { source: 'ollama_models', capability: 'generation' },
    });
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload([askModel]), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const select = document.querySelector('[data-key="ASK_MODEL"]');
    assert.equal(select.tagName.toLowerCase(), 'select');
    const values = [...select.querySelectorAll('option')].map((o) => o.getAttribute('value'));
    assert.deepEqual(values.sort(), ['gemma3:4b', 'llama3.2:3b'].sort());
    assert.ok(!values.includes('nomic-embed-text'), 'embedding-capability models must not appear in a generation selector');
  });

  it('EMBED_MODEL renders as a select containing only embedding-capable installed models', async () => {
    // configuredValue matches an installed embedding model exactly, so no
    // "(not installed)" preserved-value option is added — isolates this
    // test to the capability-filter behavior alone (the preserved-value
    // case is covered separately below).
    const settings = [embeddingBackendEntry(), embedModelEntry({ configuredValue: 'nomic-embed-text', activeValue: 'nomic-embed-text' })];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');
    const select = document.querySelector('[data-key="EMBED_MODEL"]');
    const values = [...select.querySelectorAll('option')].map((o) => o.getAttribute('value'));
    assert.deepEqual(values, ['nomic-embed-text']);
    assert.ok(!values.includes('gemma3:4b'), 'generation-capability models must not appear in an embedding selector');
  });

  it('configured model missing from the installed list is preserved as a distinct, selected, labeled-unavailable option', async () => {
    const askModel = makeEntry({
      key: 'ASK_MODEL', category: 'ai', type: 'string', advanced: false,
      configuredValue: 'not-installed-model:9b', activeValue: 'not-installed-model:9b', allowEmpty: false,
      appliesAt: 'next_restart', dynamicOptions: { source: 'ollama_models', capability: 'generation' },
    });
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload([askModel]), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const select = document.querySelector('[data-key="ASK_MODEL"]');
    const selected = select.querySelector('option[selected]');
    assert.equal(selected.getAttribute('value'), 'not-installed-model:9b');
    assert.match(selected.textContent, /not installed/);
  });

  it('Ollama unreachable: the select shows the reachability reason, never renders empty, control is disabled not silently broken', async () => {
    const askModel = makeEntry({
      key: 'ASK_MODEL', category: 'ai', type: 'string', advanced: false,
      configuredValue: 'gemma3:4b', activeValue: 'gemma3:4b', allowEmpty: false,
      appliesAt: 'next_restart', dynamicOptions: { source: 'ollama_models', capability: 'generation' },
    });
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload([askModel]), '/api/ollama-models': OLLAMA_MODELS_UNREACHABLE },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const select = document.querySelector('[data-key="ASK_MODEL"]');
    assert.ok(select, 'a control must still render, never vanish entirely');
    assert.ok(select.querySelectorAll('option').length > 0, 'must never render an empty <select>');
    assert.match(document.getElementById('gs-content').textContent, /not reachable/);
  });

  it('no installed models of the required capability (Ollama reachable): renders one disabled placeholder option, not an empty select', async () => {
    const askModel = makeEntry({
      key: 'ASK_MODEL', category: 'ai', type: 'string', advanced: false,
      configuredValue: undefined, activeValue: undefined, allowEmpty: false,
      appliesAt: 'next_restart', dynamicOptions: { source: 'ollama_models', capability: 'generation' },
    });
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': settingsPayload([askModel]),
        '/api/ollama-models': { available: true, reason: null, models: [{ name: 'nomic-embed-text', capabilities: ['embedding'], embeddingDimension: 768, parameterSize: '137M', family: 'nomic-bert' }] },
      },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const select = document.querySelector('[data-key="ASK_MODEL"]');
    assert.ok(select.querySelectorAll('option').length > 0);
    assert.match(select.textContent, /No installed models found/);
  });

  it('"Refresh models" re-fetches /api/ollama-models and updates the select options', async () => {
    let call = 0;
    const askModel = makeEntry({
      key: 'ASK_MODEL', category: 'ai', type: 'string', advanced: false,
      configuredValue: 'gemma3:4b', activeValue: 'gemma3:4b', allowEmpty: false,
      appliesAt: 'next_restart', dynamicOptions: { source: 'ollama_models', capability: 'generation' },
    });
    const { document, renderGlobalSettingsView, __apiCalls } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': settingsPayload([askModel]),
        '/api/ollama-models': () => {
          call += 1;
          return { available: true, reason: null, models: [{ name: 'gemma3:4b', capabilities: ['completion'], embeddingDimension: null, parameterSize: '4.3B', family: 'gemma3' }] };
        },
        '/api/ollama-models?refresh=1': () => ({
          available: true,
          reason: null,
          models: [
            { name: 'gemma3:4b', capabilities: ['completion'], embeddingDimension: null, parameterSize: '4.3B', family: 'gemma3' },
            { name: 'phi4:14b', capabilities: ['completion'], embeddingDimension: null, parameterSize: '14B', family: 'phi' },
          ],
        }),
      },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const callsBefore = __apiCalls.filter((u) => u === '/api/ollama-models').length;
    assert.equal(callsBefore, 1);

    document.getElementById('gs-refresh-models').click();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(__apiCalls.filter((u) => u === '/api/ollama-models?refresh=1').length, 1);
    const values = [...document.querySelector('[data-key="ASK_MODEL"]').querySelectorAll('option')].map((o) => o.getAttribute('value'));
    assert.ok(values.includes('phi4:14b'), 'the newly-installed model must appear after refresh');
  });

  it('a category with no dynamicOptions fields never fetches /api/ollama-models', async () => {
    const settings = [makeEntry({ key: 'RRF_K', category: 'retrieval', type: 'number', configuredValue: 60, activeValue: 60, advanced: true })];
    const { document, renderGlobalSettingsView, __apiCalls } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'retrieval');
    assert.equal(__apiCalls.filter((u) => u === '/api/ollama-models').length, 0);
  });
});

function denseProviderEntry(overrides = {}) {
  return makeEntry({
    key: 'DENSE_PROVIDER', category: 'embeddings', type: 'enum', advanced: true, uiHidden: true,
    configuredValue: 'ollama', activeValue: 'ollama',
    options: [{ value: 'ollama', label: 'ollama' }, { value: 'bge-m3-onnx', label: 'bge-m3-onnx' }],
    appliesAt: 'new_collection',
    ...overrides,
  });
}

function sparseProviderEntry(overrides = {}) {
  return makeEntry({
    key: 'SPARSE_PROVIDER', category: 'embeddings', type: 'enum', advanced: true, uiHidden: true,
    configuredValue: 'hashed-tf', activeValue: 'hashed-tf',
    options: [{ value: 'hashed-tf', label: 'hashed-tf' }, { value: 'bge-m3-onnx', label: 'bge-m3-onnx' }],
    appliesAt: 'new_collection',
    ...overrides,
  });
}

describe('EMBEDDING_BACKEND save — never produces an invalid dense/sparse combination', () => {
  it('saving after switching EMBEDDING_BACKEND sends only EMBEDDING_BACKEND in the PATCH body — the server-side expansion (tested in service.test.js) is what turns it into a matched DENSE_PROVIDER/SPARSE_PROVIDER pair', async () => {
    const settings = [embeddingBackendEntry()];
    const patchCalls = [];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
      apiPatchImpl: async (url, body) => { patchCalls.push({ url, body }); return { settings: [] }; },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');
    const backendSelect = document.querySelector('[data-key="EMBEDDING_BACKEND"]');
    backendSelect.querySelector('option[value="bge-m3-onnx"]').selected = true;
    backendSelect.dispatchEvent(new Event('change'));

    document.getElementById('gs-save').click();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(patchCalls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(patchCalls[0].body)), { changes: { EMBEDDING_BACKEND: 'bge-m3-onnx' } });
    // The UI never independently stages DENSE_PROVIDER/SPARSE_PROVIDER —
    // there is structurally no code path in this view that could produce a
    // mismatched pair, since DENSE_PROVIDER/SPARSE_PROVIDER aren't rendered
    // as separate controls reachable from this one selector's category flow.
    assert.ok(!('DENSE_PROVIDER' in patchCalls[0].body.changes));
    assert.ok(!('SPARSE_PROVIDER' in patchCalls[0].body.changes));
  });

  it('code review fix (P1): DENSE_PROVIDER/SPARSE_PROVIDER are genuinely absent from the DOM even when present in the real GET /api/settings response — regression test with the fixture the original test omitted', async () => {
    // The original version of this test only ever put EMBEDDING_BACKEND in
    // the fixture, so it could not observe that DENSE_PROVIDER/
    // SPARSE_PROVIDER render as real, independently-editable controls
    // elsewhere in the same category (under "Advanced settings") — a user
    // could open Advanced and set them to an invalid pair directly,
    // making the "structurally impossible" claim false as shipped. This
    // fixture includes both real entries the real API response would
    // carry, uiHidden: true and all, and asserts they truly never appear.
    const settings = [embeddingBackendEntry(), denseProviderEntry(), sparseProviderEntry()];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');
    // Open Advanced settings too, in case a regression renders them there
    // instead of hiding them outright.
    document.querySelector('.gs-advanced')?.setAttribute('open', '');
    assert.equal(document.querySelector('[data-key="DENSE_PROVIDER"]'), null, 'DENSE_PROVIDER must never render as a control, even inside Advanced settings');
    assert.equal(document.querySelector('[data-key="SPARSE_PROVIDER"]'), null, 'SPARSE_PROVIDER must never render as a control, even inside Advanced settings');
    assert.doesNotMatch(document.getElementById('gs-content').textContent, /Dense provider/);
    assert.doesNotMatch(document.getElementById('gs-content').textContent, /Sparse provider/);
  });
});

describe('dynamicOptions — env-locked field handling', () => {
  it('a configuredSource:os_env dynamicOptions field renders a disabled select showing the real configured value, not blank', async () => {
    const askModel = makeEntry({
      key: 'ASK_MODEL', category: 'ai', type: 'string', advanced: false,
      configuredValue: 'gemma3:4b', activeValue: 'gemma3:4b', allowEmpty: false,
      configuredSource: 'os_env', activeSource: 'os_env',
      appliesAt: 'next_restart', dynamicOptions: { source: 'ollama_models', capability: 'generation' },
    });
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload([askModel]), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const select = document.querySelector('[data-key="ASK_MODEL"]');
    assert.equal(select.hasAttribute('disabled'), true);
    const selected = select.querySelector('option[selected]');
    assert.equal(selected.getAttribute('value'), 'gemma3:4b');
  });
});

describe('EMBED_MODEL shadowedBy — legacy DENSE_MODEL override warning', () => {
  it('shows a warning line when a legacy DENSE_MODEL override is what is actually winning', async () => {
    const settings = [
      embeddingBackendEntry(),
      embedModelEntry({
        configuredValue: undefined, activeValue: undefined,
        shadowedBy: { key: 'DENSE_MODEL', value: 'legacy-model-name', source: 'os_env' },
      }),
    ];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');
    const field = document.querySelector('[data-key="EMBED_MODEL"]').closest('.gs-field');
    assert.match(field.textContent, /legacy-model-name/);
    assert.match(field.textContent, /Operating system environment/);
  });

  it('no warning when EMBED_MODEL has its own value (shadowedBy: null)', async () => {
    const settings = [embeddingBackendEntry(), embedModelEntry({ shadowedBy: null })];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/ollama-models': OLLAMA_MODELS_MIXED },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');
    const field = document.querySelector('[data-key="EMBED_MODEL"]').closest('.gs-field');
    assert.doesNotMatch(field.textContent, /legacy/i);
  });
});

describe('dynamicOptions — unverified ("unknown") capability handling', () => {
  it('a model /api/show could not classify is still offered, visibly marked unverified, not silently hidden', async () => {
    const askModel = makeEntry({
      key: 'ASK_MODEL', category: 'ai', type: 'string', advanced: false,
      configuredValue: 'gemma3:4b', activeValue: 'gemma3:4b', allowEmpty: false,
      appliesAt: 'next_restart', dynamicOptions: { source: 'ollama_models', capability: 'generation' },
    });
    const modelsWithUnknown = {
      available: true, reason: null,
      models: [
        { name: 'gemma3:4b', capabilities: ['completion'], embeddingDimension: null, parameterSize: '4.3B', family: 'gemma3' },
        { name: 'mystery-model:7b', capabilities: null, embeddingDimension: null, parameterSize: null, family: null },
      ],
    };
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload([askModel]), '/api/ollama-models': modelsWithUnknown },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const select = document.querySelector('[data-key="ASK_MODEL"]');
    const values = [...select.querySelectorAll('option')].map((o) => o.getAttribute('value'));
    assert.ok(values.includes('mystery-model:7b'), 'an unverified model must still be offered, not hidden');
    const unverifiedOption = [...select.querySelectorAll('option')].find((o) => o.getAttribute('value') === 'mystery-model:7b');
    assert.match(unverifiedOption.textContent, /unverified/);
  });

  it('an unverified model cannot be selected as a NEW choice — its <option> is disabled (code review: capability-first must not fail-open into "selectable")', async () => {
    const askModel = makeEntry({
      key: 'ASK_MODEL', category: 'ai', type: 'string', advanced: false,
      configuredValue: 'gemma3:4b', activeValue: 'gemma3:4b', allowEmpty: false,
      appliesAt: 'next_restart', dynamicOptions: { source: 'ollama_models', capability: 'generation' },
    });
    const modelsWithUnknown = {
      available: true, reason: null,
      models: [
        { name: 'gemma3:4b', capabilities: ['completion'], embeddingDimension: null, parameterSize: '4.3B', family: 'gemma3' },
        { name: 'mystery-model:7b', capabilities: null, embeddingDimension: null, parameterSize: null, family: null },
      ],
    };
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload([askModel]), '/api/ollama-models': modelsWithUnknown },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const select = document.querySelector('[data-key="ASK_MODEL"]');
    const unverifiedOption = select.querySelector('option[value="mystery-model:7b"]');
    assert.equal(unverifiedOption.hasAttribute('disabled'), true, 'an unverified-capability model must not be a selectable new choice');
    // The already-confirmed model remains fully selectable, unaffected.
    const confirmedOption = select.querySelector('option[value="gemma3:4b"]');
    assert.equal(confirmedOption.hasAttribute('disabled'), false);
  });

  it('an unverified model that is ALREADY the configured value stays selected and enabled — an unrelated Save must not be blocked by it', async () => {
    const askModel = makeEntry({
      key: 'ASK_MODEL', category: 'ai', type: 'string', advanced: false,
      configuredValue: 'mystery-model:7b', activeValue: 'mystery-model:7b', allowEmpty: false,
      appliesAt: 'next_restart', dynamicOptions: { source: 'ollama_models', capability: 'generation' },
    });
    const modelsWithUnknown = {
      available: true, reason: null,
      models: [
        { name: 'gemma3:4b', capabilities: ['completion'], embeddingDimension: null, parameterSize: '4.3B', family: 'gemma3' },
        { name: 'mystery-model:7b', capabilities: null, embeddingDimension: null, parameterSize: null, family: null },
      ],
    };
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload([askModel]), '/api/ollama-models': modelsWithUnknown },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'ai');
    const select = document.querySelector('[data-key="ASK_MODEL"]');
    const currentOption = select.querySelector('option[value="mystery-model:7b"]');
    assert.equal(currentOption.hasAttribute('disabled'), false, 'the currently-configured value must remain selectable even though unverified');
    assert.equal(currentOption.hasAttribute('selected'), true);
  });
});

describe('embedding model dimension safety', () => {
  it('updates the read-only vector size when the selected model changes', async () => {
    const models = {
      available: true,
      reason: null,
      models: [
        { name: 'embed-384', capabilities: ['embedding'], embeddingDimension: 384, parameterSize: null, family: null },
        { name: 'embed-768', capabilities: ['embedding'], embeddingDimension: 768, parameterSize: null, family: null },
      ],
    };
    const settings = [
      embeddingBackendEntry(),
      embedModelEntry({ configuredValue: 'embed-384', activeValue: 'embed-384' }),
      vectorSizeEntry(),
    ];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/ollama-models': models },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');
    assert.match(document.querySelector('[data-field="VECTOR_SIZE"]').textContent, /384/);

    const select = document.querySelector('[data-key="EMBED_MODEL"]');
    select.querySelector('option[value="embed-768"]').selected = true;
    select.dispatchEvent(new Event('change'));
    assert.match(document.querySelector('[data-field="VECTOR_SIZE"]').textContent, /768/);
    assert.equal(document.getElementById('gs-save').disabled, false);
  });

  it('blocks saving an embedding model whose dimension is unknown', async () => {
    const models = {
      available: true,
      reason: null,
      models: [
        { name: 'embed-384', capabilities: ['embedding'], embeddingDimension: 384, parameterSize: null, family: null },
        { name: 'unknown-dimension', capabilities: ['embedding'], embeddingDimension: null, parameterSize: null, family: null },
      ],
    };
    const settings = [
      embeddingBackendEntry(),
      embedModelEntry({ configuredValue: 'embed-384', activeValue: 'embed-384' }),
      vectorSizeEntry(),
    ];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings), '/api/ollama-models': models },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');

    const select = document.querySelector('[data-key="EMBED_MODEL"]');
    select.querySelector('option[value="unknown-dimension"]').selected = true;
    select.dispatchEvent(new Event('change'));
    assert.match(document.querySelector('[data-field="VECTOR_SIZE"]').textContent, /Unknown/);
    assert.equal(document.getElementById('gs-save').disabled, true);
  });
});

describe('invalid embedding provider configuration', () => {
  it('shows the raw invalid value and runtime validation error instead of pretending Ollama is active', async () => {
    const settings = [
      embeddingBackendEntry({
        configuredValue: 'broken-provider',
        activeValue: 'broken-provider',
        configuredSource: 'os_env',
        activeSource: 'os_env',
        invalidConfiguration: 'Invalid provider combination: denseProvider="broken-provider", sparseProvider="hashed-tf".',
      }),
    ];
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/settings': settingsPayload(settings) },
    });
    await renderGlobalSettingsView(document.getElementById('main'), 'embeddings');
    const select = document.querySelector('[data-key="EMBEDDING_BACKEND"]');
    assert.equal(select.value, 'broken-provider');
    assert.equal(select.disabled, true);
    assert.match(document.getElementById('gs-content').textContent, /Invalid provider combination/);
  });
});

