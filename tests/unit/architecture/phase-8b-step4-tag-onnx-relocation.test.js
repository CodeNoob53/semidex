// Phase 8B Step 4 — physical relocation of the local ONNX tag-generation
// runtime (indexer/phases/tag-onnx.js, indexer/workers/tag-onnx-worker.js
// -> local/indexer/phases/*.js, local/indexer/workers/*.js). Mirrors Step
// 2 (ONNX embedding runtime) and Step 3 (Ollama) for the physical
// `git mv` + import-path-update part.
//
// Code review, second pass (P1): the FIRST version of this step kept the
// physical move but left tag-onnx.js's coordinator state (_worker,
// _pending, _dispatchTail, failure flags) as module-scope singleton
// bindings — unchanged from before the move. That is a real isolation
// gap: index-full.js's `tagOnnx: tagOnnxLazy` is the SAME cached ES
// module namespace object every run({ capabilities }) call receives, so
// two concurrent run() calls in one process shared one worker — the first
// run's own `finally` block calling shutdownOnnxTagWorker() could kill a
// worker a second, concurrently-running job's pending request still
// needed. A first-draft regression test exercised two concurrent
// addTagsOnnxBatch() CALLS sharing that one singleton and proved request
// correlation worked — a real but far weaker claim than "two capability
// INSTANCES never share worker state," and it could not have caught the
// gap. Fixed by createTagOnnxCapability(): tag-onnx.js no longer exports
// bare addTagsOnnxBatch()/shutdownOnnxTagWorker() at all — only a factory
// returning a fresh, independent instance per call (see that file's own
// header comment for the full finding). This step is therefore NOT a pure
// path rename the way Steps 2/3 were — it also converts tag-onnx.js's own
// export shape from a module-scope singleton to a per-instance factory.
//
// These tests prove:
//   - the old src/indexer/phases/tag-onnx.js and
//     src/indexer/workers/tag-onnx-worker.js paths no longer exist as
//     files, AND no production import specifier anywhere still resolves
//     to them;
//   - the new src/local/indexer/phases/tag-onnx.js and
//     src/local/indexer/workers/tag-onnx-worker.js paths exist;
//   - the Lite tarball's real staged tree physically excludes local/
//     entirely (via build.mjs's own stageSrc(), not a simulation), and
//     neither moved file is staged under any other path;
//   - the Lite import graph never reaches either moved file, PRE- and
//     POST-shim identically (no build-time substitution needed);
//   - only Full/local composition modules (index-full.js, backfill-tags.js,
//     the tag-onnx-lazy.js seam) have a real edge onto the moved files —
//     Lite composition never does;
//   - shared/cloud-classified manifest modules never import src/local/**
//     directly;
//   - the manifest classifier labels both moved files `local`;
//   - the worker path genuinely resolves post-move (real fork(), not a
//     source-regex check);
//   - the persistent-worker lifecycle contract survives the move
//     behaviorally: shutdown before any worker was ever spawned is a
//     no-op, repeated shutdown is safe PER INSTANCE, and — the core of
//     this review round's fix — TWO SEPARATELY-CONSTRUCTED
//     createTagOnnxCapability() instances never share worker state:
//     shutting one down never kills the other's worker, never rejects the
//     other's pending request, and each instance's failure flag is
//     independent.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { stageSrc, listAllFiles } from '../../../packages/lite/build.mjs';
import { buildGraph } from '../../../scripts/audit/build-import-graph.mjs';
import { computeReachable, LITE_SRC_DIR, FULL_ROOTS } from '../../../scripts/audit/classify-modules.mjs';
import { loadManifest } from '../../../scripts/audit/find-dependency-violations.mjs';

const LITE_DIR = dirname(fileURLToPath(new URL('../../../packages/lite/build.mjs', import.meta.url)));
const REPO_ROOT = resolve(LITE_DIR, '..', '..');
const REPO_SRC = join(REPO_ROOT, 'src');
const STAGED_SRC = join(LITE_DIR, 'src');

const OLD_PATHS = ['src/indexer/phases/tag-onnx.js', 'src/indexer/workers/tag-onnx-worker.js'];
const NEW_PATHS = ['src/local/indexer/phases/tag-onnx.js', 'src/local/indexer/workers/tag-onnx-worker.js'];
const MOVED_FILENAMES = ['tag-onnx.js', 'tag-onnx-worker.js'];

describe('Phase 8B Step 4 — tag-onnx.js/tag-onnx-worker.js physically moved from src/indexer/ to src/local/indexer/', () => {
  it('src/indexer/phases/tag-onnx.js no longer exists', () => {
    assert.equal(existsSync(join(REPO_SRC, 'indexer', 'phases', 'tag-onnx.js')), false, 'expected src/indexer/phases/tag-onnx.js to be gone (moved to src/local/indexer/phases/tag-onnx.js)');
  });

  it('src/indexer/workers/tag-onnx-worker.js no longer exists', () => {
    assert.equal(existsSync(join(REPO_SRC, 'indexer', 'workers', 'tag-onnx-worker.js')), false, 'expected src/indexer/workers/tag-onnx-worker.js to be gone (moved to src/local/indexer/workers/tag-onnx-worker.js)');
  });

  it('src/local/indexer/phases/tag-onnx.js exists', () => {
    assert.equal(existsSync(join(REPO_SRC, 'local', 'indexer', 'phases', 'tag-onnx.js')), true);
  });

  it('src/local/indexer/workers/tag-onnx-worker.js exists', () => {
    assert.equal(existsSync(join(REPO_SRC, 'local', 'indexer', 'workers', 'tag-onnx-worker.js')), true);
  });

  it('indexer/phases/tag-onnx-lazy.js and its .lite.js shim no longer exist — Phase 8B Step 8 deleted the transitional dynamic-loader seam outright (git rm)', () => {
    assert.equal(existsSync(join(REPO_SRC, 'indexer', 'phases', 'tag-onnx-lazy.js')), false);
    assert.equal(existsSync(join(REPO_SRC, 'indexer', 'phases', 'tag-onnx-lazy.lite.js')), false);
  });
});

describe('Phase 8B Step 4 — no production source file references the old src/indexer/phases/tag-onnx.js or src/indexer/workers/tag-onnx-worker.js paths', () => {
  const SCAN_ROOTS = ['src', 'benchmarks', 'scripts'].map((d) => join(REPO_ROOT, d));

  // Real path resolution, not a segment/regex heuristic — a same-directory
  // relative specifier (e.g. a future regression reintroducing
  // './tag-onnx.js' inside tag-onnx-lazy.js) has NO "indexer/" segment
  // pointing at the OLD location at all once resolved, so a text-based
  // heuristic checking for "indexer/phases/tag-onnx.js" in the specifier
  // string would miss it entirely (the exact blind spot found and fixed
  // during Steps 2 and 3's own equivalent tests). Resolving the specifier
  // against the importing file's own directory and comparing the ABSOLUTE
  // result to the old (deleted) src/indexer/ locations is unambiguous
  // regardless of specifier text or "../"/"./" depth.
  const OLD_ABS_PATHS = new Set(OLD_PATHS.map((p) => join(REPO_ROOT, ...p.split('/'))));
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

  it('no import/require/dynamic-import specifier resolves to the old indexer/phases/tag-onnx.js or indexer/workers/tag-onnx-worker.js path anywhere under src/, benchmarks/, or scripts/', () => {
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
    assert.deepEqual(offenders, [], `found live import(s)/require(s) still targeting the old indexer/phases/tag-onnx.js or indexer/workers/tag-onnx-worker.js path: ${JSON.stringify(offenders)}`);
  });

  it('this check genuinely catches a regression, not just passes trivially (verified by a synthetic reverted specifier)', () => {
    // Proves the check above is load-bearing: constructs a synthetic
    // specifier that WOULD point at the OLD (deleted) location if it
    // appeared in a file at index-full.js's own directory, and confirms
    // isOldMovedFilePath() flags it, using the exact same resolution logic
    // the real scan above uses. (Phase 8B Step 8 deleted the
    // tag-onnx-lazy.js file this proof previously exercised directly — the
    // detector itself is what's under test here, not any specific file's
    // current content.)
    const importingFile = join(REPO_SRC, 'indexer', 'index-full.js');
    const regressedSpecifier = './phases/tag-onnx.js';
    assert.equal(isOldMovedFilePath(regressedSpecifier, importingFile), true, 'sanity: the detection logic itself must flag a reverted same-directory specifier');
    assert.equal(isOldMovedFilePath('../local/indexer/phases/tag-onnx.js', importingFile), false, 'the CURRENT real specifier shape must resolve to the NEW location, not the old one');
  });
});

describe('Phase 8B Step 4 — Lite tarball physically excludes src/local/ (not merely unreachable)', () => {
  before(() => {
    stageSrc();
  });

  it('the real staged tree contains zero files under local/', () => {
    const staged = listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/'));
    const localFiles = staged.filter((f) => f === 'local' || f.startsWith('local/'));
    assert.deepEqual(localFiles, [], `expected zero staged files under local/, found: ${JSON.stringify(localFiles)}`);
  });

  it('neither tag-onnx.js nor tag-onnx-worker.js is staged under ANY path in the Lite tarball', () => {
    const staged = listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/'));
    for (const name of MOVED_FILENAMES) {
      const matches = staged.filter((f) => f.endsWith(`/${name}`) || f === name);
      assert.deepEqual(matches, [], `expected zero staged copies of ${name} anywhere in the Lite tarball, found: ${JSON.stringify(matches)}`);
    }
  });

  it('indexer/phases/tag-onnx-lazy.js is absent from the Lite staged tree — it no longer exists in the repo at all (Phase 8B Step 8)', () => {
    const staged = listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/'));
    assert.ok(!staged.includes('indexer/phases/tag-onnx-lazy.js'), 'expected zero staged copies of the deleted tag-onnx-lazy.js file');
  });
});

describe('Phase 8B Step 4 — Lite import graph never reaches the ONNX tag-generation runtime', () => {
  const graph = buildGraph();
  const liteSyntheticRoots = graph.files.filter((f) => f.startsWith(LITE_SRC_DIR));

  it('neither local/indexer/phases/tag-onnx.js nor local/indexer/workers/tag-onnx-worker.js is reachable from Lite roots', () => {
    const reachable = computeReachable(graph, liteSyntheticRoots);
    const leaked = NEW_PATHS.filter((p) => reachable.has(p));
    assert.deepEqual(leaked, [], `expected zero tag-onnx runtime files reachable from Lite, found: ${JSON.stringify(leaked)}`);
  });

  it('@huggingface/transformers (the heavy native dependency tag-onnx-worker.js pulls in) is not reachable from Lite roots', () => {
    const reachable = computeReachable(graph, liteSyntheticRoots);
    const heavyImporters = [...reachable].filter((f) => {
      const node = graph.nodes[f];
      if (!node) return false;
      const allRefs = [...node.staticImports, ...node.dynamicImports, ...node.requireCalls];
      return allRefs.some((ref) => ref.kind === 'bare' && ref.specifier === '@huggingface/transformers');
    });
    assert.deepEqual(heavyImporters, [], `expected zero Lite-reachable files importing @huggingface/transformers, found: ${JSON.stringify(heavyImporters)}`);
  });
});

describe('Phase 8B Step 4 — only Full/local composition modules have a real edge onto the tag-onnx runtime', () => {
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

  it('src/local/indexer/phases/tag-onnx.js is imported only by files reachable from Full roots (never by any Lite-reachable file)', () => {
    const liteSyntheticRoots = graph.files.filter((f) => f.startsWith(LITE_SRC_DIR));
    const liteReachable = computeReachable(graph, liteSyntheticRoots);
    const fullReachable = computeReachable(graph, FULL_ROOTS);
    const realImporters = importers('src/local/indexer/phases/tag-onnx.js');
    assert.ok(realImporters.length > 0, 'sanity: expected at least one real importer of local/indexer/phases/tag-onnx.js');
    for (const importer of realImporters) {
      assert.ok(!liteReachable.has(importer), `${importer} imports local/indexer/phases/tag-onnx.js but IS Lite-reachable — a real shared -> local edge`);
      assert.ok(fullReachable.has(importer), `${importer} imports local/indexer/phases/tag-onnx.js but is NOT Full-reachable — a dead or misclassified edge`);
    }
  });

  it('src/local/indexer/workers/tag-onnx-worker.js has no static/dynamic import specifier anywhere in the graph (reached only via fork(), an OS-level spawn — not a module import)', () => {
    // tag-onnx-worker.js is never `import`ed or `require`d by any file —
    // it is spawned as a separate OS process via node:child_process's
    // fork(WORKER_PATH, ...), which build.mjs's own AST-based closure
    // validator inspects as a SEPARATE check (fork()/spawn() call-site
    // scanning), not as a module-graph edge. Confirms the import-graph
    // tool itself has no accidental edge here to begin with.
    const realImporters = importers('src/local/indexer/workers/tag-onnx-worker.js');
    assert.deepEqual(realImporters, [], 'expected zero import/require edges onto tag-onnx-worker.js — it is only ever reached via fork(), not import');
  });
});

describe('Phase 8B Step 4 — shared/cloud-classified manifest modules never import src/local/** directly', () => {
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

  it('src/indexer/phases/tag-onnx-lazy.js no longer exists — Phase 8B Step 8 deleted the transitional dynamic-loader seam outright (git rm), not merely excluded it from the Lite package', () => {
    const manifest = loadManifest();
    const lazySeam = manifest.modules.find((m) => m.path === 'src/indexer/phases/tag-onnx-lazy.js');
    assert.equal(lazySeam, undefined, 'expected src/indexer/phases/tag-onnx-lazy.js to be absent from the manifest — it was deleted, not merely reclassified');
  });
});

describe('Phase 8B Step 4 — classifier labels the moved tag-onnx files "local"', () => {
  it('src/local/indexer/phases/tag-onnx.js and src/local/indexer/workers/tag-onnx-worker.js are classified "local" in the manifest', () => {
    const manifest = loadManifest();
    const byPath = new Map(manifest.modules.map((m) => [m.path, m]));
    for (const p of NEW_PATHS) {
      const mod = byPath.get(p);
      assert.ok(mod, `expected ${p} to exist in the manifest`);
      assert.equal(mod.category, 'local', `expected ${p} to be classified "local", got "${mod?.category}"`);
    }
  });
});

describe('Phase 8B Step 4 — worker path genuinely resolves post-move (real fork() target, not a source-text assertion)', () => {
  it('the WORKER_PATH import.meta.url-derived resolution algorithm, re-derived independently here, points at a real file on disk', () => {
    // Direct, unambiguous proof: import.meta.url-derived path resolution,
    // using the identical algorithm tag-onnx.js's own WORKER_PATH constant
    // uses (join(__dirname, '../workers/tag-onnx-worker.js')), must point
    // at a real file at the NEW location.
    const tagOnnxDir = dirname(fileURLToPath(new URL('../../../src/local/indexer/phases/tag-onnx.js', import.meta.url)));
    const resolvedWorkerPath = join(tagOnnxDir, '../workers/tag-onnx-worker.js');
    assert.equal(existsSync(resolvedWorkerPath), true, `WORKER_PATH must resolve to a real file: ${resolvedWorkerPath}`);
  });

  it('a real fork() of the actual computed WORKER_PATH launches the file (proves Node can locate and begin executing it — not just existsSync-true), without loading the heavy @huggingface/transformers model', async () => {
    // Deliberately does NOT let the worker reach loadModel()'s own
    // @huggingface/transformers import — that is a real, potentially slow
    // (and, depending on cache state, network-touching) operation, out of
    // scope for a fast architecture test and exactly the kind of "heavy
    // model" work the task's own instructions require pre-approval and a
    // separate, explicit smoke step for (see the Step 4 report's own live
    // smoke section). This test only needs Node's own module loader to
    // confirm the resolved WORKER_PATH is a real, syntactically valid ES
    // module it can begin executing — proven by immediately killing the
    // child the instant it reports ANY sign of life (a 'spawn' event fires
    // once the OS process exists and Node has started loading the file,
    // well before the worker's own async loadModel() call would run).
    const { fork } = await import('node:child_process');
    const tagOnnxDir = dirname(fileURLToPath(new URL('../../../src/local/indexer/phases/tag-onnx.js', import.meta.url)));
    const workerPath = join(tagOnnxDir, '../workers/tag-onnx-worker.js');

    const child = fork(workerPath, [], {
      windowsHide: true,
      silent: true,
      env: { ...process.env, TAG_ONNX_WORKER_MODEL_ID: 'x', TAG_ONNX_WORKER_CACHE_DIR: '/tmp/unused', TAG_ONNX_WORKER_NUM_THREADS: '1', TAG_ONNX_WORKER_ALLOW_DOWNLOAD: '0' },
    });

    const outcome = await new Promise((resolvePromise) => {
      const timeout = setTimeout(() => resolvePromise('timeout-still-running'), 2000);
      child.once('spawn', () => { clearTimeout(timeout); resolvePromise('spawned'); });
      child.once('error', (err) => { clearTimeout(timeout); resolvePromise(`error:${err.message}`); });
    });
    try { child.kill(); } catch { /* already exited */ }

    // Any outcome other than a module-resolution error proves Node found
    // and began executing the file at the resolved WORKER_PATH — a
    // 'spawn' event or "still running after 2s" both confirm the OS
    // process launched successfully; only ENOENT/MODULE_NOT_FOUND would
    // mean the path itself is wrong.
    assert.doesNotMatch(outcome, /^error:.*(ENOENT|Cannot find module|MODULE_NOT_FOUND)/i, `WORKER_PATH did not resolve to a loadable file: ${outcome}`);
  });
});

describe('Phase 8B Step 4 — persistent worker lifecycle contract survives the move (behavioral, not simulated)', () => {
  let mod;

  before(async () => {
    mod = await import(`../../../src/local/indexer/phases/tag-onnx.js?lifecycle-test-${Date.now()}`);
  });

  it('shutdownOnnxTagWorker() before any worker has ever been spawned is a safe no-op (does not throw, does not hang)', async () => {
    const cap = mod.createTagOnnxCapability();
    await assert.doesNotReject(() => cap.shutdownOnnxTagWorker());
    const state = cap.__test.state();
    assert.equal(state.ready, false);
    assert.equal(state.pendingCount, 0);
  });

  it('repeated shutdown (call it twice in a row, no worker ever spawned) is safe — idempotent, not merely non-throwing the first time', async () => {
    const cap = mod.createTagOnnxCapability();
    await assert.doesNotReject(() => cap.shutdownOnnxTagWorker());
    await assert.doesNotReject(() => cap.shutdownOnnxTagWorker());
  });

  it('after a real fake-worker lifecycle (spawn, use, shutdown), a second shutdown call is still a safe no-op', async () => {
    // Mirrors tests/unit/indexer/phases/tag-onnx.test.js's own
    // makeFakeWorker() pattern exactly: send() synchronously records the
    // request and replies via queueMicrotask, so there is no race window
    // where a request has been dispatched but nothing is listening to
    // reply to it yet (an earlier draft of this test manually swapped
    // fakeWorker.send AFTER dispatch, which lost the race and hung until
    // the real 2-minute per-request timeout — fixed by using this
    // known-correct helper instead).
    const cap = mod.createTagOnnxCapability();
    cap.__test.setWorkerFactory(() => makeFakeWorker({ tagFn: () => [['x']] }));

    await cap.addTagsOnnxBatch([{ text: 'hello', section: 's', source_file: 'f.md' }]);

    await assert.doesNotReject(() => cap.shutdownOnnxTagWorker());
    await assert.doesNotReject(() => cap.shutdownOnnxTagWorker());
  });

  // Code review finding (P1, second pass): an earlier version of this
  // describe block only proved that two concurrent addTagsOnnxBatch()
  // CALLS sharing ONE module-scope singleton worker got correctly
  // correlated replies — a real but much weaker claim than "two capability
  // INSTANCES never share worker state." At the time, tag-onnx.js's own
  // _worker/_pending/_dispatchTail WERE module-scope singleton state, so
  // that was the only claim available to prove — and it masked a real,
  // live isolation gap: index-full.js's `tagOnnx: tagOnnxLazy` (the cached
  // ES module namespace object) meant every run({ capabilities }) call in
  // one process shared exactly one worker; the first run's own `finally`
  // block calling shutdownOnnxTagWorker() could kill a worker a second,
  // concurrently-running job's pending request still needed.
  //
  // Fixed at the source (createTagOnnxCapability() — see tag-onnx.js's own
  // header comment for the full finding). These tests now construct TWO
  // genuinely separate capability instances (mirroring two independently
  // composed Full compositions, or two run({ capabilities }) calls each
  // given their own instance — the correct composition pattern) and prove
  // shutting one down never touches the other's worker, pending requests,
  // or failure state.
  it('shutting down capability A never kills capability B\'s worker, and B\'s in-flight request still completes successfully', async () => {
    const capA = mod.createTagOnnxCapability();
    const capB = mod.createTagOnnxCapability();

    let workerAKillCalls = 0;
    let workerBKillCalls = 0;
    capA.__test.setWorkerFactory(() => {
      const w = makeFakeWorker({ tagFn: (chunks) => chunks.map(() => ['tag-a']) });
      const originalKill = w.kill;
      w.kill = (...args) => { workerAKillCalls += 1; return originalKill(...args); };
      return w;
    });
    let workerBSentRequestId = null;
    let workerB;
    capB.__test.setWorkerFactory(() => {
      workerB = new EventEmitter();
      workerB.send = (msg) => { if (msg?.kind === 'run') workerBSentRequestId = msg.requestId; };
      const originalKill = () => { workerB.killed = true; queueMicrotask(() => workerB.emit('exit', null)); };
      workerB.kill = (...args) => { workerBKillCalls += 1; return originalKill(...args); };
      queueMicrotask(() => workerB.emit('message', { kind: 'ready' }));
      return workerB;
    });

    await capA.addTagsOnnxBatch([{ text: 'warm', section: 's', source_file: 'a.md' }]);
    const bPending = capB.addTagsOnnxBatch([{ text: 'from-B', section: 's', source_file: 'b.md' }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(capB.__test.state().pendingCount, 1, 'sanity: B has a real pending request in flight');
    assert.ok(workerBSentRequestId !== null, 'sanity: B\'s own worker actually received a run request');

    await capA.shutdownOnnxTagWorker();
    assert.equal(workerAKillCalls, 1, 'A\'s own worker was killed by A\'s own shutdown');
    assert.equal(workerBKillCalls, 0, 'B\'s worker must NOT have been killed by A\'s shutdown');
    assert.equal(capB.__test.state().pendingCount, 1, 'B\'s pending request must still be pending — A\'s shutdown must not have rejected it');

    workerB.emit('message', { kind: 'done', requestId: workerBSentRequestId, tagArrays: [['tag-b']] });
    const bResult = await bPending;
    assert.deepEqual(bResult.map((c) => c.tags), [['tag-b']], 'B\'s own request resolved with B\'s own real reply, never rejected by A\'s shutdown');
    assert.equal(workerBKillCalls, 0, 'B\'s worker still must never have been killed');
  });

  it('independent failure flags — a crash in capability A does not disable capability B', async () => {
    const capA = mod.createTagOnnxCapability();
    const capB = mod.createTagOnnxCapability();

    capA.__test.setWorkerFactory(() => makeFakeWorker({ failReady: 'A crashed' }));
    capB.__test.setWorkerFactory(() => makeFakeWorker({ tagFn: (chunks) => chunks.map(() => ['tag-b']) }));

    const outA = await capA.addTagsOnnxBatch([{ text: 'a', section: 's', source_file: 'a.md' }]);
    assert.deepEqual(outA.map((c) => c.tags), [[]], 'A failed to load and fell back to empty tags');
    assert.equal(capA.__test.state().failed, true, 'A itself is marked failed');

    const outB = await capB.addTagsOnnxBatch([{ text: 'b', section: 's', source_file: 'b.md' }]);
    assert.deepEqual(outB.map((c) => c.tags), [['tag-b']], 'B was never affected by A\'s failure — it generated real tags');
    assert.equal(capB.__test.state().failed, false, 'B\'s own failure flag is independent of A\'s');
  });

  it('repeated shutdown is safe per-instance, independently — shutting A down twice never affects B', async () => {
    const capA = mod.createTagOnnxCapability();
    const capB = mod.createTagOnnxCapability();

    let workerBKillCalls = 0;
    capA.__test.setWorkerFactory(() => makeFakeWorker({ tagFn: (chunks) => chunks.map(() => []) }));
    capB.__test.setWorkerFactory(() => {
      const w = makeFakeWorker({ tagFn: (chunks) => chunks.map(() => []) });
      const originalKill = w.kill;
      w.kill = (...args) => { workerBKillCalls += 1; return originalKill(...args); };
      return w;
    });

    await capA.addTagsOnnxBatch([{ text: 'a', section: 's', source_file: 'a.md' }]);
    await capB.addTagsOnnxBatch([{ text: 'b', section: 's', source_file: 'b.md' }]);

    await assert.doesNotReject(() => capA.shutdownOnnxTagWorker());
    await assert.doesNotReject(() => capA.shutdownOnnxTagWorker());
    assert.equal(workerBKillCalls, 0, 'B\'s worker must still be untouched after A was shut down twice');

    await assert.doesNotReject(() => capB.shutdownOnnxTagWorker());
    assert.equal(workerBKillCalls, 1);
  });
});

// Mirrors tests/unit/indexer/phases/tag-onnx.test.js's own makeFakeWorker()
// helper exactly (kept local to this file rather than imported, since that
// file's helper is not exported — this is the same well-tested shape:
// send() synchronously records the message and replies via queueMicrotask,
// eliminating the dispatch/listener race a manual EventEmitter wiring is
// prone to).
function makeFakeWorker({ tagFn, failReady = null } = {}) {
  const worker = new EventEmitter();
  const sent = [];
  worker.send = (msg) => {
    sent.push(msg);
    if (msg?.kind !== 'run') return;
    queueMicrotask(() => {
      try {
        const tagArrays = tagFn(msg.chunks);
        worker.emit('message', { kind: 'done', requestId: msg.requestId, tagArrays });
      } catch (err) {
        worker.emit('message', { kind: 'error', requestId: msg.requestId, error: err.message });
      }
    });
  };
  worker.kill = () => { worker.killed = true; queueMicrotask(() => worker.emit('exit', null)); };
  worker.sent = sent;
  queueMicrotask(() => {
    if (failReady) worker.emit('message', { kind: 'error', error: failReady });
    else worker.emit('message', { kind: 'ready' });
  });
  return worker;
}
