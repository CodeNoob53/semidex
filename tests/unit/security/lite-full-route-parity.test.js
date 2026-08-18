// Supports: docs/security/semidex-lite-public-api-audit-2026-08.md
// "Full-only route accidentally shipped/mounted in the Lite composition"
// verification — the audit's explicit, checkable claim that
// src/admin/composition/lite.js's createLiteApp() never registers any of
// the Full-only local-runtime routes (ONNX probe, Ollama status, Ollama
// model discovery, folder-picker's checkOllamaFn-dependent variants).
//
// Traced by reading, not inferred: createLiteApp() (src/admin/composition/
// lite.js) calls ONLY registerNeutralRoutes() + registerQdrantCloudRoutes()
// + registerGenerationModelsRoutesGeminiOnly() (via generationModelsFn) +
// registerJobsRoutes() with LITE_JOB_POLICY (via jobsFn) — it never imports
// or calls registerOnnxRoutes, registerOllamaModelsRoutes, or
// registerOllamaStatusRoutes, all three of which createApp()
// (src/admin/server-full.js) DOES call, in addition to registerNeutralRoutes().
// tests/unit/lite/serve-lite.test.js already characterizes two of these
// paths as 404 through the REAL startLite() composition; this test
// characterizes the same absence directly against createLiteApp() (the
// lower-level composition root, no CLI/env bootstrapping involved) and
// widens the route list to match everything server-full.js registers that
// composition/lite.js does not.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLiteApp } from '../../../src/admin/composition/lite.js';
import { createJobRegistry } from '../../../src/shared/admin/jobs/registry.js';

function makeStubAdapter() {
  return {
    name: () => 'stub',
    capabilities: () => ({}),
    ping: async () => ({ ok: true }),
    listCollections: async () => [],
    getCollection: async () => null,
  };
}

function makeFakeChildForSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

async function withLiteApp(fn) {
  const jobRegistry = createJobRegistry({
    spawnIndexer: () => makeFakeChildForSpawn(),
    baseEnv: {},
  });
  const app = createLiteApp({
    adapter: makeStubAdapter(),
    embedQuery: async () => ({ dense: [], sparse: {} }),
    jobRegistry,
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

// Every route server-full.js's createApp() registers via a Full-only,
// local-runtime module that composition/lite.js's createLiteApp() never
// imports at all (registerOllamaModelsRoutes, registerOllamaStatusRoutes,
// registerOnnxRoutes — see server-full.js's own import list vs.
// composition/lite.js's own import list, read directly, not grepped).
const FULL_ONLY_ROUTES = [
  { method: 'GET', path: '/api/system/ollama-status' },
  { method: 'GET', path: '/api/ollama-models' },
  { method: 'POST', path: '/api/system/onnx-probe' },
  { method: 'GET', path: '/api/system/onnx-managed-runtimes' },
];

describe('createLiteApp() — Full-only local-runtime routes are never mounted (P0 regression guard: "does a Full-only route accidentally ship in Lite")', () => {
  for (const { method, path } of FULL_ONLY_ROUTES) {
    it(`${method} ${path} is 404 (route never registered in the Lite composition)`, async () => {
      await withLiteApp(async (base) => {
        const res = await fetch(base + path, { method });
        assert.equal(res.status, 404, `expected ${method} ${path} to be unmounted in Lite; got ${res.status}`);
      });
    });
  }

  it('GET /api/generation/models?backend=ollama is a clean 400 (Gemini-only route registered, but the ollama backend value itself is rejected) — not a 500 from a missing dependency', async () => {
    await withLiteApp(async (base) => {
      const res = await fetch(base + '/api/generation/models?backend=ollama');
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error.message, /not available in this deployment/);
    });
  });

  it('POST /api/jobs/index with options.llmSummaries:true is rejected by LITE_JOB_POLICY at request-validation time (400), never reaching a missing checkOllamaFn', async () => {
    await withLiteApp(async (base) => {
      const res = await fetch(base + '/api/jobs/index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'c', path: './docs', options: { llmSummaries: true } }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error.code, 'not_available_in_lite');
    });
  });

  it('sanity check: a genuinely shared route (GET /api/health) IS reachable in Lite, proving the 404s above are route-absence, not a broken server', async () => {
    await withLiteApp(async (base) => {
      const res = await fetch(base + '/api/health');
      assert.equal(res.status, 200);
    });
  });
});
