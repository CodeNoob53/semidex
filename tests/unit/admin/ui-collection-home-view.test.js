// Tests for features/collection-home/view.js — the Collection Home v2
// lifecycle-owned view controller for the BARE `#/c/:name` route (design
// plan §5.3, §8.4, §13 S1-style, S2B). Real ESM imports: mount()/dispose()
// against a linkedom document assigned to globalThis.document (the seam
// every shared/ui primitive's own document.createElement call resolves
// against, and the one search.js/sidebar.js/state.js already use too),
// with globalThis.fetch/location/history stubbed. No vm-harness needed —
// this is genuine module behavior, not a source-text/regex approximation.
//
// Also covers the three router-level regressions the S2B migration moved
// out of ui-router.test.js's vm-harness end-to-end suite (see that file's
// own comment): the bare-route "?q=" permalink, returning to a bare route
// clearing stale content, and switching collections resetting the search
// form — all now asserted here against the real module instead.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML, Node } from 'linkedom';
import { mount } from '../../../src/shared/admin/ui-src/features/collection-home/view.js';
import { getExpandedCollection, setExpandedCollection } from '../../../src/shared/admin/ui-src/state.js';

const originalDocument = globalThis.document;
const originalNode = globalThis.Node;
const originalFetch = globalThis.fetch;
const originalLocation = globalThis.location;
const originalHistory = globalThis.history;

// search.js's getRecentSearches()/rememberRecentSearch() touch localStorage
// on every initSearchPanel() mount. Node's own built-in `localStorage`
// global is a lazily-initialized accessor — merely reading its property
// descriptor is enough to leave it installed, and re-triggering that lazy
// init (e.g. by restoring the original descriptor between tests) against an
// unconfigured `--localstorage-file` backing store crashed the worker
// running this file (repeated allocation failures, eventually OOM) during
// local verification. Replaced once, permanently, for this whole file's
// lifetime with a plain in-memory stub — the real global's lazy getter is
// never touched again — same convention ui-test-helpers.js's own vm-context
// harness already uses (a plain object, never Node's real implementation).
Object.defineProperty(globalThis, 'localStorage', {
  value: { getItem: () => null, setItem() {}, removeItem() {} },
  configurable: true,
  writable: true,
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function notFoundResponse() {
  return new Response(JSON.stringify({ error: { message: 'Collection "my-docs" not found' } }), {
    status: 404, headers: { 'content-type': 'application/json' },
  });
}

/** Routes globalThis.fetch by endpoint substring to a canned/overridable
 * response map; each entry may be a value, a function(path), or an Error to
 * reject with. Missing entries hang forever (a deliberate "never called
 * this endpoint" trap, unless the test wants a real hang). */
function routedFetch(map) {
  return async (path, init) => {
    for (const [key, value] of Object.entries(map)) {
      if (String(path).includes(key)) {
        const resolved = typeof value === 'function' ? value(path, init) : value;
        if (resolved instanceof Error) throw resolved;
        return resolved;
      }
    }
    return new Promise(() => {}); // hang — no stub configured for this path
  };
}

function makeHost() {
  const { document } = parseHTML('<div id="root"></div><ul id="collection-list"></ul>');
  globalThis.document = document;
  return document.getElementById('root');
}

function detail(overrides = {}) {
  return {
    name: 'my-docs',
    pointCount: 99,
    chunkCount: 90,
    semidexManaged: true,
    hasSkeleton: true,
    warnings: [],
    description: null,
    overviewSummary: 'A library of internal API reference docs.',
    vectorSchema: { dense: { size: 1024, distance: 'cosine' }, sparse: true },
    provider: { denseProvider: 'onnx', denseModel: 'bge-m3-onnx', sparseProvider: 'bm25' },
    embeddingProfile: {
      state: 'valid',
      profile: { embedding: { dense: { vectorName: 'dense', execution: 'client' }, sparse: { vectorName: 'sparse' } } },
    },
    versions: { embeddingSchema: 2, chunkingSchema: 4, indexingSchema: 4, tokenCountMode: 'bge-m3' },
    availability: { status: 'available' },
    ...overrides,
  };
}

beforeEach(() => {
  setExpandedCollection(null);
  globalThis.Node = Node;
  globalThis.location = { hash: '#/c/my-docs' };
  globalThis.history = {
    pushState: (_s, _t, url) => { globalThis.location.hash = url; },
    replaceState: (_s, _t, url) => { globalThis.location.hash = url; },
  };
});

afterEach(() => {
  globalThis.document = originalDocument;
  globalThis.Node = originalNode;
  globalThis.fetch = originalFetch;
  globalThis.location = originalLocation;
  globalThis.history = originalHistory;
  setExpandedCollection(null);
});

async function settle(times = 6) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('Collection Home v2 — loading state', () => {
  it('shows a loading placeholder synchronously on mount, before the detail fetch resolves', () => {
    const host = makeHost();
    globalThis.fetch = () => new Promise(() => {}); // nothing ever resolves
    const { dispose } = mount(host, { name: 'my-docs' });
    assert.ok(host.querySelector('#col-header .state-loading'));
    dispose();
  });
});

describe('Collection Home v2 — ready state', () => {
  it('renders the name, healthy badge, summary, fact chips, and a collapsed Details panel', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({ '/api/collections/my-docs': jsonResponse(200, { collection: detail() }) });
    const { dispose } = mount(host, { name: 'my-docs' });
    await settle();

    const header = host.querySelector('#col-header');
    assert.match(header.querySelector('.view-title').textContent, /my-docs/);
    assert.ok(header.querySelector('.status-badge-ok'), 'a healthy (no-warnings) collection must show the ok badge');
    assert.match(header.querySelector('.col-header-desc').textContent, /A library of internal API reference docs\./);
    assert.match(header.querySelector('.col-header-facts').textContent, /90 chunks/);
    assert.match(header.querySelector('.col-header-facts').textContent, /bge-m3-onnx/);
    const detailsEl = header.querySelector('details.advanced-panel');
    assert.ok(detailsEl);
    assert.equal(detailsEl.hasAttribute('open'), false, 'Details must be collapsed by default');
    assert.ok(header.querySelector('#ch-index-cta'), 'the real Index action must be present');
    assert.ok(header.querySelector('#col-settings-btn'), 'the real Settings action must be present');
    dispose();
  });

  it('the settings button navigates to the collection settings route', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({ '/api/collections/my-docs': jsonResponse(200, { collection: detail() }) });
    const { dispose } = mount(host, { name: 'my-docs' });
    await settle();
    host.querySelector('#col-settings-btn').click();
    assert.equal(location.hash, '#/c/my-docs/settings');
    dispose();
  });
});

describe('Collection Home v2 — warning/degraded state', () => {
  it('shows a warning badge and banner naming the warnings, not the healthy badge', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({
      '/api/collections/my-docs': jsonResponse(200, { collection: detail({ warnings: ['legacy flat vector schema'] }) }),
    });
    const { dispose } = mount(host, { name: 'my-docs' });
    await settle();
    const header = host.querySelector('#col-header');
    // Scoped to .col-header-top: the header ALSO carries an unrelated
    // "Search available" status-badge-ok in its fact chips (factChips()'s
    // availability chip) whenever availability.status is 'available' — an
    // unscoped header-wide query would match that instead and silently
    // assert the wrong badge.
    const topRow = header.querySelector('.col-header-top');
    assert.ok(topRow.querySelector('.status-badge-ok') === null, 'must not show the healthy badge when warnings exist');
    assert.match(topRow.querySelector('.status-badge-warn').textContent, /1 warning/);
    const banner = header.querySelector('.ov-banner');
    assert.equal(banner.hidden, false);
    assert.match(banner.textContent, /legacy flat vector schema/);
    dispose();
  });
});

describe('Collection Home v2 — malformed contract response', () => {
  it('renders a contract error with Retry, and Retry re-fetches successfully', async () => {
    const host = makeHost();
    let attempt = 0;
    globalThis.fetch = routedFetch({
      '/api/collections/my-docs': () => {
        attempt += 1;
        // pointCount missing entirely on the first response — malformed.
        if (attempt === 1) return jsonResponse(200, { collection: { name: 'my-docs' } });
        return jsonResponse(200, { collection: detail() });
      },
    });
    const { dispose } = mount(host, { name: 'my-docs' });
    await settle();
    const errorBox = host.querySelector('#col-header .state-error');
    assert.ok(errorBox, 'a malformed response must render the error-state primitive, never crash');
    const retryBtn = errorBox.querySelector('button.state-retry');
    assert.ok(retryBtn);

    retryBtn.click();
    await settle();
    // assert.ok(... === null), not assert.equal(..., null) — on failure,
    // assert.equal's diff calls util.inspect() on the actual value, and a
    // linkedom DOM node's circular parent/document references made that
    // balloon memory catastrophically during local verification (see the
    // "warning/degraded state" test above, which hit this for real).
    assert.ok(host.querySelector('#col-header .state-error') === null, 'a successful retry must clear the error state');
    assert.ok(host.querySelector('#col-header .view-title'), 'retry\'s successful response must render the header');
    dispose();
  });
});

describe('Collection Home v2 — 404 (not found)', () => {
  it('renders a not-found empty state whose action returns to Overview (#/), not the removed #/collections', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({ '/api/collections/my-docs': notFoundResponse() });
    const { dispose } = mount(host, { name: 'my-docs' });
    await settle();
    const empty = host.querySelector('#col-header .state-empty');
    assert.ok(empty, 'a 404 must render the empty-state primitive, not the error-state one');
    assert.match(empty.textContent, /not found/i);
    const link = empty.querySelector('a.state-action');
    assert.ok(link);
    assert.equal(link.getAttribute('href'), '#/', 'not-found must link back to Overview, not the removed #/collections directory');
    dispose();
  });
});

describe('Collection Home v2 — network error', () => {
  it('a network failure renders the error-state primitive with Retry', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({ '/api/collections/my-docs': new TypeError('fetch failed') });
    const { dispose } = mount(host, { name: 'my-docs' });
    await settle();
    assert.ok(host.querySelector('#col-header .state-error'));
    dispose();
  });
});

describe('Collection Home v2 — retry issues exactly one owned request', () => {
  it('clicking Retry once issues exactly one new /api/collections/:name request', async () => {
    const host = makeHost();
    let calls = 0;
    globalThis.fetch = routedFetch({
      '/api/collections/my-docs': () => {
        calls += 1;
        if (calls === 1) return new TypeError('fetch failed');
        return jsonResponse(200, { collection: detail({ overviewSummary: 'after-retry summary' }) });
      },
    });
    const { dispose } = mount(host, { name: 'my-docs' });
    await settle();
    assert.equal(calls, 1);
    const retryBtn = host.querySelector('#col-header .state-error button.state-retry');
    retryBtn.click();
    await settle();
    assert.equal(calls, 2, 'exactly one new request must be issued per Retry click');
    assert.match(host.querySelector('#col-header').textContent, /after-retry summary/);
    dispose();
  });
});

describe('Collection Home v2 — navigation away aborts pending requests; late responses never commit', () => {
  it('dispose() before the detail fetch resolves leaves the loading state in place, and the late response is discarded', async () => {
    const host = makeHost();
    let capturedSignal = null;
    globalThis.fetch = async (path, init) => {
      if (String(path).includes('/api/collections/my-docs')) {
        capturedSignal = init?.signal ?? null;
        return new Promise((_resolve, reject) => {
          capturedSignal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      return new Promise(() => {});
    };
    const { dispose } = mount(host, { name: 'my-docs' });
    await settle(2);
    assert.ok(host.querySelector('#col-header .state-loading'), 'sanity: still loading before dispose');

    dispose();
    assert.ok(capturedSignal?.aborted, 'dispose() must abort the in-flight detail request');
    await settle(4);
    assert.ok(host.querySelector('#col-header .state-loading'), 'no late commit may replace the loading state after dispose()');
  });

  it('an old mount resolving after a replacement mount never commits into the replacement view', async () => {
    const host = makeHost();
    const deferredByCall = [];
    let call = 0;
    globalThis.fetch = async (path) => {
      if (String(path).includes('/api/collections/')) {
        const index = call;
        call += 1;
        return new Promise((resolve, reject) => { deferredByCall[index] = { resolve, reject }; });
      }
      return new Promise(() => {});
    };
    const first = mount(host, { name: 'my-docs' }); // call 0
    await settle(2);
    first.dispose();
    const second = mount(host, { name: 'my-docs' }); // call 1
    await settle(2);

    deferredByCall[1].resolve(jsonResponse(200, { collection: detail({ overviewSummary: 'newer' }) }));
    await settle(3);
    deferredByCall[0].resolve(jsonResponse(200, { collection: detail({ overviewSummary: 'older-must-not-render' }) }));
    await settle(3);

    const text = host.querySelector('#col-header').textContent;
    assert.match(text, /newer/);
    assert.ok(!text.includes('older-must-not-render'), 'a stale, later-resolving response must never overwrite the newer committed render');
    second.dispose();
  });
});

describe('Collection Home v2 — safe rendering (XSS)', () => {
  it('renders a hostile collection name as inert text, never markup', async () => {
    const host = makeHost();
    const malicious = '<img src=x onerror="window.__pwned=true">';
    globalThis.location = { hash: `#/c/${encodeURIComponent(malicious)}` };
    globalThis.fetch = routedFetch({
      [`/api/collections/${encodeURIComponent(malicious)}`]: jsonResponse(200, { collection: detail({ name: malicious }) }),
    });
    const { dispose } = mount(host, { name: malicious });
    await settle();
    assert.equal(host.querySelectorAll('img').length, 0, 'malicious text must never be parsed into a real element');
    assert.match(host.querySelector('#col-header').textContent, /<img/);
    dispose();
  });

  it('renders a hostile overviewSummary as inert text, never markup', async () => {
    const host = makeHost();
    const malicious = '<script>window.__pwned=true</script>';
    globalThis.fetch = routedFetch({
      '/api/collections/my-docs': jsonResponse(200, { collection: detail({ overviewSummary: malicious }) }),
    });
    const { dispose } = mount(host, { name: 'my-docs' });
    await settle();
    assert.equal(host.querySelectorAll('script').length, 0);
    assert.match(host.querySelector('.col-header-desc').textContent, /<script>/);
    dispose();
  });
});

describe('Collection Home v2 — long and Unicode/Cyrillic names', () => {
  it('renders a long, unbroken Cyrillic collection name fully (no truncation)', async () => {
    const host = makeHost();
    const name = 'Основи-Node.js-та-асинхронного-програмування-повний-курс-для-початківців-2026';
    globalThis.location = { hash: `#/c/${encodeURIComponent(name)}` };
    globalThis.fetch = routedFetch({
      [`/api/collections/${encodeURIComponent(name)}`]: jsonResponse(200, { collection: detail({ name }) }),
    });
    const { dispose } = mount(host, { name });
    await settle();
    assert.match(host.querySelector('#col-header .view-title').textContent, new RegExp(name));
    dispose();
  });
});

describe('Collection Home v2 — stale reader clearing on mount', () => {
  it('the file/section content panel starts hidden and empty on every mount, regardless of what the previous route left behind', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch({ '/api/collections/my-docs': jsonResponse(200, { collection: detail() }) });
    const { dispose } = mount(host, { name: 'my-docs' });
    const panel = host.querySelector('#collection-content-panel');
    assert.equal(panel.style.display, 'none');
    assert.equal(host.querySelector('#collection-content').innerHTML, '');
    await settle();
    dispose();
  });
});

describe('Collection Home v2 — search permalink (bare-route "?q=" runs a real search)', () => {
  it('a bare collection route with "?q=" syncs the form AND actually calls /api/search', async () => {
    const host = makeHost();
    globalThis.location = { hash: '#/c/my-docs?q=refund' };
    const apiCalls = [];
    globalThis.fetch = async (path, init) => {
      apiCalls.push(String(path));
      if (String(path).includes('/api/collections/my-docs')) return jsonResponse(200, { collection: detail() });
      if (String(path).includes('/api/search')) return jsonResponse(200, { results: [], searchMode: 'hybrid' });
      return new Promise(() => {});
    };
    const { dispose } = mount(host, { name: 'my-docs' });
    await settle();
    assert.equal(host.querySelector('#q-input').value, 'refund', 'the search form must reflect the "?q=" permalink');
    assert.ok(apiCalls.some((url) => url.includes('/api/search')), 'a bare-route "?q=" permalink must actually run the search');
    dispose();
  });
});

describe('Collection Home v2 — collection switching resets the search form and sidebar expansion', () => {
  it('mounting a second, different collection resets the query input and results — no leaked state from the first', async () => {
    const host = makeHost();
    globalThis.location = { hash: '#/c/docs-a?q=hello' };
    globalThis.fetch = routedFetch({
      '/api/collections/docs-a': jsonResponse(200, { collection: detail({ name: 'docs-a' }) }),
      '/api/collections/docs-b': jsonResponse(200, { collection: detail({ name: 'docs-b' }) }),
      '/api/search': jsonResponse(200, { results: [], searchMode: null }),
    });
    const first = mount(host, { name: 'docs-a' });
    await settle();
    assert.equal(host.querySelector('#q-input').value, 'hello', 'sanity: query synced from ?q= on the first collection');
    assert.equal(getExpandedCollection(), 'docs-a');
    // Simulate a search having actually rendered a result marker, the same
    // way ui-router.test.js's old vm-harness regression drove this
    // directly rather than depending on the result-card template.
    host.querySelector('#search-results').innerHTML = '<div class="result-card">stale result from docs-a</div>';

    first.dispose();
    globalThis.location.hash = '#/c/docs-b';
    const second = mount(host, { name: 'docs-b' });
    await settle();

    assert.equal(host.querySelector('#q-input').value, '', 'switching collections must reset the query input, not carry over docs-a\'s query');
    assert.equal(host.querySelector('#search-results').innerHTML, '', 'switching collections must clear stale results from the previous collection');
    assert.equal(getExpandedCollection(), 'docs-b', 'the sidebar expansion state must follow the newly-mounted collection');
    second.dispose();
  });
});
