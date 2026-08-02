// Real build-output regression test for the Semidex Lite admin UI. Runs
// the ACTUAL `vite build --config vite.config.lite.js` (not a simulation)
// and content-scans the real output for every local-only marker.
//
// Phase 6 (docs/design/full-lite-shared-architecture-audit-2026-08-01.md):
// renamed from "DCE proves absence" — Lite's build no longer relies on
// Rollup dead-code elimination of an IS_LITE-guarded branch, or on
// stripHtmlMarkers()'s post-build string surgery, to keep local-only
// content out. Full and Lite now build from PHYSICALLY SEPARATE entry
// points (src/admin/ui-src/index.html + entries/full.js vs.
// src/admin/ui-src/lite-entry/index.html + entries/lite.js) and
// PHYSICALLY SEPARATE partial files (partials/full/*.html vs.
// partials/lite/*.html) — Lite's build never composes the ONNX probe
// panel template or the ONNX/LLM-summaries/tag-gen checkboxes into its
// page or bundle in the first place, so there is nothing to strip. This
// file's own assertions are unchanged in what they check (the forbidden
// marker list, the real-build-output requirement) — only the reason
// they're expected to pass changed. See composition-isolation.test.js in
// this same directory for the structural (import-graph) half of this
// phase's proof; this file is the "real compiler output" half neither
// that test nor a source-regex check can substitute for.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([a-zA-Z]):/, '$1:');
const LITE_DIST = join(REPO_ROOT, 'dist', 'admin-ui-lite');
const FULL_DIST = join(REPO_ROOT, 'dist', 'admin-ui');

const FORBIDDEN_MARKERS = [
  'ONNX_EXECUTION_PROVIDER', 'ONNXRUNTIME_NODE_PATH', 'OLLAMA_URL', 'GENERATION_DEVICE',
  'ONNX_BATCH_SIZE', 'ONNX_CUDA_STRICT', 'TAG_ONNX_MODEL', 'TAG_ONNX_THREADS', 'TAG_ONNX_ALLOW_DOWNLOAD',
  'tpl-gs-onnx-probe-panel',
  '/api/system/onnx-probe', '/api/ollama-models', '/api/system/ollama-status',
  'opt-onnx', 'opt-llm-summaries', 'opt-tags',
];

function readAllText(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (readdirSync(dir, { withFileTypes: true }).find((d) => d.name === entry)?.isDirectory()) {
      return readAllText(full);
    }
    return [{ path: full, content: readFileSync(full, 'utf-8') }];
  });
}

describe('Lite admin UI build — real Vite build, real output scan', { timeout: 60000 }, () => {
  before(() => {
    // shell: true is required for npm resolution on Windows (npm.cmd
    // without a shell fails with EINVAL here) — safe in this context since
    // every argument is a hardcoded constant, never user input.
    execFileSync('npm', ['run', 'admin:build:lite'], { cwd: REPO_ROOT, stdio: 'pipe', shell: true });
  });

  it('produces zero occurrences of every local-only marker in the built output', () => {
    const files = readAllText(LITE_DIST).filter((f) => /\.(html|js|css)$/.test(f.path));
    assert.ok(files.length > 0, 'sanity: the Lite build must produce at least one html/js/css file');
    const leaks = [];
    for (const { path, content } of files) {
      for (const marker of FORBIDDEN_MARKERS) {
        if (content.includes(marker)) leaks.push(`${path}: "${marker}"`);
      }
    }
    assert.deepEqual(leaks, [], `local-only markers leaked into the Lite build:\n${leaks.join('\n')}`);
  });

  it('the prune-stale option survives (proves the physical separation is scoped, not over-broad)', () => {
    const files = readAllText(LITE_DIST).filter((f) => f.path.endsWith('.js'));
    const hasPrune = files.some((f) => f.content.includes('opt-prune'));
    assert.ok(hasPrune, 'opt-prune must still be present — the Lite jobs policy allows pruneStale');
  });

  it('produces dist/admin-ui-lite/index.html — the exact filename packages/lite/build.mjs and src/admin/static.js both require, not lite-entry/index.html or index-lite.html', () => {
    const files = readdirSync(LITE_DIST);
    assert.ok(files.includes('index.html'), `expected dist/admin-ui-lite/index.html to exist, found: ${JSON.stringify(files)}`);
  });

  it('never references local-features.js\'s own exported function names — proof of real import-graph absence, not just string-marker absence', () => {
    // A stronger check than the forbidden-marker list above: even function
    // NAMES this repo's own local-features.js exports (which never appear
    // in any FORBIDDEN_MARKERS string, since they're implementation
    // details, not user-facing text/API paths) are absent — confirms
    // Rollup genuinely never included that module's code, not merely that
    // its most identifiable string literals were individually stripped.
    const files = readAllText(LITE_DIST).filter((f) => f.path.endsWith('.js'));
    const localFeatureNames = ['wireIndexingFormLocalOptions', 'onnxProbePanel', 'refreshOllamaModels', 'collectLocalJobOptions', 'wireOnnxProbePanel'];
    const leaks = [];
    for (const { path, content } of files) {
      for (const name of localFeatureNames) {
        if (content.includes(name)) leaks.push(`${path}: "${name}"`);
      }
    }
    assert.deepEqual(leaks, [], `local-features.js function name(s) leaked into the Lite build (even minified output preserves imported-but-dead-named exports in some bundler configurations, so this is a real, not redundant, check):\n${leaks.join('\n')}`);
  });
});

describe('Full admin UI build — real Vite build, real output scan', { timeout: 60000 }, () => {
  before(() => {
    execFileSync('npm', ['run', 'admin:build'], { cwd: REPO_ROOT, stdio: 'pipe', shell: true });
  });

  it('still produces every local-only marker at least once (proves zero behavior change for full Semidex)', () => {
    const files = readAllText(FULL_DIST).filter((f) => /\.(html|js)$/.test(f.path));
    const allContent = files.map((f) => f.content).join('\n');
    for (const marker of ['ONNX_EXECUTION_PROVIDER', 'tpl-gs-onnx-probe-panel', 'opt-onnx', 'opt-llm-summaries', 'opt-tags']) {
      assert.ok(allContent.includes(marker), `full build lost "${marker}" — this would mean local-only functionality was accidentally excluded from full Semidex, not just Lite`);
    }
  });

  it('produces dist/admin-ui/index.html', () => {
    const files = readdirSync(FULL_DIST);
    assert.ok(files.includes('index.html'));
  });
});
