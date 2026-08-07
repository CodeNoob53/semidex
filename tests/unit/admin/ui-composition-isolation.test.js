// Phase 6 (docs/design/full-lite-shared-architecture-audit-2026-08-01.md,
// §8.2/§11's "Phase 6 — Physical Full/Lite Admin UI composition with
// separate Vite entries and partials"). Structural (real AST import-graph)
// half of this phase's isolation proof — see
// tests/unit/lite/ui-build-dce.test.js for the real-compiler-output half
// neither this test nor a source-regex check can substitute for. Uses the
// SAME parser-based import-graph tool the Full/Lite backend architecture
// tests already use (scripts/audit/build-import-graph.mjs), never regex,
// per the task's own explicit preference.
//
// Replaces the two pre-Phase-6 structural test files
// (tests/unit/admin/global-settings-view-lite-dce.test.js,
// tests/unit/admin/jobs-and-settings-view-lite-dce.test.js), whose entire
// premise (source-level IS_LITE guard shape, semidex-lite-strip marker
// balance) no longer applies — this build has neither mechanism any more.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { buildGraph } from '../../../scripts/audit/build-import-graph.mjs';

const graph = buildGraph();

function reachableFrom(root) {
  const reachable = new Set();
  const queue = [root];
  while (queue.length) {
    const file = queue.pop();
    if (reachable.has(file)) continue;
    reachable.add(file);
    const node = graph.nodes[file];
    if (!node) continue;
    for (const group of [node.staticImports, node.dynamicImports, node.requireCalls]) {
      for (const ref of group) {
        if (ref.kind === 'relative' && ref.resolved) queue.push(ref.resolved);
      }
    }
  }
  return reachable;
}

// Phase 8B Step 7C physically relocated admin/ui-src/ by ownership:
// entries/lite-entry/partials-lite stayed at the composition root
// (src/admin/ui-src/); shared JS modules and shared partials moved to
// src/shared/admin/ui-src/; local-only local-features.js and partials/full/
// moved to src/local/admin/ui-src/. Every graph-key string below was
// updated to the new physical location — the assertions themselves (what
// must/must-not be reachable) are unchanged from the original phase.
describe('entries/lite.js — import-graph isolation from local-only UI code (real AST, not regex)', () => {
  const LITE_ENTRY = 'src/admin/ui-src/entries/lite.js';
  const LOCAL_FEATURES = 'src/local/admin/ui-src/local-features.js';

  it('exists as a real, non-empty graph node', () => {
    assert.ok(graph.nodes[LITE_ENTRY], `expected ${LITE_ENTRY} to exist in the graph`);
  });

  it('never statically imports local-features.js at all — not directly, not transitively', () => {
    const reachable = reachableFrom(LITE_ENTRY);
    assert.ok(!reachable.has(LOCAL_FEATURES), `entries/lite.js must never reach local-features.js, reachable set: ${JSON.stringify([...reachable])}`);
  });

  it('never calls setLocalSettingsCapabilities/setJobsLocalCapabilities/setSettingsLocalCapabilities', () => {
    // Code-only (comments excluded) — entries/lite.js's own header comment
    // legitimately NAMES these setters in prose, explaining that it never
    // calls them; only a real call expression (an actual "(" invocation)
    // would be the regression this test exists to catch.
    const src = readFileSync(new URL('../../../src/admin/ui-src/entries/lite.js', import.meta.url), 'utf-8');
    const codeOnly = src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    for (const setter of ['setLocalSettingsCapabilities', 'setJobsLocalCapabilities', 'setSettingsLocalCapabilities']) {
      assert.ok(!codeOnly.includes(setter), `entries/lite.js must never call ${setter}() — Lite's capability seams must stay null`);
    }
  });

  it('reaches every genuinely shared module (app.js, router.js, global-settings-view.js, jobs-view.js, settings-view.js) — proves this isn\'t isolated by accident (e.g. a broken import), only local-features.js is excluded', () => {
    const reachable = reachableFrom(LITE_ENTRY);
    for (const shared of [
      'src/shared/admin/ui-src/app.js',
      'src/shared/admin/ui-src/router.js',
      'src/shared/admin/ui-src/global-settings-view.js',
      'src/shared/admin/ui-src/jobs-view.js',
      'src/shared/admin/ui-src/settings-view.js',
      'src/shared/admin/ui-src/collection-view.js',
      'src/shared/admin/ui-src/search.js',
    ]) {
      assert.ok(reachable.has(shared), `expected entries/lite.js to reach ${shared} (shared code must still be shared) — reachable set: ${JSON.stringify([...reachable])}`);
    }
  });
});

describe('entries/full.js — import-graph reaches local-features.js (the mirror-image positive check)', () => {
  const FULL_ENTRY = 'src/admin/ui-src/entries/full.js';
  const LOCAL_FEATURES = 'src/local/admin/ui-src/local-features.js';

  it('exists as a real, non-empty graph node', () => {
    assert.ok(graph.nodes[FULL_ENTRY], `expected ${FULL_ENTRY} to exist in the graph`);
  });

  it('directly imports local-features.js', () => {
    const node = graph.nodes[FULL_ENTRY];
    const relDeps = node.staticImports.filter((r) => r.kind === 'relative').map((r) => r.resolved);
    assert.ok(relDeps.includes(LOCAL_FEATURES), `expected entries/full.js to directly import local-features.js, got: ${JSON.stringify(relDeps)}`);
  });

  it('calls all three capability setters', () => {
    const src = readFileSync(new URL('../../../src/admin/ui-src/entries/full.js', import.meta.url), 'utf-8');
    for (const setter of ['setLocalSettingsCapabilities', 'setJobsLocalCapabilities', 'setSettingsLocalCapabilities']) {
      assert.ok(src.includes(setter), `entries/full.js must call ${setter}()`);
    }
  });
});

describe('shared modules never import Full or Lite composition roots', () => {
  const SHARED_MODULES = [
    'src/shared/admin/ui-src/app.js', 'src/shared/admin/ui-src/router.js', 'src/shared/admin/ui-src/global-settings-view.js',
    'src/shared/admin/ui-src/jobs-view.js', 'src/shared/admin/ui-src/settings-view.js', 'src/shared/admin/ui-src/collection-view.js',
    'src/shared/admin/ui-src/dom.js', 'src/shared/admin/ui-src/api.js', 'src/shared/admin/ui-src/sidebar.js',
  ];

  it('no shared module imports entries/full.js or entries/lite.js', () => {
    // .filter(Boolean): a relative .html?raw specifier (e.g.
    // collection-view.js's own overview-shell.html?raw import) resolves to
    // `null` in this shared graph tool (it does not strip Vite's ?raw
    // query before checking the file exists on disk) — a real, pre-
    // existing quirk of the tool unrelated to this phase, not a signal
    // worth failing this test over; every REAL relative import still
    // resolves correctly (confirmed directly against the graph in this
    // test file's own design work).
    const offenders = [];
    for (const file of SHARED_MODULES) {
      const node = graph.nodes[file];
      if (!node) continue;
      const relDeps = node.staticImports.filter((r) => r.kind === 'relative').map((r) => r.resolved).filter(Boolean);
      for (const dep of relDeps) {
        if (dep.includes('/entries/')) offenders.push({ file, dep });
      }
    }
    assert.deepEqual(offenders, [], `shared modules must never import a composition-root entry point: ${JSON.stringify(offenders)}`);
  });

  it('local-features.js is never imported by global-settings-view.js/jobs-view.js/settings-view.js directly (only by entries/full.js, via the capability seam)', () => {
    const offenders = [];
    for (const file of ['src/shared/admin/ui-src/global-settings-view.js', 'src/shared/admin/ui-src/jobs-view.js', 'src/shared/admin/ui-src/settings-view.js']) {
      const node = graph.nodes[file];
      if (!node) continue;
      const relDeps = node.staticImports.filter((r) => r.kind === 'relative').map((r) => r.resolved).filter(Boolean);
      if (relDeps.includes('src/local/admin/ui-src/local-features.js')) offenders.push(file);
    }
    assert.deepEqual(offenders, [], `these shared view modules must never import local-features.js directly — the whole point of the capability seam is that only entries/full.js does: ${JSON.stringify(offenders)}`);
  });
});

describe('physical partial ownership — no source-stripping mechanism remains', () => {
  it('vite.config.lite.js contains no stripHtmlMarkers/HTML_STRIPS/marker-replacement mechanism (code-only — the header comment legitimately names the removed mechanism in prose, explaining the history)', () => {
    const src = readFileSync(new URL('../../../vite.config.lite.js', import.meta.url), 'utf-8');
    const codeOnly = src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    for (const forbidden of ['stripHtmlMarkers', 'HTML_STRIPS', 'stripMarkers', 'semidex-lite-strip']) {
      assert.ok(!codeOnly.includes(forbidden), `vite.config.lite.js must not contain real code referencing "${forbidden}" — Phase 6 removed the post-build stripping mechanism entirely`);
    }
  });

  it('no partial file contains a semidex-lite-strip marker comment', () => {
    // Phase 8B Step 7C: partials now live under three physical roots —
    // admin/ui-src/partials/ (composition-owned, partials/lite/ only),
    // shared/admin/ui-src/partials/ (shared), and local/admin/ui-src/partials/
    // (local-only, partials/full/) — walk all three.
    function walk(dirUrl) {
      const dirPath = dirUrl.pathname.replace(/^\/([a-zA-Z]):/, '$1:');
      const out = [];
      for (const entry of readdirSync(dirPath)) {
        const fullUrl = new URL(entry, dirUrl.href.endsWith('/') ? dirUrl : dirUrl.href + '/');
        const fullPath = fullUrl.pathname.replace(/^\/([a-zA-Z]):/, '$1:');
        if (statSync(fullPath).isDirectory()) out.push(...walk(new URL(entry + '/', dirUrl)));
        else out.push(fullPath);
      }
      return out;
    }
    const partialsDirs = [
      new URL('../../../src/admin/ui-src/partials/', import.meta.url),
      new URL('../../../src/shared/admin/ui-src/partials/', import.meta.url),
      new URL('../../../src/local/admin/ui-src/partials/', import.meta.url),
    ];
    const offenders = [];
    for (const partialsDir of partialsDirs) {
      for (const file of walk(partialsDir)) {
        if (!file.endsWith('.html')) continue;
        const content = readFileSync(file, 'utf-8');
        if (content.includes('semidex-lite-strip')) offenders.push(file);
      }
    }
    assert.deepEqual(offenders, [], `no partial should still carry a semidex-lite-strip marker — the marker-based mechanism was removed entirely: ${JSON.stringify(offenders)}`);
  });

  it('partials/full/ (local/admin/ui-src/) and partials/lite/ (admin/ui-src/, composition-owned) each physically exist with their own index-view.html and settings-shell.html', () => {
    const fullBase = new URL('../../../src/local/admin/ui-src/partials/full/', import.meta.url).pathname.replace(/^\/([a-zA-Z]):/, '$1:');
    const liteBase = new URL('../../../src/admin/ui-src/partials/lite/', import.meta.url).pathname.replace(/^\/([a-zA-Z]):/, '$1:');
    for (const file of ['index-view.html', 'settings-shell.html']) {
      assert.ok(existsSync(`${fullBase}${file}`), `expected partials/full/${file} to exist`);
      assert.ok(existsSync(`${liteBase}${file}`), `expected partials/lite/${file} to exist`);
    }
    assert.ok(existsSync(`${fullBase}onnx-probe-panel.html`), 'expected partials/full/onnx-probe-panel.html to exist (Full-only)');
    assert.ok(!existsSync(`${liteBase}onnx-probe-panel.html`), 'partials/lite/ must not have its own onnx-probe-panel.html — Lite never needs one');
  });

  it('there is no single flat partials/index-view.html, partials/settings-shell.html, or partials/templates/global-settings.html any more', () => {
    const compositionBase = new URL('../../../src/admin/ui-src/partials/', import.meta.url).pathname.replace(/^\/([a-zA-Z]):/, '$1:');
    const sharedBase = new URL('../../../src/shared/admin/ui-src/partials/', import.meta.url).pathname.replace(/^\/([a-zA-Z]):/, '$1:');
    assert.ok(!existsSync(`${compositionBase}index-view.html`));
    assert.ok(!existsSync(`${compositionBase}settings-shell.html`));
    assert.ok(!existsSync(`${sharedBase}index-view.html`));
    assert.ok(!existsSync(`${sharedBase}settings-shell.html`));
    assert.ok(!existsSync(`${sharedBase}templates/global-settings.html`), 'global-settings.html must live under partials/shared/templates/, not directly under partials/templates/');
  });
});

describe('separate HTML entry documents', () => {
  it('src/admin/ui-src/index.html points at entries/full.js', () => {
    const html = readFileSync(new URL('../../../src/admin/ui-src/index.html', import.meta.url), 'utf-8');
    assert.match(html, /<script[^>]+src="\/entries\/full\.js"/);
  });

  it('src/admin/ui-src/lite-entry/index.html points at entries/lite.js', () => {
    const html = readFileSync(new URL('../../../src/admin/ui-src/lite-entry/index.html', import.meta.url), 'utf-8');
    assert.match(html, /<script[^>]+src="\.\.\/entries\/lite\.js"/);
  });

  it('only index.html <load>s the local-only onnx-probe-panel.html', () => {
    const fullHtml = readFileSync(new URL('../../../src/admin/ui-src/index.html', import.meta.url), 'utf-8');
    const liteHtml = readFileSync(new URL('../../../src/admin/ui-src/lite-entry/index.html', import.meta.url), 'utf-8');
    assert.match(fullHtml, /<load src="[^"]*local\/admin\/ui-src\/partials\/full\/onnx-probe-panel\.html"/);
    assert.ok(!liteHtml.includes('onnx-probe-panel.html'), 'lite-entry/index.html must never <load> the ONNX probe panel');
  });
});
