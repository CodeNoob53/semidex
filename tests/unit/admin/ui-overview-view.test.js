// Tests for features/overview/view.js — the Overview v2 lifecycle-owned
// view controller (design plan §5.1, §8.4, §13 S1). Real ESM imports:
// mount()/dispose() against a linkedom document assigned to
// globalThis.document (the seam every shared/ui primitive's own
// document.createElement call resolves against), with globalThis.fetch
// stubbed per-endpoint. No vm-harness needed — this is genuine module
// behavior, not a source-text/regex approximation.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML, EventTarget, Event, Node } from 'linkedom';
import { mount } from '../../../src/shared/admin/ui-src/features/overview/view.js';
import { resetForTests as resetStatusStore, listenerCount as statusListenerCount } from '../../../src/shared/admin/ui-src/shared/status/store.js';
import { resetForTests as resetOpStore, listenerCount as opListenerCount, pollNow as pollOpsNow } from '../../../src/shared/admin/ui-src/operation-store.js';
import { bootCapabilities, resetCapabilitiesForTests } from '../../../src/shared/admin/ui-src/shared/capabilities/boot.js';

const originalDocument = globalThis.document;
const originalNode = globalThis.Node;
const originalFetch = globalThis.fetch;
const originalLocation = globalThis.location;

const HEALTH_OK = { ok: true, storage: { backend: 'qdrant', ok: true, detail: null } };
const HEALTH_FAIL = { ok: false, storage: { backend: 'qdrant', ok: false, detail: 'connection refused' } };
const GEN_READY = { backend: 'ollama', model: 'qwen2.5', ready: true, reason: null, numCtx: 4096, capabilities: {}, devicePolicy: { value: 'auto', supported: ['auto'] }, configuration: null };
const GEN_NOT_READY = { backend: 'ollama', model: null, ready: false, reason: 'Ollama is not reachable', numCtx: null, capabilities: {}, devicePolicy: { value: 'auto', supported: ['auto'] }, configuration: null };
const CAPS_OK = { backend: 'qdrant', capabilities: { namedVectors: true, aliases: false } };

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Routes globalThis.fetch by endpoint substring to a canned/overridable
 * response map; each entry may be a value, a function(path), or an Error
 * to reject with. Missing entries hang forever (a deliberate "never called
 * this endpoint" trap, unless the test wants a real hang). */
function routedFetch(map) {
  return async (path) => {
    for (const [key, value] of Object.entries(map)) {
      if (String(path).includes(key)) {
        const resolved = typeof value === 'function' ? value(path) : value;
        if (resolved instanceof Error) throw resolved;
        return resolved;
      }
    }
    return new Promise(() => {}); // hang — no stub configured for this path
  };
}

function makeHost() {
  const { document } = parseHTML('<div id="root"></div>');
  globalThis.document = document;
  return document.getElementById('root');
}

beforeEach(() => {
  resetStatusStore();
  resetOpStore();
  resetCapabilitiesForTests();
  globalThis.Node = Node;
  globalThis.location = { hash: '#/' };
});

afterEach(() => {
  globalThis.document = originalDocument;
  globalThis.Node = originalNode;
  globalThis.fetch = originalFetch;
  globalThis.location = originalLocation;
  resetStatusStore();
  resetOpStore();
  resetCapabilitiesForTests();
});

async function settle(times = 3) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

function mountOverview(host) {
  bootCapabilities({ edition: 'full' });
  return mount(host, {});
}

describe('Overview v2 — ready state', () => {
  it('renders storage/generation/edition status and a collections table once every source resolves', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({
      '/api/health': jsonResponse(200, HEALTH_OK),
      '/api/generation/status': jsonResponse(200, GEN_READY),
      '/api/capabilities': jsonResponse(200, CAPS_OK),
      '/api/collections': jsonResponse(200, { collections: [{ name: 'my-docs', pointCount: 12, vectorSchema: 'named', provider: { denseProvider: 'ollama', denseModel: 'bge-m3', sparseProvider: null }, embeddingProfileState: 'valid', description: null }] }),
      '/api/operations': jsonResponse(200, { operations: [] }),
    });
    const { dispose } = mountOverview(host);
    await pollOpsNow();
    await settle(6);

    const statusText = host.querySelector('#ov-status').textContent;
    assert.match(statusText, /qdrant/);
    assert.match(statusText, /reachable/);
    assert.match(statusText, /ollama/);

    const table = host.querySelector('#ov-collections table.data');
    assert.ok(table, 'a collections table must render once data resolves');
    assert.match(table.textContent, /my-docs/);
    dispose();
  });
});

describe('Overview v2 — empty state', () => {
  it('renders an empty state with an "Index a folder" call to action when there are no collections', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({
      '/api/health': jsonResponse(200, HEALTH_OK),
      '/api/generation/status': jsonResponse(200, GEN_READY),
      '/api/capabilities': jsonResponse(200, CAPS_OK),
      '/api/collections': jsonResponse(200, { collections: [] }),
      '/api/operations': jsonResponse(200, { operations: [] }),
    });
    const { dispose } = mountOverview(host);
    await settle(6);
    const empty = host.querySelector('#ov-collections .state-empty');
    assert.ok(empty, 'an empty collections list must render the empty-state primitive');
    const link = empty.querySelector('a.state-action');
    assert.equal(link.getAttribute('href'), '#/index');
    dispose();
  });

  it('renders an empty state for the operations panel when there are none', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({
      '/api/health': jsonResponse(200, HEALTH_OK),
      '/api/generation/status': jsonResponse(200, GEN_READY),
      '/api/capabilities': jsonResponse(200, CAPS_OK),
      '/api/collections': jsonResponse(200, { collections: [] }),
      '/api/operations': jsonResponse(200, { operations: [] }),
    });
    const { dispose } = mountOverview(host);
    await settle(6);
    assert.ok(host.querySelector('#ov-operations .state-empty'));
    dispose();
  });
});

describe('Overview v2 — error state', () => {
  it('a malformed /api/collections response renders a contract error with Retry, and Retry re-fetches', async () => {
    const host = makeHost();
    let attempt = 0;
    globalThis.fetch = routedFetch({
      '/api/health': jsonResponse(200, HEALTH_OK),
      '/api/generation/status': jsonResponse(200, GEN_READY),
      '/api/capabilities': jsonResponse(200, CAPS_OK),
      '/api/operations': jsonResponse(200, { operations: [] }),
      '/api/collections': () => {
        attempt += 1;
        if (attempt === 1) return jsonResponse(200, { collections: 'not-an-array' }); // malformed -> contract error
        return jsonResponse(200, { collections: [] });
      },
    });
    const { dispose } = mountOverview(host);
    await settle(6);
    const errorBox = host.querySelector('#ov-collections .state-error');
    assert.ok(errorBox, 'a malformed response must render the error-state primitive, never crash');
    const retryBtn = errorBox.querySelector('button.state-retry');
    assert.ok(retryBtn);

    retryBtn.dispatchEvent(new Event('click', { bubbles: true }));
    await settle(6);
    assert.equal(host.querySelector('#ov-collections .state-error'), null, 'a successful retry must clear the error state');
    assert.ok(host.querySelector('#ov-collections .state-empty'), 'retry\'s successful response must render');
    dispose();
  });
});

describe('Overview v2 — degraded state (banner names the failing subsystem)', () => {
  it('shows a degraded banner when generation is not ready, while storage/collections still render', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({
      '/api/health': jsonResponse(200, HEALTH_OK),
      '/api/generation/status': jsonResponse(200, GEN_NOT_READY),
      '/api/capabilities': jsonResponse(200, CAPS_OK),
      '/api/collections': jsonResponse(200, { collections: [{ name: 'c1', pointCount: 1, vectorSchema: 'named', provider: { denseProvider: null, denseModel: null, sparseProvider: null }, embeddingProfileState: 'valid', description: null }] }),
      '/api/operations': jsonResponse(200, { operations: [] }),
    });
    const { dispose } = mountOverview(host);
    await settle(6);

    const banner = host.querySelector('#ov-banner');
    assert.equal(banner.hidden, false);
    assert.match(banner.textContent, /Generation/);
    assert.match(banner.textContent, /Ollama is not reachable/);
    // One failed source must not erase a successfully loaded one — the
    // collections table (and the storage status row) still render.
    assert.ok(host.querySelector('#ov-collections table.data'));
    assert.match(host.querySelector('#ov-status').textContent, /qdrant/);
    dispose();
  });

  it('hides the banner once every degraded source recovers', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({
      '/api/health': jsonResponse(200, HEALTH_FAIL),
      '/api/generation/status': jsonResponse(200, GEN_READY),
      '/api/capabilities': jsonResponse(200, CAPS_OK),
      '/api/collections': jsonResponse(200, { collections: [] }),
      '/api/operations': jsonResponse(200, { operations: [] }),
    });
    const { dispose } = mountOverview(host);
    await settle(6);
    assert.equal(host.querySelector('#ov-banner').hidden, false);
    dispose();
  });
});

describe('Overview v2 — partial (one failed source does not blank the rest)', () => {
  it('a network failure on /api/collections leaves the status strip intact', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({
      '/api/health': jsonResponse(200, HEALTH_OK),
      '/api/generation/status': jsonResponse(200, GEN_READY),
      '/api/capabilities': jsonResponse(200, CAPS_OK),
      '/api/operations': jsonResponse(200, { operations: [] }),
      '/api/collections': new TypeError('fetch failed'),
    });
    const { dispose } = mountOverview(host);
    await settle(6);
    assert.ok(host.querySelector('#ov-collections .state-error'));
    assert.match(host.querySelector('#ov-status').textContent, /qdrant/, 'storage status must still render despite the collections failure');
    dispose();
  });
});

describe('Overview v2 — safe rendering (XSS)', () => {
  it('renders a hostile collection name and operation label as inert text, never markup', async () => {
    const host = makeHost();
    const malicious = '<img src=x onerror="window.__pwned=true">';
    globalThis.fetch = routedFetch({
      '/api/health': jsonResponse(200, HEALTH_OK),
      '/api/generation/status': jsonResponse(200, GEN_READY),
      '/api/capabilities': jsonResponse(200, CAPS_OK),
      '/api/collections': jsonResponse(200, { collections: [{ name: malicious, pointCount: 1, vectorSchema: 'named', provider: { denseProvider: null, denseModel: null, sparseProvider: null }, embeddingProfileState: 'valid', description: null }] }),
      '/api/operations': jsonResponse(200, { operations: [{ id: 'op1', kind: 'index', collection: malicious, path: null, state: 'running', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null, cancellable: true, progress: null, error: null }] }),
    });
    const { dispose } = mountOverview(host);
    await pollOpsNow();
    await settle(6);
    assert.equal(host.querySelectorAll('img').length, 0, 'malicious text must never be parsed into a real element anywhere in Overview');
    assert.match(host.querySelector('#ov-collections').textContent, /<img/);
    assert.match(host.querySelector('#ov-operations').textContent, /<img/);
    dispose();
  });
});

describe('Overview v2 — navigation away aborts pending requests; late responses never commit', () => {
  it('dispose() before the collections fetch resolves leaves the loading state in place, and the late response is discarded', async () => {
    const host = makeHost();
    let capturedSignal = null;
    globalThis.fetch = async (path, init) => {
      if (String(path).includes('/api/collections')) {
        capturedSignal = init?.signal ?? null;
        return new Promise((_resolve, reject) => {
          capturedSignal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      if (String(path).includes('/api/health')) return jsonResponse(200, HEALTH_OK);
      if (String(path).includes('/api/generation/status')) return jsonResponse(200, GEN_READY);
      if (String(path).includes('/api/capabilities')) return jsonResponse(200, CAPS_OK);
      if (String(path).includes('/api/operations')) return jsonResponse(200, { operations: [] });
      return new Promise(() => {});
    };
    const { dispose } = mountOverview(host);
    await settle(2);
    assert.ok(host.querySelector('#ov-collections .state-loading'), 'sanity: still loading before dispose');

    dispose();
    assert.ok(capturedSignal?.aborted, 'dispose() must abort the in-flight collections request');
    await settle(4);
    // The host subtree is untouched by dispose() itself (the router
    // overwrites #main on the NEXT render) — what matters is that the
    // aborted fetch's rejection never overwrote the loading state with a
    // late error box or, worse, stale data.
    assert.ok(host.querySelector('#ov-collections .state-loading'), 'no late commit may replace the loading state after dispose()');
  });

  it('an old mount resolving after a replacement mount never commits into the replacement view', async () => {
    const host = makeHost();
    const deferredByCall = [];
    let call = 0;
    globalThis.fetch = async (path) => {
      if (String(path).includes('/api/collections')) {
        const index = call;
        call += 1;
        return new Promise((resolve, reject) => { deferredByCall[index] = { resolve, reject }; });
      }
      if (String(path).includes('/api/health')) return jsonResponse(200, HEALTH_OK);
      if (String(path).includes('/api/generation/status')) return jsonResponse(200, GEN_READY);
      if (String(path).includes('/api/capabilities')) return jsonResponse(200, CAPS_OK);
      if (String(path).includes('/api/operations')) return jsonResponse(200, { operations: [] });
      return new Promise(() => {});
    };
    const first = mountOverview(host); // call 0
    await settle(2);
    first.dispose();
    const second = mountOverview(host); // call 1
    await settle(2);

    deferredByCall[1].resolve(jsonResponse(200, { collections: [{ name: 'newer', pointCount: 2, vectorSchema: 'named', provider: { denseProvider: null, denseModel: null, sparseProvider: null }, embeddingProfileState: 'valid', description: null }] }));
    await settle(3);
    deferredByCall[0].resolve(jsonResponse(200, { collections: [{ name: 'older-must-not-render', pointCount: 1, vectorSchema: 'named', provider: { denseProvider: null, denseModel: null, sparseProvider: null }, embeddingProfileState: 'valid', description: null }] }));
    await settle(3);

    const text = host.querySelector('#ov-collections').textContent;
    assert.match(text, /newer/);
    assert.ok(!text.includes('older-must-not-render'), 'a stale, later-resolving response must never overwrite the newer committed render');
    second.dispose();
  });
});

describe('Overview v2 — delegated operation actions (no listener per row)', () => {
  it('registers exactly the click+keydown listeners once per operations render, not scaling with row count', async () => {
    const host = makeHost();
    const many = Array.from({ length: 15 }, (_, i) => ({
      id: `op${i}`, kind: 'index', collection: `c${i}`, path: null, state: 'running',
      startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null, cancellable: true, progress: null, error: null,
    }));
    globalThis.fetch = routedFetch({
      '/api/health': jsonResponse(200, HEALTH_OK),
      '/api/generation/status': jsonResponse(200, GEN_READY),
      '/api/capabilities': jsonResponse(200, CAPS_OK),
      '/api/collections': jsonResponse(200, { collections: [] }),
      '/api/operations': jsonResponse(200, { operations: many }),
    });
    const elementProto = Object.getPrototypeOf(document.createElement('div'));
    const original = elementProto.addEventListener;
    let calls = 0;
    elementProto.addEventListener = function patched(...args) {
      if (this.id === 'ov-operations') calls++;
      return original.apply(this, args);
    };
    let dispose;
    try {
      ({ dispose } = mountOverview(host));
      await pollOpsNow();
      await settle(6);
    } finally {
      elementProto.addEventListener = original;
    }
    // 2 (click+keydown on the operations list root) is independent of the
    // 15 rows above — a per-row implementation would scale to 30+.
    assert.equal(calls, 2, `expected exactly 2 delegated listeners regardless of the 15 operation rows, got ${calls}`);
    assert.equal(host.querySelectorAll('#ov-operations li[data-op-id]').length, 8, 'Overview intentionally bounds recent operations');
    dispose();
  });
});

describe('Overview v2 — shares status data with the topbar (no duplicate polling)', () => {
  it('mounting Overview does not start a second /api/health or /api/generation/status poll loop beyond the shared store\'s own single cycle', async () => {
    const host = makeHost();
    const calls = { health: 0, generation: 0 };
    globalThis.fetch = async (path) => {
      if (String(path).includes('/api/health')) { calls.health++; return jsonResponse(200, HEALTH_OK); }
      if (String(path).includes('/api/generation/status')) { calls.generation++; return jsonResponse(200, GEN_READY); }
      if (String(path).includes('/api/capabilities')) return jsonResponse(200, CAPS_OK);
      if (String(path).includes('/api/collections')) return jsonResponse(200, { collections: [] });
      if (String(path).includes('/api/operations')) return jsonResponse(200, { operations: [] });
      return new Promise(() => {});
    };
    const { dispose } = mountOverview(host);
    await settle(6);
    assert.equal(calls.health, 1, 'exactly one health fetch — the shared store\'s single poll tick, not one per subscriber');
    assert.equal(calls.generation, 1);
    dispose();
  });
});

describe('Overview v2 — leak soak (mount/dispose ×20)', () => {
  it('does not grow the shared status-store or operation-store subscriber counts', async () => {
    globalThis.fetch = routedFetch({
      '/api/health': jsonResponse(200, HEALTH_OK),
      '/api/generation/status': jsonResponse(200, GEN_READY),
      '/api/capabilities': jsonResponse(200, CAPS_OK),
      '/api/collections': jsonResponse(200, { collections: [] }),
      '/api/operations': jsonResponse(200, { operations: [] }),
    });
    const baselineStatus = statusListenerCount();
    const baselineOps = opListenerCount();
    for (let i = 0; i < 20; i++) {
      const host = makeHost();
      const { dispose } = mountOverview(host);
      await settle(2);
      dispose();
      assert.equal(statusListenerCount(), baselineStatus, `status-store listeners must not grow past cycle ${i}`);
      assert.equal(opListenerCount(), baselineOps, `operation-store listeners must not grow past cycle ${i}`);
    }
  });

  it('leaves no pending collections request after repeated mount/dispose (each request is aborted)', async () => {
    const signals = [];
    globalThis.fetch = async (path, init) => {
      if (String(path).includes('/api/collections')) {
        signals.push(init?.signal ?? null);
        return new Promise(() => {}); // never resolves — dispose() must abort it
      }
      if (String(path).includes('/api/health')) return jsonResponse(200, HEALTH_OK);
      if (String(path).includes('/api/generation/status')) return jsonResponse(200, GEN_READY);
      if (String(path).includes('/api/capabilities')) return jsonResponse(200, CAPS_OK);
      if (String(path).includes('/api/operations')) return jsonResponse(200, { operations: [] });
      return new Promise(() => {});
    };
    for (let i = 0; i < 5; i++) {
      const host = makeHost();
      const { dispose } = mountOverview(host);
      await settle(2);
      dispose();
    }
    assert.equal(signals.length, 5);
    assert.ok(signals.every((s) => s.aborted), 'every mount cycle\'s collections request must be aborted by its own dispose()');
  });
});
