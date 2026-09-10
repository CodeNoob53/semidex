// POST /api/generation/model-probe — offline, through the REAL router.
// probeModelFn is injected, so no billed API call is ever made here.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createRouter } from '../../../src/shared/admin/router.js';
import { registerGeminiModelProbeRoutes } from '../../../src/cloud/admin/gemini-model-probe-api.js';

function settingsService(values = { GEMINI_API_KEY: 'test-key' }) {
  return { getActiveValue: (key) => values[key], get: (key) => ({ activeValue: values[key] }) };
}

async function call(router, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.url = '/api/generation/model-probe';
  req.headers = { 'content-type': 'application/json', host: '127.0.0.1:8642' };
  let statusCode = null;
  const chunks = [];
  const res = {
    writeHead(code) { statusCode = code; },
    write(c) { chunks.push(String(c)); return true; },
    end(c) { if (c) chunks.push(String(c)); },
    on() {}, destroyed: false, writableEnded: false,
  };
  await router.handleRequest(req, res);
  const raw = chunks.join('');
  let json = null;
  try { json = JSON.parse(raw); } catch { /* non-JSON body */ }
  return { statusCode, json, raw };
}

function makeApp({ probeModelFn, values } = {}) {
  const router = createRouter();
  registerGeminiModelProbeRoutes(router, { settingsService: settingsService(values), probeModelFn });
  return router;
}

describe('POST /api/generation/model-probe', () => {
  it('returns the probe result for a model', async () => {
    const router = makeApp({ probeModelFn: async ({ model }) => ({ model, status: 'available', detail: null }) });
    const res = await call(router, { model: 'gemini-3.6-flash' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json, { model: 'gemini-3.6-flash', status: 'available', detail: null });
  });

  it('passes the configured API key to the prober and never echoes it back', async () => {
    let receivedKey = null;
    const router = makeApp({
      values: { GEMINI_API_KEY: 'super-secret' },
      probeModelFn: async ({ apiKey, model }) => { receivedKey = apiKey; return { model, status: 'available', detail: null }; },
    });
    const res = await call(router, { model: 'm' });
    assert.equal(receivedKey, 'super-secret');
    assert.ok(!res.raw.includes('super-secret'), 'the API key must never appear in the response body');
  });

  it('a retired model is a 200 with a typed status — never a 5xx', async () => {
    const router = makeApp({
      probeModelFn: async ({ model }) => ({ model, status: 'retired', detail: 'no longer available; use models/gemini-3.6-flash' }),
    });
    const res = await call(router, { model: 'gemini-2.5-flash' });
    assert.equal(res.statusCode, 200,
      'a dead MODEL is not a broken SEMIDEX — a 5xx here would be the wrong claim');
    assert.equal(res.json.status, 'retired');
    assert.match(res.json.detail, /gemini-3\.6-flash/);
  });

  it('rejects a missing or blank model with 400 and never probes', async () => {
    let called = false;
    const router = makeApp({ probeModelFn: async () => { called = true; return {}; } });
    for (const body of [{}, { model: '' }, { model: '   ' }, { model: 42 }]) {
      const res = await call(router, body);
      assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(body)}`);
    }
    assert.equal(called, false, 'a billed probe must never run for an invalid request');
  });

  it('trims the supplied model name', async () => {
    let received = null;
    const router = makeApp({ probeModelFn: async ({ model }) => { received = model; return { model, status: 'available', detail: null }; } });
    await call(router, { model: '  gemini-3.6-flash  ' });
    assert.equal(received, 'gemini-3.6-flash');
  });

  it('is registered as an admin PROBE route classified as billed LLM cost', async () => {
    const router = makeApp({ probeModelFn: async () => ({ status: 'available' }) });
    const route = router.listRoutes().find((r) => r.path === '/api/generation/model-probe');
    assert.ok(route);
    assert.equal(route.audience, 'admin', 'this makes a billed call — it must never be on the integration surface');
    assert.equal(route.operation, 'probe');
    assert.equal(route.costClass, 'llm', 'unlike GET /api/generation/models, this really does cost money');
  });
});
