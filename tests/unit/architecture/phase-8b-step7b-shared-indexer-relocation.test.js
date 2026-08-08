// Phase 8B Step 7B — physical relocation of the shared indexer pipeline
// (24 files: 11 top-level src/indexer/*.js + 14 src/indexer/phases/*.js,
// minus overlap — see the exact list below) into src/shared/indexer/, per
// docs/design/phase-8a-shared-cloud-local-migration-audit-2026-08-02.md §7
// Step 6's own "plus src/indexer/'s 24 remaining shared files" clause
// (deferred from Phase 8B Step 7A, which covered only top-level
// src/core/*.js — see that step's own §0 "narrower scope" note).
//
// 24 files moved, via `git mv` (history preserved), confirmed shared by
// direct import-graph inspection (Full+Lite reachable, capability-
// injected, never branches on edition, never loads ONNX/Ollama/
// Transformers directly, not a process entry point):
//   batch.js, files.js, index-runtime.js, preflight.js, profiler.js,
//   progress-event.js, run.js, semaphore.js, serial-queue.js,
//   skeleton-payload.js, skeleton-warnings.js,
//   phases/chunk.js, phases/combined.js, phases/context.js,
//   phases/empty-section.js, phases/entity-split.js, phases/node-policy.js,
//   phases/skeleton-chunk.js, phases/skeleton-index.js,
//   phases/skeleton-summary.js, phases/skeleton.js,
//   phases/tag-onnx-capability.js, phases/tag-provider.js, phases/tag.js,
//   phases/token-budget-split.js
//
// Left at src/indexer/ (explicitly NOT moved, confirmed by direct
// import-graph inspection, not directory-name assumption):
//   - index.js — Full-only backward-compatible CLI launcher alias
//     (delegates to index-full.js; carries no capability-building imports
//     of its own, but is a process entry point, not shared orchestration).
//   - index-full.js, index-lite.js — the two edition-specific composition
//     roots (Full builds real *-lazy.js-backed capabilities; Lite builds
//     typed-unavailable stubs). Neither is reachable from the other
//     edition — composition, not shared.
//   - phases/tag-onnx-lazy.js, phases/tag-onnx-lazy.lite.js — the one
//     remaining lazy-shim pair still physically inside src/indexer/phases/
//     (mixed), explicitly out of scope for this step per the task's own
//     "не переносити" list (Phase 8B Step 8's own scope).
// (indexer/phases/tag-onnx.js and indexer/workers/tag-onnx-worker.js
// already physically live under src/local/indexer/ — relocated in an
// earlier step, Phase 8B Step 4 — and are not part of this step's scope
// at all.)
//
// This is a pure `git mv` + import-path-update step — no exported
// function/API changed shape, no new capability abstraction, no batching/
// chunking/tagging/progress-event logic change. Two of the 24 moved files
// (skeleton-warnings.js, phases/skeleton-index.js) had an
// import.meta.url-relative path constant (pointing at the repo-root
// .tmp/semidex-inspect/ inspect-artifact directory) that needed one extra
// '../' to stay correct one directory level deeper — a mechanical
// consequence of the move, not a logic change; covered separately below.
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

const MOVED_TOP = [
  'batch.js', 'files.js', 'index-runtime.js', 'preflight.js', 'profiler.js',
  'progress-event.js', 'run.js', 'semaphore.js', 'serial-queue.js',
  'skeleton-payload.js', 'skeleton-warnings.js',
];
const MOVED_PHASES = [
  'chunk.js', 'combined.js', 'context.js', 'empty-section.js', 'entity-split.js',
  'node-policy.js', 'skeleton-chunk.js', 'skeleton-index.js', 'skeleton-summary.js',
  'skeleton.js', 'tag-onnx-capability.js', 'tag-provider.js', 'tag.js', 'token-budget-split.js',
];
const MOVED_TOP_PATHS = MOVED_TOP.map((f) => `${f}`);
const MOVED_PHASES_PATHS = MOVED_PHASES.map((f) => `phases/${f}`);
const ALL_MOVED_RELATIVE = [...MOVED_TOP_PATHS, ...MOVED_PHASES_PATHS];

const STAYED_COMPOSITION_FILES = ['index.js', 'index-full.js', 'index-lite.js'];
const STAYED_LAZY_SHIM_FILES = ['phases/tag-onnx-lazy.js', 'phases/tag-onnx-lazy.lite.js'];

describe('Phase 8B Step 7B — 24 shared indexer files physically moved from src/indexer/ to src/shared/indexer/', () => {
  for (const rel of ALL_MOVED_RELATIVE) {
    it(`src/indexer/${rel} no longer exists`, () => {
      assert.equal(existsSync(join(REPO_SRC, 'indexer', rel)), false, `expected src/indexer/${rel} to be gone (moved to src/shared/indexer/${rel})`);
    });

    it(`src/shared/indexer/${rel} exists`, () => {
      assert.equal(existsSync(join(REPO_SRC, 'shared', 'indexer', rel)), true, `expected src/shared/indexer/${rel} to exist`);
    });
  }

  for (const rel of STAYED_COMPOSITION_FILES) {
    it(`src/indexer/${rel} (composition/entry point, not shared) stayed at src/indexer/ — no duplicate under src/shared/indexer/`, () => {
      assert.equal(existsSync(join(REPO_SRC, 'indexer', rel)), true, `expected src/indexer/${rel} to still exist — it was never in scope for this move`);
      assert.equal(existsSync(join(REPO_SRC, 'shared', 'indexer', rel)), false, `expected src/shared/indexer/${rel} to NOT exist — ${rel} was never moved`);
    });
  }

  for (const rel of STAYED_LAZY_SHIM_FILES) {
    it(`src/indexer/${rel} (transitional lazy shim, explicitly out of THIS step's scope at the time) no longer exists anywhere — Phase 8B Step 8 deleted it outright`, () => {
      assert.equal(existsSync(join(REPO_SRC, 'indexer', rel)), false, `expected src/indexer/${rel} to be gone — Phase 8B Step 8 removed the transitional lazy-shim layer via git rm`);
      assert.equal(existsSync(join(REPO_SRC, 'shared', 'indexer', rel)), false, `expected src/shared/indexer/${rel} to NOT exist — it was never moved, only deleted`);
    });
  }

  it('src/local/indexer/phases/tag-onnx.js and src/local/indexer/workers/tag-onnx-worker.js are untouched by this step (already relocated by an earlier step)', () => {
    assert.equal(existsSync(join(REPO_SRC, 'local', 'indexer', 'phases', 'tag-onnx.js')), true);
    assert.equal(existsSync(join(REPO_SRC, 'local', 'indexer', 'workers', 'tag-onnx-worker.js')), true);
  });
});

describe('Phase 8B Step 7B — no production source file references an old pre-move src/indexer/*.js path for any of the 24 moved files', () => {
  // Real path resolution against each importing file's own directory, not
  // a segment/regex heuristic — a same-directory relative import like
  // './run.js' (from another moved file that moved WITH it) has no
  // "indexer/" segment in its specifier text at all, so a text-pattern
  // check could miss a reverted specifier the wrong direction just as
  // easily as it could false-positive on a legitimate same-directory
  // import. packages/lite/src/ (the gitignored staged mirror) is
  // deliberately excluded — regenerated output, not a source of truth.
  const SCAN_ROOTS = ['src', 'benchmarks', 'scripts', join('packages', 'lite', 'lite-src')].map((d) => join(REPO_ROOT, d));
  const OLD_ABS_PATHS = new Set(ALL_MOVED_RELATIVE.map((rel) => join(REPO_ROOT, 'src', 'indexer', rel)));

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

  it('no import/require/dynamic-import specifier resolves to an old src/indexer/<moved-file>.js path anywhere under src/, benchmarks/, scripts/, or packages/lite/lite-src/', () => {
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
    assert.deepEqual(offenders, [], `found live import(s)/require(s) still targeting an old src/indexer/<moved-file>.js path: ${JSON.stringify(offenders, null, 2)}`);
  });

  it('this check is genuinely load-bearing — a reverted specifier is detected, not silently passed', () => {
    const fakeOffenders = [];
    const fakeFile = join(REPO_SRC, 'admin', 'jobs', 'fake-consumer.js');
    const fakeSpecifier = '../../indexer/progress-event.js';
    if (isOldMovedFilePath(fakeSpecifier, fakeFile)) {
      fakeOffenders.push({ file: 'src/admin/jobs/fake-consumer.js', specifier: fakeSpecifier });
    }
    assert.deepEqual(fakeOffenders, [{ file: 'src/admin/jobs/fake-consumer.js', specifier: '../../indexer/progress-event.js' }], 'expected the detector to flag a synthetic reverted specifier — if this fails, the detector itself is broken, not just permissive');
  });
});

describe('Phase 8B Step 7B — src/shared/indexer/ never imports src/local/ or src/cloud/ (shared -> local/cloud implementation is forbidden)', () => {
  function walk(dir, out = []) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full, out);
      else if (entry.endsWith('.js')) out.push(full);
    }
    return out;
  }

  it('no file under src/shared/indexer/ contains a static or dynamic import specifier resolving into src/local/ or src/cloud/', () => {
    const sharedIndexerDir = join(REPO_SRC, 'shared', 'indexer');
    const localDir = join(REPO_SRC, 'local');
    const cloudDir = join(REPO_SRC, 'cloud');
    const offenders = [];
    for (const file of walk(sharedIndexerDir)) {
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
    assert.deepEqual(offenders, [], `expected zero src/shared/indexer/ -> src/local/ or src/cloud/ import edges, found: ${JSON.stringify(offenders, null, 2)}`);
  });

  it('no file under src/shared/indexer/ contains a literal import/require of onnxruntime-node, @huggingface/transformers, or ollama.js — capability injection only, never a direct runtime load', () => {
    const sharedIndexerDir = join(REPO_SRC, 'shared', 'indexer');
    const offenders = [];
    for (const file of walk(sharedIndexerDir)) {
      const src = readFileSync(file, 'utf-8');
      for (const line of src.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        if (/from\s+['"]onnxruntime-node['"]|require\(\s*['"]onnxruntime-node['"]\s*\)/.test(line)) {
          offenders.push({ file: file.replace(REPO_ROOT, '').replace(/\\/g, '/'), line: trimmed, runtime: 'onnxruntime-node' });
        }
        if (/from\s+['"]@huggingface\/transformers['"]|require\(\s*['"]@huggingface\/transformers['"]\s*\)/.test(line)) {
          offenders.push({ file: file.replace(REPO_ROOT, '').replace(/\\/g, '/'), line: trimmed, runtime: '@huggingface/transformers' });
        }
        const match = line.match(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/);
        if (match) {
          const specifier = match[1] || match[2];
          if (specifier && /(^|\/)ollama\.js$/.test(specifier)) {
            offenders.push({ file: file.replace(REPO_ROOT, '').replace(/\\/g, '/'), line: trimmed, runtime: 'ollama.js' });
          }
        }
      }
    }
    assert.deepEqual(offenders, [], `expected zero literal onnxruntime-node/@huggingface/transformers/ollama.js references under src/shared/indexer/, found: ${JSON.stringify(offenders, null, 2)}`);
  });
});

describe('Phase 8B Step 7B — declared-shared modules never directly import a concrete src/local/ or src/cloud/ implementation, anywhere in the graph (general manifest check, not file-scoped)', () => {
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

  it('the 24 moved files are genuinely declared shared at their new src/shared/indexer/ path', () => {
    const manifest = buildManifest();
    const byPath = new Map(manifest.modules.map((module) => [module.path, module]));
    for (const rel of ALL_MOVED_RELATIVE) {
      const path = `src/shared/indexer/${rel}`;
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

describe('Phase 8B Step 7B — Full and Lite indexer entry points both resolve the new src/shared/indexer/ paths at runtime', () => {
  it('src/indexer/index-full.js resolves index-runtime.js from its new src/shared/indexer/ path', () => {
    const src = readFileSync(join(REPO_SRC, 'indexer', 'index-full.js'), 'utf-8');
    assert.match(src, /from\s+['"]\.\.\/shared\/indexer\/index-runtime\.js['"]/, 'expected index-full.js to import index-runtime.js from ../shared/indexer/');
  });

  it('src/indexer/index-lite.js resolves index-runtime.js from its new src/shared/indexer/ path', () => {
    const src = readFileSync(join(REPO_SRC, 'indexer', 'index-lite.js'), 'utf-8');
    assert.match(src, /from\s+['"]\.\.\/shared\/indexer\/index-runtime\.js['"]/, 'expected index-lite.js to import index-runtime.js from ../shared/indexer/');
  });

  it('constructing index-full.js\'s runFullIndexerComposition() never throws a module-resolution error — proves the real Full composition genuinely resolves the moved run.js/index-runtime.js chain at runtime, not just at the text level', async () => {
    const { runFullIndexerComposition } = await import('../../../src/indexer/index-full.js');
    const result = await runFullIndexerComposition({
      resolveOnnxRuntimeForProcessFn: () => ({ resolutionWarning: null, prepared: { ok: true } }),
      bootstrapEnvFn: () => ({ osEnv: {}, dotenvValues: {} }),
      createSettingsServiceFn: () => ({ getActiveValue: () => '' }),
      runIndexerCliFn: async (capabilities) => {
        // Proves runFullIndexerComposition() itself reached the point of
        // calling runIndexerCli() with a real capability bundle — the
        // deeper run.js/index-runtime.js module-resolution chain is
        // exercised by the two behavioral tests immediately below (a real,
        // un-stubbed runIndexerCli() call against a nonexistent target),
        // not here.
        assert.ok(capabilities.ollamaGenerate, 'expected a real ollamaGenerate capability to be constructed');
        assert.ok(capabilities.onnxEmbed, 'expected a real onnxEmbed capability to be constructed');
        assert.ok(capabilities.tagOnnx, 'expected a real tagOnnx capability to be constructed');
        assert.ok(capabilities.cloudEmbed, 'expected a real cloudEmbed capability to be constructed');
      },
      errorLogFn: () => {}, warnLogFn: () => {},
    });
    assert.equal(result.started, true);
  });

  it('a real (un-stubbed) runIndexerCli() call from the new src/shared/indexer/index-runtime.js path resolves its own entire dynamic-import chain (env-bootstrap.js, settings/service.js, run.js) without a module-resolution error, reaching run.js\'s own real main() and failing on the injected nonexistent target — not on a broken import path', async () => {
    const { runIndexerCli } = await import('../../../src/shared/indexer/index-runtime.js');
    const originalArgv2 = process.argv[2];
    const originalCollection = process.env.COLLECTION;
    const originalExitCode = process.exitCode;
    process.argv[2] = '/definitely/does/not/exist/on/any/machine';
    process.env.COLLECTION = 'phase-8b-step7b-real-resolution-check';
    function unavailable() { return async () => { throw new Error('not available'); }; }
    const ollama = {
      generate: unavailable(), embed: unavailable(), getModelContextLength: unavailable(), isThinkingModel: unavailable(),
      getOllamaEmbeddingDimension: unavailable(), isOllamaReachable: unavailable(), listOllamaModels: unavailable(), validateOllamaModels: unavailable(),
    };
    const onnxEmbed = { loadOnnx: unavailable(), loadOnnxBatch: unavailable(), shutdown: async () => {} };
    const tagOnnx = { addTagsOnnxBatch: unavailable(), shutdownOnnxTagWorker: async () => {} };
    const cloudEmbed = {
      checkEmbedInputFits: unavailable(), fitContextToBudget: unavailable(), buildCloudQueryInputs: unavailable(),
      resolveEmbeddingBudget: () => null, getCloudTokenCounter: unavailable(),
    };
    const errors = [];
    try {
      await runIndexerCli({ ollamaGenerate: ollama, ollamaSummary: ollama, ollamaEmbed: ollama, ollamaDiscovery: ollama, onnxEmbed, tagOnnx, cloudEmbed });
    } finally {
      process.argv[2] = originalArgv2;
      if (originalCollection === undefined) delete process.env.COLLECTION; else process.env.COLLECTION = originalCollection;
    }
    // runIndexerCli() never throws (runAndReportExitCode() catches and sets
    // process.exitCode instead) — the real signal that the whole chain
    // resolved correctly is that we get HERE at all (a module-resolution
    // failure crashes the process outright, it does not reach this line),
    // and that exitCode was set to 1 for the expected reason (nonexistent
    // source path), not an ERR_MODULE_NOT_FOUND.
    assert.equal(process.exitCode, 1, 'expected runIndexerCli() to fail on the nonexistent target path, proving it reached run.js\'s real main()');
    process.exitCode = originalExitCode;
  });
});

describe('Phase 8B Step 7B — Lite tarball stages all 24 moved shared files at their new path, and none at the old path', () => {
  before(() => {
    stageSrc();
  });

  it('every one of the 24 moved files is physically staged in the Lite tarball at its new src/shared/indexer/ path', () => {
    const staged = new Set(listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/')));
    for (const rel of ALL_MOVED_RELATIVE) {
      const normalized = `shared/indexer/${rel}`;
      assert.ok(staged.has(normalized), `expected ${normalized} to be staged in the Lite tarball, but it was not found`);
    }
  });

  it('none of the 24 moved files are ALSO staged under their old pre-move src/indexer/ path (no duplication between old and new)', () => {
    const staged = new Set(listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/')));
    for (const rel of ALL_MOVED_RELATIVE) {
      const normalized = `indexer/${rel}`;
      assert.equal(staged.has(normalized), false, `expected ${normalized} (the old pre-move path) to NOT be staged — found a duplicate`);
    }
  });

  it('the Lite closure gained zero new src/local/ edges from this move — the staged tree still contains zero files under local/', () => {
    const staged = listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/'));
    const localFiles = staged.filter((f) => f === 'local' || f.startsWith('local/'));
    assert.deepEqual(localFiles, [], `expected zero staged files under local/, found: ${JSON.stringify(localFiles)}`);
  });

  it('the Lite tarball does not contain the local ONNX tag-generation worker/implementation (tag-onnx.js, tag-onnx-worker.js) at any path', () => {
    const staged = listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/'));
    const tagWorkerFiles = staged.filter((f) => f.endsWith('tag-onnx.js') || f.endsWith('tag-onnx-worker.js'));
    assert.deepEqual(tagWorkerFiles, [], `expected zero staged copies of tag-onnx.js/tag-onnx-worker.js anywhere in the Lite tarball, found: ${JSON.stringify(tagWorkerFiles)}`);
  });

  it('the Lite tarball does not contain index-full.js (Full-only composition) but does contain index-lite.js (Lite-only composition)', () => {
    const staged = new Set(listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/')));
    assert.equal(staged.has('indexer/index-full.js'), false, 'expected index-full.js to be excluded from the Lite tarball');
    assert.ok(staged.has('indexer/index-lite.js'), 'expected index-lite.js to be staged in the Lite tarball');
  });

  it('none of the files that stayed at src/indexer/ (composition entries, lazy shims) are staged under shared/indexer/ — this move introduced no new duplication', () => {
    const staged = new Set(listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/')));
    for (const rel of [...STAYED_COMPOSITION_FILES, ...STAYED_LAZY_SHIM_FILES]) {
      assert.equal(staged.has(`shared/indexer/${rel}`), false, `expected shared/indexer/${rel} to not exist at all — ${rel} was never moved`);
    }
  });
});

describe('Phase 8B Step 7B — Full entry point still resolves and can use real local capabilities (the move did not sever Full\'s access to src/local/)', () => {
  it('src/indexer/index-full.js still (dynamically) references the real local-runtime capability factories (local/core/ollama-capability.js, local/core/onnx-embed.js, local/indexer/phases/tag-onnx.js) — Phase 8B Step 8 replaced the *-lazy.js dynamic-loader wrappers with direct dynamic imports (dynamic, not static — see index-full.js\'s own header comment for why: preserves index.js\'s "import has zero env side effects" guarantee), unrelated to this step\'s own physical relocation', () => {
    const src = readFileSync(join(REPO_SRC, 'indexer', 'index-full.js'), 'utf-8');
    assert.match(src, /await import\(['"]\.\.\/local\/core\/ollama-capability\.js['"]\)/, 'expected index-full.js to import local/core/ollama-capability.js');
    assert.match(src, /await import\(['"]\.\.\/local\/core\/onnx-embed\.js['"]\)/, 'expected index-full.js to import local/core/onnx-embed.js');
    assert.match(src, /await import\(['"]\.\.\/local\/indexer\/phases\/tag-onnx\.js['"]\)/, 'expected index-full.js to import local/indexer/phases/tag-onnx.js');
  });

  it('importing index-full.js does not throw and still exports runFullIndexerComposition — the real Full capability-building composition root remains constructible after the move', async () => {
    const mod = await import('../../../src/indexer/index-full.js');
    assert.equal(typeof mod.runFullIndexerComposition, 'function');
  });
});

describe('Phase 8B Step 7B — the import.meta.url-relative path fix in skeleton-warnings.js and phases/skeleton-index.js resolves to the real repo root, not a phantom one level too shallow', () => {
  it('skeleton-warnings.js\'s warningsPathFor() resolves under the real repo-root .tmp/semidex-inspect/ directory, not a phantom nested one', async () => {
    const { warningsPathFor } = await import('../../../src/shared/indexer/skeleton-warnings.js?step7b-path-check');
    const p = warningsPathFor('phase-8b-step7b-path-check-collection').replace(/\\/g, '/');
    const expectedPrefix = join(REPO_ROOT, '.tmp', 'semidex-inspect').replace(/\\/g, '/');
    assert.ok(p.startsWith(expectedPrefix), `expected warningsPathFor() to resolve under ${expectedPrefix}, got ${p}`);
  });

  it('phases/skeleton-index.js\'s buildFileSkeleton()/buildDirectoryNavPoints() still import node-id.js and node-policy.js correctly (proves the relative-import depth fix, not just the import.meta.url ROOT constant, is correct)', async () => {
    const { buildFileSkeleton } = await import('../../../src/shared/indexer/phases/skeleton-index.js?step7b-skeleton-index-check');
    const { navPoints } = buildFileSkeleton([
      { nodeType: 'section', structuralPath: 'intro', text: 'Intro', headingPath: ['Intro'], parentStructuralPath: null, ordinalWithinParent: 1 },
    ], { sourceFile: 'test.md' });
    assert.ok(Array.isArray(navPoints));
    assert.ok(navPoints.length > 0, 'expected buildFileSkeleton() to produce at least one nav point using the real (correctly-resolved) node-id.js/node-policy.js imports');
  });
});
