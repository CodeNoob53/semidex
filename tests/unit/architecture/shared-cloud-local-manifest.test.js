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
  it('has no current violations or shared-to-cloud edges', () => {
    assert.deepEqual(findDirectionViolations(), []);
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

describe('mixed provider seams', () => {
  it('keeps known lazy shims and provider-coupled orchestration mixed', () => {
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
      'src/core/embeddings.js',
      'src/core/retrieval/search.js',
      'src/core/token-count.js',
      'src/indexer/run.js',
    ];
    assert.deepEqual(required.filter((path) => !mixed.has(path)), []);
  });

  it('keeps real lazy shims connected to local implementations', () => {
    const byPath = new Map(loadManifest().modules.map((module) => [module.path, module]));
    const pairs = {
      'src/core/ollama-lazy.js': 'src/core/ollama.js',
      'src/core/onnx-embed-lazy.js': 'src/core/onnx-embed.js',
      'src/indexer/phases/tag-onnx-lazy.js': 'src/indexer/phases/tag-onnx.js',
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

  it('distinguishes neutral tools from provider-coupled tools', () => {
    const byPath = new Map(loadManifest().modules.map((module) => [module.path, module]));
    assert.equal(byPath.get('src/mcp/tools/getChunk.js')?.category, 'shared');
    assert.equal(byPath.get('src/mcp/tools/collections.js')?.category, 'mixed');
    assert.equal(byPath.get('src/mcp/tools/search.js')?.category, 'mixed');
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
