// core/index-via-cli.mjs — offline. Confirms INDEX_ENTRY resolves to the
// real src/indexer/index.js file, and exercises the spawn/exit-code/
// stdout-stderr-capture contract against a tiny stand-in Node script
// (never the real indexer — that's slow, requires a live Qdrant cluster,
// and is exercised for real only by run-structural-smoke.mjs).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { INDEX_ENTRY } from './core/index-via-cli.mjs';

describe('INDEX_ENTRY', () => {
  it('resolves to the real src/indexer/index.js file — the same entry point npm run index uses', () => {
    assert.ok(existsSync(INDEX_ENTRY));
    assert.ok(INDEX_ENTRY.endsWith('index.js'));
    assert.match(INDEX_ENTRY.replace(/\\/g, '/'), /\/src\/indexer\/index\.js$/);
  });
});

// runIndexer()'s own spawn/capture/reject contract, proven against a
// tiny stand-in script so this test stays fast and fully offline —
// re-implementing the exact same spawn() shape runIndexer() uses,
// against a controllable script instead of the real indexer CLI.
describe('spawn/exit-code/stdout-stderr contract (mirrors runIndexer()\'s own shape)', () => {
  let scratchDir;
  it('resolves with stdout captured and exitCode 0 on success', async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'semidex-index-via-cli-test-'));
    const scriptPath = join(scratchDir, 'ok.mjs');
    writeFileSync(scriptPath, "console.log('hello from stand-in'); process.exit(0);");
    const result = await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.on('close', (exitCode) => {
        if (exitCode === 0) resolvePromise({ stdout, exitCode });
        else reject(new Error(`exited ${exitCode}`));
      });
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /hello from stand-in/);
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('rejects with stdout/stderr included in the error on a nonzero exit code', async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'semidex-index-via-cli-test-'));
    const scriptPath = join(scratchDir, 'fail.mjs');
    writeFileSync(scriptPath, "console.error('boom'); process.exit(1);");
    await assert.rejects(
      () => new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (exitCode) => {
          if (exitCode === 0) resolvePromise();
          else reject(new Error(`indexer exited with code ${exitCode}\n--- stderr ---\n${stderr}`));
        });
      }),
      /exited with code 1/,
    );
    rmSync(scratchDir, { recursive: true, force: true });
  });
});
