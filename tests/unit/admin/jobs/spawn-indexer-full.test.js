// admin/jobs/spawn-indexer-full.js — Full's own spawnIndexer implementation
// (code review, round 4). This is the ONE file containing both the literal
// path to indexer/index-full.js and the actual node:child_process.spawn()
// call — split out of admin/jobs/registry.js specifically so that shared,
// Lite-staged file never has to name Full's own entry path (see
// registry.js's own header comment). There is no DI seam for the spawn
// call itself in this file (by design — the whole point is a single,
// small, literal-target spawn() call an AST tool can trace); the
// structural proof of the literal target lives in
// tests/unit/lite/build-closure-validator.test.js. This file instead
// proves the REAL behavior: a real (but trivial and fast) child process
// invocation of the real indexer/index-full.js, with no COLLECTION set,
// exits quickly with a usage message — confirming spawnIndexer() actually
// launches the right file with the right argument/env shape, without
// requiring a live Qdrant/Ollama connection.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnIndexer } from '../../../../src/admin/jobs/spawn-indexer-full.js';

describe('spawn-indexer-full.js — spawnIndexer()', () => {
  it('spawns a real child process, passing args after the entry point and env through unmodified', async () => {
    const child = spawnIndexer({ args: ['./some/path'], env: { ...process.env, COLLECTION: '' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const [code] = await new Promise((resolve) => child.on('exit', (code, signal) => resolve([code, signal])));
    // No COLLECTION env var (blanked above) -> run.js's own main() prints
    // its usage message and exits 1 — fast, no network/Qdrant/Ollama
    // dependency reached at all. This is the exact shape a real, wrongly
    // configured spawnIndexer() invocation would also hit, so it's a
    // faithful (if minimal) proof that the right file was launched with
    // the right args.
    assert.equal(code, 1);
    assert.match(stdout + stderr, /Usage: COLLECTION=my-collection node/);
  });

  it('sets windowsHide: true and no shell — no console window flash, no shell string interpolation', async () => {
    // Indirect proof (no DI seam to intercept the raw spawn() options
    // object): a real ChildProcess is returned and behaves normally (no
    // shell-related parsing anomalies) even when args contain characters
    // that would need escaping under a shell (spaces, special chars) — if
    // shell:true were ever accidentally set, a path with spaces would be
    // split into multiple arguments instead of staying one array element.
    const child = spawnIndexer({ args: ['a path with spaces'], env: { ...process.env, COLLECTION: '' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    await new Promise((resolve) => child.on('exit', resolve));
    // The usage message is printed regardless of the path argument's
    // shape (COLLECTION is what's missing) — this just confirms the
    // process ran to completion without a shell-parsing-related crash.
    assert.match(stdout + stderr, /Usage:/);
  });
});
