// Tests for features/collections/view.js — the Collections directory v2
// lifecycle-owned view controller (design plan §5.2, §8.4, §13 S2A). Same
// harness convention as ui-overview-view.test.js: real ESM imports against
// a linkedom document assigned to globalThis.document, globalThis.fetch
// stubbed per-endpoint. No vm-harness needed — this is genuine module
// behavior, not a source-text/regex approximation.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML, EventTarget, Event, Node } from 'linkedom';
import { mount } from '../../../src/shared/admin/ui-src/features/collections/view.js';
import { resetForTests as resetStatusStore, listenerCount as statusListenerCount, pollNow as pollStatusNow } from '../../../src/shared/admin/ui-src/shared/status/store.js';
import { readUiSource } from './ui-test-helpers.js';

const originalDocument = globalThis.document;
const originalNode = globalThis.Node;
const originalFetch = globalThis.fetch;
const originalLocation = globalThis.location;

const HEALTH_OK = { ok: true, storage: { backend: 'qdrant', ok: true, detail: null } };
const HEALTH_DOWN = { ok: false, storage: { backend: 'qdrant', ok: false, detail: 'connection refused' } };
const GEN_READY = { backend: 'ollama', model: 'qwen2.5', ready: true, reason: null, numCtx: 4096, capabilities: {}, devicePolicy: { value: 'auto', supported: ['auto'] }, configuration: null };

function collection(overrides = {}) {
  return {
    name: 'my-docs',
    pointCount: 12,
    vectorSchema: 'named',
    provider: { denseProvider: 'ollama', denseModel: 'bge-m3', sparseProvider: null },
    embeddingProfileState: 'valid',
    description: null,
    ...overrides,
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Routes globalThis.fetch by endpoint substring to a canned/overridable
 * response map; each entry may be a value, a function(path), or an Error to
 * reject with. Missing entries hang forever (a deliberate "never called
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
  globalThis.Node = Node;
  globalThis.location = { hash: '#/collections' };
});

afterEach(() => {
  globalThis.document = originalDocument;
  globalThis.Node = originalNode;
  globalThis.fetch = originalFetch;
  globalThis.location = originalLocation;
  resetStatusStore();
});

async function settle(times = 6) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

const BASE_STUBS = {
  '/api/health': jsonResponse(200, HEALTH_OK),
  '/api/generation/status': jsonResponse(200, GEN_READY),
};

describe('Collections v2 — loading state', () => {
  it('shows a loading placeholder synchronously on mount, before any fetch resolves', () => {
    const host = makeHost();
    globalThis.fetch = () => new Promise(() => {}); // nothing ever resolves
    const { dispose } = mount(host, {});
    assert.ok(host.querySelector('#col-body .state-loading'));
    dispose();
  });
});

describe('Collections v2 — ready state', () => {
  it('renders a table with name/points/vector schema/embedding profile/provider columns', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({
      ...BASE_STUBS,
      '/api/collections': jsonResponse(200, { collections: [collection()] }),
    });
    const { dispose } = mount(host, {});
    await settle();

    const table = host.querySelector('#col-body table.data');
    assert.ok(table, 'a collections table must render once data resolves');
    assert.match(table.textContent, /my-docs/);
    assert.match(table.textContent, /named/);
    assert.match(table.textContent, /valid/);
    assert.match(table.textContent, /ollama/);
    assert.match(table.textContent, /bge-m3/);
    const headers = [...table.querySelectorAll('th')].map((th) => th.textContent);
    assert.ok(headers.some((h) => /name/i.test(h)));
    assert.ok(headers.some((h) => /points/i.test(h)));
    assert.ok(headers.some((h) => /vector schema/i.test(h)));
    assert.ok(headers.some((h) => /embedding profile/i.test(h)));
    assert.ok(headers.some((h) => /provider/i.test(h)));
    dispose();
  });

  it('shows "—" for a collection with no dense provider/model', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({
      ...BASE_STUBS,
      '/api/collections': jsonResponse(200, { collections: [collection({ provider: { denseProvider: null, denseModel: null, sparseProvider: null } })] }),
    });
    const { dispose } = mount(host, {});
    await settle();
    assert.match(host.querySelector('#col-body table.data').textContent, /—/);
    dispose();
  });

  it('always renders the "Index a folder" primary page action, not only in the empty state', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({
      ...BASE_STUBS,
      '/api/collections': jsonResponse(200, { collections: [collection()] }),
    });
    const { dispose } = mount(host, {});
    await settle();
    const cta = host.querySelector('#col-index-cta');
    assert.ok(cta);
    assert.equal(cta.getAttribute('href'), '#/index');
    dispose();
  });

  // S2A correction: the page-level "Index a folder" CTA is this screen's
  // primary action (there is no create-collection endpoint to compete with
  // it — GAP-04) and must use the same primary-button treatment already
  // established elsewhere (Search submit, Settings Save), not the
  // secondary/ghost treatment used for e.g. Cancel/Browse/settings links.
  it('the "Index a folder" CTA uses the established primary button treatment (.btn-amber), not .btn-ghost', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({
      ...BASE_STUBS,
      '/api/collections': jsonResponse(200, { collections: [collection()] }),
    });
    const { dispose } = mount(host, {});
    await settle();
    const cta = host.querySelector('#col-index-cta');
    assert.ok(cta.classList.contains('btn-amber'), 'the primary page action must use .btn-amber, the same treatment as Search submit / Settings Save');
    assert.ok(!cta.classList.contains('btn-ghost'), 'the primary page action must not use the secondary .btn-ghost treatment');
    dispose();
  });
});

describe('app.css: .view-head\'s primary CTA (.btn-amber) does not shrink in the flex row', () => {
  it('.view-head .btn-amber sets flex: none', () => {
    const css = readUiSource('app.css');
    const rule = css.match(/\.view-head \.btn-amber\s*\{([^}]*)\}/)?.[1] ?? '';
    assert.match(rule, /flex:\s*none/, '.view-head .btn-amber must set flex: none so a long title never squeezes the primary action');
  });
});

describe('Collections v2 — empty state', () => {
  it('renders an empty state with an "Index a folder" call to action when there are no collections', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({
      ...BASE_STUBS,
      '/api/collections': jsonResponse(200, { collections: [] }),
    });
    const { dispose } = mount(host, {});
    await settle();
    const empty = host.querySelector('#col-body .state-empty');
    assert.ok(empty, 'an empty collections list must render the empty-state primitive');
    const link = empty.querySelector('a.state-action');
    assert.equal(link.getAttribute('href'), '#/index');
    dispose();
  });
});

describe('Collections v2 — error state', () => {
  it('a malformed /api/collections response renders a contract error with Retry, and Retry re-fetches', async () => {
    const host = makeHost();
    let attempt = 0;
    globalThis.fetch = routedFetch({
      ...BASE_STUBS,
      '/api/collections': () => {
        attempt += 1;
        if (attempt === 1) return jsonResponse(200, { collections: 'not-an-array' }); // malformed -> contract error
        return jsonResponse(200, { collections: [collection()] });
      },
    });
    const { dispose } = mount(host, {});
    await settle();
    const errorBox = host.querySelector('#col-body .state-error');
    assert.ok(errorBox, 'a malformed response must render the error-state primitive, never crash');
    const retryBtn = errorBox.querySelector('button.state-retry');
    assert.ok(retryBtn);

    retryBtn.dispatchEvent(new Event('click', { bubbles: true }));
    await settle();
    assert.equal(host.querySelector('#col-body .state-error'), null, 'a successful retry must clear the error state');
    assert.ok(host.querySelector('#col-body table.data'), 'retry\'s successful response must render');
    dispose();
  });

  it('a network failure renders the error-state primitive with Retry', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({
      ...BASE_STUBS,
      '/api/collections': new TypeError('fetch failed'),
    });
    const { dispose } = mount(host, {});
    await settle();
    assert.ok(host.querySelector('#col-body .state-error'));
    dispose();
  });
});

describe('Collections v2 — degraded/unavailable (storage known down)', () => {
  it('renders an explicit "storage unavailable" panel, not the empty state, when storage is down and the list is empty', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({
      '/api/health': jsonResponse(200, HEALTH_DOWN),
      '/api/generation/status': jsonResponse(200, GEN_READY),
      '/api/collections': jsonResponse(200, { collections: [] }),
    });
    const { dispose } = mount(host, {});
    await settle();
    assert.equal(host.querySelector('#col-body .state-empty'), null, 'must never present a known-down storage backend as "zero collections"');
    const unavailable = host.querySelector('#col-body .state-partial');
    assert.ok(unavailable);
    assert.match(unavailable.textContent, /[Uu]nreachable/);
    dispose();
  });

  it('renders the "storage unavailable" panel (not a raw fetch-error box) when storage is down and the collections fetch also fails', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({
      '/api/health': jsonResponse(200, HEALTH_DOWN),
      '/api/generation/status': jsonResponse(200, GEN_READY),
      '/api/collections': new TypeError('fetch failed'),
    });
    const { dispose } = mount(host, {});
    await settle();
    assert.equal(host.querySelector('#col-body .state-error'), null);
    assert.ok(host.querySelector('#col-body .state-partial'));
    dispose();
  });

  it('still renders real, non-empty data with a warning banner when storage is reported down but the collections fetch actually succeeded', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({
      '/api/health': jsonResponse(200, HEALTH_DOWN),
      '/api/generation/status': jsonResponse(200, GEN_READY),
      '/api/collections': jsonResponse(200, { collections: [collection()] }),
    });
    const { dispose } = mount(host, {});
    await settle();
    assert.ok(host.querySelector('#col-body table.data'), 'real data must not be discarded just because a separate health poll disagrees');
    assert.equal(host.querySelector('#col-banner').hidden, false);
    assert.match(host.querySelector('#col-banner').textContent, /[Uu]nreachable/);
    dispose();
  });
});

describe('Collections v2 — partial (status polling itself is failing)', () => {
  it('renders the table plus a banner when the collections list loaded fine but the health check request failed', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({
      '/api/health': new TypeError('fetch failed'),
      '/api/generation/status': jsonResponse(200, GEN_READY),
      '/api/collections': jsonResponse(200, { collections: [collection()] }),
    });
    const { dispose } = mount(host, {});
    await settle();
    assert.ok(host.querySelector('#col-body table.data'));
    assert.equal(host.querySelector('#col-banner').hidden, false);
    assert.match(host.querySelector('#col-banner').textContent, /status check/i);
    assert.match(host.querySelector('#col-banner').textContent, /Storage/, 'a failed health poll must be named honestly as a storage problem');
    dispose();
  });

  // S2A correction: getStatus() carries healthError AND generationError
  // (shared/status/store.js) — a generation-status poll failure is just as
  // much "shared status polling currently reports an error" as a health
  // poll failure, and must not be silently dropped.
  it('renders a banner naming "Generation" when the generation-status poll fails, even though health succeeded', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({
      '/api/health': jsonResponse(200, HEALTH_OK),
      '/api/generation/status': new TypeError('fetch failed'),
      '/api/collections': jsonResponse(200, { collections: [collection()] }),
    });
    const { dispose } = mount(host, {});
    await settle();
    assert.ok(host.querySelector('#col-body table.data'));
    const banner = host.querySelector('#col-banner');
    assert.equal(banner.hidden, false);
    assert.match(banner.textContent, /[Gg]eneration/, 'a failed generation-status poll must be named honestly, not attributed to storage');
    assert.doesNotMatch(banner.textContent, /Storage status check/i, 'a generation-only failure must not be mislabeled as a storage problem');
    dispose();
  });

  it('names both subsystems when both the health and generation-status polls fail at once', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({
      '/api/health': new TypeError('fetch failed'),
      '/api/generation/status': new TypeError('fetch failed'),
      '/api/collections': jsonResponse(200, { collections: [collection()] }),
    });
    const { dispose } = mount(host, {});
    await settle();
    const banner = host.querySelector('#col-banner');
    assert.equal(banner.hidden, false);
    assert.match(banner.textContent, /Storage/);
    assert.match(banner.textContent, /[Gg]eneration/);
    dispose();
  });

  it('does not re-announce the live region on a repeated status tick when nothing meaningfully changed', async () => {
    const host = makeHost();
    let healthCalls = 0;
    let generationCalls = 0;
    // Health/generation stubs are functions returning a FRESH Response each
    // call (a real fetch Response body can only be read once) — this test
    // deliberately forces a second, real poll tick via pollNow(), so a
    // single static Response (as BASE_STUBS uses elsewhere) would throw on
    // its second read.
    globalThis.fetch = routedFetch({
      '/api/health': () => { healthCalls += 1; return jsonResponse(200, HEALTH_OK); },
      '/api/generation/status': () => { generationCalls += 1; return jsonResponse(200, GEN_READY); },
      '/api/collections': jsonResponse(200, { collections: [collection()] }),
    });
    const { dispose } = mount(host, {});
    await settle();
    const live = host.querySelector('.visually-hidden[role="status"]');
    assert.ok(live);
    const firstText = live.textContent;
    assert.equal(healthCalls, 1, 'sanity: exactly one poll tick happened on mount');

    // A second, real poll tick with identical (unchanged) status data — the
    // shared live-region primitive's own de-dupe (see shared/ui/live-
    // region.js) relies on the announced message being deterministic from
    // state, which the classify()/banner refactor above must preserve.
    await pollStatusNow();
    await settle();
    assert.equal(healthCalls, 2, 'sanity: a second poll tick actually ran');
    assert.equal(live.textContent, firstText, 'an unchanged status tick must not alter the live-region text');
    dispose();
  });
});

describe('Collections v2 — retry issues exactly one owned request', () => {
  it('clicking Retry once issues exactly one new /api/collections request, and its result replaces the error state', async () => {
    const host = makeHost();
    let collectionsCalls = 0;
    globalThis.fetch = routedFetch({
      ...BASE_STUBS,
      '/api/collections': () => {
        collectionsCalls += 1;
        if (collectionsCalls === 1) return jsonResponse(200, { collections: 'not-an-array' });
        return jsonResponse(200, { collections: [collection({ name: 'after-retry' })] });
      },
    });
    const { dispose } = mount(host, {});
    await settle();
    assert.equal(collectionsCalls, 1);
    const retryBtn = host.querySelector('#col-body .state-error button.state-retry');
    assert.ok(retryBtn);

    retryBtn.dispatchEvent(new Event('click', { bubbles: true }));
    await settle();
    assert.equal(collectionsCalls, 2, 'exactly one new request must be issued per Retry click');
    assert.match(host.querySelector('#col-body').textContent, /after-retry/);
    dispose();
  });
});

describe('Collections v2 — navigation away aborts pending requests; late responses never commit', () => {
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
      return new Promise(() => {});
    };
    const { dispose } = mount(host, {});
    await settle(2);
    assert.ok(host.querySelector('#col-body .state-loading'), 'sanity: still loading before dispose');

    dispose();
    assert.ok(capturedSignal?.aborted, 'dispose() must abort the in-flight collections request');
    await settle(4);
    assert.ok(host.querySelector('#col-body .state-loading'), 'no late commit may replace the loading state after dispose()');
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
      return new Promise(() => {});
    };
    const first = mount(host, {}); // call 0
    await settle(2);
    first.dispose();
    const second = mount(host, {}); // call 1
    await settle(2);

    deferredByCall[1].resolve(jsonResponse(200, { collections: [collection({ name: 'newer' })] }));
    await settle(3);
    deferredByCall[0].resolve(jsonResponse(200, { collections: [collection({ name: 'older-must-not-render' })] }));
    await settle(3);

    const text = host.querySelector('#col-body').textContent;
    assert.match(text, /newer/);
    assert.ok(!text.includes('older-must-not-render'), 'a stale, later-resolving response must never overwrite the newer committed render');
    second.dispose();
  });
});

describe('Collections v2 — safe rendering (XSS)', () => {
  it('renders a hostile collection name as inert text, never markup', async () => {
    const host = makeHost();
    const malicious = '<img src=x onerror="window.__pwned=true">';
    globalThis.fetch = routedFetch({
      ...BASE_STUBS,
      '/api/collections': jsonResponse(200, { collections: [collection({ name: malicious })] }),
    });
    const { dispose } = mount(host, {});
    await settle();
    assert.equal(host.querySelectorAll('img').length, 0, 'malicious text must never be parsed into a real element');
    assert.match(host.querySelector('#col-body').textContent, /<img/);
    dispose();
  });

  it('renders hostile provider/model text as inert text', async () => {
    const host = makeHost();
    const malicious = '<script>window.__pwned=true</script>';
    globalThis.fetch = routedFetch({
      ...BASE_STUBS,
      '/api/collections': jsonResponse(200, { collections: [collection({ provider: { denseProvider: malicious, denseModel: null, sparseProvider: null } })] }),
    });
    const { dispose } = mount(host, {});
    await settle();
    assert.equal(host.querySelectorAll('script').length, 0);
    assert.match(host.querySelector('#col-body').textContent, /<script>/);
    dispose();
  });
});

describe('Collections v2 — long and Unicode/Cyrillic names', () => {
  it('renders a long, unbroken Cyrillic collection name fully (no truncation) and routes correctly on activation', async () => {
    const host = makeHost();
    const name = 'Основи-Node.js-та-асинхронного-програмування-повний-курс-для-початківців-2026';
    globalThis.fetch = routedFetch({
      ...BASE_STUBS,
      '/api/collections': jsonResponse(200, { collections: [collection({ name })] }),
    });
    const { dispose } = mount(host, {});
    await settle();
    const cell = [...host.querySelectorAll('#col-body td.mono')].find((td) => td.textContent === name);
    assert.ok(cell, 'the full Cyrillic name must be present in the DOM, not truncated');

    const row = cell.closest('tr[data-row-key]');
    row.dispatchEvent(new Event('click', { bubbles: true }));
    assert.equal(location.hash, `#/c/${encodeURIComponent(name)}`);
    dispose();
  });
});

describe('Collections v2 — delegated row activation (no listener per row)', () => {
  it('registers exactly the click+keydown listeners once on the table body, not scaling with row count', async () => {
    const host = makeHost();
    const many = Array.from({ length: 15 }, (_, i) => collection({ name: `c${i}` }));
    globalThis.fetch = routedFetch({
      ...BASE_STUBS,
      '/api/collections': jsonResponse(200, { collections: many }),
    });
    const elementProto = Object.getPrototypeOf(document.createElement('div'));
    const original = elementProto.addEventListener;
    let calls = 0;
    elementProto.addEventListener = function patched(...args) {
      if (this.tagName === 'TBODY') calls++;
      return original.apply(this, args);
    };
    let dispose;
    try {
      ({ dispose } = mount(host, {}));
      await settle();
    } finally {
      elementProto.addEventListener = original;
    }
    assert.equal(calls, 2, `expected exactly 2 delegated listeners regardless of the 15 rows, got ${calls}`);
    assert.equal(host.querySelectorAll('#col-body tr[data-row-key]').length, 15);
    dispose();
  });

  it('activates a row via Enter and via Space, and via click', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({
      ...BASE_STUBS,
      '/api/collections': jsonResponse(200, { collections: [collection({ name: 'a' }), collection({ name: 'b' }), collection({ name: 'c' })] }),
    });
    const { dispose } = mount(host, {});
    await settle();

    const rows = host.querySelectorAll('#col-body tr[data-row-key]');
    rows[0].dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
    assert.equal(location.hash, '#/c/a');

    // linkedom's Event constructor (unlike a real KeyboardEvent) ignores a
    // `key` field in its init dict — set it as a plain property on the
    // constructed event instead, which the table's delegated keydown
    // handler reads the same way it would read a real KeyboardEvent's.
    location.hash = '#/collections';
    const enterEvent = new Event('keydown', { bubbles: true, cancelable: true });
    enterEvent.key = 'Enter';
    rows[1].dispatchEvent(enterEvent);
    assert.equal(location.hash, '#/c/b');

    location.hash = '#/collections';
    const spaceEvent = new Event('keydown', { bubbles: true, cancelable: true });
    spaceEvent.key = ' ';
    rows[2].dispatchEvent(spaceEvent);
    assert.equal(location.hash, '#/c/c');
    dispose();
  });
});

describe('Collections v2 — shares status data (no duplicate polling)', () => {
  it('mounting the Collections view does not start a second /api/health, /api/generation/status, or /api/collections loop', async () => {
    const host = makeHost();
    const calls = { health: 0, generation: 0, collections: 0 };
    globalThis.fetch = async (path) => {
      if (String(path).includes('/api/health')) { calls.health++; return jsonResponse(200, HEALTH_OK); }
      if (String(path).includes('/api/generation/status')) { calls.generation++; return jsonResponse(200, GEN_READY); }
      if (String(path).includes('/api/collections')) { calls.collections++; return jsonResponse(200, { collections: [] }); }
      return new Promise(() => {});
    };
    const { dispose } = mount(host, {});
    await settle();
    assert.equal(calls.health, 1, 'exactly one health fetch — the shared store\'s single poll tick');
    assert.equal(calls.generation, 1);
    assert.equal(calls.collections, 1, 'exactly one collections fetch on mount — no polling loop');
    dispose();
  });
});

describe('Collections v2 — leak soak (mount/dispose ×20)', () => {
  it('does not grow the shared status-store subscriber count', async () => {
    globalThis.fetch = routedFetch({
      ...BASE_STUBS,
      '/api/collections': jsonResponse(200, { collections: [] }),
    });
    const baselineStatus = statusListenerCount();
    for (let i = 0; i < 20; i++) {
      const host = makeHost();
      const { dispose } = mount(host, {});
      await settle(2);
      dispose();
      assert.equal(statusListenerCount(), baselineStatus, `status-store listeners must not grow past cycle ${i}`);
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
      return new Promise(() => {});
    };
    for (let i = 0; i < 5; i++) {
      const host = makeHost();
      const { dispose } = mount(host, {});
      await settle(2);
      dispose();
    }
    assert.equal(signals.length, 5);
    assert.ok(signals.every((s) => s.aborted), 'every mount cycle\'s collections request must be aborted by its own dispose()');
  });
});
