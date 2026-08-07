// Phase 8B Step 6 — physical relocation of the cloud-only provider
// implementations (Qdrant Cloud Inference, Gemini) from their scattered
// src/core/**/src/admin/** locations into one top-level src/cloud/
// boundary, per docs/design/phase-8a-shared-cloud-local-migration-audit-2026-08-02.md
// §7 Step 5 ("Physically relocate cloud providers") — the plan's own
// numbering; this repo's dated report calls it Step 6, see that report's
// own naming note.
//
// Six files moved, via `git mv` (history preserved), each into one of
// three new subdirectories:
//   src/core/embedding-profile/qdrant-cloud-catalog.js   -> src/cloud/embedding/qdrant-cloud-catalog.js
//   src/core/embedding-profile/qdrant-cloud-tokenizer.js -> src/cloud/embedding/qdrant-cloud-tokenizer.js
//   src/core/generation/gemini-provider.js                -> src/cloud/generation/gemini-provider.js
//   src/core/gemini-models.js                             -> src/cloud/generation/gemini-models.js
//   src/admin/api/qdrant-cloud.js                         -> src/cloud/admin/qdrant-cloud-api.js
//   src/admin/system/qdrant-cloud.js                      -> src/cloud/admin/qdrant-cloud-system.js
// (The last two were renamed, not just relocated, to avoid a same-name
// collision once both sibling files share one directory — qdrant-cloud-api.js
// is the HTTP route layer, qdrant-cloud-system.js is the Tier 1/Tier 2
// probe logic it delegates to.)
//
// Code review fix (Phase 8B Step 6, second pass): qdrant-cloud-models.js
// (QDRANT_CLOUD_DENSE_MODELS/SPARSE_MODELS, findDenseModel/findSparseModel,
// isCatalogCompatibleWithChunking — zero dependencies, no fs, no fetch, no
// tokenizer) was ORIGINALLY moved into src/cloud/embedding/ alongside the
// other six, then moved back to src/core/embedding-profile/ once the review
// established it is genuinely neutral catalog/typed-metadata data, not a
// cloud IMPLEMENTATION — a real architectural boundary must separate "lives
// under src/cloud/" from "IS a cloud implementation." It is intentionally
// absent from MOVED below; its own coverage lives in the "shared modules
// never import a concrete cloud implementation" describe block further
// down, which asserts the opposite: shared code MAY import it freely.
//
// Unlike Steps 2-4 (local runtime relocation into src/local/), this is NOT
// an exclusion move — Semidex Lite is cloud-only, so all six files must
// continue to ship in the Lite tarball, just at their new src/cloud/ paths.
// No *-lazy.js shim was introduced (the task's own explicit constraint):
// every consumer, in both Full and Lite composition, keeps importing these
// six files directly — the physical move only changes the import
// specifier's path, never the shape of who calls what.
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

const MOVED = [
  { oldPath: join('core', 'embedding-profile', 'qdrant-cloud-catalog.js'), newPath: join('cloud', 'embedding', 'qdrant-cloud-catalog.js') },
  { oldPath: join('core', 'embedding-profile', 'qdrant-cloud-tokenizer.js'), newPath: join('cloud', 'embedding', 'qdrant-cloud-tokenizer.js') },
  { oldPath: join('core', 'generation', 'gemini-provider.js'), newPath: join('cloud', 'generation', 'gemini-provider.js') },
  { oldPath: join('core', 'gemini-models.js'), newPath: join('cloud', 'generation', 'gemini-models.js') },
  { oldPath: join('admin', 'api', 'qdrant-cloud.js'), newPath: join('cloud', 'admin', 'qdrant-cloud-api.js') },
  { oldPath: join('admin', 'system', 'qdrant-cloud.js'), newPath: join('cloud', 'admin', 'qdrant-cloud-system.js') },
];

describe('Phase 8B Step 6 — the six cloud-provider files physically moved into src/cloud/', () => {
  for (const { oldPath, newPath } of MOVED) {
    it(`src/${oldPath.replace(/\\/g, '/')} no longer exists`, () => {
      assert.equal(existsSync(join(REPO_SRC, oldPath)), false, `expected src/${oldPath.replace(/\\/g, '/')} to be gone (moved to src/${newPath.replace(/\\/g, '/')})`);
    });

    it(`src/${newPath.replace(/\\/g, '/')} exists`, () => {
      assert.equal(existsSync(join(REPO_SRC, newPath)), true, `expected src/${newPath.replace(/\\/g, '/')} to exist`);
    });
  }
});

describe('Phase 8B Step 6 — no production source file references an old pre-move path for any of the six moved files', () => {
  // Real path resolution against each importing file's own directory, not
  // a segment/regex heuristic (the exact blind spot prior Steps' own
  // equivalent tests found and fixed — a same-directory relative import
  // like './qdrant-cloud-catalog.js' has no "embedding-profile/" segment
  // at all, so a text-pattern check could miss a reverted specifier).
  // packages/lite/src/ (the gitignored staged mirror) is deliberately
  // excluded — it is regenerated output, not a source of truth.
  const SCAN_ROOTS = ['src', 'benchmarks', 'scripts'].map((d) => join(REPO_ROOT, d));
  const CROSS_PACKAGE_ROOTS = [join(REPO_ROOT, 'packages', 'lite', 'lite-src')];

  const OLD_ABS_PATHS = new Set(MOVED.map(({ oldPath }) => join(REPO_SRC, oldPath)));

  function isOldMovedFilePath(specifier, importingFile) {
    if (!specifier.startsWith('.')) return false;
    const resolved = resolve(dirname(importingFile), specifier);
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

  function findOffenders(roots) {
    const offenders = [];
    for (const root of roots) {
      for (const file of walk(root)) {
        const src = readFileSync(file, 'utf-8');
        for (const line of src.split('\n')) {
          const trimmed = line.trim();
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
    return offenders;
  }

  it('no import/require/dynamic-import specifier under src/, benchmarks/, or scripts/ resolves to an old pre-move path', () => {
    const offenders = findOffenders(SCAN_ROOTS);
    assert.deepEqual(offenders, [], `found live import(s)/require(s) still targeting an old pre-move path: ${JSON.stringify(offenders)}`);
  });

  it('packages/lite/lite-src/ (the real, committed cross-package composition layer) also references no old pre-move path', () => {
    const offenders = findOffenders(CROSS_PACKAGE_ROOTS);
    assert.deepEqual(offenders, [], `found live import(s)/require(s) in packages/lite/lite-src/ still targeting an old pre-move path: ${JSON.stringify(offenders)}`);
  });

  it('this check is genuinely load-bearing — a reverted specifier is detected, not silently passed', () => {
    // Independently re-derive the detection logic's own verdict on a
    // deliberately-reverted specifier, proving the check would actually
    // catch a regression rather than trivially passing on any input.
    const fakeImportingFile = join(REPO_SRC, 'core', 'token-count.js');
    const revertedSpecifier = './embedding-profile/qdrant-cloud-tokenizer.js';
    assert.equal(isOldMovedFilePath(revertedSpecifier, fakeImportingFile), true, 'the detection logic itself must flag a reverted old-path specifier');
    const currentSpecifier = '../cloud/embedding/qdrant-cloud-tokenizer.js';
    assert.equal(isOldMovedFilePath(currentSpecifier, fakeImportingFile), false, 'the current, correct specifier must not be flagged');
  });
});

describe('Phase 8B Step 6 — src/local/ never imports src/cloud/ (local -> cloud implementation is forbidden)', () => {
  function walk(dir, out = []) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full, out);
      } else if (entry.endsWith('.js')) {
        out.push(full);
      }
    }
    return out;
  }

  it('no file under src/local/ contains a static or dynamic import specifier resolving into src/cloud/', () => {
    const localDir = join(REPO_SRC, 'local');
    const offenders = [];
    for (const file of walk(localDir)) {
      const src = readFileSync(file, 'utf-8');
      for (const line of src.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        const match = line.match(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/);
        if (!match) continue;
        const specifier = match[1] || match[2];
        if (!specifier || !specifier.startsWith('.')) continue;
        const resolved = resolve(dirname(file), specifier);
        const cloudDir = join(REPO_SRC, 'cloud');
        if (resolved === cloudDir || resolved.startsWith(cloudDir + '\\') || resolved.startsWith(cloudDir + '/')) {
          offenders.push({ file: file.replace(REPO_ROOT, '').replace(/\\/g, '/'), specifier });
        }
      }
    }
    assert.deepEqual(offenders, [], `expected zero src/local/ -> src/cloud/ import edges, found: ${JSON.stringify(offenders)}`);
  });
});

describe('Phase 8B Step 6 code review fix (second pass) — declared-shared modules never directly import a concrete src/cloud/ implementation, anywhere in the graph', () => {
  // The FIRST version of this describe block only checked src/admin/'s own
  // import specifiers against ONE file, qdrant-cloud-system.js — it never
  // looked at src/core/, src/indexer/, the generation registry, the cloud
  // tokenizer/catalog, or any file other than the one it happened to name.
  // That gap is exactly how embeddings.js (line 31), registry.js (line 15),
  // token-count.js (line 35), search.js (line 20), run.js (line 36), and
  // register-neutral-routes.js (line 36) all kept real, direct
  // `shared -> cloud IMPLEMENTATION` edges while this test still passed.
  //
  // This replacement is a REAL graph test: it uses the same manifest the
  // rest of the architecture suite treats as authoritative
  // (build-shared-cloud-local-manifest.mjs's buildManifest(), AST-based via
  // build-import-graph.mjs — never a regex/text scan), and asserts the
  // general rule directly — every module the manifest DECLARES 'shared'
  // (declaredCategory, fixed at classification time, see that script's own
  // header comment for why declaredCategory rather than the propagation-
  // refined category is the right field to check here) must have zero
  // direct dependencies on a module the manifest declares 'cloud'. No
  // per-file allow-list, no single named target — every shared module,
  // every src/cloud/ target, all at once.
  it('zero shared -> cloud implementation edges exist anywhere in the manifest (declaredCategory-based, not the old single-file check)', () => {
    const manifest = buildManifest();
    const byPath = new Map(manifest.modules.map((module) => [module.path, module]));
    const edges = [];
    for (const module of manifest.modules) {
      if ((module.declaredCategory ?? module.category) !== 'shared') continue;
      for (const dependency of module.directDependencies) {
        const target = byPath.get(dependency);
        if (target && (target.declaredCategory ?? target.category) === 'cloud') {
          edges.push({ from: module.path, to: dependency });
        }
      }
    }
    assert.deepEqual(edges, [], `expected zero declared-shared -> declared-cloud edges, found: ${JSON.stringify(edges, null, 2)}`);
  });

  it('the six named files from the code review are genuinely declared shared/composition — the exact regression this test exists to catch', () => {
    const manifest = buildManifest();
    const byPath = new Map(manifest.modules.map((module) => [module.path, module]));
    const named = [
      'src/shared/core/embeddings.js',
      'src/core/generation/registry.js',
      'src/shared/core/token-count.js',
      'src/core/retrieval/search.js',
      'src/indexer/run.js',
      'src/admin/register-neutral-routes.js',
    ];
    for (const path of named) {
      const category = byPath.get(path)?.declaredCategory ?? byPath.get(path)?.category;
      assert.ok(category === 'shared' || category === 'composition', `expected ${path} to be declared shared or composition, got "${category}"`);
    }
  });

  it('this check is genuinely load-bearing — a module with a fabricated direct dependency on a real cloud module is detected, not silently passed', () => {
    // Independently re-derive the detection logic's own verdict on a
    // synthetic manifest fragment shaped like a real regression (a
    // 'shared' module gaining a direct edge to a real 'cloud' module) —
    // proves this test would actually catch the exact bug class the code
    // review found, not merely pass trivially on today's clean graph.
    const fakeManifest = { modules: [
      { path: 'src/core/fake-shared.js', declaredCategory: 'shared', directDependencies: ['src/cloud/embedding/qdrant-cloud-catalog.js'] },
      { path: 'src/cloud/embedding/qdrant-cloud-catalog.js', declaredCategory: 'cloud', directDependencies: [] },
    ] };
    const byPath = new Map(fakeManifest.modules.map((module) => [module.path, module]));
    const edges = [];
    for (const module of fakeManifest.modules) {
      if (module.declaredCategory !== 'shared') continue;
      for (const dependency of module.directDependencies) {
        const target = byPath.get(dependency);
        if (target && target.declaredCategory === 'cloud') edges.push({ from: module.path, to: dependency });
      }
    }
    assert.deepEqual(edges, [{ from: 'src/core/fake-shared.js', to: 'src/cloud/embedding/qdrant-cloud-catalog.js' }]);
  });

  it('src/admin/ (excluding src/cloud/admin/ itself) never imports qdrant-cloud-system.js except through the one authorized route file (narrower, file-specific regression pin, in addition to the general graph check above)', () => {
    // Mirrors the pre-existing "src/admin/ never imports Qdrant or Ollama
    // directly" layering test (tests/unit/admin/server.test.js) — kept as
    // an additional, narrower pin alongside the general graph check above,
    // not a replacement for it.
    const adminDir = join(REPO_SRC, 'admin');
    function walk(dir, out = []) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (full.startsWith(join(REPO_SRC, 'cloud'))) continue; // src/cloud/admin/ is the implementation itself, not a consumer to check
        const st = statSync(full);
        if (st.isDirectory()) walk(full, out);
        else if (entry.endsWith('.js')) out.push(full);
      }
      return out;
    }
    const offenders = [];
    for (const file of walk(adminDir)) {
      const src = readFileSync(file, 'utf-8');
      for (const line of src.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        const match = line.match(/from\s+['"]([^'"]+)['"]/);
        if (!match) continue;
        const specifier = match[1];
        if (!specifier.startsWith('.')) continue;
        const resolved = resolve(dirname(file), specifier);
        if (resolved === join(REPO_SRC, 'cloud', 'admin', 'qdrant-cloud-system.js')) {
          offenders.push(file.replace(REPO_ROOT, '').replace(/\\/g, '/'));
        }
      }
    }
    assert.deepEqual(offenders, [], `expected zero direct src/admin/ (excluding src/cloud/admin/) -> qdrant-cloud-system.js edges; found: ${JSON.stringify(offenders)}`);
  });
});

describe('Phase 8B Step 6 — Lite tarball contains all six cloud modules at their new paths, and zero local-runtime files', () => {
  before(() => {
    stageSrc();
  });

  it('every one of the six moved cloud files is physically staged in the Lite tarball at its new src/cloud/ path', () => {
    const staged = new Set(listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/')));
    for (const { newPath } of MOVED) {
      const normalized = newPath.replace(/\\/g, '/');
      assert.ok(staged.has(normalized), `expected ${normalized} to be staged in the Lite tarball, but it was not found`);
    }
  });

  it('the real staged tree still contains zero files under local/ (unaffected by this cloud-only move)', () => {
    const staged = listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/'));
    const localFiles = staged.filter((f) => f === 'local' || f.startsWith('local/'));
    assert.deepEqual(localFiles, [], `expected zero staged files under local/, found: ${JSON.stringify(localFiles)}`);
  });

  it('none of the six moved files are ALSO staged under their old pre-move path (no duplication between old and new)', () => {
    const staged = new Set(listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/')));
    for (const { oldPath } of MOVED) {
      const normalized = oldPath.replace(/\\/g, '/');
      assert.equal(staged.has(normalized), false, `expected ${normalized} (the old pre-move path) to NOT be staged — found a duplicate`);
    }
  });
});

describe('Phase 8B Step 6 — Gemini/Qdrant Cloud imports never make a network call merely on module evaluation', () => {
  it('importing all six moved cloud modules with fetch() blocked never throws — no network call happens at import time', async () => {
    const originalFetch = global.fetch;
    let fetchCalled = false;
    global.fetch = (...args) => {
      fetchCalled = true;
      throw new Error(`unexpected network call during module import: ${args[0]}`);
    };
    try {
      await import('../../../src/cloud/embedding/qdrant-cloud-catalog.js?step6-network-check');
      await import('../../../src/cloud/embedding/qdrant-cloud-tokenizer.js?step6-network-check');
      await import('../../../src/cloud/generation/gemini-provider.js?step6-network-check');
      await import('../../../src/cloud/generation/gemini-models.js?step6-network-check');
      await import('../../../src/cloud/admin/qdrant-cloud-api.js?step6-network-check');
      await import('../../../src/cloud/admin/qdrant-cloud-system.js?step6-network-check');
      // qdrant-cloud-models.js lives in src/core/embedding-profile/ now
      // (pure catalog data, see the header comment) — covered here too
      // since it's part of the same "no network at import time" guarantee.
      await import('../../../src/core/embedding-profile/qdrant-cloud-models.js?step6-network-check');
      assert.equal(fetchCalled, false, 'none of the moved cloud modules (or qdrant-cloud-models.js) may call fetch() merely from being imported');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('Phase 8B Step 6 — Full and Lite composition roots can be constructed in either order in one process without cross-contamination of cloud capabilities', () => {
  it('constructing createApp() then createLiteApp() (and vice versa), repeatedly, in one process, never errors', async () => {
    const { createApp } = await import('../../../src/admin/server-full.js?step6-order-check');
    const { createLiteApp } = await import('../../../src/admin/composition/lite.js?step6-order-check');
    const { createSettingsService } = await import('../../../src/core/settings/service.js?step6-order-check');
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {} });

    const full1 = createApp({ settingsService });
    full1.close();
    const lite1 = createLiteApp({ settingsService });
    lite1.close();
    const full2 = createApp({ settingsService });
    full2.close();
    const lite2 = createLiteApp({ settingsService });
    lite2.close();

    assert.ok(full1 && lite1 && full2 && lite2, 'all four constructions must succeed with no error regardless of order');
  });
});
