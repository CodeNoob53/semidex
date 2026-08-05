// Phase 8B Step 2 — physical relocation of the local ONNX embedding runtime
// (core/onnx-embed.js, core/onnx-runtime.js, core/onnx-probe-runner.js,
// core/onnx-provider-probe.js, core/length-bucket.js -> local/core/*.js).
// This is a pure `git mv` + import-path-update step, per
// docs/design/phase-8a-shared-cloud-local-migration-audit-2026-08-02.md §7
// Step 2 — no runtime behavior change. These tests prove the physical move
// actually happened and stayed disciplined:
//   - the five old src/core/*.js paths no longer exist as files, AND no
//     production source file references them by that path anymore;
//   - the five new src/local/core/*.js paths exist;
//   - the Lite tarball (the real staged tree, via build.mjs's own stageSrc())
//     physically excludes the entire local/ directory — not merely
//     unreachable by the closure validator, but never even copied.
// Reachability-level proof (Lite graph never reaches these five modules) is
// already covered by lite-lazy-shim-necessity.test.js and
// full-lite-boundary.test.js, both updated in this same step to the new
// paths — this file focuses on what those don't check: physical presence/
// absence on disk, and the staged tarball's own file list.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageSrc, listAllFiles } from '../../../packages/lite/build.mjs';

const LITE_DIR = dirname(fileURLToPath(new URL('../../../packages/lite/build.mjs', import.meta.url)));
const REPO_ROOT = resolve(LITE_DIR, '..', '..');
const REPO_SRC = join(REPO_ROOT, 'src');
const STAGED_SRC = join(LITE_DIR, 'src');

const MOVED_FILES = [
  'onnx-embed.js',
  'onnx-runtime.js',
  'onnx-probe-runner.js',
  'onnx-provider-probe.js',
  'length-bucket.js',
];

describe('Phase 8B Step 2 — the five ONNX runtime files physically moved from src/core/ to src/local/core/', () => {
  for (const name of MOVED_FILES) {
    it(`src/core/${name} no longer exists`, () => {
      assert.equal(existsSync(join(REPO_SRC, 'core', name)), false, `expected src/core/${name} to be gone (moved to src/local/core/${name})`);
    });

    it(`src/local/core/${name} exists`, () => {
      assert.equal(existsSync(join(REPO_SRC, 'local', 'core', name)), true, `expected src/local/core/${name} to exist`);
    });
  }
});

describe('Phase 8B Step 2 — no production source file references the old src/core/*.js paths for the moved files', () => {
  // A repo-wide walk (src/, packages/lite/lite-src/, benchmarks/,
  // scripts/) for any import/require specifier resolving to
  // core/onnx-embed.js, core/onnx-runtime.js, core/onnx-probe-runner.js,
  // core/onnx-provider-probe.js, or core/length-bucket.js at any relative
  // depth. packages/lite/src/ (the gitignored staged mirror) is
  // deliberately excluded from this walk — it is regenerated output, not a
  // source of truth, and would otherwise report every one of build.mjs's
  // own doc-comment mentions of the old paths as a false positive.
  const SCAN_ROOTS = ['src', 'benchmarks', 'scripts'].map((d) => join(REPO_ROOT, d));

  // Segment-based check, not a regex — a regex anchored on "core/<file>.js"
  // cannot distinguish the OLD path (".../core/onnx-embed.js") from the NEW
  // one (".../local/core/onnx-embed.js"), since both literally end in
  // "core/onnx-embed.js". Splitting into path segments and checking the
  // segment immediately before "core" is never "local" is unambiguous.
  function isOldMovedFilePath(specifier) {
    const segments = specifier.split('/').filter(Boolean);
    const filename = segments[segments.length - 1];
    if (!MOVED_FILES.includes(filename)) return false;
    const coreIdx = segments.length - 2;
    if (coreIdx < 0 || segments[coreIdx] !== 'core') return false;
    return segments[coreIdx - 1] !== 'local';
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

  it('no import/require/dynamic-import specifier resolves to the old core/<moved-file>.js path anywhere under src/, benchmarks/, or scripts/', () => {
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
          if (isOldMovedFilePath(specifier)) {
            offenders.push({ file: file.replace(REPO_ROOT, '').replace(/\\/g, '/'), specifier });
          }
        }
      }
    }
    assert.deepEqual(offenders, [], `found live import(s)/require(s) still targeting the old core/<moved-file>.js path: ${JSON.stringify(offenders)}`);
  });
});

describe('Phase 8B Step 2 — Lite tarball physically excludes src/local/ (not merely unreachable)', () => {
  before(() => {
    stageSrc();
  });

  it('the real staged tree (packages/lite/src/, as produced by build.mjs\'s own stageSrc()) contains zero files under local/', () => {
    const staged = listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/'));
    const localFiles = staged.filter((f) => f === 'local' || f.startsWith('local/'));
    assert.deepEqual(localFiles, [], `expected zero staged files under local/, found: ${JSON.stringify(localFiles)}`);
  });

  it('none of the five moved files are staged under ANY path in the Lite tarball', () => {
    const staged = listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/'));
    for (const name of MOVED_FILES) {
      const matches = staged.filter((f) => f.endsWith(`/${name}`) || f === name);
      assert.deepEqual(matches, [], `expected zero staged copies of ${name} anywhere in the Lite tarball, found: ${JSON.stringify(matches)}`);
    }
  });

  it('the local/ directory does not even exist on disk under the staged tree', () => {
    assert.equal(existsSync(join(STAGED_SRC, 'local')), false, 'expected packages/lite/src/local/ to not exist at all after staging');
  });
});
