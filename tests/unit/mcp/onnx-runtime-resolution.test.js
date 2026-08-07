// src/mcp/onnx-runtime-resolution.js — review finding (P1): mcp/server.js
// used to never resolve which onnxruntime-node build to load at all, so
// a managed CUDA selection (ONNX_MANAGED_RUNTIME) had no effect in the
// MCP process even when Admin/the indexer correctly picked it up.
// resolveOnnxEmbedCapabilityForMcp() is the fix — every test here is
// BEHAVIORAL (calls the real function with injected fakes and asserts on
// what it actually returns/does), not source-text regex.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_ONNX_EMBED_CAPABILITY_METHODS } from '../../../src/core/onnx-embed-capability.js';
import { OnnxRuntimeUnavailableError } from '../../../src/local/core/onnx-runtime-unavailable-capability.js';
import { resolveOnnxEmbedCapabilityForMcp } from '../../../src/mcp/onnx-runtime-resolution.js';

function fakeSettingsService(values = {}) {
  return { getActiveValue: (key) => values[key] ?? '' };
}

describe('resolveOnnxEmbedCapabilityForMcp() — MCP now resolves ONNX_MANAGED_RUNTIME (review finding, P1)', () => {
  it('calls resolveOnnxRuntimeForProcessFn with the given settingsService and env — the SAME shared resolution sequence indexer/index-full.js and admin/bootstrap.js use', async () => {
    let receivedArgs = null;
    const settingsService = fakeSettingsService({ ONNX_MANAGED_RUNTIME: '1.26.0-cuda13' });
    const env = { PATH: 'C:\\Windows' };
    await resolveOnnxEmbedCapabilityForMcp({
      settingsService, env,
      resolveOnnxRuntimeForProcessFn: (args) => { receivedArgs = args; return { resolved: { source: 'managed' }, resolutionWarning: null, prepared: { ok: true } }; },
      createOnnxEmbeddingCapabilityFn: () => ({ real: true }),
    });
    assert.equal(receivedArgs.settingsService, settingsService);
    assert.equal(receivedArgs.env, env);
  });

  it('a successful resolution (prepared.ok: true) returns the REAL createOnnxEmbeddingCapabilityFn() result — a managed CUDA selection genuinely reaches the capability MCP search uses', async () => {
    const settingsService = fakeSettingsService({ ONNX_MANAGED_RUNTIME: '1.26.0-cuda13' });
    let realCapabilityConstructed = false;
    const capability = await resolveOnnxEmbedCapabilityForMcp({
      settingsService,
      resolveOnnxRuntimeForProcessFn: () => ({ resolved: { source: 'managed', managedId: '1.26.0-cuda13' }, resolutionWarning: null, prepared: { ok: true } }),
      createOnnxEmbeddingCapabilityFn: () => { realCapabilityConstructed = true; return { real: true, loadOnnx: async () => {} }; },
    });
    assert.equal(realCapabilityConstructed, true);
    assert.deepEqual(capability, { real: true, loadOnnx: capability.loadOnnx });
  });

  it('a broken resolution (prepared.ok: false) returns a typed-unavailable capability INSTEAD of ever constructing the real one — never silently attempts a runtime already proven broken', async () => {
    const settingsService = fakeSettingsService({ ONNX_MANAGED_RUNTIME: '1.26.0-cuda13' });
    let realCapabilityConstructed = false;
    const warnings = [];
    const capability = await resolveOnnxEmbedCapabilityForMcp({
      settingsService,
      resolveOnnxRuntimeForProcessFn: () => ({
        resolved: { source: 'managed', managedId: '1.26.0-cuda13' },
        resolutionWarning: null,
        prepared: { ok: false, reason: 'recorded cuDNN directory no longer exists on disk' },
      }),
      createOnnxEmbeddingCapabilityFn: () => { realCapabilityConstructed = true; return { real: true }; },
      warnLogFn: (msg) => warnings.push(msg),
    });
    assert.equal(realCapabilityConstructed, false, 'the real (potentially broken) runtime must never be constructed once prepared.ok is false');
    for (const m of REQUIRED_ONNX_EMBED_CAPABILITY_METHODS) {
      assert.equal(typeof capability[m], 'function');
    }
    await assert.rejects(() => capability.loadOnnx(), (err) => {
      assert.ok(err instanceof OnnxRuntimeUnavailableError);
      assert.match(err.message, /recorded cuDNN directory no longer exists on disk/);
      return true;
    });
    assert.ok(warnings.some((w) => w.includes('recorded cuDNN directory no longer exists on disk')), 'the specific failure reason must be logged, not swallowed');
  });

  it('a broken resolution\'s shutdown() still resolves safely (indexer/run.js-style finally-block callers never see a throw)', async () => {
    const settingsService = fakeSettingsService({});
    const capability = await resolveOnnxEmbedCapabilityForMcp({
      settingsService,
      resolveOnnxRuntimeForProcessFn: () => ({ resolved: { source: 'managed' }, resolutionWarning: null, prepared: { ok: false, reason: 'broken' } }),
      createOnnxEmbeddingCapabilityFn: () => ({ real: true }),
    });
    await assert.doesNotReject(() => capability.shutdown());
  });

  // Review finding (P1): an invalid/corrupt EXPLICIT managed selection is
  // no longer a scenario where prepared.ok can be true — real
  // resolveOnnxRuntimeForProcess() now folds that failure into
  // prepared.ok:false via resolved.resolutionFailed (see
  // onnx-runtime-source-resolution.js and its own dedicated test
  // coverage). This test instead proves resolveOnnxEmbedCapabilityForMcp()
  // trusts prepared.ok alone — not resolutionWarning's mere presence —
  // using a resolutionWarning shape that is NOT a broken-selection
  // failure, so the real capability legitimately gets constructed.
  it('a resolutionWarning that is NOT paired with prepared.ok:false is logged but does NOT by itself force the unavailable capability — only prepared.ok decides that', async () => {
    const settingsService = fakeSettingsService({});
    let realCapabilityConstructed = false;
    const warnings = [];
    const capability = await resolveOnnxEmbedCapabilityForMcp({
      settingsService,
      resolveOnnxRuntimeForProcessFn: () => ({
        resolved: { source: 'npm', managedId: null },
        resolutionWarning: 'informational: no ONNX_MANAGED_RUNTIME configured, using default npm package',
        prepared: { ok: true },
      }),
      createOnnxEmbeddingCapabilityFn: () => { realCapabilityConstructed = true; return { real: true }; },
      warnLogFn: (msg) => warnings.push(msg),
    });
    assert.equal(realCapabilityConstructed, true);
    assert.deepEqual(capability, { real: true });
    assert.ok(warnings.some((w) => w.includes('informational')));
  });

  it('an invalid/corrupt EXPLICIT managed selection now produces prepared.ok:false (via resolutionFailed) and returns the typed-unavailable capability — the exact scenario the review finding closed', async () => {
    const settingsService = fakeSettingsService({ ONNX_MANAGED_RUNTIME: 'not-a-valid-id' });
    let realCapabilityConstructed = false;
    const warnings = [];
    const capability = await resolveOnnxEmbedCapabilityForMcp({
      settingsService,
      resolveOnnxRuntimeForProcessFn: () => ({
        resolved: { source: 'npm', managedId: null, resolutionFailed: true },
        resolutionWarning: 'managed runtime selected but invalid/corrupt: invalid managed runtime id "not-a-valid-id"',
        prepared: { ok: false, reason: 'managed runtime selected but invalid/corrupt: invalid managed runtime id "not-a-valid-id"' },
      }),
      createOnnxEmbeddingCapabilityFn: () => { realCapabilityConstructed = true; return { real: true }; },
      warnLogFn: (msg) => warnings.push(msg),
    });
    assert.equal(realCapabilityConstructed, false, 'MCP must never construct the real (potentially CPU-only) capability when the user explicitly selected a managed CUDA runtime that failed to resolve');
    for (const m of REQUIRED_ONNX_EMBED_CAPABILITY_METHODS) {
      assert.equal(typeof capability[m], 'function');
    }
    await assert.rejects(() => capability.loadOnnx(), /invalid\/corrupt/);
    assert.ok(warnings.some((w) => w.includes('invalid/corrupt')));
  });

  it('no warning at all when resolution is clean (npm default, no managed selection configured)', async () => {
    const settingsService = fakeSettingsService({});
    const warnings = [];
    await resolveOnnxEmbedCapabilityForMcp({
      settingsService,
      resolveOnnxRuntimeForProcessFn: () => ({ resolved: { source: 'npm', managedId: null }, resolutionWarning: null, prepared: { ok: true } }),
      createOnnxEmbeddingCapabilityFn: () => ({ real: true }),
      warnLogFn: (msg) => warnings.push(msg),
    });
    assert.deepEqual(warnings, []);
  });
});
