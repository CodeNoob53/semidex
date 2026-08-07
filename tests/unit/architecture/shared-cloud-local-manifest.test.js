import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildManifest } from '../../../scripts/audit/build-shared-cloud-local-manifest.mjs';
import {
  DIRECTION_RULES,
  findDirectionViolations,
  findSharedToCloudEdges,
  loadManifest,
  main as runViolationsCli,
} from '../../../scripts/audit/find-dependency-violations.mjs';

const MANIFEST_PATH = join(process.cwd(), 'scripts', 'audit', 'full-lite-module-classification.json');
const VALID_CATEGORIES = ['shared', 'cloud', 'local', 'composition', 'tooling', 'mixed', 'unclassified'];

describe('shared/cloud/local manifest drift protection', () => {
  it('matches a freshly generated manifest byte-for-byte', () => {
    const committed = readFileSync(MANIFEST_PATH, 'utf-8');
    assert.equal(JSON.stringify(buildManifest(), null, 2) + '\n', committed);
  });

  it('contains every production module once with a valid category', () => {
    const manifest = loadManifest();
    const paths = manifest.modules.map((module) => module.path);
    assert.deepEqual(paths.filter((path, index) => paths.indexOf(path) !== index), []);
    assert.deepEqual(manifest.modules.filter((module) => !VALID_CATEGORIES.includes(module.category)), []);
    assert.ok(manifest.modules.length > 200);
  });

  it('contains no unclassified production modules', () => {
    assert.deepEqual(loadManifest().modules.filter((module) => module.category === 'unclassified'), []);
  });

  it('reports accurate category counts', () => {
    const manifest = loadManifest();
    const counts = manifest.modules.reduce((result, module) => {
      result[module.category] = (result[module.category] ?? 0) + 1;
      return result;
    }, {});
    assert.deepEqual(manifest.counts, counts);
  });
});

describe('dependency direction rules', () => {
  // Code review fix (Phase 8B Step 6, second pass): findDirectionViolations()
  // now reads each module's declaredCategory (fixed at classification time),
  // not the propagation-refined category the manifest builder used to
  // overwrite in place — the old shape meant a real shared->cloud edge
  // silently relabeled its OWN source module 'mixed' before this check ever
  // ran, so "0 violations" proved nothing.
  //
  // Third pass: this test previously carried a KNOWN_SHARED_TO_LOCAL_EXCEPTIONS
  // allow-list for three real violations (src/mcp/tools/collections.js ->
  // local/core/ollama.js; src/mcp/tools/search.js -> core/ce-rerank.js,
  // core/rerank.js) — real local-runtime coupling in two MCP tool files
  // that were declared 'shared'. Fixed properly, not allow-listed: both
  // files now take their local-coupled operations (Ollama discovery, CE
  // reranking) as injected capabilities (core/generation/
  // ollama-capability.js's OllamaDiscoveryCapability, the new
  // core/rerank-capability.js's RerankCapability) supplied by
  // src/mcp/server.js at startup — see collections.js's setOllamaDiscovery()
  // and search.js's setRerank(). Neither file imports local/core/ollama.js,
  // core/ce-rerank.js, or core/rerank.js directly anymore. The allow-list
  // is gone; both checks below are now unconditional.
  it('has zero dependency-direction violations', () => {
    assert.deepEqual(findDirectionViolations(), []);
  });

  it('has zero shared->cloud edges — the boundary this task enforces', () => {
    assert.deepEqual(findSharedToCloudEdges(), []);
  });

  for (const [fromCategory, toCategory] of [
    ['shared', 'cloud'],
    ['shared', 'local'],
    ['shared', 'composition'],
    ['cloud', 'local'],
    ['local', 'cloud'],
  ]) {
    it(`rejects ${fromCategory}->${toCategory}`, () => {
      const manifest = { modules: [
        { path: 'src/fake/from.js', category: fromCategory, directDependencies: ['src/fake/to.js'] },
        { path: 'src/fake/to.js', category: toCategory, directDependencies: [] },
      ] };
      assert.deepEqual(findDirectionViolations(manifest), [
        { type: `${fromCategory}_to_${toCategory}`, from: 'src/fake/from.js', to: 'src/fake/to.js' },
      ]);
    });
  }

  it('allows shared->shared', () => {
    const manifest = { modules: [
      { path: 'src/fake/from.js', category: 'shared', directDependencies: ['src/fake/to.js'] },
      { path: 'src/fake/to.js', category: 'shared', directDependencies: [] },
    ] };
    assert.deepEqual(findDirectionViolations(manifest), []);
    assert.ok(DIRECTION_RULES.shared.has('cloud'));
  });
});

describe('find-dependency-violations.mjs CLI — exit code (code review fix, third pass)', () => {
  // P1 fix: this script previously only printed counts and never set
  // process.exitCode — a real, unjustified violation still exited 0, so
  // CI (or any script chaining `&&` after this one) treated a genuine
  // architectural violation as success. main() is now exported precisely
  // so this contract is testable directly, without spawning a real
  // subprocess or mutating the on-disk manifest file.
  const originalExitCode = process.exitCode;
  function withRestoredExitCode(fn) {
    process.exitCode = undefined;
    try { fn(); } finally { process.exitCode = originalExitCode; }
  }

  it('sets process.exitCode = 1 when a real dependency-direction violation exists', () => {
    withRestoredExitCode(() => {
      const manifest = { modules: [
        { path: 'src/fake/from.js', declaredCategory: 'shared', directDependencies: ['src/fake/to.js'] },
        { path: 'src/fake/to.js', declaredCategory: 'cloud', directDependencies: [] },
      ] };
      runViolationsCli(manifest);
      assert.equal(process.exitCode, 1);
    });
  });

  it('sets process.exitCode = 1 when a shared->cloud edge exists even without a DIRECTION_RULES violation', () => {
    // findSharedToCloudEdges() and findDirectionViolations() are two
    // independent checks (see main()'s own body) — this proves the exit
    // code responds to EITHER one, not just the first.
    withRestoredExitCode(() => {
      const manifest = { modules: [
        { path: 'src/fake/shared.js', declaredCategory: 'shared', directDependencies: ['src/fake/cloud.js'] },
        { path: 'src/fake/cloud.js', declaredCategory: 'cloud', directDependencies: [] },
      ] };
      runViolationsCli(manifest);
      assert.equal(process.exitCode, 1);
    });
  });

  it('leaves process.exitCode unset (success) when the manifest has zero violations', () => {
    withRestoredExitCode(() => {
      const manifest = { modules: [
        { path: 'src/fake/a.js', declaredCategory: 'shared', directDependencies: ['src/fake/b.js'] },
        { path: 'src/fake/b.js', declaredCategory: 'shared', directDependencies: [] },
      ] };
      runViolationsCli(manifest);
      assert.equal(process.exitCode, undefined);
    });
  });

  it('the real, current on-disk manifest produces exitCode undefined (genuinely clean, not just an empty test fixture)', () => {
    withRestoredExitCode(() => {
      runViolationsCli();
      assert.equal(process.exitCode, undefined);
    });
  });
});

describe('mixed provider seams', () => {
  it('keeps known lazy shims mixed', () => {
    // Code review fix (Phase 8B Step 6, second pass): embeddings.js,
    // search.js, token-count.js, and run.js used to be listed here as
    // "provider-coupled orchestration" that stays mixed — but that state
    // was exactly the bug the review flagged: each imported a concrete
    // src/cloud/ implementation directly. All four are now genuinely
    // 'shared' (capability/DI-only, zero direct cloud imports — a
    // composition root injects the real cloudEmbed/cloudGeneration
    // capability). Only the real *-lazy.js shims (the actual local/cloud
    // boundary seam, by design) remain mixed.
    const mixed = new Set(loadManifest().modules
      .filter((module) => module.category === 'mixed')
      .map((module) => module.path));
    const required = [
      'src/core/ollama-lazy.js',
      'src/core/ollama-lazy.lite.js',
      'src/core/onnx-embed-lazy.js',
      'src/core/onnx-embed-lazy.lite.js',
      'src/indexer/phases/tag-onnx-lazy.js',
      'src/indexer/phases/tag-onnx-lazy.lite.js',
    ];
    assert.deepEqual(required.filter((path) => !mixed.has(path)), []);
  });

  it('code review fix (Phase 8B Step 6): embeddings.js, search.js, token-count.js, run.js, registry.js, register-neutral-routes.js are now genuinely shared/composition — no direct cloud implementation import remains', () => {
    const byPath = new Map(loadManifest().modules.map((module) => [module.path, module]));
    assert.equal(byPath.get('src/shared/core/embeddings.js')?.category, 'shared');
    assert.equal(byPath.get('src/core/retrieval/search.js')?.category, 'shared');
    assert.equal(byPath.get('src/shared/core/token-count.js')?.category, 'shared');
    assert.equal(byPath.get('src/shared/indexer/run.js')?.category, 'shared');
    assert.equal(byPath.get('src/core/generation/registry.js')?.category, 'shared');
    assert.equal(byPath.get('src/shared/admin/register-neutral-routes.js')?.category, 'composition');
  });

  it('keeps real lazy shims connected to local implementations', () => {
    const byPath = new Map(loadManifest().modules.map((module) => [module.path, module]));
    const pairs = {
      'src/core/ollama-lazy.js': 'src/local/core/ollama.js',
      'src/core/onnx-embed-lazy.js': 'src/local/core/onnx-embed.js',
      'src/indexer/phases/tag-onnx-lazy.js': 'src/local/indexer/phases/tag-onnx.js',
    };
    for (const [shim, target] of Object.entries(pairs)) {
      assert.ok(byPath.get(shim).directDependencies.includes(target));
      assert.equal(byPath.get(target).category, 'local');
    }
  });
});

describe('MCP product surface classification', () => {
  it('uses composition for the server and never tooling for MCP modules', () => {
    const modules = loadManifest().modules.filter((module) => module.path.startsWith('src/mcp/'));
    assert.equal(modules.find((module) => module.path === 'src/mcp/server.js')?.category, 'composition');
    assert.deepEqual(modules.filter((module) => module.category === 'tooling'), []);
  });

  it('code review fix (Phase 8B Step 6, third pass): collections.js and search.js are now genuinely shared — real capability injection, not direct local imports', () => {
    // Previously 'mixed' (real direct imports of local/core/ollama.js,
    // core/ce-rerank.js, core/rerank.js) — both now take their
    // local-coupled operations as injected capabilities from
    // src/mcp/server.js (see the "dependency direction rules" describe
    // block above for the full story).
    const byPath = new Map(loadManifest().modules.map((module) => [module.path, module]));
    assert.equal(byPath.get('src/mcp/tools/getChunk.js')?.category, 'shared');
    assert.equal(byPath.get('src/mcp/tools/collections.js')?.category, 'shared');
    assert.equal(byPath.get('src/mcp/tools/search.js')?.category, 'shared');
  });
});

describe('runtime closure guards', () => {
  it('keeps heavy local packages out of Lite reachability', async () => {
    const { buildGraph } = await import('../../../scripts/audit/build-import-graph.mjs');
    const { computeReachable, collectExternalDeps, HEAVY_LOCAL_PACKAGES, LITE_SRC_DIR, LITE_UI_ENTRY } = await import('../../../scripts/audit/classify-modules.mjs');
    const graph = buildGraph();
    const roots = [...graph.files.filter((file) => file.startsWith(LITE_SRC_DIR)), LITE_UI_ENTRY];
    const dependencies = collectExternalDeps(graph, computeReachable(graph, roots, { applyLiteShims: true }));
    assert.deepEqual(HEAVY_LOCAL_PACKAGES.filter((name) => dependencies.has(name)), []);
  });

  it('tracks the real Full and Lite UI entries', async () => {
    const { buildGraph } = await import('../../../scripts/audit/build-import-graph.mjs');
    const { FULL_ROOTS, LITE_UI_ENTRY } = await import('../../../scripts/audit/classify-modules.mjs');
    const graph = buildGraph();
    assert.ok(FULL_ROOTS.includes('src/admin/ui-src/entries/full.js'));
    assert.equal(LITE_UI_ENTRY, 'src/admin/ui-src/entries/lite.js');
    assert.ok(graph.nodes['src/admin/ui-src/entries/full.js']);
    assert.ok(graph.nodes['src/admin/ui-src/entries/lite.js']);
  });
});
