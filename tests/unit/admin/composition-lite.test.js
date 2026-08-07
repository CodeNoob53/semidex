// Phase 4 architecture guarantees (docs/design/full-lite-shared-architecture-audit-2026-08-01.md,
// §11's "Phase 4 — Split provider registries' Lite-relevant DI seams into
// an explicit composition-lite module" — this is that phase's own required
// test coverage). Proves: (1) src/admin/composition/lite.js is the
// canonical owner of createLiteApp/LITE_JOB_POLICY — src/admin/server.js no
// longer exports either; (2) src/admin/server.js's own import list no
// longer includes any provider-composition import (createStorageAdapter,
// registerJobsRoutes, registerGenerationModelsRoutesGeminiOnly,
// registerNeutralRoutes/createHttpServer, or any composition module) —
// checked via the SAME real AST-derived import graph the Phase 3 tests use
// (scripts/audit/build-import-graph.mjs), never a source regex; (3) Lite
// composition has zero direct/transitive local-only reachability
// post-lazy-shim-substitution, matching what the real tarball ships. Real
// createLiteApp()/createApp() end-to-end behavioral proof already exists in
// tests/unit/admin/lite-app.test.js, tests/unit/admin/server.test.js, and
// tests/unit/admin/register-neutral-routes.test.js — not duplicated here;
// this file adds only the structural ownership/import-boundary checks that
// are new to Phase 4.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as serverModule from '../../../src/shared/admin/server.js';
import * as compositionLiteModule from '../../../src/admin/composition/lite.js';
import { buildGraph } from '../../../scripts/audit/build-import-graph.mjs';
import { LOCAL_ONLY_PATH_PATTERNS, COMPOSITION_FULL_PATTERNS, computeReachable } from '../../../scripts/audit/classify-modules.mjs';

const SERVER_FILE = 'src/shared/admin/server.js';
const COMPOSITION_LITE_FILE = 'src/admin/composition/lite.js';

describe('Phase 4 — canonical ownership of createLiteApp/LITE_JOB_POLICY', () => {
  it('src/admin/composition/lite.js exports createLiteApp and LITE_JOB_POLICY', () => {
    assert.equal(typeof compositionLiteModule.createLiteApp, 'function');
    assert.ok(compositionLiteModule.LITE_JOB_POLICY);
    assert.equal(compositionLiteModule.LITE_JOB_POLICY.allowOnnxEmbed, false);
    assert.equal(compositionLiteModule.LITE_JOB_POLICY.allowLlmSummaries, false);
    assert.equal(compositionLiteModule.LITE_JOB_POLICY.allowTagGen, false);
    assert.equal(compositionLiteModule.LITE_JOB_POLICY.allowPruneStale, true);
  });

  it('src/admin/server.js no longer exports createLiteApp or LITE_JOB_POLICY — server.js hosts bind config only', () => {
    assert.equal('createLiteApp' in serverModule, false, 'server.js must not export createLiteApp after Phase 4 — composition/lite.js is the sole owner');
    assert.equal('LITE_JOB_POLICY' in serverModule, false, 'server.js must not export LITE_JOB_POLICY after Phase 4 — composition/lite.js is the sole owner');
  });

  it('src/admin/server.js exports exactly resolveHostConfig and resolvePortConfig — no compatibility re-export snuck back in', () => {
    assert.deepEqual(Object.keys(serverModule).sort(), ['resolveHostConfig', 'resolvePortConfig']);
  });
});

describe('Phase 4 — src/admin/server.js import boundary (real AST, not regex)', () => {
  const graph = buildGraph();

  it('no longer statically imports createStorageAdapter, registerJobsRoutes, registerGenerationModelsRoutesGeminiOnly, registerNeutralRoutes, or createHttpServer', () => {
    const node = graph.nodes[SERVER_FILE];
    assert.ok(node, `expected ${SERVER_FILE} to exist in the graph`);
    const relDeps = node.staticImports.filter((r) => r.kind === 'relative').map((r) => r.resolved);
    assert.ok(!relDeps.includes('src/shared/admin/register-neutral-routes.js'), `server.js must no longer import register-neutral-routes.js, got deps: ${JSON.stringify(relDeps)}`);
    assert.ok(!relDeps.includes('src/admin/composition/lite.js'), 'server.js must not import composition/lite.js (that would be a backwards edge — server.js has no reason to depend on its own former composition logic)');
    assert.ok(!relDeps.includes('src/admin/server-full.js'), 'server.js must never import server-full.js');
    assert.ok(!relDeps.includes('src/core/storage/factory.js'), `server.js must no longer import createStorageAdapter's module, got deps: ${JSON.stringify(relDeps)}`);
    assert.ok(!relDeps.includes('src/shared/admin/api/jobs.js'), `server.js must no longer import registerJobsRoutes' module, got deps: ${JSON.stringify(relDeps)}`);
  });

  it('src/admin/server.js has zero relative-import dependencies at all — pure bind-config logic, no composition imports of any kind', () => {
    const node = graph.nodes[SERVER_FILE];
    const relDeps = node.staticImports.filter((r) => r.kind === 'relative');
    assert.deepEqual(relDeps, [], `expected server.js to have zero relative imports after Phase 4, found: ${JSON.stringify(relDeps.map((r) => r.resolved))}`);
  });
});

describe('Phase 4 — src/admin/composition/lite.js import boundary (real AST, not regex)', () => {
  const graph = buildGraph();

  it('exists as a real, non-empty graph node', () => {
    assert.ok(graph.nodes[COMPOSITION_LITE_FILE], `expected ${COMPOSITION_LITE_FILE} to exist in the graph — did the extraction land at the recommended path?`);
  });

  it('has zero direct resolved edges into server-full.js or any other COMPOSITION_FULL_PATTERNS file', () => {
    const node = graph.nodes[COMPOSITION_LITE_FILE];
    const directDeps = node.staticImports.filter((r) => r.kind === 'relative').map((r) => r.resolved);
    const directFullLeaks = directDeps.filter((f) => COMPOSITION_FULL_PATTERNS.some((p) => p.test(f)));
    assert.deepEqual(directFullLeaks, [], `composition/lite.js must never import a Full-only composition file, found: ${JSON.stringify(directFullLeaks)}`);
  });

  it('has zero TRANSITIVE resolved edges into server-full.js or any other COMPOSITION_FULL_PATTERNS file', () => {
    const reachable = computeReachable(graph, [COMPOSITION_LITE_FILE]);
    const fullLeaks = [...reachable].filter((f) => COMPOSITION_FULL_PATTERNS.some((p) => p.test(f)));
    assert.deepEqual(fullLeaks, [], `composition/lite.js must never transitively reach the full-only composition root, found: ${JSON.stringify(fullLeaks)}`);
  });

  it('has zero direct resolved edges into any LOCAL_ONLY_PATH_PATTERNS file', () => {
    const node = graph.nodes[COMPOSITION_LITE_FILE];
    const directDeps = node.staticImports.filter((r) => r.kind === 'relative').map((r) => r.resolved);
    const directLocalLeaks = directDeps.filter((f) => LOCAL_ONLY_PATH_PATTERNS.some((p) => p.test(f)));
    assert.deepEqual(directLocalLeaks, [], `composition/lite.js must never DIRECTLY import a local-only module, found: ${JSON.stringify(directLocalLeaks)}`);
  });

  it('post-lazy-shim (matching what the real Lite tarball ships), has zero TRANSITIVE resolved edges into any LOCAL_ONLY_PATH_PATTERNS file either', () => {
    // Pre-shim (real, unmodified src/), composition/lite.js DOES transitively
    // reach core/ollama.js — via registerJobsRoutes -> generation/registry.js
    // -> generation/ollama-provider.js -> core/ollama-lazy.js's own real
    // `await import('./ollama.js')`. Expected, matches the already-audited
    // *-lazy.js boundary (see register-neutral-routes.test.js's identical,
    // more-detailed comment on this same pre/post-shim distinction).
    // applyLiteShims: true models build.mjs's real content substitution, so
    // this check reflects the actual shipped-tarball closure, not the
    // pre-substitution graph.
    const reachable = computeReachable(graph, [COMPOSITION_LITE_FILE], { applyLiteShims: true });
    const localLeaks = [...reachable].filter((f) => LOCAL_ONLY_PATH_PATTERNS.some((p) => p.test(f)));
    assert.deepEqual(localLeaks, [], `composition/lite.js must never transitively reach a local-only module POST-shim (the real shipped-tarball closure), found: ${JSON.stringify(localLeaks)}`);
  });

  it('never imports a bare package directly (only Node builtins and relative src/ modules)', () => {
    const node = graph.nodes[COMPOSITION_LITE_FILE];
    const packageSpecifiers = [];
    for (const group of [node.staticImports, node.dynamicImports, node.requireCalls]) {
      for (const ref of group) {
        if (ref.kind === 'package') packageSpecifiers.push(ref.resolved);
      }
    }
    assert.deepEqual(packageSpecifiers, [], `composition/lite.js must import zero bare packages directly, found: ${JSON.stringify(packageSpecifiers)}`);
  });

  it('statically imports registerNeutralRoutes/createHttpServer from register-neutral-routes.js — the same shared module server-full.js uses', () => {
    const node = graph.nodes[COMPOSITION_LITE_FILE];
    const relDeps = node.staticImports.filter((r) => r.kind === 'relative').map((r) => r.resolved);
    assert.ok(relDeps.includes('src/shared/admin/register-neutral-routes.js'), `expected composition/lite.js to import register-neutral-routes.js, got: ${JSON.stringify(relDeps)}`);
  });
});
