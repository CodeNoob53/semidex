// Phase 7 (docs/design/full-lite-shared-architecture-audit-2026-08-01.md,
// "Phase 7 — Audit and reduce unnecessary Semidex Lite lazy shims"). Proves
// each of the three *-lazy.js/*-lazy.lite.js shim pairs is genuinely
// load-bearing — not kept "just in case" — by showing the EXACT real import
// path from a real Lite entry point to the local-only module the shim cuts
// the edge to, PRE-shim (i.e. what the graph looks like if the substitution
// did not exist), using the same real AST import graph the rest of the
// architecture test suite uses (never regex). See
// docs/design/phase-7-lite-shim-reduction-2026-08-02.md for the full
// per-pair evidence and REMOVE/KEEP/REPLACE_WITH_COMPOSITION_BOUNDARY
// verdicts this test encodes as regression-proof assertions (all three:
// KEEP).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../../../scripts/audit/build-import-graph.mjs';
import { computeReachable, LITE_SRC_DIR, HEAVY_LOCAL_PACKAGES, collectExternalDeps } from '../../../scripts/audit/classify-modules.mjs';
import { LAZY_SHIM_SUBSTITUTIONS } from '../../../packages/lite/lazy-shim-substitutions.mjs';

const graph = buildGraph();
const liteSyntheticRoots = graph.files.filter((f) => f.startsWith(LITE_SRC_DIR));

// Breadth-first search over the SAME edge kinds computeReachable() uses
// (relative static/dynamic imports, require() calls, resolved fork/spawn
// targets) — returns the first shortest real import path from `root` to
// `target`, or null if none exists. Used only to produce a concrete,
// human-checkable path for each KEEP verdict below, not as a second
// reachability mechanism (computeReachable() itself is what the pass/fail
// assertions are based on).
function findImportPath(root, target) {
  const queue = [[root]];
  const seen = new Set([root]);
  while (queue.length) {
    const path = queue.shift();
    const last = path[path.length - 1];
    if (last === target) return path;
    const node = graph.nodes[last];
    if (!node) continue;
    const deps = [];
    for (const group of [node.staticImports, node.dynamicImports, node.requireCalls]) {
      for (const ref of group) if (ref.kind === 'relative' && ref.resolved) deps.push(ref.resolved);
    }
    for (const fs of node.forkSpawnCalls) if (fs.resolved) deps.push(fs.resolved);
    for (const d of deps) {
      if (!seen.has(d)) { seen.add(d); queue.push([...path, d]); }
    }
  }
  return null;
}

describe('LAZY_SHIM_SUBSTITUTIONS — every declared pair is real and matches the shared source of truth', () => {
  it('lazy-shim-substitutions.mjs has exactly the 3 pairs both build.mjs and classify-modules.mjs derive from it', () => {
    assert.deepEqual(
      LAZY_SHIM_SUBSTITUTIONS.map((p) => p.real).sort(),
      ['core/ollama-lazy.js', 'core/onnx-embed-lazy.js', 'indexer/phases/tag-onnx-lazy.js'].sort(),
    );
  });

  it('every real/shim path in the shared list exists as a real graph node', () => {
    for (const { real, shim } of LAZY_SHIM_SUBSTITUTIONS) {
      assert.ok(graph.nodes[`src/${real}`], `expected src/${real} to exist in the graph`);
      assert.ok(graph.nodes[`src/${shim}`], `expected src/${shim} to exist in the graph`);
    }
  });
});

describe('core/ollama-lazy.js shim — KEEP, real dependency path proven', () => {
  const TARGET = 'src/core/ollama.js';

  it('PRE-shim, core/ollama.js IS reachable from Lite roots (proves the shim is load-bearing, not vestigial)', () => {
    const preShim = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: false });
    assert.ok(preShim.has(TARGET), `expected ${TARGET} to be reachable from Lite roots pre-shim — if this fails, the shim may genuinely be removable (re-audit before deleting)`);
  });

  it('POST-shim (the real shipped tarball), core/ollama.js is NOT reachable — the substitution is what cuts the edge', () => {
    const postShim = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: true });
    assert.ok(!postShim.has(TARGET), `expected ${TARGET} to be UNREACHABLE from Lite roots post-shim`);
  });

  it('a concrete real import path exists from serve-lite.js to ollama.js pre-shim: serve-lite.js -> jobs/registry.js (spawn) -> indexer/index.js -> run.js -> ollama-lazy.js -> ollama.js', () => {
    const path = findImportPath('packages/lite/lite-src/serve-lite.js', TARGET);
    assert.deepEqual(path, [
      'packages/lite/lite-src/serve-lite.js',
      'src/admin/jobs/registry.js',
      'src/indexer/index.js',
      'src/indexer/run.js',
      'src/core/ollama-lazy.js',
      'src/core/ollama.js',
    ]);
  });

  it('8 real Lite-reachable consumers still import ollama-lazy.js (the shim protects a genuinely wide surface, not one dead edge)', () => {
    const importers = [];
    for (const f of graph.files) {
      const node = graph.nodes[f];
      for (const group of [node.staticImports, node.dynamicImports, node.requireCalls]) {
        for (const ref of group) if (ref.kind === 'relative' && ref.resolved === 'src/core/ollama-lazy.js') importers.push(f);
      }
    }
    const postShim = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: true });
    const liteReachableImporters = importers.filter((f) => postShim.has(f));
    assert.ok(liteReachableImporters.length >= 8, `expected at least 8 Lite-reachable importers of ollama-lazy.js, found ${liteReachableImporters.length}: ${JSON.stringify(liteReachableImporters)}`);
  });
});

describe('core/onnx-embed-lazy.js shim — KEEP, real dependency path proven (two independent surfaces: indexing AND search)', () => {
  const ONNX_EMBED = 'src/core/onnx-embed.js';
  const LENGTH_BUCKET = 'src/core/length-bucket.js';

  it('PRE-shim, both onnx-embed.js and length-bucket.js are reachable from Lite roots', () => {
    const preShim = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: false });
    assert.ok(preShim.has(ONNX_EMBED), `expected ${ONNX_EMBED} to be reachable pre-shim`);
    assert.ok(preShim.has(LENGTH_BUCKET), `expected ${LENGTH_BUCKET} to be reachable pre-shim`);
  });

  it('POST-shim, neither is reachable', () => {
    const postShim = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: true });
    assert.ok(!postShim.has(ONNX_EMBED));
    assert.ok(!postShim.has(LENGTH_BUCKET));
  });

  it('the indexing path: serve-lite.js -> jobs/registry.js (spawn) -> run.js -> embeddings.js -> onnx-embed-lazy.js -> onnx-embed.js', () => {
    const path = findImportPath('packages/lite/lite-src/serve-lite.js', ONNX_EMBED);
    assert.deepEqual(path, [
      'packages/lite/lite-src/serve-lite.js',
      'src/admin/jobs/registry.js',
      'src/indexer/index.js',
      'src/indexer/run.js',
      'src/core/embeddings.js',
      'src/core/onnx-embed-lazy.js',
      'src/core/onnx-embed.js',
    ]);
  });

  it('the SEARCH path (independent of indexing): admin/register-neutral-routes.js -> api/search.js -> embeddings.js -> onnx-embed-lazy.js — proves this shim protects search/Ask, not only the indexing job spawn chain', () => {
    const path = findImportPath('src/admin/register-neutral-routes.js', 'src/core/onnx-embed-lazy.js');
    assert.deepEqual(path, [
      'src/admin/register-neutral-routes.js',
      'src/admin/api/search.js',
      'src/core/embeddings.js',
      'src/core/onnx-embed-lazy.js',
    ]);
  });

  it('onnx-embed.js statically imports @huggingface/tokenizers directly, and (via onnx-runtime.js) dynamically resolves onnxruntime-node — both stay off the Lite closure only because this shim cuts the file-level edge', () => {
    const node = graph.nodes[ONNX_EMBED];
    const pkgSpecifiers = node.staticImports.filter((r) => r.kind === 'package').map((r) => r.resolved);
    assert.ok(pkgSpecifiers.includes('@huggingface/tokenizers'), `expected onnx-embed.js to statically import @huggingface/tokenizers, got: ${JSON.stringify(pkgSpecifiers)}`);
    const runtimeNode = graph.nodes['src/core/onnx-runtime.js'];
    assert.ok(runtimeNode, 'expected src/core/onnx-runtime.js to exist in the graph');
    const hasNonLiteralRequire = runtimeNode.requireCalls.some((r) => !r.literal);
    assert.ok(hasNonLiteralRequire, 'expected onnx-runtime.js to have a non-literal require() (its runtime resolution of onnxruntime-node/a custom ORT path)');
  });
});

describe('indexer/phases/tag-onnx-lazy.js shim — KEEP, real dependency path proven (only path to @huggingface/transformers)', () => {
  const TAG_ONNX = 'src/indexer/phases/tag-onnx.js';
  const TAG_ONNX_WORKER = 'src/indexer/workers/tag-onnx-worker.js';

  it('PRE-shim, both tag-onnx.js and its fork()ed worker are reachable from Lite roots', () => {
    const preShim = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: false });
    assert.ok(preShim.has(TAG_ONNX), `expected ${TAG_ONNX} to be reachable pre-shim`);
    assert.ok(preShim.has(TAG_ONNX_WORKER), `expected ${TAG_ONNX_WORKER} to be reachable pre-shim`);
  });

  it('POST-shim, neither is reachable', () => {
    const postShim = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: true });
    assert.ok(!postShim.has(TAG_ONNX));
    assert.ok(!postShim.has(TAG_ONNX_WORKER));
  });

  it('the real path: serve-lite.js -> jobs/registry.js (spawn) -> run.js -> tag-onnx-lazy.js -> tag-onnx.js -> (fork) -> tag-onnx-worker.js', () => {
    const path = findImportPath('packages/lite/lite-src/serve-lite.js', TAG_ONNX_WORKER);
    assert.deepEqual(path, [
      'packages/lite/lite-src/serve-lite.js',
      'src/admin/jobs/registry.js',
      'src/indexer/index.js',
      'src/indexer/run.js',
      'src/indexer/phases/tag-onnx-lazy.js',
      'src/indexer/phases/tag-onnx.js',
      'src/indexer/workers/tag-onnx-worker.js',
    ]);
  });

  it('tag-onnx-worker.js is the ONLY reachable-from-Full path to @huggingface/transformers, and it is reachable from Lite ONLY pre-shim — this is the single edge the whole heavy-package guarantee depends on', () => {
    const preShim = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: false });
    const preShimDeps = collectExternalDeps(graph, preShim);
    assert.ok(preShimDeps.has('@huggingface/transformers'), 'expected @huggingface/transformers to be reachable pre-shim (via tag-onnx-worker.js)');
    assert.deepEqual([...preShimDeps.get('@huggingface/transformers')], [TAG_ONNX_WORKER]);

    const postShim = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: true });
    const postShimDeps = collectExternalDeps(graph, postShim);
    assert.ok(!postShimDeps.has('@huggingface/transformers'), '@huggingface/transformers must be unreachable post-shim');
  });
});

describe('no other local-only module needs a NEW shim (composition-boundary exclusions already suffice — confirms Phase 7 found zero REPLACE_WITH_COMPOSITION_BOUNDARY candidates)', () => {
  it('core/ce-rerank.js / core/ce-rerank-worker.js stay unreachable from Lite with no shim of their own (excluded outright, zero importers among kept files)', () => {
    const postShim = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: true });
    assert.ok(!postShim.has('src/core/ce-rerank.js'));
    assert.ok(!postShim.has('src/core/ce-rerank-worker.js'));
  });

  it('core/onnx-provider-probe.js / core/onnx-probe-runner.js / admin/api/onnx.js stay unreachable from Lite with no shim of their own (the composition boundary — admin/composition/lite.js never registers onnx.js\'s routes — already suffices)', () => {
    const postShim = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: true });
    for (const f of ['src/core/onnx-provider-probe.js', 'src/core/onnx-probe-runner.js', 'src/admin/api/onnx.js']) {
      assert.ok(!postShim.has(f), `expected ${f} to be unreachable from Lite`);
    }
  });
});
