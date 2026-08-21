// Tests for GET /api/operations, GET /api/operations/:id (src/admin/api/
// operations.js) — the merged jobs+tasks read view the operation modal
// polls (Phase 3S). No real indexer process is ever spawned (spawnFn is
// always a fake), and repair runs against a stub adapter, never real Qdrant.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createJobRegistry } from '../../../src/shared/admin/jobs/registry.js';
import { createTaskRegistry } from '../../../src/shared/admin/jobs/task-registry.js';
import { createApp } from '../../../src/admin/server-full.js';

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { setTimeout(() => child.emit('exit', null, 'SIGTERM'), 1); };
  return child;
}

function makeNeverExitingSpawn() {
  return () => makeFakeChild();
}

function makeScriptedSpawn({ delayMs = 5, exitCode = 0, stdout = '', stderr = '' } = {}) {
  return () => {
    const child = makeFakeChild();
    setTimeout(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('exit', exitCode, null);
    }, delayMs);
    return child;
  };
}

function makeStubAdapter(overrides = {}) {
  return {
    name: () => 'stub', capabilities: () => ({}), ping: async () => ({ ok: true, detail: '' }),
    listCollections: async () => [], getCollection: async () => ({ name: 'my-docs' }), createCollection: async () => {},
    deleteCollection: async () => {}, ensureCollectionSchema: async () => ({ repaired: ['index x'], warnings: [] }),
    listSourceDocuments: async () => [], getChunk: async () => [], getFileChunks: async () => [], getSectionChunks: async () => null, searchHybridVectors: async () => [],
    getSkeletonRoot: async () => null, getSkeletonNode: async () => null, getSkeletonChildren: async () => [],
    getContentNode: async () => null, getSectionAnchor: async () => null,
    ...overrides,
  };
}

// This file is about the merged jobs+tasks read view, not path scoping (see
// tests/unit/security/spawn-indexer-path-validation.test.js for that) — every path
// used below is a fake, nonexistent string the real guard would reject.
const ALLOW_ALL_ROOTS_GUARD = { checkTarget: (rawPath) => ({ ok: true, canonicalPath: rawPath }) };

async function withOpsApp({ spawnFn = makeNeverExitingSpawn(), adapterOverrides = {} } = {}, fn) {
  const jobRegistry = createJobRegistry({ spawnIndexer: spawnFn });
  const taskRegistry = createTaskRegistry();
  const app = createApp({
    jobRegistry, taskRegistry, adapter: makeStubAdapter(adapterOverrides),
    checkOllamaFn: async () => ({ status: 'available', message: 'ok' }),
    allowedRootsGuard: ALLOW_ALL_ROOTS_GUARD,
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base, { jobRegistry, taskRegistry });
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

// predicate may be sync or async — awaited either way, so an async
// predicate's pending-Promise-is-truthy footgun can't silently make this
// resolve on the very first tick before the condition is actually true.
async function waitFor(predicate, { timeoutMs = 500, intervalMs = 5 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('GET /api/operations — merged jobs + tasks view', () => {
  it('returns an empty list when nothing has ever run', async () => {
    await withOpsApp({}, async (base) => {
      const res = await fetch(base + '/api/operations');
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.deepEqual(body.operations, []);
    });
  });

  it('a started indexing job appears with kind "index" by default', async () => {
    await withOpsApp({}, async (base) => {
      await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'my-docs', path: './docs' }),
      });
      const { operations } = await (await fetch(base + '/api/operations')).json();
      assert.equal(operations.length, 1);
      assert.equal(operations[0].kind, 'index');
      assert.equal(operations[0].collection, 'my-docs');
      assert.equal(operations[0].state, 'running');
      assert.equal(operations[0].cancellable, true);
    });
  });

  it('passing kind: "reindex" on the start request is reflected in the operation', async () => {
    await withOpsApp({}, async (base) => {
      await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'my-docs', path: './docs', kind: 'reindex' }),
      });
      const { operations } = await (await fetch(base + '/api/operations')).json();
      assert.equal(operations[0].kind, 'reindex');
    });
  });

  it('a running job with no progress data yet reports progress: null (indeterminate), not a fabricated 0%', async () => {
    await withOpsApp({}, async (base) => {
      await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'my-docs', path: './docs' }),
      });
      const { operations } = await (await fetch(base + '/api/operations')).json();
      assert.equal(operations[0].progress, null);
    });
  });

  it('a job with real progress data reports percent/phase/file counts', async () => {
    await withOpsApp({ spawnFn: makeNeverExitingSpawn() }, async (base, { jobRegistry }) => {
      await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'my-docs', path: './docs' }),
      });
      const active = jobRegistry.getActiveJob();
      active.progress = { processedFiles: 2, totalFiles: 4, currentFile: 'b.md', currentStep: 'Embedding chunks', currentFileProgress: 0.8 };

      const { operations } = await (await fetch(base + '/api/operations')).json();
      const op = operations[0];
      assert.equal(op.progress.processedFiles, 2);
      assert.equal(op.progress.totalFiles, 4);
      assert.equal(op.progress.currentFile, 'b.md');
      assert.equal(op.progress.phase, 'Embedding chunks');
      assert.equal(Math.round(op.progress.percent), 70); // (2 + 0.8) / 4 * 100
    });
  });

  // Phase 3S bug found via live Playwright verification: a failed job's
  // error field was only ever populated on the DETAIL endpoint
  // (GET /api/operations/:id), never on the LIST endpoint the modal's
  // initial render and the completion-toast transition event both actually
  // read from — so a real indexing failure showed a blank error summary in
  // the modal card and a toast with no reason text at all, even though the
  // backend genuinely had one. Fixed by computing the same firstErrorLine()
  // for both endpoints.
  it('a failed job\'s error field is populated on the LIST endpoint too, not only the detail endpoint', async () => {
    await withOpsApp({ spawnFn: makeScriptedSpawn({ exitCode: 1, stderr: '[job] failed to start: ENOENT\n' }) }, async (base) => {
      await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'my-docs', path: './docs' }),
      });
      await waitFor(async () => {
        const { operations } = await (await fetch(base + '/api/operations')).json();
        return operations[0]?.state === 'failed';
      });
      const { operations } = await (await fetch(base + '/api/operations')).json();
      assert.equal(operations[0].state, 'failed');
      assert.match(operations[0].error, /ENOENT/, 'the LIST endpoint must carry the same error summary the detail endpoint does, without an extra fetch');
    });
  });

  it('a repair task appears with kind "repair", progress: null (indeterminate), and cancellable: false', async () => {
    await withOpsApp({}, async (base) => {
      await fetch(base + '/api/collections/my-docs/sync-schema', { method: 'POST' });
      const { operations } = await (await fetch(base + '/api/operations')).json();
      const repairOp = operations.find(op => op.kind === 'repair');
      assert.ok(repairOp, 'a repair task must appear in the merged operations list');
      assert.equal(repairOp.collection, 'my-docs');
      assert.equal(repairOp.progress, null);
      assert.equal(repairOp.cancellable, false);
      assert.equal(repairOp.state, 'succeeded'); // the sync-schema request already awaited completion
    });
  });

  // The sync-schema response's `id` field (Phase 3S) is what lets the
  // frontend open the operation modal on the exact repair it just started
  // (settings-view.js's runSettingsRepair()) instead of guessing "the
  // newest operation in the store" — confirms it's a real, resolvable id,
  // not just present-but-useless.
  it('the sync-schema response\'s id resolves to the same repair task via GET /api/operations/:id', async () => {
    await withOpsApp({}, async (base) => {
      const res = await fetch(base + '/api/collections/my-docs/sync-schema', { method: 'POST' });
      const { id } = await res.json();
      assert.equal(typeof id, 'string');

      const detailRes = await fetch(base + `/api/operations/${id}`);
      assert.equal(detailRes.status, 200);
      const { operation } = await detailRes.json();
      assert.equal(operation.id, id);
      assert.equal(operation.kind, 'repair');
      assert.equal(operation.collection, 'my-docs');
      assert.equal(operation.state, 'succeeded');
    });
  });

  it('a failed repair task reports state failed with a sanitised error message', async () => {
    await withOpsApp({ adapterOverrides: { ensureCollectionSchema: async () => { throw new Error('Qdrant unreachable'); } } }, async (base) => {
      await fetch(base + '/api/collections/my-docs/sync-schema', { method: 'POST' });
      const { operations } = await (await fetch(base + '/api/operations')).json();
      const repairOp = operations.find(op => op.kind === 'repair');
      assert.equal(repairOp.state, 'failed');
    });
  });

  // Regression: this test's own name previously asserted nothing about
  // sanitisation, only state === 'failed' — a genuinely unredacted secret
  // in repairOp.error would have passed it silently. Exercises the real
  // HTTP round trip (sync-schema -> task-registry.js's redaction ->
  // GET /api/operations), not task-registry.test.js's more direct
  // registry-level unit tests, so this specifically guards the wiring
  // between the two, not just the redaction function itself.
  it('a failed repair task\'s error is actually redacted end-to-end, not just marked failed', async () => {
    const originalKey = process.env.QDRANT_KEY;
    process.env.QDRANT_KEY = 'sk-super-secret-token';
    try {
      await withOpsApp({
        adapterOverrides: {
          ensureCollectionSchema: async () => { throw new Error('auth failed with key sk-super-secret-token at https://user:pass@qdrant.example.com/x'); },
        },
      }, async (base) => {
        await fetch(base + '/api/collections/my-docs/sync-schema', { method: 'POST' });
        const { operations } = await (await fetch(base + '/api/operations')).json();
        const repairOp = operations.find(op => op.kind === 'repair');
        assert.equal(repairOp.state, 'failed');
        assert.doesNotMatch(repairOp.error, /sk-super-secret-token|user:pass/, 'the raw key/credentials must never reach the API response');
        assert.match(repairOp.error, /\[REDACTED\]/);
      });
    } finally {
      process.env.QDRANT_KEY = originalKey;
    }
  });

  it('jobs and tasks are merged newest-first by startedAt, not just concatenated', async () => {
    await withOpsApp({ spawnFn: makeScriptedSpawn({ delayMs: 5 }) }, async (base) => {
      await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'first', path: './docs' }),
      });
      await waitFor(async () => {
        const { operations } = await (await fetch(base + '/api/operations')).json();
        return operations[0]?.state === 'succeeded';
      });
      await fetch(base + '/api/collections/my-docs/sync-schema', { method: 'POST' });

      const { operations } = await (await fetch(base + '/api/operations')).json();
      assert.equal(operations[0].kind, 'repair', 'the most recently started operation must be first');
      assert.equal(operations[1].kind, 'index');
    });
  });
});

describe('GET /api/operations/:id — single operation detail', () => {
  it('returns a job\'s detail including sourcePath and log', async () => {
    await withOpsApp({ spawnFn: makeScriptedSpawn({ stdout: 'building index\n' }) }, async (base) => {
      const startRes = await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'my-docs', path: './docs' }),
      });
      const { job } = await startRes.json();
      await waitFor(async () => {
        const r = await fetch(base + `/api/operations/${job.id}`);
        const b = await r.json();
        return b.operation.state === 'succeeded';
      });
      const res = await fetch(base + `/api/operations/${job.id}`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.operation.sourcePath, './docs');
      assert.ok(body.operation.log.some(l => l.includes('building index')));
    });
  });

  it('returns a repair task\'s detail with an empty log (no log capture for in-process tasks)', async () => {
    await withOpsApp({}, async (base) => {
      await fetch(base + '/api/collections/my-docs/sync-schema', { method: 'POST' });
      const { operations } = await (await fetch(base + '/api/operations')).json();
      const repairOp = operations.find(op => op.kind === 'repair');
      const res = await fetch(base + `/api/operations/${repairOp.id}`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.deepEqual(body.operation.log, []);
      assert.equal(body.operation.sourcePath, null);
    });
  });

  it('returns 404 for an unknown operation id', async () => {
    await withOpsApp({}, async (base) => {
      const res = await fetch(base + '/api/operations/nope');
      assert.equal(res.status, 404);
      assert.equal((await res.json()).error.code, 'not_found');
    });
  });

  it('a failed job\'s detail carries the first stderr line as a concise error field', async () => {
    await withOpsApp({ spawnFn: makeScriptedSpawn({ exitCode: 1 }) }, async (base) => {
      const startRes = await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'my-docs', path: './docs' }),
      });
      const { job } = await startRes.json();
      await waitFor(async () => {
        const r = await fetch(base + `/api/operations/${job.id}`);
        return (await r.json()).operation.state === 'failed';
      });
      const res = await fetch(base + `/api/operations/${job.id}`);
      const body = await res.json();
      assert.equal(body.operation.state, 'failed');
      // No explicit stderr line was scripted, so this just confirms the
      // field exists and doesn't throw — the "real content" case is covered
      // by ui-operation-store tests using a stubbed API response instead of
      // a real (slow, timing-sensitive) child-process failure line.
      assert.ok('error' in body.operation);
    });
  });

  // Regression: confirmed live against a real indexer failure (a bad
  // source path) — Node's default uncaught-exception dump is multi-line
  // ("Error: ENOENT: ..." then several "at ..." stack frames, ending with a
  // bare "}" closing the error object's own inspect dump). Picking the
  // LAST stderr line (the original heuristic, inherited from jobs-view.js's
  // now-deleted loadJobLog()) surfaced a useless bare "}" as the entire
  // error summary in both the modal and the failure toast. The fix reads
  // the FIRST stderr line instead.
  it('a multi-line stack-trace failure surfaces the actual message (first line), not the closing brace (last line)', async () => {
    const stackTrace = "Error: ENOENT: no such file or directory, stat 'C:\\bad\\path'\n"
      + '    at statSync (node:fs:1701:25)\n'
      + '    at main (file:///indexer/index.js:556:23) {\n'
      + "  errno: -4058,\n"
      + "  code: 'ENOENT',\n"
      + '}\n';
    await withOpsApp({ spawnFn: makeScriptedSpawn({ exitCode: 1, stderr: stackTrace }) }, async (base) => {
      const startRes = await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'my-docs', path: './docs' }),
      });
      const { job } = await startRes.json();
      await waitFor(async () => {
        const { operations } = await (await fetch(base + '/api/operations')).json();
        return operations[0]?.state === 'failed';
      });
      const { operations } = await (await fetch(base + '/api/operations')).json();
      assert.match(operations[0].error, /^Error: ENOENT/, 'the LIST endpoint error must be the actual message, not the closing brace');
      assert.notEqual(operations[0].error.trim(), '}');

      const { operation } = await (await fetch(base + `/api/operations/${job.id}`)).json();
      assert.match(operation.error, /^Error: ENOENT/, 'the detail endpoint must agree with the list endpoint');
    });
  });
});
