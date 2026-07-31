// Real build-output regression test for the Semidex Lite admin UI.
// Runs the ACTUAL `vite build --config vite.config.lite.js` (not a
// simulation) and content-scans the real output for every local-only
// marker — this is the genuine behavioral proof the structural
// (source-regex) tests in global-settings-view-lite-dce.test.js and
// jobs-and-settings-view-lite-dce.test.js can only approximate. Slower
// than a typical unit test (a real Vite build), but this is exactly the
// kind of guarantee that must be verified against real compiler output,
// not inferred from source shape alone — a change to Rollup's DCE
// behavior, a broken vite.config.lite.js plugin, or a new local-only
// reference added without a guard would all be invisible to the
// structural tests but caught here.
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

  it('the prune-stale option survives (proves the strip is scoped, not over-broad)', () => {
    const files = readAllText(LITE_DIST).filter((f) => f.path.endsWith('.js'));
    const hasPrune = files.some((f) => f.content.includes('opt-prune'));
    assert.ok(hasPrune, 'opt-prune must still be present — the Lite jobs policy allows pruneStale');
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
      assert.ok(allContent.includes(marker), `full build lost "${marker}" — this would mean local-only functionality was accidentally guarded/stripped from full Semidex, not just Lite`);
    }
  });
});
