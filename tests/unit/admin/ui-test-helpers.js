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
  // module loader).
  const withoutImports = stripExports(js).replace(/^import .*$/gm, '');
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
  const context = {};
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
export function loadSearchRenderHelpers(html) {
  const { document } = parseHTML(html);
  const context = { document };
  vm.createContext(context);
  const src = stripExports(readUiSource('dom.js')).replace(/^import .*$/gm, '')
    + stripExports(readUiSource('search.js')).replace(/^import .*$/gm, '')
      // search.js imports openFileView/hideCollectionContent from
      // file-view.js and apiPost from api.js — renderResult() itself never
      // calls them (only runSearch does, which these tests don't exercise),
      // so stub them out rather than pulling in the full file-view.js graph.
      .replace(/openFileView\(/g, '(()=>{})(')
      .replace(/hideCollectionContent\(\)/g, '')
    + '\nconst apiPost = async () => ({});\n';
  vm.runInContext(src, context);
  return context;
}

// Same idea as loadSearchRenderHelpers, for file-view.js's renderFileChunks/
// nodeTypeBadgeLabel/wireFileViewButtons.
export function loadFileViewRenderHelpers(html) {
  const { document } = parseHTML(html);
  const context = { document };
  vm.createContext(context);
  const src = stripExports(readUiSource('dom.js')).replace(/^import .*$/gm, '')
    + stripExports(readUiSource('file-view.js')).replace(/^import .*$/gm, '')
      .replace(/nodeDisplayLabel\(/g, '(x=>String(x))(')
    + '\nconst api = async () => ({});\n';
  vm.runInContext(src, context);
  return context;
}

// Same idea, for jobs-view.js's renderJobRow/formatDuration/
// formatStartedLabel/jobFilesLabel/tickRunningJobRows/JOB_STATUS_BADGE_CLASS.
export function loadJobsViewRenderHelpers(html) {
  const { document } = parseHTML(html);
  const context = { document };
  vm.createContext(context);
  const src = stripExports(readUiSource('dom.js')).replace(/^import .*$/gm, '')
    + stripExports(readUiSource('jobs-view.js'))
      .replace(/^import .*$/gm, '')
      // jobs-view.js's top-level statements only declare functions/consts
      // (confirmed by direct read) — safe to eval whole-file.
    + '\nconst api = async () => ({}); const apiPost = async () => ({});'
    + ' const loadSidebar = async () => {}; const currentRoute = () => ({ view: "index" });\n';
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
    searchHybrid: async () => [],
    getSkeletonRoot: async () => null,
    getSkeletonNode: async () => null,
    getSkeletonChildren: async () => [],
    getStructuralNode: async () => null,
    getSectionAnchor: async () => null,
  };
}

export async function withServer(fn) {
  const app = createApp({ adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }) });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

export { createApp, createJobRegistry };
