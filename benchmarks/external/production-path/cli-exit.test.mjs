// core/cli-exit.mjs — offline. Unit tests for the exit-code decision, plus
// ONE real executable-level spawn test proving a runner actually wires it
// in (audit 2026-09-06, P1: "Є executable-level test: INCOMPLETE → nonzero
// exit").
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { exitCodeForSuiteState, exitCodeForManySuiteStates } from './core/cli-exit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('exitCodeForSuiteState()', () => {
  it('0 for a COMPLETE run', () => {
    assert.equal(exitCodeForSuiteState({ verdict: 'COMPLETE' }), 0);
  });

  it('1 for an INCOMPLETE run — never a silent exit 0', () => {
    assert.equal(exitCodeForSuiteState({ verdict: 'INCOMPLETE' }), 1);
  });

  it('1 for a null state (run never started, e.g. LIVE_BLOCKED)', () => {
    assert.equal(exitCodeForSuiteState(null), 1);
  });

  it('1 for a state with no verdict at all', () => {
    assert.equal(exitCodeForSuiteState({}), 1);
  });

  it('0 for --resume-check regardless of the stored verdict — a read-only inspection is not a run', () => {
    assert.equal(exitCodeForSuiteState({ verdict: 'INCOMPLETE' }, { resumeCheck: true }), 0);
    assert.equal(exitCodeForSuiteState(null, { resumeCheck: true }), 0);
  });
});

describe('exitCodeForManySuiteStates()', () => {
  it('0 only when every suite is COMPLETE', () => {
    assert.equal(exitCodeForManySuiteStates([{ verdict: 'COMPLETE' }, { verdict: 'COMPLETE' }]), 0);
  });

  it('1 when any suite is not COMPLETE', () => {
    assert.equal(exitCodeForManySuiteStates([{ verdict: 'COMPLETE' }, { verdict: 'INCOMPLETE' }]), 1);
    assert.equal(exitCodeForManySuiteStates([{ verdict: 'COMPLETE' }, null]), 1);
  });

  it('1 for an empty list is NOT asserted — an empty run is a caller bug, but resumeCheck short-circuits to 0', () => {
    assert.equal(exitCodeForManySuiteStates([], { resumeCheck: true }), 0);
  });
});

describe('executable-level: a suite runner exits nonzero when the run does not reach COMPLETE', () => {
  // Spawns the real run-structural-prodpath.mjs with QDRANT_URL/QDRANT_KEY
  // scrubbed from the environment. The runner prints LIVE_BLOCKED and must
  // exit nonzero — proving the executable path itself sets a failing exit
  // code for a run that did not complete (not just that the pure helper
  // returns 1). A full INCOMPLETE-verdict run needs live Qdrant and is
  // covered by the real structural smoke in the live checks, not here.
  it('run-structural-prodpath.mjs exits 1 when it cannot run (no Qdrant credentials)', async () => {
    const scriptPath = resolve(__dirname, 'run-structural-prodpath.mjs');
    const env = { ...process.env };
    delete env.QDRANT_URL;
    delete env.QDRANT_KEY;
    // The runner imports 'dotenv/config', which would otherwise reload the
    // repo's real .env (with real QDRANT_URL) — point it at a path that
    // does not exist so the scrubbed env actually takes effect.
    env.DOTENV_CONFIG_PATH = resolve(__dirname, '.no-such-env-file');
    const { code, stdout } = await runNode(scriptPath, env);
    assert.equal(code, 1, `expected nonzero exit, got ${code}. stdout:\n${stdout}`);
    assert.match(stdout, /LIVE_BLOCKED/);
  });

  it('run-structural-prodpath.mjs --resume-check exits 0 even with no checkpoint (read-only inspection)', async () => {
    const scriptPath = resolve(__dirname, 'run-structural-prodpath.mjs');
    // --resume-check needs to get PAST the LIVE_BLOCKED guard, so give it
    // dummy creds — it never actually contacts Qdrant on this path (it only
    // reads a local checkpoint file, which won't exist here).
    const env = { ...process.env, QDRANT_URL: 'http://127.0.0.1:0', QDRANT_KEY: 'x' };
    const { code, stdout } = await runNode(`${scriptPath}`, env, ['--resume-check']);
    assert.equal(code, 0, `expected exit 0 for --resume-check, got ${code}. stdout:\n${stdout}`);
  });
});

function runNode(scriptPath, env, args = []) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}
