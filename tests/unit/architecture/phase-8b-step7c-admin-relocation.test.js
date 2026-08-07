// Phase 8B Step 7C — physical relocation of the Admin runtime and Admin UI
// by ownership: shared Admin API/server infrastructure/jobs/UI to
// src/shared/admin/; local-only Admin API/system/UI to src/local/admin/;
// cloud-only Admin API/system stayed at src/cloud/admin/ (already
// relocated by Phase 8B Step 6); src/admin/ now contains only the
// Full/Lite composition roots and edition entry points.
//
// Moved via `git mv` (history preserved):
//   src/admin/{router.js,server.js,static.js,register-neutral-routes.js}
//     -> src/shared/admin/
//   src/admin/api/{assembly,chunks,collections,documents,generation-models,
//     generation,health,jobs,node,operations,query-params,search,settings,
//     skeleton,system}.js -> src/shared/admin/api/
//   src/admin/jobs/{registry,task-registry}.js -> src/shared/admin/jobs/
//   src/admin/system/folder-picker.js -> src/shared/admin/system/
//   src/admin/ui-src/{api,app.css,app.js,assembly-view,collection-view,dom,
//     file-view,format,global-settings-view,icons,jobs-view,operation-modal,
//     operation-render,operation-store,router,routes,search,settings-view,
//     sidebar-resize,sidebar,state,structural-renderer,toasts,topbar}.{js,css}
//     -> src/shared/admin/ui-src/
//   src/admin/ui-src/partials/shared/** -> src/shared/admin/ui-src/partials/shared/**
//   src/admin/api/{onnx,ollama-models}.js -> src/local/admin/api/
//   src/admin/system/ollama.js -> src/local/admin/system/ollama.js
//   src/admin/ui-src/local-features.js -> src/local/admin/ui-src/local-features.js
//   src/admin/ui-src/partials/full/** -> src/local/admin/ui-src/partials/full/**
//
// Left at src/admin/ (composition-owned, explicitly out of scope for this
// move): bootstrap.js, server-full.js, composition/lite.js,
// jobs/spawn-indexer-{full,lite}.js, ui-src/entries/{full,lite}.js,
// ui-src/index.html, ui-src/lite-entry/index.html,
// ui-src/partials/lite/{index-view,settings-shell}.html.
//
// This is a pure `git mv` + import-path-update step — no exported
// function/API changed shape, no route/contract change, no UI redesign, no
// behavior change. Real HTTP/UI-build behavioral coverage lives in
// tests/unit/admin/**/*.test.js (1093 tests, all passing post-move) — this
// file covers only the structural/architectural guarantees the task itself
// requires.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageSrc, listAllFiles } from '../../../packages/lite/build.mjs';
import { buildManifest } from '../../../scripts/audit/build-shared-cloud-local-manifest.mjs';
import { buildGraph } from '../../../scripts/audit/build-import-graph.mjs';
import { computeReachable, LOCAL_ONLY_PATH_PATTERNS } from '../../../scripts/audit/classify-modules.mjs';

const LITE_DIR = dirname(fileURLToPath(new URL('../../../packages/lite/build.mjs', import.meta.url)));
const REPO_ROOT = resolve(LITE_DIR, '..', '..');
const REPO_SRC = join(REPO_ROOT, 'src');
const STAGED_SRC = join(LITE_DIR, 'src');

const SHARED_MOVED_TOP = ['router.js', 'server.js', 'static.js', 'register-neutral-routes.js'];
const SHARED_MOVED_API = [
  'assembly.js', 'chunks.js', 'collections.js', 'documents.js', 'generation-models.js', 'generation.js',
  'health.js', 'jobs.js', 'node.js', 'operations.js', 'query-params.js', 'search.js', 'settings.js',
  'skeleton.js', 'system.js',
];
const SHARED_MOVED_JOBS = ['registry.js', 'task-registry.js'];
const SHARED_MOVED_UI_JS = [
  'api.js', 'app.js', 'assembly-view.js', 'collection-view.js', 'dom.js', 'file-view.js', 'format.js',
  'global-settings-view.js', 'icons.js', 'jobs-view.js', 'operation-modal.js', 'operation-render.js',
  'operation-store.js', 'router.js', 'routes.js', 'search.js', 'settings-view.js', 'sidebar-resize.js',
  'sidebar.js', 'state.js', 'structural-renderer.js', 'toasts.js', 'topbar.js',
];
const LOCAL_MOVED_API = ['onnx.js', 'ollama-models.js'];

const COMPOSITION_ROOT_FILES = [
  'src/admin/bootstrap.js', 'src/admin/server-full.js', 'src/admin/composition/lite.js',
  'src/admin/jobs/spawn-indexer-full.js', 'src/admin/jobs/spawn-indexer-lite.js',
  'src/admin/ui-src/entries/full.js', 'src/admin/ui-src/entries/lite.js',
];

function walkJs(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue;
      walkJs(full, out);
    } else if (entry.endsWith('.js') || entry.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

describe('Phase 8B Step 7C — inventory-approved files exist at their new physical path', () => {
  for (const name of SHARED_MOVED_TOP) {
    it(`src/shared/admin/${name} exists`, () => {
      assert.equal(existsSync(join(REPO_SRC, 'shared', 'admin', name)), true, `expected src/shared/admin/${name} to exist`);
    });
  }
  for (const name of SHARED_MOVED_API) {
    it(`src/shared/admin/api/${name} exists`, () => {
      assert.equal(existsSync(join(REPO_SRC, 'shared', 'admin', 'api', name)), true, `expected src/shared/admin/api/${name} to exist`);
    });
  }
  for (const name of SHARED_MOVED_JOBS) {
    it(`src/shared/admin/jobs/${name} exists`, () => {
      assert.equal(existsSync(join(REPO_SRC, 'shared', 'admin', 'jobs', name)), true, `expected src/shared/admin/jobs/${name} to exist`);
    });
  }
  it('src/shared/admin/system/folder-picker.js exists', () => {
    assert.equal(existsSync(join(REPO_SRC, 'shared', 'admin', 'system', 'folder-picker.js')), true);
  });
  for (const name of SHARED_MOVED_UI_JS) {
    it(`src/shared/admin/ui-src/${name} exists`, () => {
      assert.equal(existsSync(join(REPO_SRC, 'shared', 'admin', 'ui-src', name)), true, `expected src/shared/admin/ui-src/${name} to exist`);
    });
  }
  it('src/shared/admin/ui-src/app.css exists', () => {
    assert.equal(existsSync(join(REPO_SRC, 'shared', 'admin', 'ui-src', 'app.css')), true);
  });
  for (const name of LOCAL_MOVED_API) {
    it(`src/local/admin/api/${name} exists`, () => {
      assert.equal(existsSync(join(REPO_SRC, 'local', 'admin', 'api', name)), true, `expected src/local/admin/api/${name} to exist`);
    });
  }
  it('src/local/admin/system/ollama.js exists', () => {
    assert.equal(existsSync(join(REPO_SRC, 'local', 'admin', 'system', 'ollama.js')), true);
  });
  it('src/local/admin/ui-src/local-features.js exists', () => {
    assert.equal(existsSync(join(REPO_SRC, 'local', 'admin', 'ui-src', 'local-features.js')), true);
  });
  for (const name of ['index-view.html', 'onnx-probe-panel.html', 'settings-shell.html']) {
    it(`src/local/admin/ui-src/partials/full/${name} exists`, () => {
      assert.equal(existsSync(join(REPO_SRC, 'local', 'admin', 'ui-src', 'partials', 'full', name)), true);
    });
  }
  for (const name of ['collection-shell.html', 'overview-shell.html']) {
    it(`src/shared/admin/ui-src/partials/shared/${name} exists`, () => {
      assert.equal(existsSync(join(REPO_SRC, 'shared', 'admin', 'ui-src', 'partials', 'shared', name)), true);
    });
  }
  it('src/shared/admin/ui-src/partials/shared/templates/ contains 12 shared template files', () => {
    const dir = join(REPO_SRC, 'shared', 'admin', 'ui-src', 'partials', 'shared', 'templates');
    assert.equal(existsSync(dir), true);
    const files = readdirSync(dir).filter((f) => f.endsWith('.html'));
    assert.equal(files.length, 12, `expected 12 shared template files, found: ${JSON.stringify(files)}`);
  });
  it('src/cloud/admin/{qdrant-cloud-api,qdrant-cloud-system}.js still exist (Phase 8B Step 6, unaffected by this step)', () => {
    assert.equal(existsSync(join(REPO_SRC, 'cloud', 'admin', 'qdrant-cloud-api.js')), true);
    assert.equal(existsSync(join(REPO_SRC, 'cloud', 'admin', 'qdrant-cloud-system.js')), true);
  });

  for (const file of COMPOSITION_ROOT_FILES) {
    it(`${file} (composition-owned) stayed at its original path`, () => {
      assert.equal(existsSync(join(REPO_ROOT, file)), true, `expected ${file} to still exist at src/admin/`);
    });
  }
});

describe('Phase 8B Step 7C — old pre-move production paths are absent (no duplication, no compatibility re-exports)', () => {
  const oldTopFiles = SHARED_MOVED_TOP.map((n) => join('admin', n));
  const oldApiFiles = SHARED_MOVED_API.map((n) => join('admin', 'api', n));
  const oldJobsFiles = SHARED_MOVED_JOBS.map((n) => join('admin', 'jobs', n));
  const oldLocalApiFiles = LOCAL_MOVED_API.map((n) => join('admin', 'api', n));
  const oldUiJsFiles = SHARED_MOVED_UI_JS.map((n) => join('admin', 'ui-src', n));

  for (const rel of [...oldTopFiles, ...oldApiFiles, ...oldJobsFiles, 'admin/system/folder-picker.js', 'admin/system/ollama.js', ...oldLocalApiFiles, ...oldUiJsFiles, 'admin/ui-src/app.css', 'admin/ui-src/local-features.js']) {
    it(`src/${rel.replace(/\\/g, '/')} no longer exists at the old path`, () => {
      assert.equal(existsSync(join(REPO_SRC, rel)), false, `expected src/${rel.replace(/\\/g, '/')} to be gone (moved)`);
    });
  }

  it('src/admin/ui-src/partials/full/ no longer exists at the old path', () => {
    assert.equal(existsSync(join(REPO_SRC, 'admin', 'ui-src', 'partials', 'full')), false);
  });
  it('src/admin/ui-src/partials/shared/ no longer exists at the old path', () => {
    assert.equal(existsSync(join(REPO_SRC, 'admin', 'ui-src', 'partials', 'shared')), false);
  });

  it('the old admin/api/ and admin/system/ directories contain zero leftover .js files (fully relocated, nothing composition-owned remained there)', () => {
    for (const oldDir of ['api', 'system']) {
      const dirPath = join(REPO_SRC, 'admin', oldDir);
      if (!existsSync(dirPath)) continue; // fully removed is also acceptable
      const remaining = readdirSync(dirPath).filter((f) => f.endsWith('.js'));
      assert.deepEqual(remaining, [], `expected src/admin/${oldDir}/ to contain zero leftover .js files, found: ${JSON.stringify(remaining)}`);
    }
  });

  it('admin/jobs/ contains ONLY the two composition-owned spawn-indexer-*.js files (registry.js/task-registry.js genuinely relocated, nothing else left behind)', () => {
    const dirPath = join(REPO_SRC, 'admin', 'jobs');
    const remaining = readdirSync(dirPath).filter((f) => f.endsWith('.js')).sort();
    assert.deepEqual(remaining, ['spawn-indexer-full.js', 'spawn-indexer-lite.js'], `expected src/admin/jobs/ to contain only the two composition-owned spawn-indexer files, found: ${JSON.stringify(remaining)}`);
  });
});

describe('Phase 8B Step 7C — no production source file references an old pre-move src/admin/*.js path for any moved file', () => {
  // Real path resolution against each importing file's own directory, not a
  // segment/regex heuristic — the blind spot every prior physical-
  // relocation step's own equivalent test guards against.
  const SCAN_ROOTS = ['src', 'benchmarks', 'scripts', join('packages', 'lite', 'lite-src')].map((d) => join(REPO_ROOT, d));
  const OLD_ABS_PATHS = new Set([
    ...SHARED_MOVED_TOP.map((n) => join(REPO_SRC, 'admin', n)),
    ...SHARED_MOVED_API.map((n) => join(REPO_SRC, 'admin', 'api', n)),
    ...SHARED_MOVED_JOBS.map((n) => join(REPO_SRC, 'admin', 'jobs', n)),
    join(REPO_SRC, 'admin', 'system', 'folder-picker.js'),
    join(REPO_SRC, 'admin', 'system', 'ollama.js'),
    ...LOCAL_MOVED_API.map((n) => join(REPO_SRC, 'admin', 'api', n)),
    ...SHARED_MOVED_UI_JS.map((n) => join(REPO_SRC, 'admin', 'ui-src', n)),
    join(REPO_SRC, 'admin', 'ui-src', 'app.css'),
    join(REPO_SRC, 'admin', 'ui-src', 'local-features.js'),
  ]);

  function isOldMovedFilePath(specifier, importingFile) {
    if (!specifier.startsWith('.')) return false;
    const bare = specifier.split('?')[0];
    const resolved = resolve(dirname(importingFile), bare);
    return OLD_ABS_PATHS.has(resolved);
  }

  it('no import/require/dynamic-import specifier resolves to an old src/admin/<moved-file>.js path anywhere under src/, benchmarks/, scripts/, or packages/lite/lite-src/', () => {
    const offenders = [];
    for (const root of SCAN_ROOTS) {
      if (!existsSync(root)) continue;
      for (const file of walkJs(root)) {
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
    assert.deepEqual(offenders, [], `found live import(s)/require(s) still targeting an old src/admin/<moved-file>.js path: ${JSON.stringify(offenders, null, 2)}`);
  });

  it('this check is genuinely load-bearing — a reverted specifier is detected, not silently passed (reverted-fix proof, applied against a real file then restored)', () => {
    // Temporarily revert composition/lite.js's real import of
    // src/shared/admin/register-neutral-routes.js back to the exact
    // relative specifier it used pre-move ('../register-neutral-routes.js',
    // since register-neutral-routes.js used to live one directory up from
    // composition/lite.js at src/admin/), confirm the SAME
    // isOldMovedFilePath() detector the check above uses flags it against
    // the real file on disk, then restore the correct code — proving the
    // check is load-bearing, not a tautology that would pass regardless of
    // file content.
    const consumerFile = join(REPO_SRC, 'admin', 'composition', 'lite.js');
    const original = readFileSync(consumerFile, 'utf-8');
    assert.match(original, /from ['"]\.\.\/\.\.\/shared\/admin\/register-neutral-routes\.js['"]/, 'precondition: composition/lite.js must currently import the NEW shared/admin/register-neutral-routes.js path');
    const reverted = original.replace("from '../../shared/admin/register-neutral-routes.js'", "from '../register-neutral-routes.js'");
    assert.notEqual(reverted, original, 'precondition: the revert must actually change the file');

    try {
      writeFileSync(consumerFile, reverted, 'utf-8');
      const offenders = [];
      for (const line of readFileSync(consumerFile, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        const match = line.match(/from\s+['"]([^'"]+)['"]/);
        if (!match) continue;
        if (isOldMovedFilePath(match[1], consumerFile)) offenders.push(match[1]);
      }
      assert.ok(offenders.length > 0, 'expected the reverted import to be detected by isOldMovedFilePath() — if this fails, the detector itself is broken, not just permissive');
    } finally {
      writeFileSync(consumerFile, original, 'utf-8');
    }
    assert.equal(readFileSync(consumerFile, 'utf-8'), original, 'composition/lite.js must be restored to its correct, working state after the reverted-fix proof');
  });
});

describe('Phase 8B Step 7C — src/shared/admin/ never imports src/local/ or src/cloud/ (shared -> local/cloud implementation is forbidden)', () => {
  function collectRelativeImportEdges(dir) {
    const offenders = [];
    for (const file of walkJs(dir)) {
      const src = readFileSync(file, 'utf-8');
      for (const line of src.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        const match = line.match(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/);
        if (!match) continue;
        const specifier = match[1] || match[2];
        if (!specifier || !specifier.startsWith('.')) continue;
        const resolved = resolve(dirname(file), specifier.split('?')[0]);
        offenders.push({ file, resolved });
      }
    }
    return offenders;
  }

  it('no file under src/shared/admin/ contains a static or dynamic import specifier resolving into src/local/', () => {
    const localDir = join(REPO_SRC, 'local');
    const edges = collectRelativeImportEdges(join(REPO_SRC, 'shared', 'admin'));
    const offenders = edges
      .filter(({ resolved }) => resolved === localDir || resolved.startsWith(localDir + '\\') || resolved.startsWith(localDir + '/'))
      .map(({ file, resolved }) => ({ file: file.replace(REPO_ROOT, '').replace(/\\/g, '/'), into: resolved.replace(REPO_ROOT, '').replace(/\\/g, '/') }));
    assert.deepEqual(offenders, [], `expected zero src/shared/admin/ -> src/local/ import edges, found: ${JSON.stringify(offenders, null, 2)}`);
  });

  it('no file under src/shared/admin/ contains a static or dynamic import specifier resolving into src/cloud/', () => {
    const cloudDir = join(REPO_SRC, 'cloud');
    const edges = collectRelativeImportEdges(join(REPO_SRC, 'shared', 'admin'));
    const offenders = edges
      .filter(({ resolved }) => resolved === cloudDir || resolved.startsWith(cloudDir + '\\') || resolved.startsWith(cloudDir + '/'))
      .map(({ file, resolved }) => ({ file: file.replace(REPO_ROOT, '').replace(/\\/g, '/'), into: resolved.replace(REPO_ROOT, '').replace(/\\/g, '/') }));
    assert.deepEqual(offenders, [], `expected zero src/shared/admin/ -> src/cloud/ import edges, found: ${JSON.stringify(offenders, null, 2)}`);
  });

  it('no file under src/cloud/admin/ contains a static or dynamic import specifier resolving into src/local/', () => {
    const localDir = join(REPO_SRC, 'local');
    const edges = collectRelativeImportEdges(join(REPO_SRC, 'cloud', 'admin'));
    const offenders = edges
      .filter(({ resolved }) => resolved === localDir || resolved.startsWith(localDir + '\\') || resolved.startsWith(localDir + '/'))
      .map(({ file, resolved }) => ({ file: file.replace(REPO_ROOT, '').replace(/\\/g, '/'), into: resolved.replace(REPO_ROOT, '').replace(/\\/g, '/') }));
    assert.deepEqual(offenders, [], `expected zero src/cloud/admin/ -> src/local/ import edges, found: ${JSON.stringify(offenders, null, 2)}`);
  });
});

describe('Phase 8B Step 7C — declared-shared Admin modules never directly import a concrete local/cloud implementation, anywhere in the manifest', () => {
  it('zero shared -> local and zero shared -> cloud implementation edges exist anywhere in the manifest, restricted to shared/admin/ modules', () => {
    const manifest = buildManifest();
    const byPath = new Map(manifest.modules.map((module) => [module.path, module]));
    const edges = [];
    for (const module of manifest.modules) {
      if (!module.path.startsWith('src/shared/admin/')) continue;
      if ((module.declaredCategory ?? module.category) !== 'shared') continue;
      for (const dependency of module.directDependencies) {
        const target = byPath.get(dependency);
        const targetCategory = target?.declaredCategory ?? target?.category;
        if (targetCategory === 'local' || targetCategory === 'cloud') {
          edges.push({ from: module.path, to: dependency, targetCategory });
        }
      }
    }
    assert.deepEqual(edges, [], `expected zero declared-shared(admin) -> declared-local/cloud edges, found: ${JSON.stringify(edges, null, 2)}`);
  });

  it('zero unclassified modules exist anywhere in the manifest after the move', () => {
    const manifest = buildManifest();
    const unclassified = manifest.modules.filter((m) => (m.declaredCategory ?? m.category) === 'unclassified');
    assert.deepEqual(unclassified.map((m) => m.path), [], `expected zero unclassified modules, found: ${JSON.stringify(unclassified.map((m) => m.path))}`);
  });

  it('every moved shared Admin file is genuinely declared shared at its new src/shared/admin/ path', () => {
    const manifest = buildManifest();
    const byPath = new Map(manifest.modules.map((module) => [module.path, module]));
    const paths = [
      ...SHARED_MOVED_TOP.filter((n) => n !== 'register-neutral-routes.js').map((n) => `src/shared/admin/${n}`),
      ...SHARED_MOVED_API.map((n) => `src/shared/admin/api/${n}`),
      ...SHARED_MOVED_JOBS.map((n) => `src/shared/admin/jobs/${n}`),
      'src/shared/admin/system/folder-picker.js',
    ];
    for (const path of paths) {
      const category = byPath.get(path)?.declaredCategory ?? byPath.get(path)?.category;
      assert.equal(category, 'shared', `expected ${path} to be declared shared, got "${category}"`);
    }
    // register-neutral-routes.js alone is pinned 'composition' via
    // COMPOSITION_COMMON_FILES (it is the actual composition-time wiring
    // function both editions call, not passive shared logic) — see
    // build-shared-cloud-local-manifest.mjs's own header comment.
    // server.js (bind-config only: resolveHostConfig/resolvePortConfig) is
    // NOT in that override set and is genuinely 'shared' by real dual
    // reachability, same as any other shared/admin/ file.
    const registerNeutralRoutesCategory = byPath.get('src/shared/admin/register-neutral-routes.js')?.declaredCategory
      ?? byPath.get('src/shared/admin/register-neutral-routes.js')?.category;
    assert.equal(registerNeutralRoutesCategory, 'composition', `expected src/shared/admin/register-neutral-routes.js to be declared composition, got "${registerNeutralRoutesCategory}"`);
  });

  it('every moved local-only Admin file is genuinely declared local at its new src/local/admin/ path', () => {
    const manifest = buildManifest();
    const byPath = new Map(manifest.modules.map((module) => [module.path, module]));
    const paths = [
      ...LOCAL_MOVED_API.map((n) => `src/local/admin/api/${n}`),
      'src/local/admin/system/ollama.js',
    ];
    for (const path of paths) {
      const category = byPath.get(path)?.declaredCategory ?? byPath.get(path)?.category;
      assert.equal(category, 'local', `expected ${path} to be declared local, got "${category}"`);
    }
  });
});

describe('Phase 8B Step 7C — Lite Admin composition roots structurally cannot reach local-only code, ONNX runtime, Ollama runtime, or the Full indexer spawner', () => {
  const graph = buildGraph();
  const LITE_ROOTS = ['src/admin/composition/lite.js', 'src/admin/ui-src/entries/lite.js'];

  function reachableFrom(root) {
    const reachable = new Set();
    const queue = [root];
    while (queue.length) {
      const file = queue.pop();
      if (reachable.has(file)) continue;
      reachable.add(file);
      const node = graph.nodes[file];
      if (!node) continue;
      for (const group of [node.staticImports, node.dynamicImports, node.requireCalls]) {
        for (const ref of group) {
          if (ref.kind === 'relative' && ref.resolved) queue.push(ref.resolved);
        }
      }
    }
    return reachable;
  }

  for (const root of LITE_ROOTS) {
    it(`${root} never transitively reaches src/local/admin/`, () => {
      const reachable = reachableFrom(root);
      const leaks = [...reachable].filter((f) => f.startsWith('src/local/admin/'));
      assert.deepEqual(leaks, [], `expected ${root} to never reach src/local/admin/, found: ${JSON.stringify(leaks)}`);
    });

    it(`${root} never transitively reaches any LOCAL_ONLY_PATH_PATTERNS file (post-lazy-shim, matching the real Lite tarball)`, () => {
      const reachable = computeReachable(graph, [root], { applyLiteShims: true });
      const leaks = [...reachable].filter((f) => LOCAL_ONLY_PATH_PATTERNS.some((p) => p.test(f)));
      assert.deepEqual(leaks, [], `expected ${root} to never transitively reach a local-only module post-shim, found: ${JSON.stringify(leaks)}`);
    });

    it(`${root} never transitively reaches src/admin/jobs/spawn-indexer-full.js or src/indexer/index-full.js`, () => {
      const reachable = reachableFrom(root);
      for (const forbidden of ['src/admin/jobs/spawn-indexer-full.js', 'src/indexer/index-full.js']) {
        assert.ok(!reachable.has(forbidden), `expected ${root} to never reach ${forbidden}`);
      }
    });

    it(`${root} never transitively reaches the Full-only UI entry (entries/full.js) or Full-only partials (partials/full/, local/admin/ui-src/)`, () => {
      const reachable = reachableFrom(root);
      assert.ok(!reachable.has('src/admin/ui-src/entries/full.js'), `expected ${root} to never reach entries/full.js`);
      const fullOnlyLeaks = [...reachable].filter((f) => f.includes('/partials/full/') || f.startsWith('src/local/admin/ui-src/'));
      assert.deepEqual(fullOnlyLeaks, [], `expected ${root} to never reach Full-only UI partials, found: ${JSON.stringify(fullOnlyLeaks)}`);
    });
  }
});

describe('Phase 8B Step 7C — Full Admin composition roots still reach every capability they need', () => {
  const graph = buildGraph();

  function reachableFrom(root) {
    const reachable = new Set();
    const queue = [root];
    while (queue.length) {
      const file = queue.pop();
      if (reachable.has(file)) continue;
      reachable.add(file);
      const node = graph.nodes[file];
      if (!node) continue;
      for (const group of [node.staticImports, node.dynamicImports, node.requireCalls]) {
        for (const ref of group) {
          if (ref.kind === 'relative' && ref.resolved) queue.push(ref.resolved);
        }
      }
    }
    return reachable;
  }

  it('src/admin/server-full.js reaches src/local/admin/api/onnx.js, src/local/admin/api/ollama-models.js, and src/local/admin/system/ollama.js', () => {
    const reachable = reachableFrom('src/admin/server-full.js');
    for (const expected of ['src/local/admin/api/onnx.js', 'src/local/admin/api/ollama-models.js', 'src/local/admin/system/ollama.js']) {
      assert.ok(reachable.has(expected), `expected server-full.js to reach ${expected}, reachable set size: ${reachable.size}`);
    }
  });

  it('src/admin/server-full.js reaches src/cloud/admin/qdrant-cloud-api.js', () => {
    const reachable = reachableFrom('src/admin/server-full.js');
    assert.ok(reachable.has('src/cloud/admin/qdrant-cloud-api.js'));
  });

  it('src/admin/server-full.js reaches every shared/admin/ API route module', () => {
    const reachable = reachableFrom('src/admin/server-full.js');
    for (const name of SHARED_MOVED_API) {
      const path = `src/shared/admin/api/${name}`;
      assert.ok(reachable.has(path), `expected server-full.js to reach ${path}`);
    }
  });

  it('src/admin/ui-src/entries/full.js reaches src/local/admin/ui-src/local-features.js', () => {
    const reachable = reachableFrom('src/admin/ui-src/entries/full.js');
    assert.ok(reachable.has('src/local/admin/ui-src/local-features.js'));
  });
});

describe('Phase 8B Step 7C — Full/Lite Admin API route contracts did not lose endpoints (real HTTP round-trip, not just import-graph)', () => {
  it('createApp() (Full) still registers every neutral route plus Full-only ONNX/Ollama routes', async () => {
    const { createApp } = await import('../../../src/admin/server-full.js');
    const stubAdapter = () => ({
      name: () => 'stub', capabilities: () => ({ namedVectors: true, sparseVectors: true, hybridSearch: true, payloadIndexes: true }),
      ping: async () => ({ ok: true }), listCollections: async () => [], getCollection: async () => null,
      createCollection: async () => {}, deleteCollection: async () => {}, ensureCollectionSchema: async () => ({ repaired: [], warnings: [] }),
      getEmbeddingProfile: async () => ({ state: 'missing' }), listSourceDocuments: async () => [], getChunk: async () => [],
      getFileChunks: async () => [], getSectionChunks: async () => null, searchHybridVectors: async () => [],
      getSkeletonRoot: async () => null, getSkeletonNode: async () => null, getSkeletonChildren: async () => [],
      getContentNode: async () => null, getSectionAnchor: async () => null,
    });
    const app = createApp({ adapter: stubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }) });
    await new Promise((res) => app.listen(0, '127.0.0.1', res));
    try {
      const base = `http://127.0.0.1:${app.address().port}`;
      for (const path of ['/api/health', '/api/settings', '/api/generation/status', '/api/operations', '/api/system/ollama-status']) {
        const res = await fetch(`${base}${path}`);
        assert.notEqual(res.status, 404, `expected ${path} to be a registered route on createApp() (Full)`);
      }
      const onnxRes = await fetch(`${base}/api/system/onnx-probe`, { method: 'POST' });
      assert.notEqual(onnxRes.status, 404, 'expected /api/system/onnx-probe to be registered on createApp() (Full)');
    } finally {
      await new Promise((res) => app.close(res));
    }
  });

  it('createLiteApp() (Lite) still registers every neutral route, and correctly 404s the Full-only ONNX/Ollama routes', async () => {
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
    const app = createLiteApp({ adapter: stubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }) });
    await new Promise((res) => app.listen(0, '127.0.0.1', res));
    try {
      const base = `http://127.0.0.1:${app.address().port}`;
      for (const path of ['/api/health', '/api/settings', '/api/generation/status', '/api/operations']) {
        const res = await fetch(`${base}${path}`);
        assert.notEqual(res.status, 404, `expected ${path} to be a registered route on createLiteApp() (Lite)`);
      }
      const onnxRes = await fetch(`${base}/api/system/onnx-probe`, { method: 'POST' });
      const ollamaRes = await fetch(`${base}/api/system/ollama-status`);
      assert.equal(onnxRes.status, 404, 'expected /api/system/onnx-probe to be absent on createLiteApp() (Lite)');
      assert.equal(ollamaRes.status, 404, 'expected /api/system/ollama-status to be absent on createLiteApp() (Lite)');
    } finally {
      await new Promise((res) => app.close(res));
    }
  });
});

describe('Phase 8B Step 7C — Full/Lite job registries use the correct indexer entry, unaffected by the relocation', () => {
  const graph = buildGraph();

  it('admin/jobs/spawn-indexer-full.js resolves to indexer/index-full.js', () => {
    const node = graph.nodes['src/admin/jobs/spawn-indexer-full.js'];
    assert.ok(node, 'expected src/admin/jobs/spawn-indexer-full.js to exist in the graph');
    const spawnCalls = node.forkSpawnCalls.filter((c) => c.callee === 'spawn');
    assert.ok(spawnCalls.some((c) => c.literal && c.resolved === 'src/indexer/index-full.js'), `expected a spawn() call resolving to src/indexer/index-full.js, got: ${JSON.stringify(spawnCalls)}`);
  });

  it('admin/jobs/spawn-indexer-lite.js resolves to indexer/index-lite.js', () => {
    const node = graph.nodes['src/admin/jobs/spawn-indexer-lite.js'];
    assert.ok(node, 'expected src/admin/jobs/spawn-indexer-lite.js to exist in the graph');
    const spawnCalls = node.forkSpawnCalls.filter((c) => c.callee === 'spawn');
    assert.ok(spawnCalls.some((c) => c.literal && c.resolved === 'src/indexer/index-lite.js'), `expected a spawn() call resolving to src/indexer/index-lite.js, got: ${JSON.stringify(spawnCalls)}`);
  });

  it('shared/admin/jobs/registry.js itself has zero spawn()/fork() calls of its own — spawnIndexer stays a required, injected dependency', () => {
    const node = graph.nodes['src/shared/admin/jobs/registry.js'];
    assert.ok(node, 'expected src/shared/admin/jobs/registry.js to exist in the graph');
    const spawnCalls = node.forkSpawnCalls.filter((c) => c.callee === 'spawn' || c.callee === 'fork');
    assert.deepEqual(spawnCalls, [], 'registry.js must contain zero spawn()/fork() calls of its own');
  });
});

describe('Phase 8B Step 7C — Full/Lite UI entries resolve without any old admin/ui-src path (real Vite build output scan)', () => {
  it('the built dist/admin-ui/index.html and dist/admin-ui-lite/index.html reference no /admin/ui-src/ path fragment', () => {
    // This test intentionally does NOT invoke Vite itself (that is
    // tests/unit/lite/ui-build-dce.test.js's own real-build coverage,
    // already run separately and passing) — it only confirms the SOURCE
    // entry documents' own <load>/<script> paths are the new, relocated
    // ones, which the real Vite build then resolves.
    const fullIndex = readFileSync(join(REPO_SRC, 'admin', 'ui-src', 'index.html'), 'utf-8');
    const liteIndex = readFileSync(join(REPO_SRC, 'admin', 'ui-src', 'lite-entry', 'index.html'), 'utf-8');
    for (const html of [fullIndex, liteIndex]) {
      assert.ok(!html.includes('src="partials/'), 'expected zero un-prefixed old-style "partials/..." <load> paths (must be ../shared/admin/ui-src/partials/... or ../local/admin/ui-src/partials/... now)');
    }
    assert.match(fullIndex, /shared\/admin\/ui-src\/partials\/shared\/templates\//);
    assert.match(fullIndex, /local\/admin\/ui-src\/partials\/full\/onnx-probe-panel\.html/);
    assert.match(liteIndex, /shared\/admin\/ui-src\/partials\/shared\/templates\//);
    assert.ok(!liteIndex.includes('onnx-probe-panel.html'));
  });

  it('entries/full.js and entries/lite.js both resolve app.css/app.js from src/shared/admin/ui-src/, not the old src/admin/ui-src/ path', () => {
    const fullEntry = readFileSync(join(REPO_SRC, 'admin', 'ui-src', 'entries', 'full.js'), 'utf-8');
    const liteEntry = readFileSync(join(REPO_SRC, 'admin', 'ui-src', 'entries', 'lite.js'), 'utf-8');
    for (const src of [fullEntry, liteEntry]) {
      assert.match(src, /from ['"]\.\.\/\.\.\/\.\.\/shared\/admin\/ui-src\/app\.js['"]/);
    }
    assert.match(fullEntry, /from ['"]\.\.\/\.\.\/\.\.\/local\/admin\/ui-src\/local-features\.js['"]/);
  });
});

describe('Phase 8B Step 7C — Lite Vite graph and Lite package staging contain no local-only Admin modules, before or after the move', () => {
  before(() => {
    stageSrc();
  });

  it('every moved shared Admin file is staged in the Lite tarball at its new src/shared/admin/ path', () => {
    const staged = new Set(listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/')));
    for (const name of SHARED_MOVED_API) {
      assert.ok(staged.has(`shared/admin/api/${name}`), `expected shared/admin/api/${name} to be staged`);
    }
    for (const name of SHARED_MOVED_JOBS) {
      assert.ok(staged.has(`shared/admin/jobs/${name}`), `expected shared/admin/jobs/${name} to be staged`);
    }
    assert.ok(staged.has('shared/admin/system/folder-picker.js'));
    assert.ok(staged.has('shared/admin/register-neutral-routes.js'));
  });

  it('none of the moved shared Admin files are ALSO staged under their old pre-move src/admin/ path', () => {
    const staged = new Set(listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/')));
    for (const name of SHARED_MOVED_API) {
      assert.equal(staged.has(`admin/api/${name}`), false, `expected admin/api/${name} (old path) to NOT be staged`);
    }
  });

  it('none of the local-only Admin files (onnx.js, ollama-models.js, ollama.js, local-features.js, partials/full/) are staged in the Lite tarball', () => {
    const staged = listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/'));
    const localAdminFiles = staged.filter((f) => f.startsWith('local/admin/'));
    assert.deepEqual(localAdminFiles, [], `expected zero staged files under local/admin/, found: ${JSON.stringify(localAdminFiles)}`);
  });

  it('the Lite package build.mjs closure validator passes clean against the real staged tree (five-part validator, zero errors)', async () => {
    const { runValidator } = await import('../../../packages/lite/build.mjs');
    const staged = listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/'));
    const errors = runValidator(staged);
    assert.deepEqual(errors, [], `expected zero closure-validator errors against the real staged tree, found: ${JSON.stringify(errors, null, 2)}`);
  });
});

describe('Phase 8B Step 7C — no compatibility re-export stub was introduced anywhere under src/admin/', () => {
  it('src/admin/*.js (composition-owned remainder) contains no file whose entire body is a pass-through re-export of a shared/admin/ or local/admin/ module', () => {
    const adminDir = join(REPO_SRC, 'admin');
    const offenders = [];
    for (const file of walkJs(adminDir)) {
      const src = readFileSync(file, 'utf-8').trim();
      const lines = src.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//') && !l.startsWith('*'));
      const isPureReExport = lines.length > 0 && lines.every((l) => /^export\s*(\*|\{)/.test(l) || /^import\s/.test(l));
      const onlyTargetsMovedDir = lines.every((l) => !/from ['"]\.\.?\//.test(l) || /shared\/admin|local\/admin/.test(l) || !/from ['"]/.test(l));
      if (isPureReExport && lines.some((l) => /shared\/admin|local\/admin/.test(l)) && onlyTargetsMovedDir) {
        offenders.push(file.replace(REPO_ROOT, '').replace(/\\/g, '/'));
      }
    }
    assert.deepEqual(offenders, [], `expected zero compatibility re-export stubs under src/admin/, found: ${JSON.stringify(offenders)}`);
  });
});
