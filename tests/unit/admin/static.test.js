// Static UI shell serving — offline tests over a real node:http server with
// a stub StorageAdapter. Verifies content types, 404s, traversal guard, and
// that /api routes keep working with static serving enabled.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { createApp } from '../../../src/admin/server.js';
import { resolveStaticPath } from '../../../src/admin/static.js';
import { createJobRegistry } from '../../../src/admin/jobs/registry.js';

// Pulls the small, pure rendering helpers directly out of the served app.js
// source (by name, between two known adjacent function declarations — same
// slicing technique already used elsewhere in this file) and evaluates just
// those snippets in an isolated vm context. This lets tests assert on actual
// rendering behavior for given inputs, not just regex-match the source text
// — without needing a browser, and without risking the module-level side
// effects (loadTopbar()/loadSidebar()/route()) that running the whole file
// would trigger.
function extractBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error(`end marker not found after start: ${endMarker}`);
  return src.slice(start, end);
}

function loadSidebarLabelHelpers(js) {
  const src = extractBetween(js, 'function esc(value)', 'function errorBox(err)')
    + extractBetween(js, 'function sidebarNodeRow(', 'async function onSidebarNodeClick');
  const context = {};
  vm.createContext(context);
  vm.runInContext(src, context);
  return context;
}

// currentRoute() is a pure function (hash string in, route object out) —
// deliberately refactored to take an explicit `hash` parameter instead of
// reading location.hash internally, specifically so it's testable with zero
// DOM/location mocking. The extracted range also picks up openNodeFromPath()
// and route() (adjacent in the source), which reference api()/$()/document
// and are never called by these tests — only defined, which is harmless.
//
// The route object vm.runInContext returns is a cross-realm object (its own
// Object.prototype, distinct from this file's) — assert/strict's deepEqual
// compares prototypes, so it fails on structurally-identical cross-realm
// objects. Re-serializing through JSON strips realm identity; every route
// shape here is plain string data, so this loses nothing.
function loadRouterHelper(js) {
  const src = extractBetween(js, 'function currentRoute(', 'function startAdminApp');
  const context = {};
  vm.createContext(context);
  vm.runInContext(src, context);
  return { currentRoute: (hash) => JSON.parse(JSON.stringify(context.currentRoute(hash))) };
}

// showToast()/showCollectionWarnings() need a real `document` (createElement,
// querySelector via `$`) and a fake `#toast-host` to append into — same
// linkedom-backed vm approach as loadDomRenderHelpers below, but with its own
// minimal HTML fixture rather than the full served index.html, since toasts
// don't depend on any served template.
function loadToastHelpers(js) {
  const { document } = parseHTML('<div id="toast-host"></div>');
  // Real setTimeout would schedule an 8s auto-dismiss per toast and keep the
  // test process's event loop alive until it fires — tests only care about
  // the toast existing right after showToast() returns, never the dismiss
  // timing, so a stub that never actually fires is sufficient here.
  const context = {
    document, $: (sel, root = document) => root.querySelector(sel),
    setTimeout: () => 0, clearTimeout: () => {},
  };
  vm.createContext(context);
  const src = extractBetween(js, 'const TOAST_AUTO_DISMISS_MS', 'async function renderCollection(');
  vm.runInContext(src, context);
  return context;
}

// renderResult()/renderFileChunks()/renderJobRow() clone <template> elements
// via document.getElementById(...).content.cloneNode(true) — a plain vm
// context has no `document`, so these need a real (if minimal) DOM. linkedom
// is a small, fast DOM implementation used here for tests only; it is never
// a runtime dependency of the shipped UI. The templates come from the same
// served index.html the browser actually gets, not a hand-copied duplicate,
// so a template/JS drift would show up as a querySelector miss here too.
function loadDomRenderHelpers(js, html) {
  const { document } = parseHTML(html);
  const context = { document };
  vm.createContext(context);
  // End markers are other function/const declarations, not comments — Vite's
  // build strips comments even with minify:false, so a comment-based marker
  // (fine for the dev source) would silently not match the served bundle.
  const src = extractBetween(js, 'function esc(value)', 'async function loadTopbar')
    + extractBetween(js, 'function renderResult(', 'let fileViewState')
    + extractBetween(js, 'const STRUCTURAL_NODE_TYPES', 'function fileViewLoadMoreButton')
    + extractBetween(js, 'const JOB_STATUS_BADGE_CLASS', 'async function loadJobs(');
  vm.runInContext(src, context);
  return context;
}

function makeFakeChildForSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { setTimeout(() => child.emit('exit', null, 'SIGTERM'), 1); };
  return child;
}

function makeStubAdapter() {
  return {
    name: () => 'stub',
    capabilities: () => ({
      namedVectors: true, sparseVectors: true, hybridSearch: true, payloadIndexes: true,
      aliases: false, snapshots: false, collectionExists: true,
    }),
    ping: async () => ({ ok: true, detail: 'stub reachable' }),
    listCollections: async () => [],
    getCollection: async () => null,
    createCollection: async () => {},
    deleteCollection: async () => {},
    ensureCollectionSchema: async () => ({ repaired: [], warnings: [] }),
    listSourceDocuments: async () => [],
    getChunk: async () => [],
    searchHybrid: async () => [],
    getSkeletonRoot: async () => null,
    getSkeletonNode: async () => null,
    getSkeletonChildren: async () => [],
    getStructuralNode: async () => null,
    getSectionAnchor: async () => null,
  };
}

async function withServer(fn) {
  const app = createApp({ adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }) });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

describe('static UI serving', () => {
  it('GET / returns the HTML shell', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /^text\/html/);
      const html = await res.text();
      assert.match(html, /semidex/);
      assert.match(html, /app\.js/);
    });
  });

  it('GET / contains the real static layout directly in the body — not an empty shell relying on runtime injection', async () => {
    // Regression guard for the app-shell.html indirection this project
    // deliberately removed: the layout must be baked into index.html by
    // Vite (via src/admin/ui-src/index.html directly, not a document.body.
    // innerHTML = ... call at runtime). An empty <body> that only gets
    // filled in by JS would still pass every other test in this file (they
    // fetch app.js source, not a rendered DOM) but would defeat the whole
    // point of moving the shell out of JS.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
      assert.ok(bodyMatch, 'index.html must have a <body> tag');
      const body = bodyMatch[1];
      assert.match(body, /<header class="topbar">/, 'topbar must be present in the raw served HTML');
      assert.match(body, /<nav class="sidebar">/, 'sidebar must be present in the raw served HTML');
      assert.match(body, /<main class="main" id="main">/, 'main content root must be present in the raw served HTML');
      assert.match(body, /id="health-lamp"/);
      assert.match(body, /id="collection-list"/);
      // The templates (delete modal, search result, chunk card, job row,
      // empty/error state) are also inlined here by vite-plugin-html-inject
      // — confirms <load> tags resolved, not left as literal <load> elements.
      assert.match(body, /<template id="tpl-delete-modal">/);
      assert.match(body, /<template id="tpl-search-result">/);
      assert.match(body, /<template id="tpl-chunk-card">/);
      assert.match(body, /<template id="tpl-job-row">/);
      assert.match(body, /<template id="tpl-empty-state">/);
      assert.match(body, /<template id="tpl-error-state">/);
      assert.ok(!/<load\s/.test(body), 'the <load> include tags must be resolved at build time, not shipped literally');
    });
  });

  it('main.js/app.js never assign document.body.innerHTML (the layout lives in index.html, not injected at runtime)', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.ok(!/document\.body\.innerHTML/.test(js), 'no full-body innerHTML injection should remain in the bundle');
    });
  });

  it('GET /app.js returns JavaScript with the right content type', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/app.js');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /^text\/javascript/);
      assert.match(await res.text(), /api\/health/);
    });
  });

  it('GET /app.css returns CSS with the right content type', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/app.css');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /^text\/css/);
    });
  });

  it('unknown static path returns 404 with the JSON error envelope', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/no-such-file.js');
      assert.equal(res.status, 404);
      assert.equal((await res.json()).error.code, 'not_found');
    });
  });

  it('paths without a known extension return 404 (no directory listing)', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/ui');
      assert.equal(res.status, 404);
    });
  });

  it('non-GET methods on static paths return 405', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/app.js', { method: 'POST' });
      assert.equal(res.status, 405);
      assert.equal((await res.json()).error.code, 'method_not_allowed');
    });
  });

  it('API routes still work with static serving enabled', async () => {
    await withServer(async (base) => {
      const health = await fetch(base + '/api/health');
      assert.equal(health.status, 200);
      assert.equal((await health.json()).storage.backend, 'stub');

      const missing = await fetch(base + '/api/no-such-route');
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).error.code, 'not_found');
    });
  });
});

describe('resolveStaticPath — traversal guard', () => {
  it('/ resolves to index.html inside the UI dir', () => {
    const p = resolveStaticPath('/');
    assert.ok(p !== null && p.endsWith('index.html'));
  });

  it('rejects .. traversal out of the UI dir', () => {
    assert.equal(resolveStaticPath('/../server.js'), null);
    assert.equal(resolveStaticPath('/../../core/qdrant.js'), null);
    assert.equal(resolveStaticPath('/..%2F..%2Fserver.js'.replaceAll('%2F', '/')), null);
  });

  it('rejects unknown extensions', () => {
    assert.equal(resolveStaticPath('/app.wasm'), null);
    assert.equal(resolveStaticPath('/data.json5'), null);
  });
});

// ── Phase 2E: "Search this collection" (renamed from Search playground) ─────
// Browser-level tests are out of scope (no DOM runner in the toolchain);
// these assert the served app.js wires search to the right endpoint, keeps
// the evidence-vs-navigation copy, and defaults to the human-readable "full"
// window format with advanced controls collapsed. Behavior of /api/search
// itself is covered in search.test.js.
describe('search this collection (served app.js)', () => {
  it('app.js posts to /api/search and renders a search panel', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/app.js');
      assert.equal(res.status, 200);
      const js = await res.text();
      assert.match(js, /apiPost\(["']\/api\/search["']/, 'search must call POST /api/search');
      assert.match(js, /search-panel/, 'collection view must render the search panel container');
      assert.match(js, /windowFormat/, 'search must send windowFormat');
      assert.match(js, /sourceFile/, 'search must support the file filter');
    });
  });

  it('is labeled "Search this collection", not "Search playground"', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /Search this collection/);
      assert.ok(!/Search playground/.test(js), 'old "Search playground" label must not remain');
    });
  });

  it('defaults the window format to full, not compact', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /data-v="full" class="on"/, 'full must be the default-selected segmented option');
      assert.ok(!/data-v="compact" class="on"/.test(js), 'compact must not be the default');
    });
  });

  it('defaults the score display to off (an advanced/debug opt-in, not shown by default)', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const checkboxTag = js.slice(js.indexOf('id="q-show-score"') - 40, js.indexOf('id="q-show-score"') + 30);
      assert.ok(!/\bchecked\b/.test(checkboxTag), `score checkbox must not be checked by default: ${checkboxTag}`);
    });
  });

  it('hides advanced controls (window, format, score, file filter) behind a collapsible disclosure', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /<details class="advanced-box">/);
      assert.match(js, /<summary>Advanced<\/summary>/);
    });
  });

  it('the default visible controls are just query, top-k, and submit', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /search-main-row/);
      assert.match(js, /id="q-top"/);
    });
  });

  it('app.js keeps evidence-vs-navigation copy', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /retrieval evidence/i, 'results must be framed as evidence');
      assert.match(js, /navigation only/i, 'sidebar tree must be framed as navigation');
    });
  });

  it('search result rendering never lets API/user content become live markup (XSS-safe by construction)', async () => {
    // renderResult() fills result fields via textContent, not innerHTML/string
    // concatenation — this is a stronger guarantee than esc()+innerHTML
    // (there is no escaping step to forget), so this test proves the
    // behavior directly: a sourceFile/text/window-snippet containing HTML
    // must render as inert text, never as a parsed element.
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const html = await (await fetch(base + '/')).text();
      const { renderResult } = loadDomRenderHelpers(js, html);
      const malicious = '<img src=x onerror="window.__pwned=true">';
      const card = renderResult({
        sourceFile: malicious, text: malicious, section: malicious,
        chunkIndex: 0, windowChunks: [{ chunkIndex: 1, textSnippet: malicious, isMatch: true }],
      }, 0, false);
      assert.equal(card.querySelector('.result-source').textContent, malicious);
      assert.equal(card.querySelector('.chunk-text').textContent, malicious);
      assert.equal(card.querySelectorAll('img').length, 0, 'malicious markup must never be parsed into a real element');
      assert.equal(card.querySelector('.win-text').textContent, malicious);
    });
  });
});

// ── Phase 2C: indexing jobs UI presence ──────────────────────────────────────
// Same served-file-level approach as Phase 2B: no DOM runner in this
// toolchain, so these assert the served app.js/index.html wire the indexing
// view to the right endpoints and keep the required safety copy. Job
// manager/API behavior itself is covered in jobs.test.js.
describe('indexing jobs view (served app.js / index.html)', () => {
  it('the served shell links to the indexing view', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /#\/index/, 'sidebar must link to the indexing view');
    });
  });

  it('app.js posts to /api/jobs/index with the six typed options', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /apiPost\(["']\/api\/jobs\/index["']/, 'must POST to /api/jobs/index');
      assert.match(js, /onnxEmbed/);
      assert.match(js, /llmSummaries/);
      assert.match(js, /skeletonChunking/);
      assert.match(js, /skeletonNav/);
      assert.match(js, /pruneStale/);
      assert.match(js, /tagGen/);
    });
  });

  it('app.js fetches the job list and a single job\'s detail/log', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /api\(["']\/api\/jobs["']\)/, 'must GET the job list');
      assert.match(js, /\/api\/jobs\/\$\{/, 'must GET a single job by id');
    });
  });

  it('app.js supports cancelling a job via POST /api/jobs/:id/cancel', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /\/cancel/);
    });
  });

  it('app.js keeps the required safety copy', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /Indexing writes to the selected collection/);
      assert.match(js, /Prune stale should be used only with the full source root/);
    });
  });

  it('app.js refreshes the sidebar after a job succeeds', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /loadSidebar\(\)/);
    });
  });
});

// ── Phase 3A0: simplified create-collection form (happy-path defaults visible,
// prune-stale/generate-tags collapsed behind an Advanced disclosure) ────────
describe('simplified indexing form — advanced options collapsed (served app.js)', () => {
  // The create-collection form's markup is inlined into app.js via Vite's
  // `?raw` import (src/admin/ui-src/app.js imports partials/index-view.html
  // as a string) — so it's found in the served JS bundle, not a separate
  // static HTML file. Locate the disclosure by class, not exact whitespace,
  // since Vite's raw-string inlining is not guaranteed byte-stable.
  function findAdvancedBoxRange(js) {
    const detailsStart = js.indexOf('<details class="advanced-box">');
    if (detailsStart === -1) return null;
    const detailsEnd = js.indexOf('</details>', detailsStart);
    if (detailsEnd === -1) return null;
    return [detailsStart, detailsEnd];
  }

  it('collapses prune-stale and generate-tags behind an "Advanced options" disclosure', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const range = findAdvancedBoxRange(js);
      assert.ok(range, 'the create-collection form must have an Advanced options disclosure');
      const inside = js.slice(range[0], range[1]);
      assert.match(inside, /Advanced options/);
      assert.match(inside, /id="opt-prune"/, 'prune-stale must be inside the disclosure');
      assert.match(inside, /id="opt-tags"/, 'generate-tags must be inside the disclosure');
    });
  });

  it('keeps ONNX embeddings, LLM summaries, skeleton chunking, and skeleton nav visible above the disclosure', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const range = findAdvancedBoxRange(js);
      assert.ok(range);
      const [detailsStart] = range;
      const onnxIdx = js.indexOf('id="opt-onnx"');
      const llmIdx = js.indexOf('id="opt-llm-summaries"');
      const chunkIdx = js.indexOf('id="opt-skel-chunk"');
      const navIdx = js.indexOf('id="opt-skel-nav"');
      for (const [name, idx] of [['opt-onnx', onnxIdx], ['opt-llm-summaries', llmIdx], ['opt-skel-chunk', chunkIdx], ['opt-skel-nav', navIdx]]) {
        assert.ok(idx !== -1, `${name} must be present`);
        assert.ok(idx < detailsStart, `${name} must appear before the Advanced options disclosure, not inside/after it`);
      }
    });
  });

  it('keeps the prune-stale safety caveat, now scoped inside the disclosure with the checkbox it explains', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const range = findAdvancedBoxRange(js);
      const inside = js.slice(range[0], range[1]);
      assert.match(inside, /Prune stale should be used only with the full source root/);
    });
  });
});

// ── indexing progress redesign: user-facing progress, not a raw job console ─
describe('indexing progress panel (served app.js / index.html, redesigned)', () => {
  it('the panel is labeled "Indexing progress", not the internal word "Jobs"', async () => {
    await withServer(async (base) => {
      const indexView = await (await fetch(base + '/app.js')).text();
      assert.match(indexView, /Indexing progress/);
      // "Jobs" as a standalone panel heading must not remain user-visible —
      // internal ids/dataset keys/comments containing "job" are fine (and
      // expected), this only guards the *visible panel heading* text.
      assert.ok(!/panel-head['"]>Jobs</.test(indexView), 'the primary panel heading must not read just "Jobs"');
    });
  });

  it('has a collapsed "Show details" section instead of the log being the primary UI', async () => {
    await withServer(async (base) => {
      // The job-row <template> (with the "Show details" <summary>) lives in
      // partials/templates/job-row.html, inlined into index.html by
      // vite-plugin-html-inject — not in app.js, which only clones/fills it.
      const html = await (await fetch(base + '/')).text();
      assert.match(html, /Show details/);
      assert.match(html, /class="job-details"/);
    });
  });

  it('a running job never shows "ended", and shows progress bar/current file/count', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const html = await (await fetch(base + '/')).text();
      const { renderJobRow } = loadDomRenderHelpers(js, html);
      const startedAt = new Date(Date.now() - 5000).toISOString();
      const card = renderJobRow({
        id: 'job-1', collection: 'demo', path: './docs', state: 'running',
        startedAt, finishedAt: null, exitCode: null,
        progress: { processedFiles: 2, totalFiles: 5, currentFile: 'b.md', percent: 40 },
      });
      const statusLine = card.querySelector('.job-status-line');
      assert.doesNotMatch(statusLine.textContent + card.querySelector('.job-times').textContent, /ended/);
      assert.equal(card.querySelector('.job-progress-bar').hidden, false);
      assert.match(card.querySelector('.job-progress-fill').style.width, /40%/);
      assert.match(card.querySelector('.job-progress-current').textContent, /Current file: b\.md/);
      assert.match(card.querySelector('.job-progress-count').textContent, /2 \/ 5 files processed/);
    });
  });

  it('tickRunningJobRows fills in "Running · Xs elapsed" / "Queued · Xs elapsed" wording for active jobs', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const html = await (await fetch(base + '/')).text();
      const { document } = (await import('linkedom')).parseHTML(html);
      const context = { document };
      const vmMod = await import('node:vm');
      vmMod.createContext(context);
      const src = extractBetween(js, 'function esc(value)', 'async function loadTopbar')
        + extractBetween(js, 'function renderResult(', 'let fileViewState')
        + extractBetween(js, 'const STRUCTURAL_NODE_TYPES', 'function fileViewLoadMoreButton')
        + extractBetween(js, 'const JOB_STATUS_BADGE_CLASS', 'async function loadJobs(')
        + 'const $ = (sel, root = document) => root.querySelector(sel);';
      vmMod.runInContext(src, context);

      const container = document.createElement('div');
      container.id = 'idx-jobs';
      document.body.appendChild(container);
      const startedAt = new Date(Date.now() - 5000).toISOString();
      const runningCard = context.renderJobRow({
        id: 'job-1', collection: 'demo', path: './docs', state: 'running',
        startedAt, finishedAt: null, exitCode: null,
        progress: { processedFiles: 2, totalFiles: 5, currentFile: 'b.md', percent: 40 },
      });
      container.appendChild(runningCard);

      context.tickRunningJobRows();
      assert.match(runningCard.querySelector('.job-status-line').textContent, /^Running · \d+s elapsed$/);
      assert.doesNotMatch(runningCard.querySelector('.job-status-line').textContent, /ended/);
    });
  });

  it('finished (succeeded) job shows "Completed in <duration>" using actual finishedAt, not forecast wording', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const html = await (await fetch(base + '/')).text();
      const { renderJobRow } = loadDomRenderHelpers(js, html);
      const startedAt = new Date(Date.now() - 134_000).toISOString(); // 2m 14s ago
      const finishedAt = new Date().toISOString();
      const card = renderJobRow({
        id: 'job-2', collection: 'demo', path: './docs', state: 'succeeded',
        startedAt, finishedAt, exitCode: 0,
        progress: { processedFiles: 124, totalFiles: 124, currentFile: null, percent: 100 },
      });
      assert.match(card.querySelector('.job-title').textContent, /^Indexed demo/);
      assert.match(card.querySelector('.job-status-line').textContent, /^Completed in 2m 14s$/);
      assert.doesNotMatch(card.querySelector('.job-status-line').textContent, /will finish|estimated|forecast/i);
      assert.match(card.querySelector('.job-progress-count').textContent, /124 \/ 124 files processed/);
      // The actual finished timestamp only shows inside the collapsed
      // details ("Show details"), not as a primary-UI "ended" label.
      assert.match(card.querySelector('.job-times').textContent, /ended/);
    });
  });

  it('failed job shows "Failed after <duration>" and an error summary', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const html = await (await fetch(base + '/')).text();
      const { renderJobRow } = loadDomRenderHelpers(js, html);
      const startedAt = new Date(Date.now() - 31_000).toISOString();
      const finishedAt = new Date().toISOString();
      const card = renderJobRow({
        id: 'job-3', collection: 'demo', path: './docs', state: 'failed',
        startedAt, finishedAt, exitCode: 1,
        progress: { processedFiles: 37, totalFiles: 124, currentFile: null, percent: 29.8 },
      });
      assert.equal(card.querySelector('.job-title').textContent, 'Indexing failed');
      assert.match(card.querySelector('.job-status-line').textContent, /^Failed after 31s$/);
      assert.match(card.querySelector('.job-progress-count').textContent, /37 \/ 124 files processed/);
      // Details auto-expand on failure so the error is visible without an extra click.
      assert.equal(card.querySelector('.job-details').open, true);
    });
  });

  it('shows an indeterminate progress indicator (not a fake 0%/100% bar) when totalFiles is unknown', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const html = await (await fetch(base + '/')).text();
      const { renderJobRow } = loadDomRenderHelpers(js, html);
      const card = renderJobRow({
        id: 'job-4', collection: 'demo', path: './docs', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
        progress: { processedFiles: null, totalFiles: null, currentFile: null, percent: null },
      });
      assert.equal(card.querySelector('.job-progress-bar').hidden, true);
      assert.equal(card.querySelector('.job-progress-indeterminate').hidden, false);
    });
  });

  it('renders "Step: Generating summaries" for a running job with a currentStep', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const html = await (await fetch(base + '/')).text();
      const { renderJobRow } = loadDomRenderHelpers(js, html);
      const card = renderJobRow({
        id: 'job-7', collection: 'demo', path: './docs', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
        progress: {
          processedFiles: 1, totalFiles: 4, currentFile: 'Тема 13...', currentStep: 'Generating summaries',
          currentFileProgress: 0.45, percent: 36.25,
        },
      });
      const stepEl = card.querySelector('.job-progress-step');
      assert.equal(stepEl.hidden, false);
      assert.equal(stepEl.textContent, 'Step: Generating summaries');
    });
  });

  it('omits the step line (keeps it hidden) when currentStep is null', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const html = await (await fetch(base + '/')).text();
      const { renderJobRow } = loadDomRenderHelpers(js, html);
      const card = renderJobRow({
        id: 'job-8', collection: 'demo', path: './docs', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
        progress: {
          processedFiles: 2, totalFiles: 5, currentFile: 'b.md', currentStep: null,
          currentFileProgress: null, percent: null,
        },
      });
      assert.equal(card.querySelector('.job-progress-step').hidden, true);
    });
  });

  it('still renders an old-shaped progress payload (no currentStep/currentFileProgress keys at all) without throwing', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const html = await (await fetch(base + '/')).text();
      const { renderJobRow } = loadDomRenderHelpers(js, html);
      const card = renderJobRow({
        id: 'job-9', collection: 'demo', path: './docs', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
        progress: { processedFiles: 2, totalFiles: 5, currentFile: 'b.md', percent: 40 },
      });
      assert.equal(card.querySelector('.job-progress-step').hidden, true);
      assert.match(card.querySelector('.job-progress-count').textContent, /2 \/ 5 files processed/);
      assert.match(card.querySelector('.job-progress-current').textContent, /Current file: b\.md/);
    });
  });

  it('shows a cancel button while running/queued, not once finished', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const html = await (await fetch(base + '/')).text();
      const { renderJobRow } = loadDomRenderHelpers(js, html);
      const running = renderJobRow({
        id: 'job-5', collection: 'demo', path: './docs', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, progress: null,
      });
      assert.equal(running.querySelector('.job-cancel').hidden, false);

      const done = renderJobRow({
        id: 'job-6', collection: 'demo', path: './docs', state: 'succeeded',
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, progress: null,
      });
      assert.equal(done.querySelector('.job-cancel').hidden, true);
    });
  });
});

// ── folder picker + human collection naming (developer-form redesign) ───────
describe('folder picker (served app.js)', () => {
  it('has a primary "Choose folder" button wired to POST /api/system/pick-folder', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /idx-choose-folder/);
      assert.match(js, /apiPost\(["']\/api\/system\/pick-folder["']/);
    });
  });

  it('has a manual-path fallback state that is shown when the picker fails', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /idx-path-fallback/);
      assert.match(js, /idx-path-manual/);
      // The fallback must actually be revealed on picker failure, not just present in markup.
      const fnStart = js.indexOf('async function chooseIndexFolder');
      assert.ok(fnStart !== -1, 'chooseIndexFolder should be defined');
      const fn = js.slice(fnStart, fnStart + 800);
      assert.match(fn, /catch/);
      assert.match(fn, /fallback\.style\.display\s*=\s*["']{2}/);
    });
  });

  it('the settings reindex form also offers a folder-picker button, not manual-only', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /settings-choose-folder/);
    });
  });
});

describe('POST /api/system/pick-folder — response shape', () => {
  it('returns a domain-shaped { path, cancelled } response, not a raw dialog/OS object', async () => {
    const pickFolderFn = async () => ({ path: 'C:\\Users\\demo\\Docs', cancelled: false });
    const app = createApp({ adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }), pickFolderFn });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.address().port}`;
    try {
      const res = await fetch(base + '/api/system/pick-folder', { method: 'POST' });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(Object.keys(body).sort(), ['cancelled', 'path']);
    } finally {
      await new Promise((resolve) => app.close(resolve));
    }
  });
});

describe('LLM summaries — Ollama dependency status (served app.js)', () => {
  it('shows "LLM summaries require Ollama" copy with a status badge, not a silent checkbox', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /LLM summaries require Ollama/);
      assert.match(js, /idx-ollama-status/);
      assert.match(js, /\/api\/system\/ollama-status/);
    });
  });

  it('checking the LLM summaries checkbox triggers an Ollama status check', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /opt-llm-summaries["']\)\.addEventListener\(["']change["']|opt-llm-summaries.*addEventListener\(["']change["']/s);
      assert.match(js, /loadOllamaStatus/);
    });
  });

  it('maps each Ollama status (available/missing/model_missing) to a distinct badge class', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /available:\s*["']badge badge-ok["']/);
      assert.match(js, /missing:\s*["']badge badge-fail["']/);
      assert.match(js, /model_missing:\s*["']badge badge-warn["']/);
    });
  });

  it('surfaces a 503 dependency error from job start back through the Ollama status check, not a generic failure', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const start = js.indexOf('async function startIndexJob');
      const fn = js.slice(start, start + 1500);
      assert.match(fn, /err\.status === 503/);
      assert.match(fn, /loadOllamaStatus/);
    });
  });
});

describe('collection naming (served app.js)', () => {
  it('does not suggest lowercase-hyphen slug names anywhere in the served UI', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const html = await (await fetch(base + '/')).text();
      assert.ok(!/my-docs/.test(js), 'app.js must not use the old slug placeholder "my-docs"');
      assert.ok(!/lowercase-hyphen|lowercase and hyphens|use lowercase/i.test(js + html), 'no lowercase-hyphen guidance should remain');
    });
  });

  it('uses a human-readable example as the collection-name placeholder', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /idx-collection/);
      const start = js.indexOf('id="idx-collection"');
      const tag = js.slice(start - 20, start + 120);
      assert.match(tag, /placeholder="[^"]*[А-ЯҐЄІЇа-яґєії ][^"]*"/, 'placeholder should look like a human name, not a slug');
    });
  });
});

describe('POST /api/collections/:name — names with spaces (served API)', () => {
  it('starts an indexing job for a collection name containing spaces', async () => {
    const calls = [];
    const spawnFn = (command, args, opts) => { calls.push({ command, args, opts }); return makeFakeChildForSpawn(); };
    const jobRegistry = createJobRegistry({ spawnFn });
    const app = createApp({ adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }), jobRegistry });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.address().port}`;
    try {
      const res = await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'Company Knowledge Base', path: './docs' }),
      });
      assert.equal(res.status, 202);
      const body = await res.json();
      assert.equal(body.job.collection, 'Company Knowledge Base');
      assert.equal(calls[0].opts.env.COLLECTION, 'Company Knowledge Base');
    } finally {
      await new Promise((resolve) => app.close(resolve));
    }
  });

  it('GET /api/collections/:name round-trips a name with spaces through URL encoding', async () => {
    const name = 'Основи Node.js';
    const adapter = makeStubAdapter();
    let seenName = null;
    adapter.getCollection = async (n) => { seenName = n; return { name: n, pointCount: 0 }; };
    const app = createApp({ adapter, embedQuery: async () => ({ dense: [], sparse: {} }) });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.address().port}`;
    try {
      const res = await fetch(base + `/api/collections/${encodeURIComponent(name)}`);
      assert.equal(res.status, 200);
      assert.equal(seenName, name);
      const body = await res.json();
      assert.equal(body.collection.name, name);
    } finally {
      await new Promise((resolve) => app.close(resolve));
    }
  });
});

// ── Phase 2E: navigation-first dashboard redesign ────────────────────────────
// Same served-file-level approach: no DOM runner, so these assert the served
// app.js wires the sidebar tree, collection header, file/section view, and
// collection settings correctly, and that the old flat panels/type-to-confirm
// UI are gone. API behavior is covered in server.test.js/jobs.test.js.
describe('sidebar navigation tree (served app.js)', () => {
  it('renders collections as an expandable tree, not a flat link list', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /function renderSidebarList/);
      assert.match(js, /tree-collection-row/);
      assert.match(js, /tree-children/);
    });
  });

  it('loads the skeleton tree for a selected collection, falling back to a flat file list', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /async function loadSidebarTree/);
      assert.match(js, /hasSkeleton/);
      assert.match(js, /async function loadSidebarFileList/);
      assert.match(js, /\/documents\?limit=/);
    });
  });

  it('drills into skeleton children via /api/collections/:name/skeleton/children', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /\/skeleton\/children\?/);
    });
  });

  it('clicking a file/section opens the file view, not a separate route', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /openFileView/);
    });
  });

  it('an empty section (404 from skeleton/anchor) does not auto-open chunk 0 — it requires an explicit click', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const start = js.indexOf('async function openSectionView');
      assert.ok(start !== -1, 'openSectionView should be defined');
      const end = js.indexOf('\nasync function openFileView');
      assert.ok(end !== -1 && end > start, 'openFileView should follow openSectionView');
      const fn = js.slice(start, end);
      assert.match(fn, /section-open-file-start/);
      assert.match(fn, /addEventListener\(["']click["'], \(\) => openFileView/);
      assert.ok(!/return openFileView\(name, node\.sourceFile, node\.nodePath, 0\);/.test(fn),
        'a 404 from skeleton/anchor must not automatically open chunk 0 of the file');
    });
  });
});

// ── skeleton node labels and chunk display clarity ───────────────────────────
describe('sidebar node labels (served app.js, evaluated behavior)', () => {
  it('a file node with nodePath "pitch-en.md#file" renders as "pitch-en.md", not "file"', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { nodeDisplayLabel } = loadSidebarLabelHelpers(js);
      const label = nodeDisplayLabel({ nodeType: 'file', nodePath: 'pitch-en.md#file', sourceFile: 'pitch-en.md' });
      assert.equal(label, 'pitch-en.md');
      assert.notEqual(label, 'file');
    });
  });

  it('a file node under a subfolder renders only the basename, not the folder path', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { nodeDisplayLabel } = loadSidebarLabelHelpers(js);
      const label = nodeDisplayLabel({
        nodeType: 'file',
        nodePath: 'Тема 10. Процеси в Linux/1. Вступ.md#file',
        sourceFile: 'Тема 10. Процеси в Linux/1. Вступ.md',
      });
      assert.equal(label, '1. Вступ.md');
    });
  });

  it('a section node uses the last heading_path entry, not the raw nodePath', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { nodeDisplayLabel } = loadSidebarLabelHelpers(js);
      const label = nodeDisplayLabel({
        nodeType: 'section',
        nodePath: 'pitch-en.md#intro/details',
        headingPath: ['Introduction', 'Details'],
        summary: 'Details — 3 paragraphs',
      });
      assert.equal(label, 'Details');
    });
  });

  it('a section node with no heading_path falls back to summary, not the raw nodePath', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { nodeDisplayLabel } = loadSidebarLabelHelpers(js);
      const label = nodeDisplayLabel({
        nodeType: 'section', nodePath: 'pitch-en.md#вступ', headingPath: [], summary: 'Вступ',
      });
      assert.equal(label, 'Вступ');
    });
  });

  it('a directory node renders its own directory name, not the full nested path', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { nodeDisplayLabel } = loadSidebarLabelHelpers(js);
      const label = nodeDisplayLabel({
        nodeType: 'directory',
        nodePath: 'demo#dir/Тема 10. Процеси в Linux (ps, top, kill, htop)',
      });
      assert.equal(label, 'Тема 10. Процеси в Linux (ps, top, kill, htop)');
    });
  });

  it('a nested directory node renders only its own segment, not the parent path', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { nodeDisplayLabel } = loadSidebarLabelHelpers(js);
      const label = nodeDisplayLabel({ nodeType: 'directory', nodePath: 'demo#dir/parent/child' });
      assert.equal(label, 'child');
    });
  });

  it('sidebarNodeRow keeps node_path and summary in the tooltip only, not the visible label', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { sidebarNodeRow } = loadSidebarLabelHelpers(js);
      const html = sidebarNodeRow({
        nodeType: 'file', nodePath: 'pitch-en.md#file', sourceFile: 'pitch-en.md', summary: 'Pitch deck', childCount: 0,
      }, 0, 0);
      assert.match(html, /title="Pitch deck — pitch-en\.md#file"/);
      assert.match(html, />pitch-en\.md</);
      assert.ok(!html.includes('>pitch-en.md#file<'), 'raw node_path must not be the visible label text');
    });
  });
});

describe('chunk view rendering (served app.js + index.html, evaluated behavior)', () => {
  it('renderFileChunks includes a node_type badge for every chunk', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadDomRenderHelpers(js, html);
      const frag = renderFileChunks([
        { chunkIndex: 0, section: 'Intro', nodeType: 'paragraph', text: 'hello', context: 'Intro' },
      ]);
      const badge = frag.querySelector('.chunk-node-type');
      assert.equal(badge.hidden, false);
      assert.equal(badge.textContent, 'paragraph');
      assert.match(badge.className, /badge-amber/);
    });
  });

  it('labels structural node types (table/code/checklist) distinctly', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadDomRenderHelpers(js, html);
      const table = renderFileChunks([{ chunkIndex: 1, nodeType: 'table', text: '| a | b |', context: 'Intro — table' }]);
      const code = renderFileChunks([{ chunkIndex: 2, nodeType: 'code_block', text: 'console.log(1)', context: 'Intro — code block' }]);
      const checklist = renderFileChunks([{ chunkIndex: 3, nodeType: 'checklist', text: '- [ ] todo', context: 'Intro — checklist' }]);
      assert.equal(table.querySelector('.chunk-node-type').textContent, 'table');
      assert.equal(code.querySelector('.chunk-node-type').textContent, 'code');
      assert.equal(checklist.querySelector('.chunk-node-type').textContent, 'checklist');
    });
  });

  it('labels context as "retrieval context" for structural chunks and "section path" for plain prose', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadDomRenderHelpers(js, html);
      const prose = renderFileChunks([{ chunkIndex: 0, nodeType: 'paragraph', text: 'hello', context: 'Intro › Details' }]);
      const table = renderFileChunks([{ chunkIndex: 1, nodeType: 'table', text: '| a |', context: 'Intro — table' }]);
      assert.match(prose.querySelector('.chunk-context-label').textContent, /section path/i);
      assert.doesNotMatch(prose.querySelector('.chunk-context-label').textContent, /retrieval context/i);
      assert.match(table.querySelector('.chunk-context-label').textContent, /retrieval context/i);
      assert.doesNotMatch(table.querySelector('.chunk-context-label').textContent, /^section path/i);
    });
  });

  it('the context annotation is visually secondary (a distinct label class), not ordinary chunk content', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadDomRenderHelpers(js, html);
      const frag = renderFileChunks([{ chunkIndex: 0, nodeType: 'paragraph', text: 'hello', context: 'Intro' }]);
      const contextEl = frag.querySelector('.chunk-context');
      assert.equal(contextEl.hidden, false);
      assert.ok(contextEl.querySelector('.chunk-context-label'), 'context must carry a distinct label element, not just plain text');
    });
  });
});

// ── Phase 3A follow-up: warning delivery (toasts, deduped) ───────────────────
describe('collection warning delivery (served app.js, evaluated behavior)', () => {
  it('showToast() appends a visible, readable toast into #toast-host', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { showToast, document } = loadToastHelpers(js);
      showToast('legacy flat vector schema — hybrid search unavailable');
      const toasts = document.querySelectorAll('#toast-host .toast');
      assert.equal(toasts.length, 1);
      assert.match(toasts[0].textContent, /hybrid search unavailable/);
    });
  });

  it('showCollectionWarnings() shows one toast per distinct warning text', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { showCollectionWarnings, document } = loadToastHelpers(js);
      showCollectionWarnings('demo', ['warning A', 'warning B']);
      const toasts = document.querySelectorAll('#toast-host .toast');
      assert.equal(toasts.length, 2);
    });
  });

  it('does not spam a duplicate toast for the same collection + warning text seen again', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { showCollectionWarnings, document } = loadToastHelpers(js);
      showCollectionWarnings('demo', ['no vector schema found on this collection']);
      showCollectionWarnings('demo', ['no vector schema found on this collection']);
      const toasts = document.querySelectorAll('#toast-host .toast');
      assert.equal(toasts.length, 1, 're-showing the same collection+warning must not add a second toast');
    });
  });

  it('the same warning text on a different collection is not deduped away', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { showCollectionWarnings, document } = loadToastHelpers(js);
      showCollectionWarnings('demo-a', ['no vector schema found on this collection']);
      showCollectionWarnings('demo-b', ['no vector schema found on this collection']);
      const toasts = document.querySelectorAll('#toast-host .toast');
      assert.equal(toasts.length, 2, 'dedupe key must be scoped per collection, not warning text alone');
    });
  });

  it('renderCollection() triggers warning toasts on collection open', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /showCollectionWarnings\(name, detail\.warnings\)/,
        'opening a collection must route its warnings through the toast dedupe path, not render them ad hoc');
    });
  });

  it('the collapsed Details panel is not the only place warning text appears — toasts exist as a separate delivery path', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /function showToast/, 'a toast mechanism must exist');
      assert.match(js, /id="toast-host"|toast-host/, 'a toast host must be wired');
      // The badge itself (health summary) must still be visible outside Details —
      // regression guard for the Phase 3A header collapsibility this builds on.
      const start = js.indexOf('function renderCollectionHeader');
      const fn = js.slice(start, start + 1200);
      const detailsIdx = fn.indexOf('<details');
      const badgeIdx = fn.indexOf('healthBadge');
      assert.ok(badgeIdx > -1 && badgeIdx < detailsIdx, 'health badge must render before/outside the Details disclosure');
    });
  });
});

describe('collection header (served app.js)', () => {
  it('renders name, summary, health badge, and point count — no dense/sparse/provider strings', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /function renderCollectionHeader/);
      const fn = js.slice(js.indexOf('function renderCollectionHeader'), js.indexOf('function renderCollectionHeader') + 1200);
      assert.ok(!/dense vector|sparse vector|denseProvider|chunkingSchema/.test(fn),
        'collection header must not render technical vector/provider/schema details');
    });
  });

  it('has a settings button that navigates to the settings route using the #/c/ URL scheme', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /col-settings-btn/);
      assert.match(js, /#\/c\/\$\{encodeURIComponent\(name\)\}\/settings/);
    });
  });

  it('keeps name, health badge, and settings button always visible; collapses description/point-count/warnings behind a "Details" disclosure', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const start = js.indexOf('function renderCollectionHeader');
      const fn = js.slice(start, start + 1200);
      const topLineEnd = fn.indexOf('col-header-top');
      const detailsStart = fn.indexOf('<details class="panel advanced-panel"');
      assert.ok(detailsStart > -1, 'collection header must have a collapsible Details panel');
      assert.ok(fn.indexOf('col-settings-btn') < detailsStart, 'settings button must be outside/above the disclosure');
      assert.ok(fn.indexOf('healthBadge') < detailsStart || topLineEnd < detailsStart,
        'health badge must render on the always-visible top line, not inside the disclosure');
      const inside = fn.slice(detailsStart);
      assert.match(inside, /pointCount/, 'point count must be inside the collapsed Details panel');
    });
  });
});

// ── Phase 3A: #/c/ URL scheme (renamed from #/collections/) ─────────────────
describe('router — currentRoute() (served app.js, evaluated behavior)', () => {
  it('parses collection home: #/c/:name', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { currentRoute } = loadRouterHelper(js);
      assert.deepEqual(currentRoute('#/c/my-docs'), { view: 'collection', name: 'my-docs' });
    });
  });

  it('parses file view: #/c/:name/f/:sourceFile, including an encoded slash in the path', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { currentRoute } = loadRouterHelper(js);
      const r = currentRoute(`#/c/my-docs/f/${encodeURIComponent('sub/dir/readme.md')}`);
      assert.deepEqual(r, { view: 'collection', name: 'my-docs', openFile: 'sub/dir/readme.md' });
    });
  });

  it('parses section/node view: #/c/:name/n/:nodePath', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { currentRoute } = loadRouterHelper(js);
      const r = currentRoute(`#/c/my-docs/n/${encodeURIComponent('readme.md#intro')}`);
      assert.deepEqual(r, { view: 'collection', name: 'my-docs', openNodePath: 'readme.md#intro' });
    });
  });

  it('parses settings: #/c/:name/settings', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { currentRoute } = loadRouterHelper(js);
      assert.deepEqual(currentRoute('#/c/my-docs/settings'), { view: 'settings', name: 'my-docs' });
    });
  });

  it('parses the indexing view and falls back to overview for everything else', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { currentRoute } = loadRouterHelper(js);
      assert.deepEqual(currentRoute('#/index'), { view: 'index' });
      assert.deepEqual(currentRoute('#/'), { view: 'overview' });
      assert.deepEqual(currentRoute(''), { view: 'overview' });
    });
  });

  it('decodes a URI-encoded Cyrillic collection name', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { currentRoute } = loadRouterHelper(js);
      const r = currentRoute(`#/c/${encodeURIComponent('Основи Node.js')}`);
      assert.deepEqual(r, { view: 'collection', name: 'Основи Node.js' });
    });
  });

  it('no longer recognizes the old #/collections/:name scheme (falls through to overview)', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { currentRoute } = loadRouterHelper(js);
      assert.deepEqual(currentRoute('#/collections/my-docs'), { view: 'overview' });
    });
  });
});

describe('old flat technical panels are removed (served app.js)', () => {
  it('no longer renders a separate Documents card', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.ok(!/col-docs/.test(js), 'old standalone Documents panel container must be gone');
      assert.ok(!/async function loadDocuments/.test(js), 'old loadDocuments() must be removed');
    });
  });

  it('no longer uses the old #/collections/ URL scheme anywhere in the served bundle', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.ok(!/#\/collections\//.test(js), 'old #/collections/ URL scheme must be fully removed');
    });
  });

  it('no longer renders skeleton navigation as its own main-panel card', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.ok(!/col-skel/.test(js), 'old standalone skeleton-nav panel container must be gone');
    });
  });

  it('the Metadata panel is not duplicated as a separate technical card in the collection view', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.ok(!/col-meta/.test(js), 'old standalone Metadata panel container must be gone');
    });
  });
});

describe('collection settings (served app.js)', () => {
  it('renders a settings view with reindex, repair, diagnostics, and delete', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /async function renderSettingsView/);
      assert.match(js, /Advanced diagnostics/);
    });
  });

  it('starts a reindex job with the current collection name, no separate retyped field', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /runSettingsReindex/);
      assert.match(js, /collection:\s*name,[\s\S]{0,80}path,/);
    });
  });

  it('reindex options are grouped and include LLM summaries', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /opt-group-label">Quality/);
      assert.match(js, /opt-group-label">Structure/);
      assert.match(js, /opt-llm-summaries/);
    });
  });

  it('offers a recent-source-path selector with a manual fallback, not only a plain path input', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /function renderSourcePathField/);
      assert.match(js, /settings-path-recent/);
      assert.match(js, /settings-path-manual/);
    });
  });

  it('the manual source-path input has no HTML "required" attribute (JS-level validation only)', async () => {
    // A `required` attribute on an input that can be hidden via display:none
    // (when a recent-path <select> is shown instead) risks blocking form
    // submission on native constraint validation before the JS handler ever
    // runs. Validation is done entirely by runSettingsReindex's own
    // "Source path is required" check instead.
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const inputTag = js.slice(js.indexOf('id="settings-path-manual"') - 60, js.indexOf('id="settings-path-manual"') + 150);
      assert.ok(!/\brequired\b/.test(inputTag), `manual path input must not have "required": ${inputTag}`);
    });
  });

  it('requires a source path before starting a reindex', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /Source path is required/);
    });
  });

  it('renames sync-schema to "Repair collection compatibility" with an explanatory tooltip', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /Repair collection compatibility/);
      assert.match(js, /Checks and repairs semidex metadata, vector names, and payload indexes/);
      assert.ok(!/>sync schema</i.test(js), 'old unexplained "sync schema" label must not remain verbatim');
    });
  });

  it('keeps the reindex/prune-stale safety copy', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /Reindex starts a background job and writes to this collection/);
      assert.match(js, /Use prune stale only with the full source root/);
    });
  });

  it('delete uses a modal confirmation, not a typed-name text input', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /delete-modal-backdrop/);
      assert.match(js, /openDeleteModal/);
      assert.ok(!/maint-delete-confirm/.test(js), 'old type-to-confirm text input must be gone');
      assert.ok(!/confirmInput/.test(js), 'old type-to-confirm input reference must be gone');
    });
  });

  it('the delete modal calls DELETE with no request body', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /async function apiDelete\(path\)/, 'apiDelete must take no payload parameter');
      assert.match(js, /apiDelete\(`\/api\/collections\/\$\{encodeURIComponent\(name\)\}`\)/);
    });
  });

  it('navigates away from the deleted collection after a successful delete', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /async function runDeleteCollection\(name\)/);
      assert.match(js, /location\.hash = ["']#\/["']/);
    });
  });

  it('advanced diagnostics (dense/sparse vector, provider, schema versions) are collapsed by default', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /<details class="panel advanced-panel">/);
      assert.match(js, /function renderAdvancedDiagnostics/);
    });
  });
});
