// Phase 3 architecture guarantees (docs/design/full-lite-shared-architecture-audit-2026-08-01.md,
// §11's "Phase 3 — Split admin/server.js into register-neutral-routes.js
// (shared) + a thinner server.js" — this is that phase's own required
// test coverage, not a general regression suite). Proves the extraction
// (a) kept src/admin/register-neutral-routes.js's import graph free of
// Ollama/ONNX/CUDA/Transformers.js/full-only-composition edges, using the
// SAME real AST-based import graph the earlier architecture audit built
// (never regex), and (b) — via three DISTINCT, individually weaker but
// jointly strong pieces of evidence, not one overclaimed test — that
// createApp() and createLiteApp() genuinely share one neutral-route
// wiring: (b1) a structural check that both statically import
// registerNeutralRoutes from the SAME module (so they cannot have quietly
// forked into two copies), (b2) a call-shape test proving
// registerNeutralRoutes() itself is deterministic regardless of which
// composition root's own extra-args shape invokes it, and (b3) real
// end-to-end HTTP round-trips against both REAL composed apps (already
// covered in depth by tests/unit/admin/server.test.js and
// tests/unit/admin/lite-app.test.js — this file adds only the minimal
// smoke-level confirmation that both still start and serve after the
// extraction, plus the local-only-route-absence check for Lite). No test
// here intercepts createApp()'s/createLiteApp()'s own internally
// constructed router instance — see (b2)'s own test for the exact,
// narrower claim it actually proves, and why a stronger DI-based
// interception was considered and rejected.
//
// Updated for Phase 4 (createLiteApp() moved from server.js into
// admin/composition/lite.js — imported from its new canonical path below;
// (b1)'s structural check now targets server-full.js and
// composition/lite.js, the two real composition roots, not server.js,
// which after Phase 4 is bind-config-only. Phase 4's own dedicated
// ownership/import-boundary tests live in
// tests/unit/admin/composition-lite.test.js, not here).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../../../scripts/audit/build-import-graph.mjs';
import {
  LOCAL_ONLY_PATH_PATTERNS, COMPOSITION_FULL_PATTERNS, computeReachable,
} from '../../../scripts/audit/classify-modules.mjs';
import { registerNeutralRoutes } from '../../../src/admin/register-neutral-routes.js';
import { createApp } from '../../../src/admin/server-full.js';
import { createLiteApp } from '../../../src/admin/composition/lite.js';
import { makeStubAdapter } from './ui-test-helpers.js';

const NEUTRAL_ROUTES_FILE = 'src/admin/register-neutral-routes.js';

describe('register-neutral-routes.js — import-graph isolation (real AST, not regex)', () => {
  const graph = buildGraph();

  it('exists as a real, non-empty graph node', () => {
    assert.ok(graph.nodes[NEUTRAL_ROUTES_FILE], `expected ${NEUTRAL_ROUTES_FILE} to exist in the graph — did the extraction land at the recommended path?`);
  });

  it('has zero direct resolved edges into any LOCAL_ONLY_PATH_PATTERNS file — no local-only module is imported BY register-neutral-routes.js itself', () => {
    const node = graph.nodes[NEUTRAL_ROUTES_FILE];
    const directDeps = node.staticImports.filter((r) => r.kind === 'relative').map((r) => r.resolved);
    const directLocalLeaks = directDeps.filter((f) => LOCAL_ONLY_PATH_PATTERNS.some((p) => p.test(f)));
    assert.deepEqual(directLocalLeaks, [], `register-neutral-routes.js must never DIRECTLY import a local-only module, found: ${JSON.stringify(directLocalLeaks)}`);
  });

  it('post-lazy-shim (matching what the real Lite tarball ships), has zero TRANSITIVE resolved edges into any LOCAL_ONLY_PATH_PATTERNS file either', () => {
    // Pre-shim (real, unmodified src/), register-neutral-routes.js DOES
    // transitively reach core/ollama.js — via registerJobsRoutes ->
    // generation/registry.js -> generation/ollama-provider.js ->
    // core/ollama-lazy.js's own real `await import('./ollama.js')`. This
    // is EXPECTED and matches the existing, already-audited *-lazy.js
    // boundary (docs/design/full-lite-shared-architecture-audit-2026-08-01.md
    // §2.4/§5.2) — the lazy-shim mechanism, not "this file never mentions
    // Ollama," is what makes Lite safe. build.mjs (and this repo's own
    // graph tooling) substitutes core/ollama-lazy.js's CONTENT with its
    // *.lite.js shim (whose every export throws instead of importing
    // anything) at STAGING time — the same substitution
    // packages/lite/build.mjs performs for the real shipped tarball.
    // applyLiteShims: true models that substitution here, so this check
    // reflects the REAL, POST-BUILD closure the Lite package ships, not
    // the pre-substitution graph.
    const reachable = computeReachable(graph, [NEUTRAL_ROUTES_FILE], { applyLiteShims: true });
    const localLeaks = [...reachable].filter((f) => LOCAL_ONLY_PATH_PATTERNS.some((p) => p.test(f)));
    assert.deepEqual(localLeaks, [], `register-neutral-routes.js must never transitively reach a local-only module POST-shim (the real shipped-tarball closure), found: ${JSON.stringify(localLeaks)}`);
  });

  it('has zero resolved edges into server-full.js or any other COMPOSITION_FULL_PATTERNS file', () => {
    const reachable = computeReachable(graph, [NEUTRAL_ROUTES_FILE]);
    const fullLeaks = [...reachable].filter((f) => COMPOSITION_FULL_PATTERNS.some((p) => p.test(f)));
    assert.deepEqual(fullLeaks, [], `register-neutral-routes.js must never import the full-only composition root or its siblings, found: ${JSON.stringify(fullLeaks)}`);
  });

  it('never imports onnxruntime-node, @huggingface/transformers, or any bare package outside the declared closure', () => {
    const node = graph.nodes[NEUTRAL_ROUTES_FILE];
    const packageSpecifiers = [];
    for (const group of [node.staticImports, node.dynamicImports, node.requireCalls]) {
      for (const ref of group) {
        if (ref.kind === 'package') packageSpecifiers.push(ref.resolved);
      }
    }
    assert.deepEqual(packageSpecifiers, [], `register-neutral-routes.js must import zero bare packages directly (only Node builtins and relative src/ modules), found: ${JSON.stringify(packageSpecifiers)}`);
  });

  // Phase 4 (docs/design/full-lite-shared-architecture-audit-2026-08-01.md):
  // createLiteApp() moved out of server.js into composition/lite.js, so the
  // two REAL composition roots that must each independently import the
  // shared neutral-route wiring are now server-full.js and
  // composition/lite.js — server.js itself is bind-config-only and no
  // longer imports register-neutral-routes.js at all (see
  // tests/unit/admin/composition-lite.test.js for that assertion).
  it('src/admin/server-full.js and src/admin/composition/lite.js both statically import registerNeutralRoutes/createHttpServer from register-neutral-routes.js, not from each other or via server.js', () => {
    const serverFullNode = graph.nodes['src/admin/server-full.js'];
    const compositionLiteNode = graph.nodes['src/admin/composition/lite.js'];
    assert.ok(serverFullNode, 'expected src/admin/server-full.js to exist in the graph');
    assert.ok(compositionLiteNode, 'expected src/admin/composition/lite.js to exist in the graph');

    const serverFullDeps = serverFullNode.staticImports.filter((r) => r.kind === 'relative').map((r) => r.resolved);
    const compositionLiteDeps = compositionLiteNode.staticImports.filter((r) => r.kind === 'relative').map((r) => r.resolved);

    assert.ok(serverFullDeps.includes(NEUTRAL_ROUTES_FILE), `expected server-full.js to import ${NEUTRAL_ROUTES_FILE}, got: ${JSON.stringify(serverFullDeps)}`);
    assert.ok(compositionLiteDeps.includes(NEUTRAL_ROUTES_FILE), `expected composition/lite.js to import ${NEUTRAL_ROUTES_FILE}, got: ${JSON.stringify(compositionLiteDeps)}`);
    assert.ok(!serverFullDeps.includes('src/admin/composition/lite.js'), 'server-full.js must never import composition/lite.js (would give Full a real edge to the Lite-only composition root)');
    assert.ok(!compositionLiteDeps.includes('src/admin/server-full.js'), 'composition/lite.js must never import server-full.js (would give Lite a real edge to the full-only composition root)');
    assert.ok(!serverFullDeps.includes('src/admin/server.js'), 'server-full.js must import the shared route wiring from register-neutral-routes.js directly, not re-import it via server.js');
    assert.ok(!compositionLiteDeps.includes('src/admin/server.js'), 'composition/lite.js must import the shared route wiring from register-neutral-routes.js directly, not re-import it via server.js');
  });
});

describe('registerNeutralRoutes() — call-shape determinism (NOT a composition-root interception — see the module header comment)', () => {
  // A minimal, real router-shaped fake — records {method, path} for every
  // route registration, matching the exact 4-method surface router.js's
  // own createRouter() exposes (get/post/patch/delete), but with zero
  // matching/dispatch logic — this test only needs to observe WHAT gets
  // registered, not exercise request handling (that is already covered
  // end-to-end by tests/unit/admin/server.test.js and
  // tests/unit/admin/lite-app.test.js against the real createRouter()).
  //
  // IMPORTANT — what this describe block does NOT prove: it never calls
  // createApp() or createLiteApp(), and it never intercepts the REAL
  // router either composition root constructs internally (createRouter()
  // has no injection seam, and this task's own scope forbids adding one
  // "just in case" — a monkey-patch of router.js's live ESM export was
  // tried and found unreliable: import ordering across the test process
  // meant the patched binding was not always the one createApp()/
  // createLiteApp() actually called, so it was rejected as a fragile
  // false confidence rather than shipped). What IS proven here is
  // narrower but real: registerNeutralRoutes() itself — the ONE function
  // both composition roots statically import from THE SAME module (see
  // the structural test above) — registers a deterministic route set
  // regardless of which caller's own extra-args shape invokes it. Code
  // review (correctly) flagged an earlier version of this test's name and
  // comment as overclaiming "proven by intercepting the real router each
  // composition root constructs," which never happened. Combined with
  // the structural single-source-of-truth check above and the real
  // end-to-end HTTP round-trips below (against the REAL createApp()/
  // createLiteApp()), these three together are the actual evidence for
  // "Full and Lite share one neutral-route wiring" — no single test here
  // claims to be that whole proof by itself.
  function makeRecordingRouter() {
    const registered = [];
    const router = {};
    for (const method of ['get', 'post', 'patch', 'delete']) {
      router[method] = (path) => { registered.push(`${method.toUpperCase()} ${path}`); };
    }
    return { router, registered };
  }

  it('calling registerNeutralRoutes() directly registers a non-empty, deterministic route set', () => {
    const { router, registered } = makeRecordingRouter();
    registerNeutralRoutes(router, {
      adapter: makeStubAdapter(),
      embedQuery: async () => ({ dense: [], sparse: {} }),
      generationModelsFn: () => {},
      jobsFn: () => {},
    });
    assert.ok(registered.length > 0, 'expected registerNeutralRoutes() to register at least one route');
    // Sanity check a handful of well-known neutral routes are really
    // present — proves the recording router actually observed real
    // registration calls, not an empty no-op.
    assert.ok(registered.includes('GET /api/health'));
    assert.ok(registered.includes('POST /api/v1/ask'));
    assert.ok(registered.includes('GET /api/settings'));
  });

  it('registerNeutralRoutes() itself registers the identical route set regardless of which caller-shape invokes it (Full-shaped extra args vs. Lite-shaped args) — a call-shape determinism check, not proof that createApp()/createLiteApp() reach this same code path (that is what the structural import test above establishes)', async () => {
    // Directly calls registerNeutralRoutes() twice with the fake
    // recording router — once with Full-shaped extra args (pickFolderFn),
    // once with Lite-shaped args — proving the SHARED function's own
    // output does not vary by which shape of caller invokes it. This is
    // deliberately NOT a claim about createApp()/createLiteApp()'s own
    // internal router instances — see this describe block's header
    // comment for why that stronger claim was considered and rejected as
    // unreliable to implement without a production-code DI change this
    // task's scope forbids.
    const fullRecording = makeRecordingRouter();
    registerNeutralRoutes(fullRecording.router, {
      adapter: makeStubAdapter(),
      embedQuery: async () => ({ dense: [], sparse: {} }),
      pickFolderFn: async () => ({ path: null, cancelled: true }), // Full passes this; Lite never does
      generationModelsFn: () => {},
      jobsFn: () => {},
    });

    const liteRecording = makeRecordingRouter();
    registerNeutralRoutes(liteRecording.router, {
      adapter: makeStubAdapter(),
      embedQuery: async () => ({ dense: [], sparse: {} }),
      generationModelsFn: () => {},
      jobsFn: () => {},
    });

    assert.deepEqual(
      [...fullRecording.registered].sort(),
      [...liteRecording.registered].sort(),
      'registerNeutralRoutes() must register the identical route set regardless of caller — Full-only extras like pickFolderFn must never change WHICH routes are registered, only their behavior',
    );
  });

  it('createApp() actually starts and responds on GET /api/health — end-to-end proof the real composition still works after the extraction', async () => {
    const app = createApp({ adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }) });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${app.address().port}`;
      const res = await fetch(`${base}/api/health`);
      assert.equal(res.status, 200);
    } finally {
      await new Promise((resolve) => app.close(resolve));
    }
  });

  it('createLiteApp() actually starts and responds on GET /api/health — end-to-end proof the real composition still works after the extraction', async () => {
    const app = createLiteApp({ adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }) });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${app.address().port}`;
      const res = await fetch(`${base}/api/health`);
      assert.equal(res.status, 200);
    } finally {
      await new Promise((resolve) => app.close(resolve));
    }
  });

  it('createLiteApp() never registers the local-only routes createApp() does (onnx-probe, ollama-status) — both return 404', async () => {
    const app = createLiteApp({ adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }) });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${app.address().port}`;
      const onnxRes = await fetch(`${base}/api/system/onnx-probe`, { method: 'POST' });
      const ollamaRes = await fetch(`${base}/api/system/ollama-status`);
      assert.equal(onnxRes.status, 404);
      assert.equal(ollamaRes.status, 404);
    } finally {
      await new Promise((resolve) => app.close(resolve));
    }
  });

  it('both REAL composed apps (createApp() and createLiteApp()) respond non-404 on the same set of neutral GET routes — the closest behavioral proof available, over real HTTP, that both reach the shared registerNeutralRoutes() wiring, without any production-code DI seam added for testing', async () => {
    // Distinct from (and stronger evidence than) the call-shape test
    // above: this exercises createApp()'s and createLiteApp()'s OWN,
    // internally-constructed router instances over real HTTP — no fake
    // router anywhere in this test. A non-parameterized subset of
    // registerNeutralRoutes()'s GET routes is used (parameterized routes,
    // e.g. /api/collections/:name, need real fixture data behind a real
    // StorageAdapter — already covered per-route in server.test.js/
    // lite-app.test.js; re-deriving fixtures for all of them here would
    // duplicate that coverage rather than add a new guarantee).
    const NEUTRAL_GET_ROUTES = ['/api/health', '/api/settings', '/api/generation/status', '/api/operations'];
    const fullApp = createApp({ adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }) });
    const liteApp = createLiteApp({ adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }) });
    await Promise.all([
      new Promise((resolve) => fullApp.listen(0, '127.0.0.1', resolve)),
      new Promise((resolve) => liteApp.listen(0, '127.0.0.1', resolve)),
    ]);
    try {
      const fullBase = `http://127.0.0.1:${fullApp.address().port}`;
      const liteBase = `http://127.0.0.1:${liteApp.address().port}`;
      for (const route of NEUTRAL_GET_ROUTES) {
        const [fullRes, liteRes] = await Promise.all([fetch(`${fullBase}${route}`), fetch(`${liteBase}${route}`)]);
        assert.notEqual(fullRes.status, 404, `expected createApp()'s real router to have ${route} registered (non-404), got ${fullRes.status}`);
        assert.notEqual(liteRes.status, 404, `expected createLiteApp()'s real router to have ${route} registered (non-404), got ${liteRes.status}`);
      }
    } finally {
      await Promise.all([
        new Promise((resolve) => fullApp.close(resolve)),
        new Promise((resolve) => liteApp.close(resolve)),
      ]);
    }
  });
});
