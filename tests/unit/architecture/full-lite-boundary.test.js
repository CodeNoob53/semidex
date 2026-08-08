// Phase 1 architecture tests (docs/design/full-lite-shared-architecture-audit-2026-08-01.md,
// §12/§15 — the audit's own recommended first implementation task). Locks
// in, as real assertions rather than console output, facts the audit's
// scripts/audit/*.mjs tooling already establishes about the CURRENT
// codebase. All tests pass against src/ exactly as it exists today — this
// file is not aspirational, it is a regression lock.
//
// Reuses build-import-graph.mjs's real AST-based graph builder AND
// classify-modules.mjs's own FULL_ROOTS/pattern-list/helper exports
// directly, rather than re-declaring local copies of them — code review
// correctly flagged that a hand-maintained LITE_SYNTHETIC_ROOTS list
// (this file's own first version) could silently drift from a new import
// added to a Lite entry point. Lite roots are now derived from the real
// graph (every file under packages/lite/lite-src/, which
// build-import-graph.mjs parses as genuine AST nodes alongside src/ — see
// that file's own header comment) rather than hand-transcribed, so a new
// import in a Lite entry point is picked up automatically, with no list
// to remember to update.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../../../scripts/audit/build-import-graph.mjs';
import {
  FULL_ROOTS, LITE_SRC_DIR, HEAVY_LOCAL_PACKAGES,
  LOCAL_ONLY_PATH_PATTERNS, CLOUD_ONLY_PATH_PATTERNS,
  computeReachable, collectExternalDeps,
} from '../../../scripts/audit/classify-modules.mjs';

// The exact, current, fully-enumerated non-literal reference in the whole
// graph (dynamic import(), require(), and fork()/spawn() calls whose
// target could not be statically resolved to a literal path) — replaces
// an earlier `nonLiteralCount <= 3` fuzzy bound code review correctly
// flagged as letting new unreviewed non-literal imports slip in silently
// as long as the total stayed under 3. Every entry here was reviewed:
// local/core/onnx-runtime.js's require(resolveOnnxRuntimeModule(env)) resolves
// onnxruntime-node's OWN module path from an env var at runtime — a
// genuinely necessary runtime resolution (the whole point is letting a
// user point at a custom ORT build), not a closure-validator gap. Adding
// a NEW entry to this list is a real, git-diff-visible signal that a new
// non-literal reference needs the same kind of review, not a number to
// silently increment.
const ALLOWED_NON_LITERAL_REFERENCES = [
  { file: 'src/local/core/onnx-runtime.js', kind: 'require', reason: 'require(resolveOnnxRuntimeModule(env)) — runtime-resolves onnxruntime-node itself, or a user-supplied ONNXRUNTIME_NODE_PATH override; local-only file, never staged into the Lite tarball' },
];

describe('full-lite architecture boundary (Phase 1 lock-in)', () => {
  const graph = buildGraph();

  it('parses every file under src/ and packages/lite/lite-src/ with zero AST errors (sanity check the graph itself is trustworthy)', () => {
    assert.equal(graph.parseErrors.length, 0, `parse errors: ${JSON.stringify(graph.parseErrors)}`);
  });

  it('packages/lite/lite-src/*.js are real, non-empty graph nodes (sanity check they are actually being parsed, not silently skipped)', () => {
    const liteSrcFiles = graph.files.filter((f) => f.startsWith(LITE_SRC_DIR));
    assert.ok(liteSrcFiles.length >= 5, `expected at least 5 files under ${LITE_SRC_DIR}, found ${liteSrcFiles.length}: ${JSON.stringify(liteSrcFiles)}`);
  });

  it('Lite composition never reaches onnxruntime-node or @huggingface/transformers — item #3', () => {
    const liteSyntheticRoots = graph.files.filter((f) => f.startsWith(LITE_SRC_DIR));
    const liteReachable = computeReachable(graph, liteSyntheticRoots);
    const liteDeps = collectExternalDeps(graph, liteReachable);
    const heavyFound = HEAVY_LOCAL_PACKAGES.filter((p) => liteDeps.has(p));
    assert.deepEqual(heavyFound, [], `heavy local package(s) reachable from Lite: ${JSON.stringify(heavyFound)}`);
  });

  it('Lite composition never reaches any LOCAL_ONLY_PATH_PATTERNS file', () => {
    const liteSyntheticRoots = graph.files.filter((f) => f.startsWith(LITE_SRC_DIR));
    const liteReachable = computeReachable(graph, liteSyntheticRoots);
    const leaked = [...liteReachable].filter((f) => LOCAL_ONLY_PATH_PATTERNS.some((p) => p.test(f)));
    assert.deepEqual(leaked, [], `local-only file(s) reachable from Lite: ${JSON.stringify(leaked)}`);
  });

  it('cloud never imports local — no CLOUD_ONLY_PATH_PATTERNS file has a direct resolved edge into a LOCAL_ONLY_PATH_PATTERNS file', () => {
    // Code review P2 finding: the design doc's Part K explicitly requires
    // this rule but no prior test actually checked it — only Lite-
    // reachability-excludes-local was checked, which is a different
    // (weaker, indirect) guarantee. This checks the DIRECT dependency
    // edges of every cloud-classified file, matching how the rest of this
    // script's direction-rules work.
    const violations = [];
    for (const file of graph.files.filter((f) => CLOUD_ONLY_PATH_PATTERNS.some((p) => p.test(f)))) {
      const node = graph.nodes[file];
      const relDeps = [];
      for (const group of [node.staticImports, node.dynamicImports, node.requireCalls]) {
        for (const ref of group) {
          if (ref.kind === 'relative' && ref.resolved) relDeps.push(ref.resolved);
        }
      }
      for (const fs of node.forkSpawnCalls) {
        if (fs.resolved) relDeps.push(fs.resolved);
      }
      for (const dep of relDeps) {
        if (LOCAL_ONLY_PATH_PATTERNS.some((p) => p.test(dep))) violations.push({ from: file, to: dep });
      }
    }
    assert.deepEqual(violations, [], `cloud file(s) importing local-only file(s): ${JSON.stringify(violations)}`);
  });

  it('Full build still includes every known local-only file — item #7 (regression guard against accidentally excluding local code from FULL, not just Lite)', () => {
    const fullReachable = computeReachable(graph, FULL_ROOTS);
    const localOnlyFiles = graph.files.filter((f) => LOCAL_ONLY_PATH_PATTERNS.some((p) => p.test(f)));
    const missing = localOnlyFiles.filter((f) => !fullReachable.has(f));
    assert.deepEqual(missing, [], `local-only file(s) NOT reachable from Full (should all be reachable): ${JSON.stringify(missing)}`);
  });

  it('Full build still includes every known cloud-only file — item #7', () => {
    const fullReachable = computeReachable(graph, FULL_ROOTS);
    const cloudOnlyFiles = graph.files.filter((f) => CLOUD_ONLY_PATH_PATTERNS.some((p) => p.test(f)));
    const missing = cloudOnlyFiles.filter((f) => !fullReachable.has(f));
    assert.deepEqual(missing, [], `cloud-only file(s) NOT reachable from Full (should all be reachable): ${JSON.stringify(missing)}`);
  });

  it('the six transitional *-lazy.js/*-lazy.lite.js shim files are absent from the graph entirely (Phase 8B Step 8 deleted them outright — git rm, not merely excluded from staging)', () => {
    const formerShimPaths = [
      'src/core/ollama-lazy.js', 'src/core/ollama-lazy.lite.js',
      'src/core/onnx-embed-lazy.js', 'src/core/onnx-embed-lazy.lite.js',
      'src/indexer/phases/tag-onnx-lazy.js', 'src/indexer/phases/tag-onnx-lazy.lite.js',
    ];
    for (const path of formerShimPaths) {
      assert.equal(graph.nodes[path], undefined, `expected ${path} to be absent from the graph`);
    }
  });

  it('admin/jobs/spawn-indexer-full.js\'s and spawn-indexer-lite.js\'s spawn targets resolve to indexer/index-full.js and indexer/index-lite.js respectively — item #8 (regression guard for the process.execPath spawn-shape extraction fix)', () => {
    // Code review, round 4: admin/jobs/registry.js itself no longer
    // contains any spawn() call at all — it accepts an injected
    // spawnIndexer({ args, env }) callback instead (a REQUIRED dependency,
    // no default), specifically so this shared, Lite-staged file never
    // has to name either edition's literal indexer entry path in its own
    // source. The actual node:child_process.spawn() call — and each
    // edition's own literal target — now lives in these two small sibling
    // files. See registry.js's own header comment for the full rationale.
    for (const [file, target] of [
      ['src/admin/jobs/spawn-indexer-full.js', 'src/indexer/index-full.js'],
      ['src/admin/jobs/spawn-indexer-lite.js', 'src/indexer/index-lite.js'],
    ]) {
      const node = graph.nodes[file];
      assert.ok(node, `${file} must exist in the graph`);
      const spawnCalls = node.forkSpawnCalls.filter((c) => c.callee === 'spawn');
      assert.ok(spawnCalls.length > 0, `expected at least one spawn() call in ${file}`);
      assert.ok(
        spawnCalls.some((c) => c.literal && c.resolved === target),
        `expected a spawn() call in ${file} resolving to ${target}, got: ${JSON.stringify(spawnCalls)}`,
      );
    }
    // registry.js itself: confirm the shared file has NO spawn() call of
    // its own anymore.
    const registryNode = graph.nodes['src/shared/admin/jobs/registry.js'];
    assert.ok(registryNode, 'src/shared/admin/jobs/registry.js must exist in the graph');
    const registrySpawnCalls = registryNode.forkSpawnCalls.filter((c) => c.callee === 'spawn');
    assert.deepEqual(registrySpawnCalls, [], 'registry.js must contain zero spawn() calls of its own — spawnIndexer is injected');
  });

  it('core/ce-rerank.js\'s fork target resolves to core/ce-rerank-worker.js — item #8 (regression guard for the join(__dirname, bareFilename) extraction fix)', () => {
    const node = graph.nodes['src/core/ce-rerank.js'];
    assert.ok(node, 'src/core/ce-rerank.js must exist in the graph');
    const forkCalls = node.forkSpawnCalls.filter((c) => c.callee === 'fork');
    assert.ok(forkCalls.length > 0, 'expected at least one fork() call in src/core/ce-rerank.js');
    assert.ok(
      forkCalls.every((c) => c.literal && c.resolved === 'src/core/ce-rerank-worker.js'),
      `expected every fork() call to resolve to src/core/ce-rerank-worker.js, got: ${JSON.stringify(forkCalls)}`,
    );
  });

  it('packages/lite/lite-src/doctor-lite.js\'s real imports resolve into src/, not the gitignored packages/lite/src/ staging mirror — regression guard for the staging-path redirect fix', () => {
    // If this ever regresses (e.g. resolveRelativeSpecifier's staging-
    // prefix redirect is removed), edges would resolve to
    // "packages/lite/src/..." paths that only exist AFTER running
    // build.mjs locally, silently breaking every Lite-reachability
    // computation in a way that only reproduces on a machine that happens
    // to have a stale local build artifact present.
    const node = graph.nodes['packages/lite/lite-src/doctor-lite.js'];
    assert.ok(node, 'packages/lite/lite-src/doctor-lite.js must exist in the graph');
    const relDeps = node.staticImports.filter((r) => r.kind === 'relative').map((r) => r.resolved);
    assert.ok(relDeps.length > 0, 'expected doctor-lite.js to have at least one resolved relative import');
    for (const dep of relDeps) {
      assert.ok(dep.startsWith('src/'), `expected "${dep}" to resolve into src/, not packages/lite/src/ (the gitignored staging mirror)`);
    }
  });

  it('non-literal dynamic import()/require()/fork()/spawn() references match an EXACT, reviewed allow-list — item #9 (no fuzzy count)', () => {
    // Replaces an earlier `nonLiteralCount <= 3` bound (code review
    // finding: a fuzzy upper bound lets new unreviewed non-literal
    // references slip in silently as long as the total stays under the
    // bound). This check is exact in both directions: every ACTUAL
    // non-literal reference in the graph must appear in
    // ALLOWED_NON_LITERAL_REFERENCES, AND every entry in that allow-list
    // must still correspond to a real reference (so a stale allow-list
    // entry for code that was since removed/fixed is caught too).
    const actual = [];
    for (const file of graph.files) {
      const node = graph.nodes[file];
      for (const d of node.dynamicImports) if (!d.literal) actual.push({ file, kind: 'dynamic-import' });
      for (const r of node.requireCalls) if (!r.literal) actual.push({ file, kind: 'require' });
      for (const fs of node.forkSpawnCalls) if (!fs.literal) actual.push({ file, kind: fs.callee });
    }
    const allowedSet = new Set(ALLOWED_NON_LITERAL_REFERENCES.map((a) => `${a.file}::${a.kind}`));
    const actualSet = new Set(actual.map((a) => `${a.file}::${a.kind}`));

    const unreviewed = actual.filter((a) => !allowedSet.has(`${a.file}::${a.kind}`));
    assert.deepEqual(unreviewed, [], `new, unreviewed non-literal reference(s) found — add a reviewed entry to ALLOWED_NON_LITERAL_REFERENCES in this test file if intentional: ${JSON.stringify(unreviewed)}`);

    const stale = ALLOWED_NON_LITERAL_REFERENCES.filter((a) => !actualSet.has(`${a.file}::${a.kind}`));
    assert.deepEqual(stale, [], `stale allow-list entry no longer matches any real non-literal reference (the underlying code may have been fixed/removed) — remove it from ALLOWED_NON_LITERAL_REFERENCES: ${JSON.stringify(stale)}`);
  });
});
