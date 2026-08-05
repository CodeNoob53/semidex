// Code review, round 4 — this file used to prove and PIN each of the three
// *-lazy.js/*-lazy.lite.js shim pairs as KEEP: it showed a concrete real
// import path from a Lite entry point to core/ollama.js/core/onnx-embed.js/
// indexer/phases/tag-onnx.js, PRE-shim, and confirmed build.mjs's own
// substituteLazyShims() content-substitution was the ONE thing cutting
// that edge for the real shipped tarball.
//
// The review's own instruction: "it must no longer assert/pin KEEP, but
// instead prove the ABSENCE of Lite -> local-runtime edges." Per that
// directive (and a full follow-up migration, not just a narrower fix):
//   - indexer/index.js was split into index-full.js (Full-only, real
//     capabilities, excluded from the Lite package) and index-lite.js
//     (Lite's own entry point, typed-unavailable capabilities, imports
//     NONE of the three real *-lazy.js modules).
//   - core/embeddings.js, indexer/run.js, the four phase modules
//     (context.js/tag.js/combined.js/skeleton-summary.js),
//     indexer/preflight.js, and core/generation/ollama-provider.js were
//     all migrated off their own module-scope real-*-lazy.js default —
//     each now starts with an UNSET (null) capability, populated only by
//     an explicit applyXCapability()/applyAllCapabilities() call from a
//     composition root.
//   - admin/jobs/registry.js (shared, staged for Lite) no longer contains
//     any spawn() call of its own — it accepts an injected `spawnIndexer`
//     callback with NO default; the actual node:child_process.spawn()
//     call, and each edition's own literal entry-file path, live in two
//     small sibling files (spawn-indexer-full.js / spawn-indexer-lite.js).
//
// The result: packages/lite/build.mjs's substituteLazyShims() step was
// removed ENTIRELY (no *-lazy.js content substitution happens at build
// time anymore — see that file's own header comment) — core/ollama-lazy.js,
// core/onnx-embed-lazy.js, and indexer/phases/tag-onnx-lazy.js are simply
// EXCLUDED from the Lite package outright, the same as any other
// local-only file, because nothing in the Lite-staged closure imports them
// at all, PRE-shim or POST-shim — both numbers are now identical and zero.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../../../scripts/audit/build-import-graph.mjs';
import { computeReachable, LITE_SRC_DIR } from '../../../scripts/audit/classify-modules.mjs';

const graph = buildGraph();
const liteSyntheticRoots = graph.files.filter((f) => f.startsWith(LITE_SRC_DIR));

const REAL_LAZY_MODULES = [
  'src/core/ollama-lazy.js',
  'src/core/onnx-embed-lazy.js',
  'src/indexer/phases/tag-onnx-lazy.js',
];

const LOCAL_RUNTIME_TARGETS = [
  'src/core/ollama.js',
  'src/core/onnx-embed.js',
  'src/indexer/phases/tag-onnx.js',
  'src/indexer/workers/tag-onnx-worker.js',
  'src/core/onnx-runtime.js',
  'src/core/length-bucket.js',
];

describe('Lite -> local-runtime edges are structurally ABSENT (code review, round 4 — no build-time shim substitution needed)', () => {
  it('none of the three real *-lazy.js modules are reachable from Lite roots, PRE-shim (applyLiteShims: false) — the strongest possible claim: even without any build-time substitution, the static graph never reaches them', () => {
    const reachable = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: false });
    const leaked = REAL_LAZY_MODULES.filter((m) => reachable.has(m));
    assert.deepEqual(leaked, [], `expected zero real *-lazy.js modules reachable from Lite, found: ${JSON.stringify(leaked)}`);
  });

  it('none of the local-runtime targets those *-lazy.js modules would have led to (core/ollama.js, core/onnx-embed.js, indexer/phases/tag-onnx.js and its worker) are reachable from Lite roots either, PRE-shim', () => {
    const reachable = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: false });
    const leaked = LOCAL_RUNTIME_TARGETS.filter((m) => reachable.has(m));
    assert.deepEqual(leaked, [], `expected zero local-runtime targets reachable from Lite, found: ${JSON.stringify(leaked)}`);
  });

  it('POST-shim (applyLiteShims: true) reachability is IDENTICAL to pre-shim — there is nothing left for a shim substitution to do', () => {
    const preShim = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: false });
    const postShim = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: true });
    assert.deepEqual([...preShim].sort(), [...postShim].sort());
  });

  it('packages/lite/build.mjs no longer exports or calls substituteLazyShims() — the mechanism was removed, not merely made a no-op', async () => {
    const { readFileSync } = await import('node:fs');
    const buildSrc = readFileSync(new URL('../../../packages/lite/build.mjs', import.meta.url), 'utf-8');
    // Doesn't grep for the bare identifier — this file's own header/
    // EXCLUDE_FILES comments legitimately mention substituteLazyShims() in
    // prose explaining why it was removed. What must be absent is the
    // actual function DECLARATION or a real (non-comment) CALL.
    assert.doesNotMatch(buildSrc, /^function substituteLazyShims/m);
    assert.doesNotMatch(buildSrc, /(?<!\/\/[^\n]*)\bsubstituteLazyShims\(\);/);
    assert.doesNotMatch(buildSrc, /export \{[^}]*\bsubstituteLazyShims\b/);
  });

  it('all three real *-lazy.js modules (and their *-lazy.lite.js siblings) are listed in build.mjs\'s own EXCLUDE_FILES — excluded outright, like any other local-only file, not content-substituted', async () => {
    const { readFileSync } = await import('node:fs');
    const buildSrc = readFileSync(new URL('../../../packages/lite/build.mjs', import.meta.url), 'utf-8');
    for (const rel of [
      'core/ollama-lazy.js', 'core/ollama-lazy.lite.js',
      'core/onnx-embed-lazy.js', 'core/onnx-embed-lazy.lite.js',
      'indexer/phases/tag-onnx-lazy.js', 'indexer/phases/tag-onnx-lazy.lite.js',
    ]) {
      assert.match(buildSrc, new RegExp(`['"]${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`), `expected '${rel}' in build.mjs's EXCLUDE_FILES`);
    }
  });
});

describe('index-full.js (Full-only) is the ONE file that still statically/dynamically imports the three real *-lazy.js modules — and it is excluded from the Lite package', () => {
  it('indexer/index-full.js imports all three real *-lazy.js modules', () => {
    for (const target of REAL_LAZY_MODULES) {
      const importers = [];
      for (const f of graph.files) {
        const node = graph.nodes[f];
        for (const group of [node.staticImports, node.dynamicImports, node.requireCalls]) {
          for (const ref of group) if (ref.kind === 'relative' && ref.resolved === target) importers.push(f);
        }
      }
      assert.ok(importers.includes('src/indexer/index-full.js'), `expected src/indexer/index-full.js to import ${target}, importers: ${JSON.stringify(importers)}`);
    }
  });

  it('indexer/index-full.js is unreachable from Lite roots — it is Full\'s own entry point, excluded from the Lite package (see build.mjs EXCLUDE_FILES)', () => {
    const reachable = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: false });
    assert.ok(!reachable.has('src/indexer/index-full.js'));
  });

  it('indexer/index-lite.js — Lite\'s own real entry point — imports NONE of the three real *-lazy.js modules', () => {
    const node = graph.nodes['src/indexer/index-lite.js'];
    assert.ok(node, 'expected src/indexer/index-lite.js to exist in the graph');
    for (const group of [node.staticImports, node.dynamicImports, node.requireCalls]) {
      for (const ref of group) {
        assert.ok(!REAL_LAZY_MODULES.includes(ref.resolved), `index-lite.js must not import ${ref.resolved}`);
      }
    }
  });
});

describe('every OTHER former real-*-lazy.js consumer (core/embeddings.js, the phase modules, preflight.js, run.js, ollama-provider.js) no longer imports any of the three modules either', () => {
  const FORMER_CONSUMERS = [
    'src/core/embeddings.js',
    'src/indexer/run.js',
    'src/indexer/phases/context.js',
    'src/indexer/phases/tag.js',
    'src/indexer/phases/combined.js',
    'src/indexer/phases/skeleton-summary.js',
    'src/indexer/preflight.js',
    'src/core/generation/ollama-provider.js',
  ];

  it('none of these files have a resolved relative edge onto any of the three real *-lazy.js modules', () => {
    for (const file of FORMER_CONSUMERS) {
      const node = graph.nodes[file];
      assert.ok(node, `expected ${file} to exist in the graph`);
      const leaked = [];
      for (const group of [node.staticImports, node.dynamicImports, node.requireCalls]) {
        for (const ref of group) {
          if (ref.kind === 'relative' && REAL_LAZY_MODULES.includes(ref.resolved)) leaked.push(ref.resolved);
        }
      }
      assert.deepEqual(leaked, [], `expected ${file} to import none of the three real *-lazy.js modules, found: ${JSON.stringify(leaked)}`);
    }
  });
});

describe('no other local-only module needs a shim of its own (composition-boundary exclusions already suffice)', () => {
  it('core/ce-rerank.js / core/ce-rerank-worker.js stay unreachable from Lite (excluded outright, zero importers among kept files)', () => {
    const reachable = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: true });
    assert.ok(!reachable.has('src/core/ce-rerank.js'));
    assert.ok(!reachable.has('src/core/ce-rerank-worker.js'));
  });

  it('core/onnx-provider-probe.js / core/onnx-probe-runner.js / admin/api/onnx.js stay unreachable from Lite (the composition boundary — admin/composition/lite.js never registers onnx.js\'s routes — already suffices)', () => {
    const reachable = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: true });
    for (const f of ['src/core/onnx-provider-probe.js', 'src/core/onnx-probe-runner.js', 'src/admin/api/onnx.js']) {
      assert.ok(!reachable.has(f), `expected ${f} to be unreachable from Lite`);
    }
  });
});
