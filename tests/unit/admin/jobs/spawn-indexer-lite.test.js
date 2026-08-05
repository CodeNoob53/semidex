// admin/jobs/spawn-indexer-lite.js — Lite's own spawnIndexer implementation
// (code review, round 4). Sibling of spawn-indexer-full.js — see that
// file's own test for the full rationale. Spawns the real
// indexer/index-lite.js, which never imports any local-runtime module.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnIndexer } from '../../../../src/admin/jobs/spawn-indexer-lite.js';

describe('spawn-indexer-lite.js — spawnIndexer()', () => {
  it('spawns a real child process running indexer/index-lite.js, passing args and env through unmodified', async () => {
    const child = spawnIndexer({ args: ['./some/path'], env: { ...process.env, COLLECTION: '' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const [code] = await new Promise((resolve) => child.on('exit', (code, signal) => resolve([code, signal])));
    // No COLLECTION env var (blanked above) -> run.js's own main() prints
    // its usage message and exits 1 — fast, no network/Qdrant dependency
    // reached at all, and (the actual point of this test existing as a
    // sibling to spawn-indexer-full.js's own) NO Ollama/ONNX capability is
    // ever constructed either, since main() exits before run() reaches
    // any indexing work.
    assert.equal(code, 1);
    assert.match(stdout + stderr, /Usage: COLLECTION=my-collection node/);
  });
});
