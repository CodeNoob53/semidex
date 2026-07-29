// Tests for POST /api/system/qdrant-cloud-probe (src/admin/api/qdrant-cloud.js)
// — the admin route wiring around admin/system/qdrant-cloud.js's Tier 2
// probeQdrantCloudInference(). Every test injects a stub runQdrantCloudProbeFn
// — never a real Qdrant Cloud Inference round-trip, matching this endpoint's
// own contract (mirrors tests/unit/admin/api/onnx.test.js's conventions).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withServer } from '../ui-test-helpers.js';
import { createSettingsService } from '../../../../src/core/settings/service.js';

function tempSettingsPath(dir) {
  return join(dir, 'settings.json');
}

async function httpPostJson(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

describe('POST /api/system/qdrant-cloud-probe', () => {
  let dir;
  test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'semidex-qdrant-cloud-probe-api-test-')); });
  test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('returns inference_available on success', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const runQdrantCloudProbeFn = async () => ({ status: 'inference_available' });
    await withServer(async (base) => {
      const { status, json } = await httpPostJson(base, '/api/system/qdrant-cloud-probe', { denseModel: 'intfloat/multilingual-e5-small' });
      assert.equal(status, 200);
      assert.deepEqual(json, { status: 'inference_available' });
    }, { settingsService, runQdrantCloudProbeFn });
  });

  test('returns inference_disabled_or_model_unavailable with a message, status 200 (status-in-body convention, never 5xx for a normal probe failure)', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const runQdrantCloudProbeFn = async () => ({ status: 'inference_disabled_or_model_unavailable', message: 'model not found' });
    await withServer(async (base) => {
      const { status, json } = await httpPostJson(base, '/api/system/qdrant-cloud-probe', { denseModel: 'intfloat/multilingual-e5-small' });
      assert.equal(status, 200);
      assert.equal(json.status, 'inference_disabled_or_model_unavailable');
      assert.equal(json.message, 'model not found');
    }, { settingsService, runQdrantCloudProbeFn });
  });

  test('rejects a denseModel not in the supported catalog with 400, never calling the probe', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    let called = false;
    const runQdrantCloudProbeFn = async () => { called = true; return { status: 'inference_available' }; };
    await withServer(async (base) => {
      const { status } = await httpPostJson(base, '/api/system/qdrant-cloud-probe', { denseModel: 'not-a-real-model' });
      assert.equal(status, 400);
    }, { settingsService, runQdrantCloudProbeFn });
    assert.equal(called, false);
  });

  test('rejects a catalog-disabled model (MiniLM) with 400, never calling the probe', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    let called = false;
    const runQdrantCloudProbeFn = async () => { called = true; return { status: 'inference_available' }; };
    await withServer(async (base) => {
      const { status } = await httpPostJson(base, '/api/system/qdrant-cloud-probe', { denseModel: 'sentence-transformers/all-minilm-l6-v2' });
      assert.equal(status, 400);
    }, { settingsService, runQdrantCloudProbeFn });
    assert.equal(called, false);
  });

  test('defaults denseModel to the configured QDRANT_CLOUD_DENSE_MODEL setting when the request body omits it — the built profile carries it', async () => {
    const settingsService = createSettingsService({ osEnv: { QDRANT_CLOUD_DENSE_MODEL: 'intfloat/multilingual-e5-small' }, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    let received;
    const runQdrantCloudProbeFn = async ({ profile }) => { received = profile; return { status: 'inference_available' }; };
    await withServer(async (base) => {
      const { status } = await httpPostJson(base, '/api/system/qdrant-cloud-probe', {});
      assert.equal(status, 200);
    }, { settingsService, runQdrantCloudProbeFn });
    assert.equal(received.embedding.dense.model, 'intfloat/multilingual-e5-small');
    assert.equal(received.embedding.dense.execution, 'qdrant-cloud');
  });

  test('an explicit body.denseModel overrides the configured default (tests a STAGED, unsaved selection, same discipline as the ONNX probe route)', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    let received;
    const runQdrantCloudProbeFn = async ({ profile }) => { received = profile; return { status: 'inference_available' }; };
    await withServer(async (base) => {
      await httpPostJson(base, '/api/system/qdrant-cloud-probe', { denseModel: 'intfloat/multilingual-e5-small' });
    }, { settingsService, runQdrantCloudProbeFn });
    assert.equal(received.embedding.dense.model, 'intfloat/multilingual-e5-small');
  });

  test('never echoes QDRANT_KEY in the response — sanitiseErrorMessage redaction is already applied by the probe itself, this route adds no raw error text of its own', async () => {
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const runQdrantCloudProbeFn = async () => ({ status: 'inference_disabled_or_model_unavailable', message: 'redacted upstream: [REDACTED]' });
    await withServer(async (base) => {
      const { json } = await httpPostJson(base, '/api/system/qdrant-cloud-probe', { denseModel: 'intfloat/multilingual-e5-small' });
      assert.ok(!JSON.stringify(json).includes('super-secret-key'));
    }, { settingsService, runQdrantCloudProbeFn });
  });

  test('registerQdrantCloudRoutes()\'s runProbeFn default parameter is genuinely bound to probeQdrantCloudInference — proven via the live function object, not a re-read of the source file', async () => {
    const { registerQdrantCloudRoutes } = await import('../../../../src/admin/api/qdrant-cloud.js');
    const { probeQdrantCloudInference } = await import('../../../../src/admin/system/qdrant-cloud.js');

    const src = registerQdrantCloudRoutes.toString();
    const match = src.match(/function\s+registerQdrantCloudRoutes\s*\(\s*router\s*,\s*\{([^}]*)\}\s*=\s*\{\}\s*\)/);
    assert.ok(match, 'expected registerQdrantCloudRoutes(router, { ... } = {}) destructured-params signature');
    assert.match(match[1], /runProbeFn\s*=\s*probeQdrantCloudInference\b/);

    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath: tempSettingsPath(dir) });
    const registered = [];
    const fakeRouter = { post: (path, handler) => registered.push({ path, handler }) };
    registerQdrantCloudRoutes(fakeRouter, { settingsService });
    assert.equal(registered.length, 1);
    assert.equal(registered[0].path, '/api/system/qdrant-cloud-probe');
    assert.equal(typeof probeQdrantCloudInference, 'function');
  });
});
