// Admin UI tests for two Part D additions to the "Embeddings & hardware"
// category: (1) the ONNXRUNTIME_NODE_PATH path-picker control (Browse
// button wired to the existing POST /api/system/pick-folder endpoint, with
// a manual-entry fallback), and (2) the ONNX hardware status panel (a
// "Test <PROVIDER> configuration" button -> POST /api/system/onnx-probe;
// the label names the actual provider under test — "Test CUDA
// configuration" for cuda, "Test DML configuration" for dml — never a
// fixed CUDA-only label shown while testing DML). The panel must never
// claim a provider is verified until a real probe response arrives, and
// must render the exact required copy on a CPU-fallback result — never a
// paraphrase, never inferred from the configured value alone.
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
    configuredValue: 'cpu', activeValue: 'cpu', pendingRestart: false,
    options: [{ value: 'cpu', label: 'cpu' }, { value: 'dml', label: 'dml' }, { value: 'cuda', label: 'cuda' }],
    visibleWhen: { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx' },
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

function onnxManagedRuntimeEntry(overrides = {}) {
  return makeEntry({
    key: 'ONNX_MANAGED_RUNTIME', category: 'embeddings', type: 'string', advanced: true,
    configuredValue: '', activeValue: '', allowEmpty: true,
    visibleWhen: [
      { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx' },
      { key: 'ONNX_EXECUTION_PROVIDER', equals: 'cuda' },
    ],
    dynamicOptions: { source: 'managed_onnx_runtimes' },
    appliesAt: 'next_restart',
    ...overrides,
  });
}

function baseEntries(overrides = {}) {
  return [
    embeddingBackendEntry(overrides.backend),
    onnxExecutionProviderEntry(overrides.provider),
    onnxRuntimeNodePathEntry(overrides.runtimePath),
  ];
}

function baseEntriesWithManaged(overrides = {}) {
  return [...baseEntries(overrides), onnxManagedRuntimeEntry(overrides.managedRuntime)];
}

// loadGlobalSettingsHelpers() exposes renderGlobalSettingsView on its
// returned context (same convention ui-global-settings-cuda.test.js uses),
// not as a real ES export — re-derive it the same way that file does.
async function renderCategory(entries, opts = {}) {
  const ctx = loadGlobalSettingsHelpers({
    apiResponses: { '/api/settings': settingsPayload(entries) },
    ...opts,
  });
  await ctx.renderGlobalSettingsView(ctx.document.getElementById('main'), 'embeddings');
  ctx.document.querySelector('.gs-advanced')?.setAttribute('open', '');
  return ctx;
}

describe('ONNXRUNTIME_NODE_PATH path-picker control', () => {
  it('renders a text input plus a Browse button, not a bare text field', async () => {
    const { document } = await renderCategory(baseEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }));
    const wrapper = document.querySelector('[data-field="ONNXRUNTIME_NODE_PATH"] .gs-path-control');
    assert.ok(wrapper, 'expected the path-control wrapper to render');
    assert.ok(wrapper.querySelector('.gs-path-input[data-key="ONNXRUNTIME_NODE_PATH"]'));
    assert.ok(wrapper.querySelector('.gs-path-browse'));
  });

  it('a successful Browse click populates the input and hides the fallback message', async () => {
    // apiPostImpl is a caller-supplied stub (loadGlobalSettingsHelpers'
    // convention: __postCalls only tracks the DEFAULT apiPost impl, and is
    // bypassed once a test supplies its own), so calls are tracked locally.
    const calls = [];
    const { document } = await renderCategory(
      baseEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }),
      { apiPostImpl: async (url) => { calls.push(url); return { path: 'C:\\custom\\onnxruntime-node', cancelled: false }; } },
    );
    const input = document.querySelector('.gs-path-input[data-key="ONNXRUNTIME_NODE_PATH"]');
    const btn = document.querySelector('[data-field="ONNXRUNTIME_NODE_PATH"] .gs-path-browse');
    btn.dispatchEvent(new Event('click'));
    // linkedom dispatchEvent runs listeners synchronously but the handler
    // itself is async — wait a tick for the awaited apiPost to resolve.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['/api/system/pick-folder']);
    assert.equal(input.value, 'C:\\custom\\onnxruntime-node');
    const fallback = document.querySelector('[data-field="ONNXRUNTIME_NODE_PATH"] .gs-path-fallback');
    assert.equal(fallback.hidden, true);
  });

  it('a failed/unavailable Browse click leaves the input editable and shows the manual-fallback message', async () => {
    const { document } = await renderCategory(
      baseEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }),
      { apiPostImpl: async () => { throw Object.assign(new Error('UNSUPPORTED_PLATFORM'), { status: 400 }); } },
    );
    const input = document.querySelector('.gs-path-input[data-key="ONNXRUNTIME_NODE_PATH"]');
    const btn = document.querySelector('[data-field="ONNXRUNTIME_NODE_PATH"] .gs-path-browse');
    btn.dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const fallback = document.querySelector('[data-field="ONNXRUNTIME_NODE_PATH"] .gs-path-fallback');
    assert.equal(fallback.hidden, false);
    assert.equal(input.disabled, false, 'the manual text field must remain usable when the picker fails');
  });

  it('typing directly into the path input still stages a pending change (Browse is an assist, not the only way in)', async () => {
    const { document } = await renderCategory(baseEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }));
    const input = document.querySelector('.gs-path-input[data-key="ONNXRUNTIME_NODE_PATH"]');
    input.value = 'D:\\manual\\path';
    input.dispatchEvent(new Event('input'));
    assert.ok(document.querySelector('.gs-save-bar'), 'a manual edit must dirty the save bar exactly like any other text field');
  });

  it('an os_env-locked ONNXRUNTIME_NODE_PATH disables both the input and the Browse button', async () => {
    const { document } = await renderCategory(baseEntries({
      provider: { configuredValue: 'cuda', activeValue: 'cuda' },
      runtimePath: { configuredValue: '/locked/path', activeValue: '/locked/path', configuredSource: 'os_env' },
    }));
    const input = document.querySelector('.gs-path-input[data-key="ONNXRUNTIME_NODE_PATH"]');
    const btn = document.querySelector('[data-field="ONNXRUNTIME_NODE_PATH"] .gs-path-browse');
    assert.equal(input.disabled, true);
    assert.equal(btn.disabled, true);
  });
});

describe('ONNX hardware status panel', () => {
  it('is absent entirely when the provider is cpu', async () => {
    const { document } = await renderCategory(baseEntries({ provider: { configuredValue: 'cpu', activeValue: 'cpu' } }));
    assert.equal(document.querySelector('.gs-onnx-probe-panel'), null);
  });

  it('appears for cuda, showing the requested/active provider, a CUDA-specific button label, and no verified state yet', async () => {
    const { document } = await renderCategory(baseEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }));
    const panel = document.querySelector('.gs-onnx-probe-panel');
    assert.ok(panel);
    assert.equal(panel.querySelector('.gs-onnx-requested').textContent, 'cuda');
    assert.equal(panel.querySelector('.gs-onnx-active').textContent, 'cuda');
    assert.equal(panel.querySelector('.gs-onnx-verified').textContent, 'Not yet tested');
    assert.equal(panel.querySelector('.gs-onnx-result').hidden, true, 'no result block until a real probe runs');
    assert.equal(panel.querySelector('.gs-onnx-test-button').textContent, 'Test CUDA configuration');
    // Regression: the "Active provider" label used to read as if it were a
    // confirmed, running execution provider — it is only the settings
    // system's configured/active VALUE, never a verified one. The label
    // itself must say so, so a reader can't mistake configuration for
    // verification.
    const activeLabel = panel.querySelector('.gs-onnx-active').previousElementSibling;
    assert.equal(activeLabel.tagName.toLowerCase(), 'dt');
    assert.match(activeLabel.textContent, /unverified/i);
  });

  it('appears for dml too, with a DML-specific button label — never the fixed "Test CUDA configuration" text while testing DML', async () => {
    const { document } = await renderCategory(baseEntries({ provider: { configuredValue: 'dml', activeValue: 'dml' } }));
    const panel = document.querySelector('.gs-onnx-probe-panel');
    assert.ok(panel);
    assert.equal(panel.querySelector('.gs-onnx-test-button').textContent, 'Test DML configuration');
    assert.notEqual(panel.querySelector('.gs-onnx-test-button').textContent, 'Test CUDA configuration');
  });

  it('shows a pending-restart note when the configured provider differs from the active one', async () => {
    const { document } = await renderCategory(baseEntries({
      provider: { configuredValue: 'cuda', activeValue: 'cpu', pendingRestart: true },
    }));
    const note = document.querySelector('.gs-onnx-pending-restart');
    assert.equal(note.hidden, false);
    assert.match(note.textContent, /still using "cpu"/);
  });

  it('a successful probe populates runtime source/version/model-cached and the verified state, without the CPU-fallback warning', async () => {
    // Assertions live OUTSIDE apiPostImpl deliberately — a throw inside the
    // stub would be caught by runOnnxProbe()'s own try/catch and misreported
    // as a probe failure rather than failing this test at the real
    // assertion site (bit twice by this exact pitfall while first writing
    // this test). Calls are tracked in a local array, matching
    // loadGlobalSettingsHelpers' convention that __postCalls only tracks
    // the DEFAULT apiPost impl, not a caller-supplied one.
    const calls = [];
    const { document } = await renderCategory(
      baseEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }),
      { apiPostImpl: async (url, body) => {
        calls.push({ url, provider: body?.provider });
        return {
          ok: true, requestedProvider: 'cuda', effectiveProvider: 'cuda', fellBackToCpu: false,
          runtimeSource: 'custom', runtimeVersion: '1.26.0', modelCached: true,
          restartRequired: false, message: 'CUDA session created successfully',
        };
      } },
    );
    const panel = document.querySelector('.gs-onnx-probe-panel');
    panel.querySelector('.gs-onnx-test-button').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, [{ url: '/api/system/onnx-probe', provider: 'cuda' }]);

    assert.match(panel.querySelector('.gs-onnx-verified').textContent, /^cuda /);
    assert.equal(panel.querySelector('.gs-onnx-result').hidden, false);
    assert.equal(panel.querySelector('.gs-onnx-runtime-source').textContent, 'custom');
    assert.equal(panel.querySelector('.gs-onnx-runtime-version').textContent, '1.26.0');
    assert.equal(panel.querySelector('.gs-onnx-model-cached').textContent, 'yes');
    assert.equal(panel.querySelector('.gs-onnx-fallback-warning').hidden, true);
  });

  it('a fellBackToCpu:true result renders the EXACT required copy, never a paraphrase, never GPU-backed wording', async () => {
    const { document } = await renderCategory(
      baseEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }),
      { apiPostImpl: async () => ({
        ok: true, requestedProvider: 'cuda', effectiveProvider: 'cpu', fellBackToCpu: true,
        runtimeSource: 'custom', runtimeVersion: '1.26.0', modelCached: true,
        restartRequired: false, message: 'CUDA unavailable — fell back to CPU',
      }) },
    );
    const panel = document.querySelector('.gs-onnx-probe-panel');
    panel.querySelector('.gs-onnx-test-button').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const warning = panel.querySelector('.gs-onnx-fallback-warning');
    assert.equal(warning.hidden, false);
    assert.equal(warning.textContent, 'CUDA was requested, but the effective provider is CPU.');
  });

  it('a plain probe failure (e.g. model_not_cached) does NOT show the CPU-fallback copy — that copy is reserved for a real fellBackToCpu signal', async () => {
    const { document } = await renderCategory(
      baseEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }),
      { apiPostImpl: async () => ({
        ok: false, requestedProvider: 'cuda', effectiveProvider: null, fellBackToCpu: false,
        runtimeSource: 'npm', runtimeVersion: null, modelCached: false,
        restartRequired: false, message: 'model_not_cached',
      }) },
    );
    const panel = document.querySelector('.gs-onnx-probe-panel');
    panel.querySelector('.gs-onnx-test-button').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(panel.querySelector('.gs-onnx-fallback-warning').hidden, true);
    assert.equal(panel.querySelector('.gs-onnx-model-cached').textContent, 'no');
    assert.equal(panel.querySelector('.gs-onnx-message').textContent, 'model_not_cached');
  });

  it('a network/transport failure from apiPost itself is surfaced as a failed test, not a silent success', async () => {
    const { document } = await renderCategory(
      baseEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }),
      { apiPostImpl: async () => { throw new Error('network error'); } },
    );
    const panel = document.querySelector('.gs-onnx-probe-panel');
    panel.querySelector('.gs-onnx-test-button').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(panel.querySelector('.gs-onnx-verified').textContent, 'Test failed');
    assert.equal(panel.querySelector('.gs-onnx-result').hidden, false);
    assert.match(panel.querySelector('.gs-onnx-message').textContent, /network error/);
  });

  it('the button sends the currently STAGED provider, not the originally configured one', async () => {
    const { document } = await renderCategory(baseEntries({ provider: { configuredValue: 'cpu', activeValue: 'cpu' } }));
    assert.equal(document.querySelector('.gs-onnx-probe-panel'), null);

    const providerSelect = document.querySelector('[data-key="ONNX_EXECUTION_PROVIDER"]');
    providerSelect.querySelector('option[value="cuda"]').selected = true;
    providerSelect.dispatchEvent(new Event('change'));
    document.querySelector('.gs-advanced')?.setAttribute('open', '');

    const panel = document.querySelector('.gs-onnx-probe-panel');
    assert.ok(panel, 'the panel must appear immediately once cuda is staged, no Save round trip');
    assert.equal(panel.querySelector('.gs-onnx-test-button').dataset.provider, 'cuda');
  });

  it('sends the CURRENTLY STAGED (unsaved) runtime path, not the saved configuredValue — fixes a mixed-tier probe bug', async () => {
    // Regression test: the previous fix made the SERVER consistently use
    // configuredValue for both provider and runtime path — correct for
    // avoiding a mixed-tier probe from stale/frozen state, but it also
    // meant the UI (which already lets a user test a staged, unsaved
    // PROVIDER) had no way to send a staged, unsaved RUNTIME PATH at the
    // same time. A user who types a new custom path and clicks Test before
    // Save must have that unsaved value actually sent, not silently
    // dropped in favor of whatever was last saved.
    const calls = [];
    const { document } = await renderCategory(
      baseEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }),
      { apiPostImpl: async (url, body) => {
        calls.push({ url, body });
        return { ...body, ok: true, effectiveProvider: 'cuda', fellBackToCpu: false, runtimeSource: 'custom', runtimeVersion: '1.26.0', modelCached: true, testedStagedRuntimePath: true, message: 'ok' };
      } },
    );
    const pathInput = document.querySelector('.gs-path-input[data-key="ONNXRUNTIME_NODE_PATH"]');
    pathInput.value = 'C:\\unsaved\\staged\\path';
    pathInput.dispatchEvent(new Event('input'));

    const panel = document.querySelector('.gs-onnx-probe-panel');
    panel.querySelector('.gs-onnx-test-button').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const probeCalls = calls.filter((c) => c.url === '/api/system/onnx-probe');
    assert.equal(probeCalls.length, 1);
    assert.equal(probeCalls[0].body.runtimePath, 'C:\\unsaved\\staged\\path');
  });

  it('DML never sends a runtimePath field at all — there is no ONNXRUNTIME_NODE_PATH input to read for a non-CUDA provider', async () => {
    const calls = [];
    const { document } = await renderCategory(
      baseEntries({ provider: { configuredValue: 'dml', activeValue: 'dml' } }),
      { apiPostImpl: async (url, body) => { calls.push({ url, body }); return { ok: true, effectiveProvider: 'dml', fellBackToCpu: false, runtimeSource: 'npm', runtimeVersion: '1.24.3', modelCached: true, testedStagedRuntimePath: false, message: 'ok' }; } },
    );
    assert.equal(document.querySelector('.gs-path-input[data-key="ONNXRUNTIME_NODE_PATH"]'), null, 'test setup: DML must not render the path input');
    const panel = document.querySelector('.gs-onnx-probe-panel');
    panel.querySelector('.gs-onnx-test-button').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const probeCalls = calls.filter((c) => c.url === '/api/system/onnx-probe');
    assert.equal(probeCalls.length, 1);
    // Cross-realm object (from the vm context) — re-serialize before
    // comparing, matching this test suite's established convention for
    // deepEqual against vm-produced objects (deepStrictEqual also checks
    // prototype identity, which differs across realms even when the data
    // is identical).
    assert.deepEqual(JSON.parse(JSON.stringify(probeCalls[0].body)), { provider: 'dml' });
  });

  it('shows the server-confirmed "unsaved runtime path" notice only when testedStagedRuntimePath is true — never inferred client-side alone', async () => {
    const { document } = await renderCategory(
      baseEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }),
      { apiPostImpl: async () => ({
        ok: true, effectiveProvider: 'cuda', fellBackToCpu: false, runtimeSource: 'custom',
        runtimeVersion: '1.26.0', modelCached: true, testedStagedRuntimePath: true, message: 'ok',
      }) },
    );
    const panel = document.querySelector('.gs-onnx-probe-panel');
    panel.querySelector('.gs-onnx-test-button').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const notice = panel.querySelector('.gs-onnx-staged-path-notice');
    assert.equal(notice.hidden, false);
    assert.match(notice.textContent, /unsaved/i);
  });

  it('does NOT show the "unsaved runtime path" notice when testedStagedRuntimePath is false (saved config was tested)', async () => {
    const { document } = await renderCategory(
      baseEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }),
      { apiPostImpl: async () => ({
        ok: true, effectiveProvider: 'cuda', fellBackToCpu: false, runtimeSource: 'custom',
        runtimeVersion: '1.26.0', modelCached: true, testedStagedRuntimePath: false, message: 'ok',
      }) },
    );
    const panel = document.querySelector('.gs-onnx-probe-panel');
    panel.querySelector('.gs-onnx-test-button').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(panel.querySelector('.gs-onnx-staged-path-notice').hidden, true);
  });
});

// CUDA guided-setup diagnosis — result.diagnosis (added by
// src/admin/api/onnx.js only for a failed CUDA probe, from real
// nvidia-smi/CUDA_PATH/cuDNN system checks server-side). Renders into the
// .gs-onnx-diagnosis block inside .gs-onnx-result. Every apiPostImpl stub
// here plays the role of that server response — never a real probe/spawn.
describe('ONNX hardware status panel — CUDA guided-setup diagnosis', () => {
  it('a diagnosis object renders details plus one <li> per nextSteps entry, and unhides the block', async () => {
    const { document } = await renderCategory(
      baseEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }),
      { apiPostImpl: async () => ({
        ok: false, requestedProvider: 'cuda', effectiveProvider: null, fellBackToCpu: false,
        runtimeSource: 'npm', runtimeVersion: '1.24.3', modelCached: true,
        restartRequired: false, message: 'no available backend found. ERR: [cuda] backend not found.',
        diagnosis: {
          reason: 'no_custom_build',
          details: 'GPU, driver, CUDA Toolkit, and cuDNN are all present, but the currently loaded onnxruntime-node is the default npm package.',
          nextSteps: ['Set ONNXRUNTIME_NODE_PATH to a compatible custom build.', 'See: docs/en/configuration.md'],
        },
      }) },
    );
    const panel = document.querySelector('.gs-onnx-probe-panel');
    panel.querySelector('.gs-onnx-test-button').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const diagBlock = panel.querySelector('.gs-onnx-diagnosis');
    assert.equal(diagBlock.hidden, false);
    assert.match(diagBlock.querySelector('.gs-onnx-diagnosis-details').textContent, /default npm package/);
    const steps = [...diagBlock.querySelectorAll('.gs-onnx-diagnosis-steps li')].map((li) => li.textContent);
    assert.deepEqual(steps, [
      'Set ONNXRUNTIME_NODE_PATH to a compatible custom build.',
      'See: docs/en/configuration.md',
    ]);
  });

  it('diagnosis: null (a successful CUDA probe, or an older cached shape) keeps the block hidden', async () => {
    const { document } = await renderCategory(
      baseEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }),
      { apiPostImpl: async () => ({
        ok: true, requestedProvider: 'cuda', effectiveProvider: 'cuda', fellBackToCpu: false,
        runtimeSource: 'custom', runtimeVersion: '1.26.0', modelCached: true,
        restartRequired: false, message: 'CUDA session created successfully', diagnosis: null,
      }) },
    );
    const panel = document.querySelector('.gs-onnx-probe-panel');
    panel.querySelector('.gs-onnx-test-button').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(panel.querySelector('.gs-onnx-diagnosis').hidden, true);
  });

  it('a response with the diagnosis key entirely absent (older cached shape) is treated identically to null — block stays hidden, no crash', async () => {
    const { document } = await renderCategory(
      baseEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }),
      { apiPostImpl: async () => ({
        ok: true, requestedProvider: 'cuda', effectiveProvider: 'cuda', fellBackToCpu: false,
        runtimeSource: 'custom', runtimeVersion: '1.26.0', modelCached: true,
        restartRequired: false, message: 'CUDA session created successfully',
        // no `diagnosis` key at all
      }) },
    );
    const panel = document.querySelector('.gs-onnx-probe-panel');
    panel.querySelector('.gs-onnx-test-button').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(panel.querySelector('.gs-onnx-diagnosis').hidden, true);
  });

  it('reason: "unknown" with an empty nextSteps array renders details but zero <li> elements — never fabricated advice', async () => {
    const { document } = await renderCategory(
      baseEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }),
      { apiPostImpl: async () => ({
        ok: false, requestedProvider: 'cuda', effectiveProvider: null, fellBackToCpu: false,
        runtimeSource: 'custom', runtimeVersion: '1.26.0', modelCached: true,
        restartRequired: false, message: 'unrecognized ORT failure',
        diagnosis: { reason: 'unknown', details: 'Everything checked out but the session still failed.', nextSteps: [] },
      }) },
    );
    const panel = document.querySelector('.gs-onnx-probe-panel');
    panel.querySelector('.gs-onnx-test-button').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const diagBlock = panel.querySelector('.gs-onnx-diagnosis');
    assert.equal(diagBlock.hidden, false);
    assert.equal(diagBlock.querySelector('.gs-onnx-diagnosis-details').textContent, 'Everything checked out but the session still failed.');
    assert.equal(diagBlock.querySelectorAll('.gs-onnx-diagnosis-steps li').length, 0);
  });

  it('a network/transport failure hides the diagnosis block, even after a prior successful click left it visible', async () => {
    let callCount = 0;
    const { document } = await renderCategory(
      baseEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }),
      { apiPostImpl: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            ok: false, requestedProvider: 'cuda', effectiveProvider: null, fellBackToCpu: false,
            runtimeSource: 'npm', runtimeVersion: '1.24.3', modelCached: true,
            restartRequired: false, message: 'no available backend found. ERR: [cuda] backend not found.',
            diagnosis: { reason: 'no_custom_build', details: 'npm build in use.', nextSteps: ['Set ONNXRUNTIME_NODE_PATH.'] },
          };
        }
        throw new Error('network error');
      } },
    );
    const panel = document.querySelector('.gs-onnx-probe-panel');
    const button = panel.querySelector('.gs-onnx-test-button');

    button.dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(panel.querySelector('.gs-onnx-diagnosis').hidden, false, 'test setup: diagnosis must be visible after the first (successful-shape) click');

    button.dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(panel.querySelector('.gs-onnx-diagnosis').hidden, true, 'a later network error must hide a stale diagnosis from a prior click, not leave it lingering');
  });
});

describe('ONNX_MANAGED_RUNTIME dropdown', () => {
  async function renderCategoryWithManagedFetch(entries, { runtimes = [], apiResponses = {}, ...opts } = {}) {
    const ctx = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': settingsPayload(entries),
        '/api/system/onnx-managed-runtimes': { runtimes },
        ...apiResponses,
      },
      ...opts,
    });
    await ctx.renderGlobalSettingsView(ctx.document.getElementById('main'), 'embeddings');
    ctx.document.querySelector('.gs-advanced')?.setAttribute('open', '');
    // renderCategoryContent's managed-runtimes refresh resolves and
    // re-renders asynchronously — wait a tick before asserting on the DOM.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return ctx;
  }

  it('renders a <select>, not a bare text field, for ONNX_MANAGED_RUNTIME', async () => {
    const { document } = await renderCategoryWithManagedFetch(
      baseEntriesWithManaged({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }),
    );
    const select = document.querySelector('[data-field="ONNX_MANAGED_RUNTIME"] select[data-key="ONNX_MANAGED_RUNTIME"]');
    assert.ok(select, 'expected a <select> control for ONNX_MANAGED_RUNTIME');
  });

  it('lists one option per installed runtime, labeled with ORT/CUDA version and verification status', async () => {
    const { document } = await renderCategoryWithManagedFetch(
      baseEntriesWithManaged({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }),
      { runtimes: [
        { id: '1.26.0-cuda13', ortVersion: '1.26.0', cudaMajor: '13', verification: { status: 'verified', verifiedAt: '2026-08-07T00:00:00.000Z', effectiveProvider: 'cuda' } },
        { id: '1.27.0-cuda13', ortVersion: '1.27.0', cudaMajor: '13', verification: { status: 'unverified', verifiedAt: null, effectiveProvider: null } },
      ] },
    );
    const select = document.querySelector('select[data-key="ONNX_MANAGED_RUNTIME"]');
    const optionTexts = [...select.querySelectorAll('option')].map((o) => o.textContent);
    assert.ok(optionTexts.some((t) => t.includes('1.26.0') && t.includes('CUDA 13') && t.includes('verified')));
    assert.ok(optionTexts.some((t) => t.includes('1.27.0') && t.includes('unverified')));
  });

  it('a saved selection that no longer resolves in the fetched list is preserved as a distinct "(not installed)" option, never silently dropped', async () => {
    const { document } = await renderCategoryWithManagedFetch(
      baseEntriesWithManaged({
        provider: { configuredValue: 'cuda', activeValue: 'cuda' },
        managedRuntime: { configuredValue: '9.9.9-cuda99', activeValue: '9.9.9-cuda99' },
      }),
      { runtimes: [] },
    );
    const select = document.querySelector('select[data-key="ONNX_MANAGED_RUNTIME"]');
    const selected = select.querySelector('option[selected]');
    assert.ok(selected);
    assert.match(selected.textContent, /9\.9\.9-cuda99.*not installed/);
  });

  it('defaults to the "(none — use default npm package)" option when no selection is configured', async () => {
    const { document } = await renderCategoryWithManagedFetch(
      baseEntriesWithManaged({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }),
      { runtimes: [{ id: '1.26.0-cuda13', ortVersion: '1.26.0', cudaMajor: '13', verification: { status: 'verified', verifiedAt: null, effectiveProvider: 'cuda' } }] },
    );
    const select = document.querySelector('select[data-key="ONNX_MANAGED_RUNTIME"]');
    const selected = select.querySelector('option[selected]');
    assert.equal(selected.getAttribute('value'), '');
  });

  it('a non-empty ONNXRUNTIME_NODE_PATH (explicit path) disables the managed-runtime select AND shows the exact required override note', async () => {
    const { document } = await renderCategoryWithManagedFetch(
      baseEntriesWithManaged({
        provider: { configuredValue: 'cuda', activeValue: 'cuda' },
        runtimePath: { configuredValue: 'D:\\custom\\onnxruntime-node', activeValue: 'D:\\custom\\onnxruntime-node' },
      }),
      { runtimes: [] },
    );
    const select = document.querySelector('select[data-key="ONNX_MANAGED_RUNTIME"]');
    assert.equal(select.disabled, true);
    const mount = select.closest('.gs-field-control-mount');
    const note = [...mount.querySelectorAll('.gs-field-source')].find((el) => el.textContent === 'Custom runtime path overrides the managed runtime selection.');
    assert.ok(note, 'expected the exact required override note text');
  });

  it('an EMPTY ONNXRUNTIME_NODE_PATH leaves the managed-runtime select enabled, with no override note', async () => {
    const { document } = await renderCategoryWithManagedFetch(
      baseEntriesWithManaged({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }),
      { runtimes: [] },
    );
    const select = document.querySelector('select[data-key="ONNX_MANAGED_RUNTIME"]');
    assert.equal(select.disabled, false);
    const mount = select.closest('.gs-field-control-mount');
    const note = [...mount.querySelectorAll('.gs-field-source')].find((el) => el.textContent === 'Custom runtime path overrides the managed runtime selection.');
    assert.equal(note, undefined);
  });

  it('typing into ONNXRUNTIME_NODE_PATH live-disables the managed-runtime select without a full category rebuild', async () => {
    const { document } = await renderCategoryWithManagedFetch(
      baseEntriesWithManaged({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }),
      { runtimes: [] },
    );
    const pathInput = document.querySelector('.gs-path-input[data-key="ONNXRUNTIME_NODE_PATH"]');
    const select = document.querySelector('select[data-key="ONNX_MANAGED_RUNTIME"]');
    assert.equal(select.disabled, false);

    pathInput.value = 'D:\\typed\\path';
    pathInput.dispatchEvent(new Event('input'));
    assert.equal(select.disabled, true, 'the managed-runtime select must react live to typing, not just at render time');

    pathInput.value = '';
    pathInput.dispatchEvent(new Event('input'));
    assert.equal(select.disabled, false, 'clearing the explicit path must re-enable the managed-runtime select');
  });

  it('a category with no ONNX_MANAGED_RUNTIME field never fetches /api/system/onnx-managed-runtimes', async () => {
    const ctx = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': settingsPayload(baseEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } })),
      },
    });
    await ctx.renderGlobalSettingsView(ctx.document.getElementById('main'), 'embeddings');
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(!ctx.__apiCalls.includes('/api/system/onnx-managed-runtimes'));
  });
});

describe('ONNX hardware status panel — managedRuntimeManifest field', () => {
  it('a probe result with managedRuntimeManifest renders the ORT/CUDA version and verification status', async () => {
    const { document } = await renderCategory(
      baseEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }),
      { apiPostImpl: async () => ({
        ok: true, requestedProvider: 'cuda', effectiveProvider: 'cuda', fellBackToCpu: false,
        runtimeSource: 'managed', runtimeVersion: '1.26.0', modelCached: true,
        restartRequired: false, message: 'CUDA session created successfully',
        managedRuntimeManifest: { ortVersion: '1.26.0', cudaMajor: '13', verification: { status: 'verified', verifiedAt: '2026-08-07T00:00:00.000Z', effectiveProvider: 'cuda' } },
      }) },
    );
    const panel = document.querySelector('.gs-onnx-probe-panel');
    panel.querySelector('.gs-onnx-test-button').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(panel.querySelector('.gs-onnx-managed-runtime').textContent, 'ORT 1.26.0 / CUDA 13 (verified)');
  });

  it('a probe result with managedRuntimeManifest: null renders "—", never a stale value from a prior click', async () => {
    let callCount = 0;
    const { document } = await renderCategory(
      baseEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }),
      { apiPostImpl: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            ok: true, requestedProvider: 'cuda', effectiveProvider: 'cuda', fellBackToCpu: false,
            runtimeSource: 'managed', runtimeVersion: '1.26.0', modelCached: true, message: 'ok',
            managedRuntimeManifest: { ortVersion: '1.26.0', cudaMajor: '13', verification: { status: 'verified', verifiedAt: null, effectiveProvider: 'cuda' } },
          };
        }
        return {
          ok: true, requestedProvider: 'cuda', effectiveProvider: 'cuda', fellBackToCpu: false,
          runtimeSource: 'custom', runtimeVersion: '1.26.0', modelCached: true, message: 'ok',
          managedRuntimeManifest: null,
        };
      } },
    );
    const panel = document.querySelector('.gs-onnx-probe-panel');
    const button = panel.querySelector('.gs-onnx-test-button');
    button.dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.notEqual(panel.querySelector('.gs-onnx-managed-runtime').textContent, '—');

    button.dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(panel.querySelector('.gs-onnx-managed-runtime').textContent, '—');
  });

  it('starts as "—" before any probe has run', async () => {
    const { document } = await renderCategory(baseEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }));
    const panel = document.querySelector('.gs-onnx-probe-panel');
    assert.equal(panel.querySelector('.gs-onnx-managed-runtime').textContent, '—');
  });

  it('a network/transport failure resets .gs-onnx-managed-runtime to "—"', async () => {
    const { document } = await renderCategory(
      baseEntries({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } }),
      { apiPostImpl: async () => { throw new Error('network error'); } },
    );
    const panel = document.querySelector('.gs-onnx-probe-panel');
    panel.querySelector('.gs-onnx-test-button').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(panel.querySelector('.gs-onnx-managed-runtime').textContent, '—');
  });

  it('sends managedRuntimeId from the live <select> value at click time (staged, not a stale snapshot)', async () => {
    const calls = [];
    const ctx = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/settings': settingsPayload(baseEntriesWithManaged({ provider: { configuredValue: 'cuda', activeValue: 'cuda' } })),
        '/api/system/onnx-managed-runtimes': { runtimes: [
          { id: '1.26.0-cuda13', ortVersion: '1.26.0', cudaMajor: '13', verification: { status: 'verified', verifiedAt: null, effectiveProvider: 'cuda' } },
        ] },
      },
      apiPostImpl: async (url, body) => {
        calls.push({ url, managedRuntimeId: body?.managedRuntimeId });
        return {
          ok: true, requestedProvider: 'cuda', effectiveProvider: 'cuda', fellBackToCpu: false,
          runtimeSource: 'managed', runtimeVersion: '1.26.0', modelCached: true, message: 'ok',
          managedRuntimeManifest: null,
        };
      },
    });
    await ctx.renderGlobalSettingsView(ctx.document.getElementById('main'), 'embeddings');
    ctx.document.querySelector('.gs-advanced')?.setAttribute('open', '');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const select = ctx.document.querySelector('select[data-key="ONNX_MANAGED_RUNTIME"]');
    select.querySelector('option[value="1.26.0-cuda13"]').selected = true;
    const panel = ctx.document.querySelector('.gs-onnx-probe-panel');
    panel.querySelector('.gs-onnx-test-button').dispatchEvent(new Event('click'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, [{ url: '/api/system/onnx-probe', managedRuntimeId: '1.26.0-cuda13' }]);
  });
});
