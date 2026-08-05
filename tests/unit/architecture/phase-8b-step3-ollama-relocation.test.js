// Phase 8B Step 3 — physical relocation of the local Ollama implementation
// (core/ollama.js, core/ollama-models.js -> local/core/*.js), plus the
// conversion of five indexer phase modules (context.js, tag.js, combined.js,
// skeleton-summary.js, preflight.js) from Phase 8B Step 1's module-scope
// apply*Capability() setters to genuine instance-scoped capability
// injection. Per docs/design/phase-8b-step3-local-ollama-relocation-2026-08-05.md.
//
// These tests prove:
//   - the old src/core/ollama*.js paths no longer exist as files, AND no
//     production import specifier anywhere still resolves to them;
//   - the new src/local/core/ollama*.js paths exist;
//   - the Lite tarball's real staged tree physically excludes local/
//     entirely (via build.mjs's own stageSrc(), not a simulation);
//   - the Lite import graph never reaches the Ollama implementation, even
//     PRE-shim (no build-time substitution needed);
//   - only Full composition modules (index-full.js, server-full.js,
//     mcp/tools/collections.js, admin/system/ollama.js) have a real edge
//     onto the moved files — Lite composition never does;
//   - shared/cloud-classified modules never import src/local/** directly;
//   - the manifest classifier still labels the moved files `local`;
//   - createApp()/createLiteApp() can be constructed in either order in one
//     process with no shared-state contamination of the Ollama capability
//     lane (mirrors the existing embeddings.js isolation test).
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageSrc, listAllFiles } from '../../../packages/lite/build.mjs';
import { buildGraph } from '../../../scripts/audit/build-import-graph.mjs';
import { computeReachable, LITE_SRC_DIR, FULL_ROOTS } from '../../../scripts/audit/classify-modules.mjs';
import { loadManifest } from '../../../scripts/audit/find-dependency-violations.mjs';
import { createSettingsService } from '../../../src/core/settings/service.js';

const LITE_DIR = dirname(fileURLToPath(new URL('../../../packages/lite/build.mjs', import.meta.url)));
const REPO_ROOT = resolve(LITE_DIR, '..', '..');
const REPO_SRC = join(REPO_ROOT, 'src');
const STAGED_SRC = join(LITE_DIR, 'src');

const MOVED_FILES = ['ollama.js', 'ollama-models.js'];
const MOVED_PATHS = ['src/local/core/ollama.js', 'src/local/core/ollama-models.js'];

describe('Phase 8B Step 3 — ollama.js/ollama-models.js physically moved from src/core/ to src/local/core/', () => {
  for (const name of MOVED_FILES) {
    it(`src/core/${name} no longer exists`, () => {
      assert.equal(existsSync(join(REPO_SRC, 'core', name)), false, `expected src/core/${name} to be gone (moved to src/local/core/${name})`);
    });

    it(`src/local/core/${name} exists`, () => {
      assert.equal(existsSync(join(REPO_SRC, 'local', 'core', name)), true, `expected src/local/core/${name} to exist`);
    });
  }
});

describe('Phase 8B Step 3 — no production source file references the old src/core/ollama*.js paths', () => {
  const SCAN_ROOTS = ['src', 'benchmarks', 'scripts'].map((d) => join(REPO_ROOT, d));

  // Real path resolution, not a segment/regex heuristic — a same-directory
  // relative specifier like './ollama.js' (exactly what core/ollama-lazy.js
  // itself uses to reach the file, both before AND after this move) has NO
  // "core/" segment at all, so a check that only looks for "core/<file>.js"
  // in the specifier text would silently miss a regression here entirely
  // (verified: this is a REAL gap, not hypothetical — an earlier draft of
  // this exact test used a segment-based check copied from
  // phase-8b-step2-local-relocation.test.js and it did not catch a
  // deliberately reverted './ollama.js' regression in ollama-lazy.js).
  // Resolving the specifier against the importing file's own directory and
  // comparing the ABSOLUTE result to the old (deleted) src/core/ location
  // is unambiguous regardless of how many "../"/"./" segments separate the
  // two, and regardless of whether "core/" appears in the specifier text.
  const OLD_ABS_PATHS = new Set(MOVED_FILES.map((name) => join(REPO_SRC, 'core', name)));
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

  it('no import/require/dynamic-import specifier resolves to the old core/ollama.js or core/ollama-models.js path anywhere under src/, benchmarks/, or scripts/', () => {
    const offenders = [];
    for (const root of SCAN_ROOTS) {
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
    assert.deepEqual(offenders, [], `found live import(s)/require(s) still targeting the old core/ollama*.js path: ${JSON.stringify(offenders)}`);
  });
});

describe('Phase 8B Step 3 — Lite tarball physically excludes src/local/ (not merely unreachable)', () => {
  before(() => {
    stageSrc();
  });

  it('the real staged tree contains zero files under local/', () => {
    const staged = listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/'));
    const localFiles = staged.filter((f) => f === 'local' || f.startsWith('local/'));
    assert.deepEqual(localFiles, [], `expected zero staged files under local/, found: ${JSON.stringify(localFiles)}`);
  });

  it('neither ollama.js nor ollama-models.js is staged under ANY path in the Lite tarball', () => {
    const staged = listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/'));
    for (const name of MOVED_FILES) {
      const matches = staged.filter((f) => f.endsWith(`/${name}`) || f === name);
      assert.deepEqual(matches, [], `expected zero staged copies of ${name} anywhere in the Lite tarball, found: ${JSON.stringify(matches)}`);
    }
  });
});

describe('Phase 8B Step 3 — Lite import graph never reaches the Ollama implementation', () => {
  const graph = buildGraph();
  const liteSyntheticRoots = graph.files.filter((f) => f.startsWith(LITE_SRC_DIR));

  it('neither local/core/ollama.js nor local/core/ollama-models.js is reachable from Lite roots, PRE-shim (no build-time substitution needed)', () => {
    const reachable = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: false });
    const leaked = MOVED_PATHS.filter((p) => reachable.has(p));
    assert.deepEqual(leaked, [], `expected zero Ollama implementation files reachable from Lite, found: ${JSON.stringify(leaked)}`);
  });

  it('POST-shim reachability is identical to PRE-shim — nothing left for a shim substitution to do', () => {
    const preShim = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: false });
    const postShim = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: true });
    for (const p of MOVED_PATHS) {
      assert.equal(preShim.has(p), postShim.has(p));
      assert.equal(preShim.has(p), false);
    }
  });
});

describe('Phase 8B Step 3 — only Full composition modules have a real edge onto the Ollama implementation', () => {
  const graph = buildGraph();

  function importers(target) {
    const result = [];
    for (const f of graph.files) {
      const node = graph.nodes[f];
      for (const group of [node.staticImports, node.dynamicImports, node.requireCalls]) {
        for (const ref of group) {
          if (ref.kind === 'relative' && ref.resolved === target) result.push(f);
        }
      }
    }
    return result;
  }

  it('src/local/core/ollama.js is imported only by files reachable from Full roots (never by any Lite-reachable file)', () => {
    const liteSyntheticRoots = graph.files.filter((f) => f.startsWith(LITE_SRC_DIR));
    const liteReachable = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: true });
    const fullReachable = computeReachable(graph, FULL_ROOTS);
    const realImporters = importers('src/local/core/ollama.js');
    assert.ok(realImporters.length > 0, 'sanity: expected at least one real importer of local/core/ollama.js');
    for (const importer of realImporters) {
      assert.ok(!liteReachable.has(importer), `${importer} imports local/core/ollama.js but IS Lite-reachable — a real shared -> local edge`);
      assert.ok(fullReachable.has(importer), `${importer} imports local/core/ollama.js but is NOT Full-reachable — a dead or misclassified edge`);
    }
  });

  it('src/local/core/ollama-models.js is imported only by files reachable from Full roots', () => {
    const liteSyntheticRoots = graph.files.filter((f) => f.startsWith(LITE_SRC_DIR));
    const liteReachable = computeReachable(graph, liteSyntheticRoots, { applyLiteShims: true });
    const fullReachable = computeReachable(graph, FULL_ROOTS);
    const realImporters = importers('src/local/core/ollama-models.js');
    assert.ok(realImporters.length > 0, 'sanity: expected at least one real importer of local/core/ollama-models.js');
    for (const importer of realImporters) {
      assert.ok(!liteReachable.has(importer), `${importer} imports local/core/ollama-models.js but IS Lite-reachable`);
      assert.ok(fullReachable.has(importer), `${importer} imports local/core/ollama-models.js but is NOT Full-reachable`);
    }
  });
});

describe('Phase 8B Step 3 — shared/cloud-classified manifest modules never import src/local/** directly', () => {
  it('every shared or cloud module\'s directDependencies list contains zero src/local/ paths', () => {
    const manifest = loadManifest();
    const violations = [];
    for (const mod of manifest.modules) {
      if (mod.category !== 'shared' && mod.category !== 'cloud') continue;
      for (const dep of mod.directDependencies) {
        if (dep.startsWith('src/local/')) violations.push({ from: mod.path, to: dep });
      }
    }
    assert.deepEqual(violations, [], `found shared/cloud module(s) with a direct src/local/ dependency: ${JSON.stringify(violations)}`);
  });

  it('core/ollama-lazy.js (category "mixed" — the deliberate seam) is the one documented exception, not silently exempted', () => {
    const manifest = loadManifest();
    const lazySeam = manifest.modules.find((m) => m.path === 'src/core/ollama-lazy.js');
    assert.ok(lazySeam, 'expected src/core/ollama-lazy.js to exist in the manifest');
    assert.equal(lazySeam.category, 'mixed', 'the lazy seam must be classified "mixed", not "shared" — it is the boundary itself, not a shared-side violation');
    assert.ok(lazySeam.directDependencies.includes('src/local/core/ollama.js'), 'sanity: the seam really does depend on the moved file');
  });
});

describe('Phase 8B Step 3 — classifier labels the moved Ollama files "local"', () => {
  it('src/local/core/ollama.js and src/local/core/ollama-models.js are classified "local" in the manifest', () => {
    const manifest = loadManifest();
    const byPath = new Map(manifest.modules.map((m) => [m.path, m]));
    for (const p of MOVED_PATHS) {
      const mod = byPath.get(p);
      assert.ok(mod, `expected ${p} to exist in the manifest`);
      assert.equal(mod.category, 'local', `expected ${p} to be classified "local", got "${mod?.category}"`);
    }
  });
});

describe('Phase 8B Step 3 — Full and Lite composition roots construct in either order with no Ollama-capability contamination', () => {
  it('constructing createLiteApp() then createApp() (and vice versa) in one process leaves core/embeddings.js\'s own module-scope fallback untouched by either — mirrors the existing per-call isolation guarantee, extended to confirm order-independence for the Ollama lane specifically', async () => {
    const embeddings = await import('../../../src/core/embeddings.js?step3-order-check');
    const profile = {
      schemaVersion: 1, managedBy: 'semidex', embeddingSchemaVersion: 2,
      embedding: {
        dense: { provider: 'ollama', model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
        sparse: { provider: 'hashed-tf', model: 'hashed-tf', vectorName: 'sparse', execution: 'client' },
      },
    };
    await assert.rejects(() => embeddings.embedForSearch(profile, 'q'), (err) => { assert.match(err.message, /no ollama capability available/); return true; });

    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {} });
    const { createLiteApp } = await import('../../../src/admin/composition/lite.js?step3-order-check');
    const { createApp } = await import('../../../src/admin/server-full.js?step3-order-check');

    // Order 1: Lite first, then Full.
    const lite1 = createLiteApp({ settingsService });
    lite1.close();
    const full1 = createApp({ settingsService });
    full1.close();
    await assert.rejects(() => embeddings.embedForSearch(profile, 'q'), (err) => { assert.match(err.message, /no ollama capability available/); return true; });

    // Order 2: Full first, then Lite — the reverse order, same process.
    const full2 = createApp({ settingsService });
    full2.close();
    const lite2 = createLiteApp({ settingsService });
    lite2.close();
    await assert.rejects(() => embeddings.embedForSearch(profile, 'q'), (err) => { assert.match(err.message, /no ollama capability available/); return true; });
  });

  // Code review (Phase 8B Step 3, second pass): this describe block used to
  // include a second test here asserting indexer/run.js's own
  // ollamaCapabilities() run-scoped snapshot was "immune" to a concurrent
  // applyRunCapabilities() call — but that test only ever manually set one
  // module-scope snapshot via a test-only setter and then called another
  // setter afterward; it never ran two genuinely overlapping run() calls,
  // so it could not actually observe the "last call wins" race it claimed
  // to guard against (and indeed did not, since the underlying design was
  // still module-scope state that later failed under real concurrency).
  // The fix removed run.js's module-scope capability state entirely
  // (applyRunCapabilities/applyAllCapabilities/ollamaCapabilities/
  // __setActiveRun*ForTest are all gone — see run.js's own header comment)
  // in favor of a local `const ctx` built once per call and threaded as a
  // real parameter through main()/stageA/stageB/stageC. There is no
  // module-scope binding left in run.js for a "construct in either order"
  // test to probe. The genuine behavioral replacement — two REAL
  // concurrently-executing run() calls, each with its own distinguishable
  // fake capabilities, asserting neither ever observes the other's
  // ctx.tagOnnx/ctx.ollamaGenerate/etc. — lives in
  // tests/unit/indexer/phase-capability-injection.test.js, describe
  // block "indexer/run.js — TWO real concurrent run() calls never
  // cross-contaminate (behavioral, not simulated)", plus a second,
  // stageB()-level interleaved-generate() proof in the sibling describe
  // block right after it. Removing the duplicate here rather than
  // reimplementing it against a design that no longer exists.
});
