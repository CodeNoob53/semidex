// Regression: agent mode must share the SAME single-flight generation gate
// as Ask v1/v2.
//
// The bug was in the WIRING, not the runtime: register-neutral-routes.js
// constructed the agent runtime with no gate at all, so /api/v3/ask
// bypassed the process's one-generation-at-a-time policy entirely
// (reproduced: two concurrent start() calls ran two real generations).
// A runtime-level test cannot catch that — it can only be proven through a
// real composition root, over real HTTP, which is what this file does.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiteApp } from '../../../src/admin/composition/lite.js';
import { createJobRegistry } from '../../../src/shared/admin/jobs/registry.js';
import { createKeyStore } from '../../../src/core/auth/key-store.js';
import { createIntegrationPolicy } from '../../../src/core/auth/integration-policy.js';
import { createRateLimiter } from '../../../src/core/auth/rate-limiter.js';

const TOOLS = [{
  name: 'lookup_items',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
}];

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  return c;
}

/**
 * A generation runtime whose agentStep is deliberately slow, so two
 * overlapping requests would be observable if the gate were missing.
 */
function slowGenerationRuntime(observe) {
  return {
    name: () => 'fake',
    capabilities: () => ({ streaming: true, clientAbort: true, upstreamCancellation: false, hardOutputCap: true, toolCalling: true }),
    ready: async () => ({ ok: true, model: 'fake', numCtx: 8192 }),
    generate: async () => ({ text: 'ok' }),
    async agentStep() {
      observe.enter();
      await new Promise((resolve) => setTimeout(resolve, 25));
      observe.exit();
      return { status: 'completed', text: 'ok', toolCalls: [], usage: {}, providerState: {} };
    },
    getStatus: async () => ({ backend: 'fake', ready: true }),
    getConfig: () => null,
  };
}

async function withApp(generationRuntime, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-gate-'));
  const keyStore = createKeyStore({ path: join(dir, 'integration-keys.json') });
  const { token } = keyStore.createKey({ name: 'gate-test', collections: ['*'], operations: ['agent'] });
  const app = createLiteApp({
    integrationPolicy: createIntegrationPolicy({ keyStore, rateLimiter: createRateLimiter(), logger: { warn() {}, error() {} } }),
    adapter: {
      name: () => 's',
      capabilities: () => ({ namedVectors: true, sparseVectors: true, hybridSearch: true }),
      ping: async () => ({ ok: true }),
      listCollections: async () => [],
      getCollection: async () => null,
      getEmbeddingProfile: async () => ({ state: 'missing' }),
    },
    embedQuery: async () => ({ dense: [1], sparse: {} }),
    jobRegistry: createJobRegistry({ spawnIndexer: () => fakeChild(), baseEnv: {} }),
    generationRuntime,
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${app.address().port}`, token);
  } finally {
    await new Promise((r) => app.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('agent mode shares the Ask generation gate', () => {
  it('two concurrent /api/v3/ask requests never run two generations at once', async () => {
    let inFlight = 0;
    let observedParallel = 0;
    const observe = {
      enter() { inFlight += 1; observedParallel = Math.max(observedParallel, inFlight); },
      exit() { inFlight -= 1; },
    };

    await withApp(slowGenerationRuntime(observe), async (base, token) => {
      const body = JSON.stringify({ input: 'hi', tools: TOOLS });
      const call = () => fetch(`${base}/api/v3/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body,
      }).then(async (r) => ({ status: r.status, text: await r.text() }));

      const [a, b] = await Promise.all([call(), call()]);

      assert.equal(observedParallel, 1,
        'agent mode must contend on the SAME single-flight gate as Ask v1/v2 — two real generations must never overlap');

      // One request wins; the other is told the gate is held rather than
      // silently running a second concurrent generation.
      const results = [a, b];
      const succeeded = results.filter((r) => r.status === 200 && r.text.includes('"status":"completed"'));
      const busy = results.filter((r) => r.text.includes('busy'));
      assert.equal(succeeded.length, 1, 'exactly one request may complete');
      assert.equal(busy.length, 1, 'the other must report busy');
    });
  });
});
