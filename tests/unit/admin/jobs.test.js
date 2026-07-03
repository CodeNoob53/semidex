// Indexing job registry + API tests. No real indexer process is ever
// spawned — spawnFn is always a fake EventEmitter-based stub, so these
// tests run fully offline in whatever time node:test allows.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createJobRegistry, buildJobEnv } from '../../../src/admin/jobs/registry.js';
import { createApp } from '../../../src/admin/server.js';

// ── fake spawn helpers ──────────────────────────────────────────────────────

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { setTimeout(() => child.emit('exit', null, 'SIGTERM'), 1); };
  return child;
}

/** Never exits on its own — for cancel tests. Records the spawn call. */
function makeNeverExitingSpawn(calls) {
  return (command, args, opts) => {
    calls.push({ command, args, opts });
    return makeFakeChild();
  };
}

/**
 * A child whose kill() does NOT emit 'exit' on its own — the test decides
 * exactly when the process "really" stops by calling the returned
 * `triggerExit()`. Needed to deterministically test the window between
 * cancelJob() and the process's actual exit, which makeFakeChild's
 * always-async-but-fast kill() can't reliably hold open across an HTTP
 * round trip (the 1ms auto-exit can beat a fetch() call to the server).
 */
function makeManualExitSpawn() {
  let triggerExit;
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {}; // signal sent, no automatic exit
    triggerExit = (code = null, signal = 'SIGTERM') => child.emit('exit', code, signal);
    return child;
  };
  return { spawnFn, triggerExit: (...args) => triggerExit(...args) };
}

/** Exits after `delayMs` with the given code/stdout/stderr. */
function makeScriptedSpawn({ delayMs = 10, exitCode = 0, signal = null, stdout = '', stderr = '' } = {}, calls) {
  return (command, args, opts) => {
    calls?.push({ command, args, opts });
    const child = makeFakeChild();
    setTimeout(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('exit', exitCode, signal);
    }, delayMs);
    return child;
  };
}

function waitFor(predicate, { timeoutMs = 500, intervalMs = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// ── buildJobEnv ───────────────────────────────────────────────────────────────

describe('buildJobEnv', () => {
  it('always sets COLLECTION and the three always-present flags', () => {
    const env = buildJobEnv('demo', {});
    assert.equal(env.COLLECTION, 'demo');
    assert.equal(env.ONNX_EMBED, '0');
    assert.equal(env.SKELETON_CHUNKING, '0');
    assert.equal(env.SKELETON_NAV, '0');
  });

  it('sets flags to "1" when options are true', () => {
    const env = buildJobEnv('demo', { onnxEmbed: true, skeletonChunking: true, skeletonNav: true });
    assert.equal(env.ONNX_EMBED, '1');
    assert.equal(env.SKELETON_CHUNKING, '1');
    assert.equal(env.SKELETON_NAV, '1');
  });

  it('omits PRUNE_STALE and TAG_GEN entirely when false/unset (not "0")', () => {
    const env = buildJobEnv('demo', { pruneStale: false, tagGen: false });
    assert.equal('PRUNE_STALE' in env, false);
    assert.equal('TAG_GEN' in env, false);
  });

  it('sets PRUNE_STALE=1 and TAG_GEN=1 only when true', () => {
    const env = buildJobEnv('demo', { pruneStale: true, tagGen: true });
    assert.equal(env.PRUNE_STALE, '1');
    assert.equal(env.TAG_GEN, '1');
  });
});

// ── registry: spawn shape (no shell) ─────────────────────────────────────────

describe('createJobRegistry — spawns without a shell', () => {
  it('calls spawnFn with (command, argsArray, { env }) — no string concatenation', () => {
    const calls = [];
    const registry = createJobRegistry({ spawnFn: makeNeverExitingSpawn(calls) });
    registry.startIndexJob({ collection: 'demo', path: 'C:\\docs\\my folder' });

    assert.equal(calls.length, 1);
    const [{ command, args, opts }] = calls;
    assert.equal(typeof command, 'string');
    assert.ok(Array.isArray(args), 'args must be an array, not a shell string');
    assert.ok(args.some(a => a.includes('index.js')), 'args must include the indexer entry point');
    assert.ok(args.includes('C:\\docs\\my folder'), 'path is passed as its own array element, never concatenated');
    assert.equal(typeof opts.env, 'object');
    assert.equal(opts.shell, undefined, 'must never set shell:true');
  });

  it('passes the built env vars through to the child process env', () => {
    const calls = [];
    const registry = createJobRegistry({ spawnFn: makeNeverExitingSpawn(calls) });
    registry.startIndexJob({ collection: 'my-collection', path: './x', options: { onnxEmbed: true } });
    assert.equal(calls[0].opts.env.COLLECTION, 'my-collection');
    assert.equal(calls[0].opts.env.ONNX_EMBED, '1');
  });
});

// ── registry: log capture ────────────────────────────────────────────────────

describe('createJobRegistry — log capture', () => {
  it('captures stdout and stderr lines with their stream tagged', async () => {
    const registry = createJobRegistry({
      spawnFn: makeScriptedSpawn({ delayMs: 5, stdout: 'line one\nline two\n', stderr: 'warn line\n' }),
    });
    const { id } = registry.startIndexJob({ collection: 'demo', path: './x' });
    await waitFor(() => registry.getJob(id).state !== 'running');

    const job = registry.getJob(id);
    assert.deepEqual(job.log.map(l => l.stream), ['stdout', 'stdout', 'stderr']);
    assert.deepEqual(job.log.map(l => l.line), ['line one', 'line two', 'warn line']);
  });

  it('does not include empty lines from trailing newlines', async () => {
    const registry = createJobRegistry({ spawnFn: makeScriptedSpawn({ delayMs: 5, stdout: 'only line\n' }) });
    const { id } = registry.startIndexJob({ collection: 'demo', path: './x' });
    await waitFor(() => registry.getJob(id).state !== 'running');
    assert.deepEqual(registry.getJob(id).log, [{ stream: 'stdout', line: 'only line' }]);
  });

  it('redacts a literal QDRANT_KEY value that leaks into stderr', async () => {
    const savedKey = process.env.QDRANT_KEY;
    process.env.QDRANT_KEY = 'sk-super-secret-token';
    try {
      const registry = createJobRegistry({
        spawnFn: makeScriptedSpawn({ delayMs: 5, stderr: 'auth failed with key sk-super-secret-token\n' }),
      });
      const { id } = registry.startIndexJob({ collection: 'demo', path: './x' });
      await waitFor(() => registry.getJob(id).state !== 'running');
      const line = registry.getJob(id).log.find(l => l.stream === 'stderr').line;
      assert.ok(!line.includes('sk-super-secret-token'), `secret leaked into log: ${line}`);
      assert.match(line, /\[REDACTED\]/);
    } finally {
      if (savedKey === undefined) delete process.env.QDRANT_KEY; else process.env.QDRANT_KEY = savedKey;
    }
  });

  it('redacts a URL with embedded credentials that leaks into stdout', async () => {
    const registry = createJobRegistry({
      spawnFn: makeScriptedSpawn({ delayMs: 5, stdout: 'connecting to https://user:pass@qdrant.example.com/collections\n' }),
    });
    const { id } = registry.startIndexJob({ collection: 'demo', path: './x' });
    await waitFor(() => registry.getJob(id).state !== 'running');
    const line = registry.getJob(id).log.find(l => l.stream === 'stdout').line;
    assert.ok(!line.includes('user:pass'), `credentials leaked into log: ${line}`);
    assert.match(line, /https:\/\/qdrant\.example\.com/);
  });
});

// ── registry: concurrency (one job at a time) ────────────────────────────────

describe('createJobRegistry — one active job at a time', () => {
  it('throws JOB_ALREADY_RUNNING when starting a second job while one is active', () => {
    const registry = createJobRegistry({ spawnFn: makeNeverExitingSpawn([]) });
    registry.startIndexJob({ collection: 'a', path: './a' });
    assert.throws(
      () => registry.startIndexJob({ collection: 'b', path: './b' }),
      (err) => err.code === 'JOB_ALREADY_RUNNING',
    );
  });

  it('allows a new job to start after the active one finishes', async () => {
    const registry = createJobRegistry({ spawnFn: makeScriptedSpawn({ delayMs: 5 }) });
    const first = registry.startIndexJob({ collection: 'a', path: './a' });
    await waitFor(() => registry.getJob(first.id).state !== 'running');

    const second = registry.startIndexJob({ collection: 'b', path: './b' });
    assert.notEqual(second.id, first.id);
  });

  it('rejects a second start immediately after cancelJob(), before the process has actually exited', () => {
    // Regression: cancelJob() must NOT free the slot synchronously —
    // child.kill() only sends a signal, the process may still be running
    // (and still writing to Qdrant) until its own 'exit' event fires.
    const registry = createJobRegistry({ spawnFn: makeNeverExitingSpawn([]) });
    const first = registry.startIndexJob({ collection: 'a', path: './a' });
    registry.cancelJob(first.id);
    assert.equal(registry.getJob(first.id).state, 'cancelling');
    assert.throws(
      () => registry.startIndexJob({ collection: 'b', path: './b' }),
      (err) => err.code === 'JOB_ALREADY_RUNNING',
    );
  });

  it('allows a new job to start only after the cancelled process actually exits', async () => {
    const registry = createJobRegistry({ spawnFn: makeNeverExitingSpawn([]) });
    const first = registry.startIndexJob({ collection: 'a', path: './a' });
    registry.cancelJob(first.id);
    // makeFakeChild's kill() emits 'exit' asynchronously (setTimeout 1ms) —
    // wait for the real transition to 'cancelled' before starting a new job.
    await waitFor(() => registry.getJob(first.id).state === 'cancelled');
    const second = registry.startIndexJob({ collection: 'b', path: './b' });
    assert.notEqual(second.id, first.id);
  });
});

// ── registry: state transitions ──────────────────────────────────────────────

describe('createJobRegistry — state transitions', () => {
  it('queued -> running immediately on start', () => {
    const registry = createJobRegistry({ spawnFn: makeNeverExitingSpawn([]) });
    const { id } = registry.startIndexJob({ collection: 'a', path: './a' });
    assert.equal(registry.getJob(id).state, 'running');
  });

  it('running -> succeeded on exit code 0', async () => {
    const registry = createJobRegistry({ spawnFn: makeScriptedSpawn({ delayMs: 5, exitCode: 0 }) });
    const { id } = registry.startIndexJob({ collection: 'a', path: './a' });
    await waitFor(() => registry.getJob(id).state !== 'running');
    const job = registry.getJob(id);
    assert.equal(job.state, 'succeeded');
    assert.equal(job.exitCode, 0);
    assert.ok(job.finishedAt);
  });

  it('running -> failed on non-zero exit code', async () => {
    const registry = createJobRegistry({ spawnFn: makeScriptedSpawn({ delayMs: 5, exitCode: 1, stderr: 'boom\n' }) });
    const { id } = registry.startIndexJob({ collection: 'a', path: './a' });
    await waitFor(() => registry.getJob(id).state !== 'running');
    const job = registry.getJob(id);
    assert.equal(job.state, 'failed');
    assert.equal(job.exitCode, 1);
  });

  it('running -> failed when the child is killed by a signal', async () => {
    const registry = createJobRegistry({ spawnFn: makeScriptedSpawn({ delayMs: 5, exitCode: null, signal: 'SIGKILL' }) });
    const { id } = registry.startIndexJob({ collection: 'a', path: './a' });
    await waitFor(() => registry.getJob(id).state !== 'running');
    assert.equal(registry.getJob(id).state, 'failed');
  });

  it('running -> cancelling immediately on cancelJob(), then cancelled once the process actually exits', async () => {
    const registry = createJobRegistry({ spawnFn: makeNeverExitingSpawn([]) });
    const { id } = registry.startIndexJob({ collection: 'a', path: './a' });
    const afterCancel = registry.cancelJob(id);
    assert.equal(afterCancel.state, 'cancelling', 'must not jump straight to cancelled — the process may still be alive');
    assert.equal(registry.getActiveJob()?.id, id, 'cancelling must still count as active — blocks a second start');
    await waitFor(() => registry.getJob(id).finishedAt !== null);
    assert.equal(registry.getJob(id).state, 'cancelled');
    assert.equal(registry.getActiveJob(), null, 'slot frees only after the real exit event');
  });

  it('failed to start (spawn error) marks the job failed with no exit code', async () => {
    const registry = createJobRegistry({
      spawnFn: () => {
        const child = makeFakeChild();
        setTimeout(() => child.emit('error', new Error('ENOENT: node not found')), 5);
        return child;
      },
    });
    const { id } = registry.startIndexJob({ collection: 'a', path: './a' });
    await waitFor(() => registry.getJob(id).state !== 'running');
    const job = registry.getJob(id);
    assert.equal(job.state, 'failed');
    assert.equal(job.exitCode, null);
    assert.ok(job.log.some(l => l.line.includes('ENOENT')));
  });

  it('cancelJob on an already-finished job is a no-op that returns the job unchanged', async () => {
    const registry = createJobRegistry({ spawnFn: makeScriptedSpawn({ delayMs: 5 }) });
    const { id } = registry.startIndexJob({ collection: 'a', path: './a' });
    await waitFor(() => registry.getJob(id).state !== 'running');
    const before = registry.getJob(id).state;
    const result = registry.cancelJob(id);
    assert.equal(result.state, before);
  });

  it('cancelJob on an unknown id returns null', () => {
    const registry = createJobRegistry({ spawnFn: makeNeverExitingSpawn([]) });
    assert.equal(registry.cancelJob('does-not-exist'), null);
  });
});

// ── registry: listing ────────────────────────────────────────────────────────

describe('createJobRegistry — listJobs', () => {
  it('returns jobs newest first', async () => {
    const registry = createJobRegistry({ spawnFn: makeScriptedSpawn({ delayMs: 5 }) });
    const first = registry.startIndexJob({ collection: 'a', path: './a' });
    await waitFor(() => registry.getJob(first.id).state !== 'running');
    const second = registry.startIndexJob({ collection: 'b', path: './b' });
    const list = registry.listJobs();
    assert.equal(list[0].id, second.id);
    assert.equal(list[1].id, first.id);
  });
});

// ── API: request validation ──────────────────────────────────────────────────

async function withJobApp(spawnFn, fn) {
  const jobRegistry = createJobRegistry({ spawnFn });
  const app = createApp({ jobRegistry, adapter: makeStubAdapter() });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base, jobRegistry);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

function makeStubAdapter() {
  return {
    name: () => 'stub', capabilities: () => ({}), ping: async () => ({ ok: true, detail: '' }),
    listCollections: async () => [], getCollection: async () => null, createCollection: async () => {},
    deleteCollection: async () => {}, ensureCollectionSchema: async () => ({ repaired: [], warnings: [] }),
    listSourceDocuments: async () => [], getChunk: async () => [], searchHybrid: async () => [],
    getSkeletonRoot: async () => null, getSkeletonNode: async () => null, getSkeletonChildren: async () => [],
    getStructuralNode: async () => null,
  };
}

describe('POST /api/jobs/index — validation', () => {
  it('requires collection', async () => {
    await withJobApp(makeNeverExitingSpawn([]), async (base) => {
      const res = await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: './x' }),
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, 'bad_request');
    });
  });

  it('requires path', async () => {
    await withJobApp(makeNeverExitingSpawn([]), async (base) => {
      const res = await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'demo' }),
      });
      assert.equal(res.status, 400);
    });
  });

  it('rejects a non-object options field', async () => {
    await withJobApp(makeNeverExitingSpawn([]), async (base) => {
      const res = await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'demo', path: './x', options: 'nope' }),
      });
      assert.equal(res.status, 400);
    });
  });

  it('rejects a non-boolean option value', async () => {
    await withJobApp(makeNeverExitingSpawn([]), async (base) => {
      const res = await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'demo', path: './x', options: { onnxEmbed: 'yes' } }),
      });
      assert.equal(res.status, 400);
    });
  });

  for (const url of ['http://example.com/docs', 'https://example.com/docs', 'file:///C:/docs', 'ftp://example.com/docs']) {
    it(`rejects a remote URL as path: ${url}`, async () => {
      await withJobApp(makeNeverExitingSpawn([]), async (base) => {
        const res = await fetch(base + '/api/jobs/index', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ collection: 'demo', path: url }),
        });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error.code, 'bad_request');
      });
    });
  }

  for (const path of ['C:\\path\\to\\docs', 'C:/path/to/docs', './docs', '../docs', 'docs']) {
    it(`accepts a local path: ${path}`, async () => {
      await withJobApp(makeNeverExitingSpawn([]), async (base) => {
        const res = await fetch(base + '/api/jobs/index', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ collection: 'demo', path }),
        });
        assert.equal(res.status, 202);
      });
    });
  }
});

describe('POST /api/jobs/index — success and conflict', () => {
  it('starts a job and returns 202 with a job summary', async () => {
    await withJobApp(makeNeverExitingSpawn([]), async (base) => {
      const res = await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'demo', path: './docs', options: { onnxEmbed: true } }),
      });
      assert.equal(res.status, 202);
      const body = await res.json();
      assert.equal(body.job.collection, 'demo');
      assert.equal(body.job.path, './docs');
      assert.equal(body.job.state, 'running');
      assert.ok(body.job.id);
      // no raw child_process handle or env dump leaked to the client
      assert.equal('child' in body.job, false);
      assert.equal('env' in body.job, false);
    });
  });

  it('returns 409 conflict when a job is already running', async () => {
    await withJobApp(makeNeverExitingSpawn([]), async (base) => {
      await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'a', path: './a' }),
      });
      const res = await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'b', path: './b' }),
      });
      assert.equal(res.status, 409);
      assert.equal((await res.json()).error.code, 'conflict');
    });
  });
});

describe('GET /api/jobs', () => {
  it('lists jobs newest first', async () => {
    await withJobApp(makeScriptedSpawn({ delayMs: 5 }), async (base) => {
      await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'a', path: './a' }),
      });
      await new Promise((r) => setTimeout(r, 30));
      await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'b', path: './b' }),
      });

      const res = await fetch(base + '/api/jobs');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.jobs.length, 2);
      assert.equal(body.jobs[0].collection, 'b');
    });
  });
});

describe('GET /api/jobs/:id', () => {
  it('returns job detail with a log field', async () => {
    await withJobApp(makeScriptedSpawn({ delayMs: 5, stdout: 'hello\n' }), async (base) => {
      const start = await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'demo', path: './x' }),
      });
      const { job } = await start.json();
      await new Promise((r) => setTimeout(r, 30));

      const res = await fetch(base + `/api/jobs/${job.id}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.job.state, 'succeeded');
      assert.ok(Array.isArray(body.job.log));
      assert.ok(body.job.log.some(l => l.includes('hello')));
    });
  });

  it('returns 404 for an unknown job id', async () => {
    await withJobApp(makeNeverExitingSpawn([]), async (base) => {
      const res = await fetch(base + '/api/jobs/does-not-exist');
      assert.equal(res.status, 404);
    });
  });
});

describe('POST /api/jobs/:id/cancel', () => {
  it('requests cancellation of a running job (cancelling, not yet cancelled), and still blocks a second start until the process actually exits', async () => {
    // Uses a manual-exit fake (not makeNeverExitingSpawn's auto-kill) so the
    // process's real exit is fully under this test's control — an HTTP round
    // trip is enough real time to beat a 1ms auto-exit and make the "still
    // blocked" assertion flaky with the other fake.
    const { spawnFn, triggerExit } = makeManualExitSpawn();
    await withJobApp(spawnFn, async (base) => {
      const start = await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'demo', path: './x' }),
      });
      const { job } = await start.json();

      const res = await fetch(base + `/api/jobs/${job.id}/cancel`, { method: 'POST' });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).job.state, 'cancelling');

      // The process hasn't "exited" yet (triggerExit() not called) — a
      // second job must still be rejected.
      const secondStart = await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'other', path: './y' }),
      });
      assert.equal(secondStart.status, 409);

      // Now the process really exits — the slot frees, a new job can start.
      triggerExit();
      await new Promise((r) => setTimeout(r, 10));
      const thirdStart = await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'other', path: './y' }),
      });
      assert.equal(thirdStart.status, 202);
    });
  });

  it('returns 404 for an unknown job id', async () => {
    await withJobApp(makeNeverExitingSpawn([]), async (base) => {
      const res = await fetch(base + '/api/jobs/does-not-exist/cancel', { method: 'POST' });
      assert.equal(res.status, 404);
    });
  });
});
