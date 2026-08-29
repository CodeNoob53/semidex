// Tests for shared/status/store.js — the shared shell-owned health/
// generation status store (design plan §8.3: "one poller, many
// subscribers"; §13 S1: topbar and Overview must never start duplicate
// polling loops). Plain ESM import with a stubbed global fetch, same seam
// ui-capabilities-boot.test.js uses — no DOM/vm-harness dependency.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  startPolling, stopPolling, pollNow, subscribe, getStatus, resetForTests,
} from '../../../src/shared/admin/ui-src/shared/status/store.js';

const originalFetch = globalThis.fetch;

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  resetForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetForTests();
});

describe('status/store.js — polling', () => {
  it('startPolling() fetches both /api/health and /api/generation/status immediately', async () => {
    const calls = [];
    globalThis.fetch = async (path) => {
      calls.push(path);
      if (String(path).includes('/api/health')) return jsonResponse(200, { ok: true, storage: { backend: 'qdrant', ok: true, detail: null } });
      return jsonResponse(200, { backend: null, model: null, ready: false, reason: 'not configured', numCtx: null, capabilities: {}, devicePolicy: { value: null, supported: [] }, configuration: null });
    };
    startPolling();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(calls.some((c) => String(c).includes('/api/health')));
    assert.ok(calls.some((c) => String(c).includes('/api/generation/status')));
  });

  it('startPolling() is idempotent — a second call does not start a second poll loop', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return jsonResponse(200, { ok: true, storage: { backend: 'qdrant', ok: true, detail: null } }); };
    startPolling();
    startPolling();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2, 'exactly one health + one generation-status call from the ONE poll loop, not four from two loops');
  });

  it('one failed source does not erase the other successfully loaded source', async () => {
    globalThis.fetch = async (path) => {
      if (String(path).includes('/api/health')) return jsonResponse(200, { ok: true, storage: { backend: 'qdrant', ok: true, detail: null } });
      return jsonResponse(503, { error: { message: 'generation backend unavailable' } });
    };
    await pollNow();
    const status = getStatus();
    assert.ok(status.health, 'health must still be populated');
    assert.equal(status.health.ok, true);
    assert.equal(status.generation, null);
    assert.ok(status.generationError, 'the failed source reports its own error');
  });

  it('a later successful poll clears a previous error for that source', async () => {
    let generationFails = true;
    globalThis.fetch = async (path) => {
      if (String(path).includes('/api/health')) return jsonResponse(200, { ok: true, storage: { backend: 'qdrant', ok: true, detail: null } });
      if (generationFails) return jsonResponse(503, { error: { message: 'unavailable' } });
      return jsonResponse(200, { backend: 'ollama', model: 'x', ready: true, reason: null, numCtx: 4096, capabilities: {}, devicePolicy: { value: 'auto', supported: ['auto'] }, configuration: null });
    };
    await pollNow();
    assert.ok(getStatus().generationError);
    generationFails = false;
    await pollNow();
    assert.equal(getStatus().generationError, null);
    assert.ok(getStatus().generation);
  });

  it('subscribers are notified once per poll tick with a consistent snapshot', async () => {
    globalThis.fetch = async () => jsonResponse(200, { ok: true, storage: { backend: 'qdrant', ok: true, detail: null } });
    const events = [];
    subscribe((status) => events.push(status));
    await pollNow();
    assert.equal(events.length, 1);
    assert.ok(events[0].health);
  });

  it('a poll already in flight when stopPolling() runs does not update the store or notify once it resolves', async () => {
    let resolveHealth;
    globalThis.fetch = (path) => {
      if (String(path).includes('/api/health')) {
        return new Promise((resolve) => { resolveHealth = resolve; });
      }
      return Promise.resolve(jsonResponse(200, { backend: null, model: null, ready: false, reason: null, numCtx: null, capabilities: {}, devicePolicy: { value: null, supported: [] }, configuration: null }));
    };
    startPolling(); // kicks off pollOnce(); the health fetch hangs on resolveHealth
    await new Promise((resolve) => setImmediate(resolve));

    stopPolling(); // bumps pollGeneration while the health fetch is still in flight
    let notified = false;
    subscribe(() => { notified = true; });

    resolveHealth(jsonResponse(200, { ok: true, storage: { backend: 'qdrant', ok: true, detail: null } }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(notified, false, 'a poll that was already in flight when stopPolling() ran must not notify subscribers once it resolves');
    assert.equal(getStatus().health, null, 'its result must not be committed to the store either');
  });
});
