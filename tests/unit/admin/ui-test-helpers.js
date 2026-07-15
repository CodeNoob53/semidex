// Shared test infrastructure for the split admin-UI test files
// (ui-router.test.js, ui-sidebar.test.js, ui-search.test.js, etc.). Not
// itself a *.test.js file — imported by the ones that are.
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { createApp } from '../../../src/admin/server.js';
import { createJobRegistry } from '../../../src/admin/jobs/registry.js';

// Keep the shared helper free of the heavy unified/remark/highlight graph.
// Structural-renderer tests inject the real implementation explicitly.
function renderChunkContentPlain(container, chunk) {
  container.textContent = chunk?.rawContent ?? chunk?.text ?? '';
}

// Production builds are minified (Vite/esbuild renames every top-level
// function/variable identifier — confirmed empirically, `--keep-names`
// doesn't help either, since it only attaches a runtime `.name` string
// without preserving the declaration site's text). Tests that need original
// function names read unminified ui-src source directly instead — no build
// step required for these, and immune to minification.
const UI_SRC_DIR = fileURLToPath(new URL('../../../src/admin/ui-src/', import.meta.url));
export function readUiSource(relativePath) {
  return readFileSync(UI_SRC_DIR + relativePath, 'utf-8');
}

// A view module's `?raw` HTML-partial import is just an import statement in
// source — Vite only inlines the partial's content as a string literal at
// build time. Tests that regex-match copy/markup that actually lives in a
// partial need that inlined text. Concatenating the module with the partial
// it imports approximates that inlining closely enough for substring/regex
// assertions (it does not need to be a real bundler — this text is never
// eval'd as JS here, only searched).
export function readUiModuleWithPartial(moduleFile, partialFile) {
  return readUiSource(moduleFile) + readUiSource(`partials/${partialFile}`);
}

// Parses the real hashed asset paths out of a served (built) index.html —
// Vite hashes filenames by content, so nothing can hardcode `/app.js`
// anymore. Used only by tests that must exercise actual serving behavior
// (content-type headers, etc.), where the built output is unavoidable.
export function getBuiltAssetPaths(html) {
  const js = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/)?.[1];
  const css = html.match(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/)?.[1];
  if (!js) throw new Error('could not find built JS entry script in served index.html');
  return { js, css };
}

// Pulls the small, pure rendering helpers directly out of module source (by
// name, between two known adjacent declarations) and evaluates just those
// snippets in an isolated vm context. Lets tests assert on actual rendering
// behavior for given inputs, not just regex-match the source text —
// without needing a browser, and without risking a module's own top-level
// side effects.
export function extractBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error(`end marker not found after start: ${endMarker}`);
  return src.slice(start, end);
}

// Strips ES module `export` keywords before running source in a vm context
// — vm.runInContext evaluates as a plain script, not a module, so `export`
// statements are a SyntaxError there. Only the keyword is stripped (not the
// declaration itself), so every export becomes a plain top-level
// function/const declaration, reachable via the vm context object afterward.
function stripExports(src) {
  return src.replace(/^export\s+(?=(function|async function|const|let|class)\b)/gm, '');
}

// nodeDisplayLabel/basename/shortLabel (format.js) are pure string
// functions — no DOM dependency — so the whole file can be evaluated
// directly with no markers needed.
export function loadFormatHelpers() {
  const src = stripExports(readUiSource('format.js'));
  const context = {};
  vm.createContext(context);
  vm.runInContext(src, context);
  return context;
}

// sidebarNodeRow/onSidebarNodeClick (sidebar.js) reference `document`/`$`
// via imports from dom.js — since sidebar.js is now its own file containing
// only the sidebar domain, no marker-slicing is needed, just strip the
// `import` lines (they'd fail in a bare vm context with no module loader)
// and provide the few cross-module functions it calls as stubs/real values.
export function loadSidebarLabelHelpers(js) {
  // Drop import lines — the vm context supplies $ / esc / nodeDisplayLabel
  // directly instead of via ES module resolution (vm.runInContext has no
  // module loader). icons.js itself has no imports of its own, so its real
  // source is prepended (not stubbed) — sidebarNodeRow() calls
  // iconForNodeType() directly.
  const withoutImports = stripExports(readUiSource('icons.js')) + '\n'
    + stripExports(js).replace(/^import .*$/gm, '');
  const format = loadFormatHelpers();
  const context = {
    $: (sel, root = context.document) => root.querySelector(sel),
    esc(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    },
    nodeDisplayLabel: format.nodeDisplayLabel,
    shortLabel: format.shortLabel,
    currentRoute: () => ({ view: 'overview' }), // sidebar.js imports this from router.js; unused by the label helpers themselves
  };
  vm.createContext(context);
  vm.runInContext(withoutImports, context);
  return context;
}

// Exercises markActive()'s actual DOM behavior (Phase 3A: highlighting the
// open file/section row, not just the collection row) against a small
// hand-built tree fragment shaped like renderSidebarList()/sidebarNodeRow()'s
// real output — a collection row, a fallback file row (data-sf), and a
// skeleton section row (data-path).
export function loadSidebarActiveStateHelpers() {
  const { document } = parseHTML(`<ul id="collection-list">
    <li class="tree-collection">
      <a href="#/c/my-docs" data-name="my-docs" class="tree-row tree-collection-row"></a>
      <div class="tree-children">
        <a class="tree-row tree-file" data-sf="readme.md"></a>
        <div class="tree-row tree-node" data-path="readme.md#file"></div>
        <div class="tree-row tree-node" data-path="readme.md#intro"></div>
      </div>
    </li>
  </ul><nav id="nav-index"></nav><a id="nav-global-settings"></a>`);
  const context = {
    document,
    $: (sel, root = document) => root.querySelector(sel),
    currentRoute: () => ({ view: 'overview' }),
  };
  vm.createContext(context);
  const src = stripExports(readUiSource('icons.js')) + '\n'
    + stripExports(readUiSource('sidebar.js')).replace(/^import .*$/gm, '');
  vm.runInContext(src, context);
  return context;
}

// Drives renderSidebarSkeletonLevel() (unexported, but reachable as a plain
// vm-context top-level function) against a real document + a real click-
// event dispatch, so tests can assert on ACTUAL row/caret click wiring —
// not just source-text regex matches. apiResponses maps a nodePath (the
// "nodePath=" query value) to the children array /skeleton/children should
// return for it.
export function loadSidebarNodeInteractionHelpers({ apiResponses = {} } = {}) {
  const { document } = parseHTML('<div id="root"></div>');
  const context = {
    document,
    $: (sel, root = document) => root.querySelector(sel),
    esc(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    },
    currentRoute: () => ({ view: 'overview' }),
    location: { hash: '#/' },
    api: async (url) => {
      const nodePath = new URL(url, 'http://x').searchParams.get('nodePath');
      if (nodePath in apiResponses) return { children: apiResponses[nodePath] };
      return { children: [] };
    },
  };
  vm.createContext(context);
  const format = readUiSource('format.js');
  const src = stripExports(readUiSource('icons.js')) + '\n'
    + stripExports(format).replace(/^import .*$/gm, '') + '\n'
    + stripExports(readUiSource('sidebar.js')).replace(/^import .*$/gm, '');
  vm.runInContext(src, context);
  return context;
}

// Drives loadSidebar()/loadSidebarTree()/loadSidebarFileList() against a
// real document + a URL-substring-keyed api() stub (same convention as
// loadFileViewBehaviorHelpers/loadRouteIntegrationHelpers), so tests can
// assert on the ACTUAL rendered empty/error/loading DOM — not just source-
// text regex matches (Phase 3K: sidebar.js's fetch-failure/empty-state
// branches had no behavioral coverage at all before this). A stub value can
// be a response object, a function (called with the full URL, for varying
// the response by query string), or an Error instance (thrown, simulating
// a rejected api() call).
export function loadSidebarTreeHelpers({ apiResponses = {} } = {}) {
  const { document } = parseHTML(`<ul id="collection-list"></ul><nav id="nav-index"></nav>`);
  let expanded = null;
  const context = {
    document,
    $: (sel, root = document) => root.querySelector(sel),
    esc(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    },
    currentRoute: () => ({ view: 'overview' }),
    // renderSidebarList() reads/writes the expanded-collection state via
    // these (normally imported from state.js) — stubbed as simple closures
    // over `expanded` so a real (unexpanded, by default) sidebar list can
    // render without crashing on an undefined import inside the vm context.
    getExpandedCollection: () => expanded,
    setExpandedCollection: (name) => { expanded = name; },
    api: async (url) => {
      // Best (longest) matching key wins — e.g. the bare collection-detail
      // URL "/api/collections/my-docs" is itself a substring of
      // "/api/collections/my-docs/documents?limit=200", so a naive
      // first-match-wins scan would let a broad detail-endpoint key shadow
      // a more specific /documents or /skeleton key entirely. Picking the
      // longest key that actually appears in the URL (not just the longest
      // key overall) correctly prefers whichever stub is the closer match.
      let best = null;
      for (const [key, value] of Object.entries(apiResponses)) {
        if (url.includes(key) && (!best || key.length > best[0].length)) best = [key, value];
      }
      if (best) {
        const [, value] = best;
        const resolved = typeof value === 'function' ? value(url) : value;
        if (resolved instanceof Error) throw resolved;
        return resolved;
      }
      throw new Error(`no stub api() response configured for ${url}`);
    },
  };
  vm.createContext(context);
  const format = readUiSource('format.js');
  const src = stripExports(readUiSource('icons.js')) + '\n'
    + stripExports(format).replace(/^import .*$/gm, '') + '\n'
    + stripExports(readUiSource('sidebar.js')).replace(/^import .*$/gm, '');
  vm.runInContext(src, context);
  return context;
}

// clampSidebarWidth/readSidebarWidth/writeSidebarWidth/nextSidebarWidth are
// pure (no DOM) — sidebar-resize.js also exports applySidebarWidth/
// updateSidebarResizeAria/initSidebarResize which touch `document`, but
// those are only *defined*, never called, by the pure-helper tests, so
// evaluating the whole file (with `document` stubbed as unused) is safe.
export function loadSidebarResizeHelpers() {
  const src = stripExports(readUiSource('sidebar-resize.js'));
  const context = { document: undefined };
  vm.createContext(context);
  vm.runInContext(src, context);
  return context;
}

// currentRoute() is a pure function (hash string in, route object out),
// living in its own leaf module (routes.js) specifically so sidebar.js/
// jobs-view.js can read it without importing router.js — no marker-slicing
// needed, the whole file is just this one function.
//
// The route object vm.runInContext returns is a cross-realm object (its own
// Object.prototype, distinct from this file's) — assert/strict's deepEqual
// compares prototypes, so it fails on structurally-identical cross-realm
// objects. Re-serializing through JSON strips realm identity; every route
// shape here is plain string data, so this loses nothing.
export function loadRouterHelper() {
  const src = stripExports(readUiSource('routes.js'));
  // vm.createContext's realm doesn't inherit Node's global URLSearchParams
  // — routes.js's query-string parsing (Phase 3B) needs it injected.
  const context = { URLSearchParams };
  vm.createContext(context);
  vm.runInContext(src, context);
  return { currentRoute: (hash) => JSON.parse(JSON.stringify(context.currentRoute(hash))) };
}

// showToast()/showCollectionWarnings() need a real `document` (createElement,
// querySelector via `$`) and a fake `#toast-host` to append into.
export function loadToastHelpers() {
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
  const src = stripExports(readUiSource('toasts.js')).replace(/^import .*$/gm, '');
  vm.runInContext(src, context);
  return context;
}

// renderResult() (search.js) clones <template> elements via
// document.getElementById(...).content.cloneNode(true) — a plain vm context
// has no `document`, so this needs a real (if minimal) DOM. linkedom is a
// small, fast DOM implementation used here for tests only; it is never a
// runtime dependency of the shipped UI. The <template> markup only exists
// post-build (vite-plugin-html-inject's <load> resolution happens at build
// time — ui-src/index.html on disk still has literal <load src="..."> tags),
// so `html` must come from the real built/served index.html, unlike the
// pure-logic helpers above.
export function loadSearchRenderHelpers(html, { hash = '#/', storage, apiPostImpl, openFileViewImpl, markActiveImpl, revealSidebarPathImpl, renderChunkContentImpl } = {}) {
  const { document, Element } = parseHTML(html);
  // initSearchPanel()/setSearchFile() need #search-panel (the mount point)
  // and #search-scope (the "Searching in: ..." label) to exist — these
  // normally come from collection-shell.html, not the base index.html shell
  // these tests parse — so inject a minimal stand-in into #main.
  document.getElementById('main').insertAdjacentHTML('beforeend',
    '<span id="search-scope"></span><span id="search-mode"></span><div id="search-panel"></div>');
  Element.prototype.scrollIntoView = () => {};
  const memoryStorage = storage ?? (() => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    };
  })();
  // A minimal history stack — real enough for tests to assert "did this
  // action push a new entry or replace the current one" (the pushState-
  // for-a-new-query / replaceState-for-everything-else distinction in
  // search.js's updateSearchUrl), without implementing real browser
  // session-history semantics (no actual back()/forward() traversal).
  const historyStack = [hash];
  const context = {
    document,
    URLSearchParams,
    localStorage: memoryStorage,
    location: { hash },
    history: {
      pushState: (_state, _title, url) => { context.location.hash = url; historyStack.push(url); },
      replaceState: (_state, _title, url) => { context.location.hash = url; historyStack[historyStack.length - 1] = url; },
      get length() { return historyStack.length; },
    },
    __apiPostImpl: apiPostImpl ?? (async () => ({ results: [] })),
    __openFileViewImpl: openFileViewImpl ?? (() => {}),
    __markActiveImpl: markActiveImpl ?? (() => {}),
    __revealSidebarPathImpl: revealSidebarPathImpl ?? (async () => {}),
    // The import is stripped below. Most tests use the lightweight plain
    // renderer; structural integration tests inject the real ES module.
    renderChunkContent: renderChunkContentImpl ?? renderChunkContentPlain,
  };
  vm.createContext(context);
  const src = stripExports(readUiSource('dom.js')).replace(/^import .*$/gm, '')
    + stripExports(readUiSource('routes.js')).replace(/^import .*$/gm, '')
    + stripExports(readUiSource('search.js')).replace(/^import .*$/gm, '')
      // search.js imports openFileView/hideCollectionContent/
      // nodeTypeBadgeIcon/STRUCTURAL_NODE_TYPES from file-view.js,
      // markActive/revealSidebarPath from sidebar.js, and apiPost from
      // api.js — renderResult() itself only calls nodeTypeBadgeIcon/
      // STRUCTURAL_NODE_TYPES directly; the "Show more" open-button-wiring
      // tests need a real (test-supplied) openFileView to assert on, so
      // it's a caller-provided stub (default a no-op) rather than always
      // inlined away — hideCollectionContent() still isn't exercised by
      // these tests, so that one stays a no-op. markActive/revealSidebarPath
      // (Phase 3R: keeps the sidebar's active-row highlight in sync, and
      // expands collapsed ancestor folders, when a search result is opened)
      // are caller-provided stubs the same way, so tests can assert they
      // were actually called (and in what order) on an "Open" click.
      .replace(/openFileView\(/g, '__openFileViewImpl(')
      .replace(/hideCollectionContent\(\)/g, '')
      .replace(/markActive\(\)/g, '__markActiveImpl()')
      .replace(/revealSidebarPath\(/g, '__revealSidebarPathImpl(')
    + '\nconst apiPost = __apiPostImpl;\n'
    + stripExports(readUiSource('icons.js'))
    + `\nfunction nodeTypeBadgeIcon(nodeType) {
      return { table: iconTable, code_block: iconCodeBlock, checklist: iconChecklist }[nodeType]?.() ?? '';
    }
    const STRUCTURAL_NODE_TYPES = new Set(['table', 'code_block', 'checklist']);\n`;
  vm.runInContext(src, context);
  return context;
}

// Same idea as loadSearchRenderHelpers, for file-view.js's renderFileChunks/
// nodeTypeBadgeLabel/wireFileViewButtons.
export function loadFileViewRenderHelpers(html, { renderChunkContentImpl } = {}) {
  const { document } = parseHTML(html);
  const context = { document, renderChunkContent: renderChunkContentImpl ?? renderChunkContentPlain };
  vm.createContext(context);
  const src = stripExports(readUiSource('dom.js')).replace(/^import .*$/gm, '')
    + stripExports(readUiSource('icons.js'))
    + stripExports(readUiSource('assembly-view.js')).replace(/^import .*$/gm, '')
    + stripExports(readUiSource('file-view.js')).replace(/^import .*$/gm, '')
      .replace(/nodeDisplayLabel\(/g, '(x=>String(x))(')
    + '\nconst api = async () => ({});\nfunction basename(p) { return String(p ?? "").split("/").filter(Boolean).at(-1) ?? ""; }\n';
  vm.runInContext(src, context);
  return context;
}

// Exercises openFileView()/openSectionView()'s actual DOM behavior (panel
// visibility, title text, and — the mutual-exclusion mechanism — clearing
// #search-results) against the real served index.html (needed for the
// <template> tags cloneTemplate()/emptyBox()/errorBox() depend on) with the
// collection-shell IDs injected into #main. Takes an `apiResponses` map from
// URL substring -> response object/thrown error, since these functions call
// the real api() with different query strings.
export function loadFileViewBehaviorHelpers(html, apiResponses = {}, { renderChunkContentImpl } = {}) {
  const { document, Element } = parseHTML(html);
  // linkedom doesn't implement scrollIntoView (a no-op layout affordance in
  // real browsers) — openFileView()/openSectionView() call it on the
  // content panel after showing it, so every element needs a stub.
  Element.prototype.scrollIntoView = () => {};
  document.getElementById('main').innerHTML = `
    <div class="col-header" id="col-header"></div>
    <div class="panel">
      <div class="panel-head"><span id="search-mode"></span></div>
      <div class="panel-body" id="search-panel">
        <div id="search-status">3 results</div>
        <div id="search-results"><div class="result-card">stale result</div></div>
      </div>
    </div>
    <div class="panel" id="collection-content-panel" style="display:none">
      <div class="panel-head"><span id="content-title">Results</span></div>
      <div class="panel-body" id="collection-content"></div>
    </div>`;
  const context = {
    document,
    nodeDisplayLabel: (n) => n.nodePath ?? '',
    basename: (p) => String(p ?? '').split('/').filter(Boolean).at(-1) ?? '',
    api: async (url) => {
      for (const [key, value] of Object.entries(apiResponses)) {
        if (url.includes(key)) {
          // A function stub gets the full request URL, so a test can vary
          // its response by query string (e.g. asserting the exact
          // chunkIndex a follow-up "load more" call requests).
          const resolved = typeof value === 'function' ? value(url) : value;
          if (resolved instanceof Error) throw resolved;
          return resolved;
        }
      }
      throw new Error(`no stub api() response configured for ${url}`);
    },
    renderChunkContent: renderChunkContentImpl ?? renderChunkContentPlain,
    // file-view.js surfaces non-blocking failures (e.g. a rejected lazy
    // /chunks fetch) through showToast — captured here so tests can assert
    // on the toast without the real #toast-host/timer machinery.
    __toasts: [],
    showToast: (message, opts = {}) => { context.__toasts.push({ message, ...opts }); },
  };
  vm.createContext(context);
  const src = stripExports(readUiSource('dom.js')).replace(/^import .*$/gm, '')
    + stripExports(readUiSource('icons.js'))
    + stripExports(readUiSource('assembly-view.js')).replace(/^import .*$/gm, '')
    + stripExports(readUiSource('file-view.js')).replace(/^import .*$/gm, '');
  vm.runInContext(src, context);
  return context;
}

// For operation-render.js's renderOperationCard/formatDuration/
// formatStartedLabel/tickElapsedRows (Phase 3S — replaces the deleted
// jobs-view.js renderJobRow(), which this module's tests used to target;
// see docs/admin-ui-phase3s-unified-operation-status-2026-07-11.md for the
// architecture this replaced). Needs the real built index.html (tpl-job-row
// lives in partials/templates/job-row.html, reused as-is by the modal).
export function loadOperationRenderHelpers(html) {
  const { document } = parseHTML(html);
  const context = { document };
  vm.createContext(context);
  const src = stripExports(readUiSource('dom.js')).replace(/^import .*$/gm, '')
    + stripExports(readUiSource('operation-render.js')).replace(/^import .*$/gm, '');
  vm.runInContext(src, context);
  return context;
}

// Evaluates topbar.js against a real DOM, with operation-store.js's
// subscribe()/getActiveOperation() and operation-modal.js's
// openOperationModal() stubbed (Phase 3S: topbar.js no longer polls on its
// own — it subscribes to the shared store, so these tests drive it by
// calling the test's own __emit() directly rather than waiting on a real
// poller or network timers).
export function loadTopbarHelpers(html, { apiImpl, openOperationModalImpl } = {}) {
  const { document } = parseHTML(html);
  let listener = null;
  let active = null;
  const context = {
    document,
    __apiImpl: apiImpl ?? (async () => ({ storage: { backend: 'stub' }, ok: true })),
    __openOperationModalImpl: openOperationModalImpl ?? (() => {}),
    location: { hash: '#/' },
    setTimeout: () => 0, clearTimeout: () => {},
    // Test-facing handles, set after vm.runInContext below.
    __setActive: (op) => { active = op; },
    __emitUpdate: () => listener?.({ type: 'update' }),
  };
  vm.createContext(context);
  const src = stripExports(readUiSource('dom.js')).replace(/^import .*$/gm, '')
    + stripExports(readUiSource('icons.js'))
    + stripExports(readUiSource('topbar.js')).replace(/^import .*$/gm, '')
    + `\nconst api = __apiImpl;
    const openOperationModal = __openOperationModalImpl;
    function subscribe(fn) { __registerListener(fn); return () => {}; }
    function getActiveOperation() { return __getActive(); }
    `;
  context.__registerListener = (fn) => { listener = fn; };
  context.__getActive = () => active;
  vm.runInContext(src, context);
  return context;
}

// Evaluates the REAL route()/renderCollection()/openFileView()/
// initSearchPanel() call graph together (dom.js, api.js, format.js,
// state.js, toasts.js, routes.js, file-view.js, search.js, sidebar.js,
// collection-view.js, router.js) against a minimal shell, so tests can
// assert on the actual end-to-end flow a URL navigation triggers — not
// just source-text regex matches, which (by construction) can't see across
// module boundaries and previously missed a real bug: initSearchPanel()
// calling syncSearchStateFromUrl() internally, bypassing router.js's
// file/section-aware apply-vs-sync split on a route's FIRST visit.
// settings-view.js/jobs-view.js are stubbed out (imported by router.js but
// only reachable via the 'settings'/'index' route views, not exercised
// here) to keep the graph to what a collection-route navigation actually
// touches.
export function loadRouteIntegrationHelpers(html, { hash = '#/', apiResponses = {}, renderChunkContentImpl } = {}) {
  const { document, Element } = parseHTML(html);
  Element.prototype.scrollIntoView = () => {};
  document.getElementById('main').insertAdjacentHTML('beforeend', '<ul id="collection-list"></ul><nav id="nav-index"></nav>');
  const apiCalls = [];
  const context = {
    document,
    URLSearchParams,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    matchMedia: undefined,
    location: { hash },
    // renderCollection() -> showCollectionWarnings() -> showToast() schedules
    // an 8s auto-dismiss via setTimeout whenever a collection has warnings —
    // unstubbed, that's a ReferenceError in this vm context (no real timers
    // exist here at all, unlike a browser).
    setTimeout: () => 0, clearTimeout: () => {},
    history: {
      pushState: (_s, _t, url) => { context.location.hash = url; },
      replaceState: (_s, _t, url) => { context.location.hash = url; },
    },
    api: async (url) => {
      apiCalls.push(url);
      for (const [key, value] of Object.entries(apiResponses)) {
        if (url.includes(key)) {
          const resolved = typeof value === 'function' ? value(url) : value;
          if (resolved instanceof Error) throw resolved;
          return resolved;
        }
      }
      throw new Error(`no stub api() response configured for ${url}`);
    },
    apiPost: async (url) => { apiCalls.push(url); return { results: [] }; },
    __apiCalls: apiCalls,
    renderChunkContent: renderChunkContentImpl ?? renderChunkContentPlain,
  };
  vm.createContext(context);
  // stripExports only strips the `export` keyword off individual
  // declarations (export function/const/etc.) — collection-view.js and
  // router.js also end with a trailing re-export statement
  // ("export { a, b };"), a form vm.runInContext still can't parse, so
  // strip that separately here.
  const stripImports = (src) => stripExports(src).replace(/^import .*$/gm, '').replace(/^export \{[^}]*\};?\s*$/gm, '');
  const src = [
    stripImports(readUiSource('dom.js')),
    // api.js's real functions call fetch(), unavailable in this vm context —
    // api/apiPost are supplied directly on `context` instead (below), so
    // api.js's own source is deliberately NOT evaluated here.
    stripImports(readUiSource('format.js')),
    stripImports(readUiSource('state.js')),
    stripImports(readUiSource('toasts.js')),
    stripImports(readUiSource('routes.js')),
    stripImports(readUiSource('icons.js')),
    stripImports(readUiSource('assembly-view.js')),
    stripImports(readUiSource('file-view.js')),
    stripImports(readUiSource('search.js')),
    stripImports(readUiSource('sidebar.js')),
    // collection-view.js's ?raw partial imports become plain consts —
    // real partial content, so markup-dependent behavior (e.g. #col-header,
    // #search-panel existing after mount) matches production exactly.
    `const overviewShell = ${JSON.stringify(readUiSource('partials/overview-shell.html'))};`,
    `const collectionShell = ${JSON.stringify(readUiSource('partials/collection-shell.html'))};`,
    stripImports(readUiSource('collection-view.js')),
    stripImports(readUiSource('router.js'))
      // router.js imports renderSettingsView/renderGlobalSettingsView/
      // renderIndexingView for the 'settings'/'global-settings'/'index'
      // route views — not exercised by these collection-route tests,
      // stubbed to avoid pulling in their modules.
      .replace(/renderSettingsView\(/g, '(async()=>{})(')
      .replace(/renderGlobalSettingsView\(/g, '(async()=>{})(')
      .replace(/renderIndexingView\(/g, '(async()=>{})('),
  ].join('\n');
  vm.runInContext(src, context);
  return context;
}

export function makeFakeChildForSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { setTimeout(() => child.emit('exit', null, 'SIGTERM'), 1); };
  return child;
}

export function makeStubAdapter() {
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
    getFileChunks: async () => [],
    getSectionChunks: async () => null,
    searchHybrid: async () => [],
    getSkeletonRoot: async () => null,
    getSkeletonNode: async () => null,
    getSkeletonChildren: async () => [],
    getContentNode: async () => null,
    getSectionAnchor: async () => null,
  };
}

export async function withServer(fn, extraOptions = {}) {
  const app = createApp({ adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }), ...extraOptions });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

// For operation-store.js — no DOM/template dependency at all (pure state +
// api() calls), so this just needs api() stubbed and setTimeout captured
// (not run for real — tests advance polling by calling __flushTimers()
// themselves, which invokes whatever callback the store's own poll loop
// most recently scheduled, rather than waiting on a real 1.5s/5s delay).
export function loadOperationStoreHelpers({ apiImpl } = {}) {
  let scheduled = null;
  const context = {
    __apiImpl: apiImpl ?? (async () => ({ operations: [] })),
    setTimeout: (fn, ms) => { scheduled = { fn, ms }; return 1; },
    clearTimeout: () => { scheduled = null; },
  };
  vm.createContext(context);
  const src = stripExports(readUiSource('operation-store.js')).replace(/^import .*$/gm, '')
    + '\nconst api = __apiImpl;\n';
  vm.runInContext(src, context);
  // Runs whatever the store's poll loop most recently scheduled via
  // setTimeout, then waits for the resulting api()/notify chain to settle —
  // the store's pollOnce() is async, so the scheduled callback kicks it off
  // but doesn't itself wait for it to finish.
  context.__flushTimers = async () => {
    const next = scheduled;
    scheduled = null;
    next?.fn();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  context.__lastScheduledDelay = () => scheduled?.ms ?? null;
  return context;
}

// For operation-modal.js — needs the real built index.html (the modal
// template) plus operation-store.js's real subscribe()/getOperations()
// (evaluated together, not stubbed, since these tests exercise the actual
// store<->modal wiring) with api()/apiPost() stubbed and timers captured
// the same way loadOperationStoreHelpers does, so tests control both the
// store's poll loop and the modal's elapsed-time ticker deterministically.
export function loadOperationModalHelpers(html, { apiImpl, apiPostImpl } = {}) {
  const { document, Element } = parseHTML(html);
  const intervals = [];
  const timeouts = [];
  // linkedom does not implement document.activeElement at all — .focus()
  // only dispatches a 'focus' event, it never updates any "currently
  // focused" tracking (confirmed directly against node_modules/linkedom).
  // operation-modal.js's focus-return behavior (closeOperationModal()
  // reads document.activeElement to know what to refocus) is real,
  // correct, browser behavior — untestable through this harness without a
  // minimal activeElement shim. Patching Element.prototype.focus to record
  // the most-recently-focused element mirrors real DOM behavior closely
  // enough for this purpose; it does not change production code, only this
  // test harness's document object.
  document.activeElement = null;
  const originalFocus = Element.prototype.focus;
  Element.prototype.focus = function focus(...args) {
    document.activeElement = this;
    return originalFocus.apply(this, args);
  };
  const context = {
    document,
    __apiImpl: apiImpl ?? (async () => ({ operations: [] })),
    __apiPostImpl: apiPostImpl ?? (async () => ({})),
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => {},
    setTimeout: (fn) => { timeouts.push(fn); return timeouts.length; },
    clearTimeout: () => {},
  };
  vm.createContext(context);
  const src = stripExports(readUiSource('dom.js')).replace(/^import .*$/gm, '')
    + stripExports(readUiSource('operation-store.js')).replace(/^import .*$/gm, '')
    + stripExports(readUiSource('operation-render.js')).replace(/^import .*$/gm, '')
    + stripExports(readUiSource('toasts.js')).replace(/^import .*$/gm, '')
    + stripExports(readUiSource('operation-modal.js')).replace(/^import .*$/gm, '')
    + '\nconst api = __apiImpl; const apiPost = __apiPostImpl;\n';
  vm.runInContext(src, context);
  context.__runTimeouts = () => { const t = timeouts.splice(0); t.forEach(fn => fn()); };
  context.__tickElapsed = () => { intervals.forEach(fn => fn()); };
  context.__settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  return context;
}

// For settings-view.js's runSettingsRepair() specifically (code-review P1:
// repair must actually integrate with the operation modal/store, not just
// call the sync-schema endpoint and stop) — layers settings-view.js on top
// of the same real operation-store.js/operation-modal.js/operation-render.js/
// toasts.js stack loadOperationModalHelpers uses, plus stubs for
// settings-view.js's own remaining dependencies (state.js, sidebar.js,
// the settings-shell.html ?raw import) that aren't relevant to this specific
// behavior. apiPostImpl backs BOTH apiPost (the sync-schema call this test
// cares about) and api (the settings-view.js's post-repair health/diagnostics
// refetch) — tests supply whichever shape each call site expects by URL.
export function loadSettingsRepairHelpers(html, { apiPostImpl, apiImpl } = {}) {
  const { document, Element } = parseHTML(html);
  const intervals = [];
  const timeouts = [];
  document.activeElement = null;
  const originalFocus = Element.prototype.focus;
  Element.prototype.focus = function focus(...args) {
    document.activeElement = this;
    return originalFocus.apply(this, args);
  };
  const context = {
    document,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    __apiImpl: apiImpl ?? (async () => ({ operations: [] })),
    __apiPostImpl: apiPostImpl ?? (async () => ({})),
    __apiDeleteImpl: async () => ({}),
    __loadSidebarImpl: async () => {},
    __getExpandedCollectionImpl: () => null,
    __setExpandedCollectionImpl: () => {},
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => {},
    setTimeout: (fn) => { timeouts.push(fn); return timeouts.length; },
    clearTimeout: () => {},
  };
  vm.createContext(context);
  const settingsShellHtml = readUiSource('partials/settings-shell.html');
  const src = stripExports(readUiSource('dom.js')).replace(/^import .*$/gm, '')
    + stripExports(readUiSource('operation-store.js')).replace(/^import .*$/gm, '')
    + stripExports(readUiSource('operation-render.js')).replace(/^import .*$/gm, '')
    + stripExports(readUiSource('toasts.js')).replace(/^import .*$/gm, '')
    + stripExports(readUiSource('operation-modal.js')).replace(/^import .*$/gm, '')
    + `const settingsShell = ${JSON.stringify(settingsShellHtml)};\n`
    + stripExports(readUiSource('settings-view.js')).replace(/^import .*$/gm, '')
      .replace(/\bapiDelete\(/g, '__apiDeleteImpl(')
      .replace(/\bloadSidebar\(\)/g, '__loadSidebarImpl()')
      .replace(/\bgetExpandedCollection\(\)/g, '__getExpandedCollectionImpl()')
      .replace(/\bsetExpandedCollection\(/g, '__setExpandedCollectionImpl(')
    + '\nconst api = __apiImpl; const apiPost = __apiPostImpl;\n';
  // settings-view.js's own top-level runSettingsRepair (a `function`
  // declaration, hoisted, sloppy-mode global attach) is reachable as
  // context.runSettingsRepair directly after vm.runInContext — same
  // convention as every other vm-loaded module in this file (e.g.
  // loadOperationModalHelpers exposing context.openOperationModal).
  vm.runInContext(src, context);
  context.__runTimeouts = () => { const t = timeouts.splice(0); t.forEach(fn => fn()); };
  context.__settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  return context;
}

// For global-settings-view.js (#/settings, Phase 4A.5b) — the view only
// depends on dom.js/api.js plus its own ?raw partial, so this needs just a
// real DOM (for querySelector/innerHTML) and a URL-substring-keyed api()
// stub (same convention as loadFileViewBehaviorHelpers/
// loadRouteIntegrationHelpers) that can resolve OR throw per endpoint, so
// tests can exercise "health ok, generation fails" and vice versa
// independently — the exact behavior Promise.allSettled() exists to
// guarantee.
export function loadGlobalSettingsHelpers({ apiResponses = {} } = {}) {
  const { document } = parseHTML('<main id="main"></main>');
  const apiCalls = [];
  const context = {
    document,
    __apiCalls: apiCalls,
    api: async (url) => {
      apiCalls.push(url);
      for (const [key, value] of Object.entries(apiResponses)) {
        if (url.includes(key)) {
          const resolved = typeof value === 'function' ? value(url) : value;
          if (resolved instanceof Error) throw resolved;
          return resolved;
        }
      }
      throw new Error(`no stub api() response configured for ${url}`);
    },
  };
  vm.createContext(context);
  const shellHtml = readUiSource('partials/global-settings-shell.html');
  const src = stripExports(readUiSource('dom.js')).replace(/^import .*$/gm, '')
    + `const globalSettingsShell = ${JSON.stringify(shellHtml)};\n`
    + stripExports(readUiSource('global-settings-view.js')).replace(/^import .*$/gm, '');
  vm.runInContext(src, context);
  return context;
}

export { createApp, createJobRegistry };
