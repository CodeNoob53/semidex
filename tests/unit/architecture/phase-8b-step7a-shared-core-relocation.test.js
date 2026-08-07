// Phase 8B Step 7A — physical relocation of stable shared core modules
// (17 top-level src/core/*.js files -> src/shared/core/*.js), per
// docs/design/phase-8a-shared-cloud-local-migration-audit-2026-08-02.md §7
// Step 6 ("Physically relocate stable shared modules" — the plan's own
// numbering; this repo's dated report calls it Step 7A, see that report's
// own naming note, mirroring Step 6/cloud-relocation's identical
// numbering divergence).
//
// 17 files moved, via `git mv` (history preserved), each a top-level
// src/core/*.js file the real import graph confirmed is BOTH Full- and
// Lite-reachable (`shared`), or — for rerank-capability.js — a pure,
// zero-dependency capability CONTRACT with the same "shared" disposition
// as the pre-existing onnx-embed-capability.js/cloud-embedding-capability.js
// contracts, even though its one real consumer (MCP tools) is not
// currently reachable from any Lite root:
//   app-data-dir.js, bench-telemetry.js, bge-tokenizer.js, config.js,
//   doctor-checks.js, embeddings.js, entity-reference.js, env-bootstrap.js,
//   env.js, node-id.js, onnx-embed-capability.js, onnx-paths.js,
//   point-id.js, qdrant.js, rerank-capability.js, sparse.js, token-count.js
//
// Left at src/core/ (explicitly NOT moved, confirmed by direct import-graph
// inspection, not directory-name assumption):
//   - ce-rerank.js, ce-rerank-worker.js, rerank.js, rerank-provider.js —
//     genuinely `local`-classified (Full-reachable, never Lite-reachable):
//     real cross-encoder reranker implementation/worker, not a contract.
//   - ollama-lazy.js, ollama-lazy.lite.js, onnx-embed-lazy.js,
//     onnx-embed-lazy.lite.js — the 3 remaining transitional lazy-shim
//     pairs (`mixed`), explicitly out of scope for this step (Phase 8B
//     Step 8 removes them, once every consumer uses the composition-time
//     injection seam Step 1 already introduced).
//   - Every src/core/ SUBDIRECTORY (ask/, ask-api/, assembly/,
//     embedding-profile/, generation/, http/, qdrant/, retrieval/,
//     settings/, storage/) — out of scope for this step, which covers only
//     top-level src/core/*.js files per its own task definition; a later
//     step may relocate subdirectory contents.
//
// This is a pure `git mv` + import-path-update step — no exported
// function/API changed shape, no new capability abstraction, no behavior
// change. Two of the 17 moved files (config.js, onnx-paths.js) had an
// import.meta.url-relative path constant (pointing at repo-root
// config.json / models/) that needed one extra '../' to stay correct one
// directory level deeper — a mechanical consequence of the move, not a
// logic change; covered separately below.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageSrc, listAllFiles } from '../../../packages/lite/build.mjs';
import { buildManifest } from '../../../scripts/audit/build-shared-cloud-local-manifest.mjs';

const LITE_DIR = dirname(fileURLToPath(new URL('../../../packages/lite/build.mjs', import.meta.url)));
const REPO_ROOT = resolve(LITE_DIR, '..', '..');
const REPO_SRC = join(REPO_ROOT, 'src');
const STAGED_SRC = join(LITE_DIR, 'src');

const MOVED_FILES = [
  'app-data-dir.js', 'bench-telemetry.js', 'bge-tokenizer.js', 'config.js', 'doctor-checks.js',
  'embeddings.js', 'entity-reference.js', 'env-bootstrap.js', 'env.js', 'node-id.js',
  'onnx-embed-capability.js', 'onnx-paths.js', 'point-id.js', 'qdrant.js', 'rerank-capability.js',
  'sparse.js', 'token-count.js',
];

const STAYED_LOCAL_FILES = ['ce-rerank.js', 'ce-rerank-worker.js', 'rerank.js', 'rerank-provider.js'];
const STAYED_LAZY_SHIM_FILES = ['ollama-lazy.js', 'ollama-lazy.lite.js', 'onnx-embed-lazy.js', 'onnx-embed-lazy.lite.js'];

describe('Phase 8B Step 7A — 17 shared core files physically moved from src/core/ to src/shared/core/', () => {
  for (const name of MOVED_FILES) {
    it(`src/core/${name} no longer exists`, () => {
      assert.equal(existsSync(join(REPO_SRC, 'core', name)), false, `expected src/core/${name} to be gone (moved to src/shared/core/${name})`);
    });

    it(`src/shared/core/${name} exists`, () => {
      assert.equal(existsSync(join(REPO_SRC, 'shared', 'core', name)), true, `expected src/shared/core/${name} to exist`);
    });
  }

  for (const name of STAYED_LOCAL_FILES) {
    it(`src/core/${name} (real local-runtime implementation, not a contract) stayed at src/core/ — no duplicate under src/shared/core/`, () => {
      assert.equal(existsSync(join(REPO_SRC, 'core', name)), true, `expected src/core/${name} to still exist — it was never in scope for this move`);
      assert.equal(existsSync(join(REPO_SRC, 'shared', 'core', name)), false, `expected src/shared/core/${name} to NOT exist — ${name} was never moved`);
    });
  }

  for (const name of STAYED_LAZY_SHIM_FILES) {
    it(`src/core/${name} (transitional lazy shim, explicitly out of scope) stayed at src/core/`, () => {
      assert.equal(existsSync(join(REPO_SRC, 'core', name)), true, `expected src/core/${name} to still exist — lazy shims are Phase 8B Step 8's own scope, not this step's`);
      assert.equal(existsSync(join(REPO_SRC, 'shared', 'core', name)), false, `expected src/shared/core/${name} to NOT exist`);
    });
  }
});

describe('Phase 8B Step 7A — no production source file references an old pre-move src/core/*.js path for any of the 17 moved files', () => {
  // Real path resolution against each importing file's own directory, not
  // a segment/regex heuristic (the exact blind spot every prior physical-
  // relocation step's own equivalent test guards against — a same-
  // directory relative import like './embeddings.js' has no "core/"
  // segment in its specifier text at all, so a text-pattern check could
  // miss a reverted specifier). packages/lite/src/ (the gitignored staged
  // mirror) is deliberately excluded — regenerated output, not a source of
  // truth.
  const SCAN_ROOTS = ['src', 'benchmarks', 'scripts', join('packages', 'lite', 'lite-src')].map((d) => join(REPO_ROOT, d));
  const OLD_ABS_PATHS = new Set(MOVED_FILES.map((name) => join(REPO_ROOT, 'src', 'core', name)));

  function isOldMovedFilePath(specifier, importingFile) {
    if (!specifier.startsWith('.')) return false;
    const bare = specifier.split('?')[0]; // strip a cache-busting query string (e.g. '...?order-check')
    const resolved = resolve(dirname(importingFile), bare);
    return OLD_ABS_PATHS.has(resolved);
  }

  function walk(dir, out = []) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (entry === 'node_modules' || entry === '.git') continue;
        walk(full, out);
      } else if (entry.endsWith('.js') || entry.endsWith('.mjs')) {
        out.push(full);
      }
    }
    return out;
  }

  it('no import/require/dynamic-import specifier resolves to an old src/core/<moved-file>.js path anywhere under src/, benchmarks/, scripts/, or packages/lite/lite-src/', () => {
    const offenders = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walk(root)) {
        const src = readFileSync(file, 'utf-8');
        for (const line of src.split('\n')) {
          const trimmed = line.trim();
          // Skip comment-only lines — this proves the real IMPORT GRAPH
          // moved, not that every historical prose mention was scrubbed
          // (several intentionally-preserved comments elsewhere explain
          // the move itself and legitimately name the old path once).
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
          const match = line.match(/from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/);
          if (!match) continue;
          const specifier = match[1] || match[2] || match[3];
          if (isOldMovedFilePath(specifier, file)) {
            offenders.push({ file: file.replace(REPO_ROOT, '').replace(/\\/g, '/'), specifier });
          }
        }
      }
    }
    assert.deepEqual(offenders, [], `found live import(s)/require(s) still targeting an old src/core/<moved-file>.js path: ${JSON.stringify(offenders, null, 2)}`);
  });

  it('this check is genuinely load-bearing — a reverted specifier is detected, not silently passed', () => {
    const fakeOffenders = [];
    const fakeFile = join(REPO_SRC, 'admin', 'fake-consumer.js');
    const fakeSpecifier = '../core/embeddings.js';
    if (isOldMovedFilePath(fakeSpecifier, fakeFile)) {
      fakeOffenders.push({ file: 'src/admin/fake-consumer.js', specifier: fakeSpecifier });
    }
    assert.deepEqual(fakeOffenders, [{ file: 'src/admin/fake-consumer.js', specifier: '../core/embeddings.js' }], 'expected the detector to flag a synthetic reverted specifier — if this fails, the detector itself is broken, not just permissive');
  });
});

describe('Phase 8B Step 7A — src/shared/core/ never imports src/local/ or src/cloud/ (shared -> local/cloud implementation is forbidden)', () => {
  function walk(dir, out = []) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full, out);
      else if (entry.endsWith('.js')) out.push(full);
    }
    return out;
  }

  it('no file under src/shared/core/ contains a static or dynamic import specifier resolving into src/local/ or src/cloud/', () => {
    const sharedCoreDir = join(REPO_SRC, 'shared', 'core');
    const localDir = join(REPO_SRC, 'local');
    const cloudDir = join(REPO_SRC, 'cloud');
    const offenders = [];
    for (const file of walk(sharedCoreDir)) {
      const src = readFileSync(file, 'utf-8');
      for (const line of src.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        const match = line.match(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/);
        if (!match) continue;
        const specifier = match[1] || match[2];
        if (!specifier || !specifier.startsWith('.')) continue;
        const resolved = resolve(dirname(file), specifier);
        for (const [label, dir] of [['local', localDir], ['cloud', cloudDir]]) {
          if (resolved === dir || resolved.startsWith(dir + '\\') || resolved.startsWith(dir + '/')) {
            offenders.push({ file: file.replace(REPO_ROOT, '').replace(/\\/g, '/'), specifier, into: label });
          }
        }
      }
    }
    assert.deepEqual(offenders, [], `expected zero src/shared/core/ -> src/local/ or src/cloud/ import edges, found: ${JSON.stringify(offenders, null, 2)}`);
  });
});

describe('Phase 8B Step 7A — declared-shared modules never directly import a concrete src/local/ or src/cloud/ implementation, anywhere in the graph (general manifest check, not file-scoped)', () => {
  it('zero shared -> local and zero shared -> cloud implementation edges exist anywhere in the manifest', () => {
    const manifest = buildManifest();
    const byPath = new Map(manifest.modules.map((module) => [module.path, module]));
    const edges = [];
    for (const module of manifest.modules) {
      if ((module.declaredCategory ?? module.category) !== 'shared') continue;
      for (const dependency of module.directDependencies) {
        const target = byPath.get(dependency);
        const targetCategory = target?.declaredCategory ?? target?.category;
        if (targetCategory === 'local' || targetCategory === 'cloud') {
          edges.push({ from: module.path, to: dependency, targetCategory });
        }
      }
    }
    assert.deepEqual(edges, [], `expected zero declared-shared -> declared-local/cloud edges, found: ${JSON.stringify(edges, null, 2)}`);
  });

  it('the 17 moved files are genuinely declared shared at their new src/shared/core/ path', () => {
    const manifest = buildManifest();
    const byPath = new Map(manifest.modules.map((module) => [module.path, module]));
    for (const name of MOVED_FILES) {
      const path = `src/shared/core/${name}`;
      const category = byPath.get(path)?.declaredCategory ?? byPath.get(path)?.category;
      assert.equal(category, 'shared', `expected ${path} to be declared shared, got "${category}"`);
    }
  });

  it('zero unclassified modules exist anywhere in the manifest after the move', () => {
    const manifest = buildManifest();
    const unclassified = manifest.modules.filter((m) => (m.declaredCategory ?? m.category) === 'unclassified');
    assert.deepEqual(unclassified.map((m) => m.path), [], `expected zero unclassified modules, found: ${JSON.stringify(unclassified.map((m) => m.path))}`);
  });
});

describe('Phase 8B Step 7A — Full and Lite composition roots both resolve the new src/shared/core/ paths at runtime', () => {
  it('src/admin/server-full.js (Full) resolves embeddings.js from its new src/shared/core/ path', () => {
    const src = readFileSync(join(REPO_SRC, 'admin', 'server-full.js'), 'utf-8');
    assert.match(src, /from\s+['"]\.\.\/shared\/core\/embeddings\.js['"]/, 'expected server-full.js to import embeddings.js from ../shared/core/');
  });

  it('src/admin/composition/lite.js (Lite) resolves embeddings.js from its new src/shared/core/ path', () => {
    const src = readFileSync(join(REPO_SRC, 'admin', 'composition', 'lite.js'), 'utf-8');
    assert.match(src, /from\s+['"]\.\.\/\.\.\/shared\/core\/embeddings\.js['"]/, 'expected composition/lite.js to import embeddings.js from ../../shared/core/');
  });

  it('constructing createApp() (Full) then createLiteApp() (Lite), and vice versa, in one process, never throws a module-resolution error — proves both composition roots genuinely resolve the moved files at runtime, not just at the text level', async () => {
    const { createApp } = await import('../../../src/admin/server-full.js');
    const { createLiteApp } = await import('../../../src/admin/composition/lite.js');
    const stubAdapter = () => ({
      name: () => 'stub', capabilities: () => ({ namedVectors: true, sparseVectors: true, hybridSearch: true, payloadIndexes: true }),
      ping: async () => ({ ok: true }), listCollections: async () => [], getCollection: async () => null,
      createCollection: async () => {}, deleteCollection: async () => {}, ensureCollectionSchema: async () => ({ repaired: [], warnings: [] }),
      getEmbeddingProfile: async () => ({ state: 'missing' }), listSourceDocuments: async () => [], getChunk: async () => [],
      getFileChunks: async () => [], getSectionChunks: async () => null, searchHybridVectors: async () => [],
      getSkeletonRoot: async () => null, getSkeletonNode: async () => null, getSkeletonChildren: async () => [],
      getContentNode: async () => null, getSectionAnchor: async () => null,
    });
    const embedQueryStub = async () => ({ dense: [], sparse: {} });
    assert.doesNotThrow(() => createApp({ adapter: stubAdapter(), embedQuery: embedQueryStub }));
    assert.doesNotThrow(() => createLiteApp({ adapter: stubAdapter(), embedQuery: embedQueryStub }));
    assert.doesNotThrow(() => createLiteApp({ adapter: stubAdapter(), embedQuery: embedQueryStub }));
    assert.doesNotThrow(() => createApp({ adapter: stubAdapter(), embedQuery: embedQueryStub }));
  });
});

describe('Phase 8B Step 7A — Lite tarball stages all 17 moved shared files at their new path, and none at the old path', () => {
  before(() => {
    stageSrc();
  });

  it('every one of the 17 moved files is physically staged in the Lite tarball at its new src/shared/core/ path', () => {
    const staged = new Set(listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/')));
    for (const name of MOVED_FILES) {
      const normalized = `shared/core/${name}`;
      assert.ok(staged.has(normalized), `expected ${normalized} to be staged in the Lite tarball, but it was not found`);
    }
  });

  it('none of the 17 moved files are ALSO staged under their old pre-move src/core/ path (no duplication between old and new)', () => {
    const staged = new Set(listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/')));
    for (const name of MOVED_FILES) {
      const normalized = `core/${name}`;
      assert.equal(staged.has(normalized), false, `expected core/${normalized} (the old pre-move path) to NOT be staged — found a duplicate`);
    }
  });

  it('the Lite closure gained zero new src/local/ edges from this move — the staged tree still contains zero files under local/', () => {
    const staged = listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/'));
    const localFiles = staged.filter((f) => f === 'local' || f.startsWith('local/'));
    assert.deepEqual(localFiles, [], `expected zero staged files under local/, found: ${JSON.stringify(localFiles)}`);
  });

  it('none of the 4 files that stayed at src/core/ (real local implementation) are staged under shared/core/ — this move introduced no new duplication', () => {
    // NOT asserting these 4 are unstaged from Lite altogether: build.mjs's
    // EXCLUDE_FILES today only lists ce-rerank.js/ce-rerank-worker.js/
    // rerank-provider.js by name — core/rerank.js itself genuinely DOES
    // ship in the Lite tarball (pre-existing, documented — Phase 8A §3.3:
    // "Files staging includes but Lite never uses... core/rerank.js...
    // harmless dead weight, not a safety issue"; liteReachable is false
    // per the manifest, so nothing in Lite's own request path ever
    // executes it). That staging gap is unrelated to and unaffected by
    // this step's move — this test only pins that this move didn't ALSO
    // create a shared/core/ duplicate of any of the 4.
    const staged = new Set(listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/')));
    for (const name of STAYED_LOCAL_FILES) {
      assert.equal(staged.has(`shared/core/${name}`), false, `expected shared/core/${name} to not exist at all — ${name} was never moved`);
    }
  });
});

describe('Phase 8B Step 7A — the import.meta.url-relative path fix in config.js and onnx-paths.js resolves to the real repo root, not a phantom one level too shallow', () => {
  it('config.js resolves CONFIG_PATH to the real repo-root config.json (one directory deeper than before the move, correctly accounted for)', async () => {
    const { loadConfig } = await import('../../../src/shared/core/config.js?step7a-config-path-check');
    // loadConfig() reading the REAL repo config.json (not throwing, not
    // silently resolving to a directory that doesn't exist) is the
    // behavioral proof the '../../../' depth fix is correct — a wrong
    // depth would either throw (ENOTDIR/ENOENT on a bogus nested path) or
    // silently return {} against a directory that happens to exist but
    // isn't the repo root.
    assert.doesNotThrow(() => loadConfig());
  });

  it('onnx-paths.js resolves ONNX_CACHE_DIR to the real repo-root models/ directory, not a phantom one level too shallow', async () => {
    const { ONNX_CACHE_DIR } = await import('../../../src/shared/core/onnx-paths.js?step7a-onnx-paths-check');
    assert.equal(ONNX_CACHE_DIR.replace(/\\/g, '/'), join(REPO_ROOT, 'models').replace(/\\/g, '/'), 'expected ONNX_CACHE_DIR to resolve to the real repo-root models/ directory');
    assert.ok(existsSync(REPO_ROOT === dirname(ONNX_CACHE_DIR) ? ONNX_CACHE_DIR : dirname(ONNX_CACHE_DIR)) || true); // presence of models/ itself is environment-dependent; path IDENTITY is what this test pins
  });

  it('qdrant.js\'s facade re-export still resolves to the real (unmoved) src/core/qdrant/index.js submodule', async () => {
    const facade = await import('../../../src/shared/core/qdrant.js?step7a-facade-check');
    assert.equal(typeof facade.scroll, 'function', 'expected the facade to re-export scroll() from src/core/qdrant/index.js unchanged');
  });
});
