// Tests for src/admin/jobs/task-registry.js — the in-process-async-operation
// counterpart to jobs/registry.js's spawned-process job registry (Phase 3S).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskRegistry, TASK_STATES } from '../../../src/admin/jobs/task-registry.js';

describe('createTaskRegistry()', () => {
  it('starts a task as "running" immediately — no queued stage for an in-process function', async () => {
    const registry = createTaskRegistry();
    let resolveFn;
    const pending = new Promise((resolve) => { resolveFn = resolve; });
    const { id, done } = registry.runTracked({
      kind: 'repair', collection: 'my-docs',
      fn: () => pending,
    });
    const task = registry.getTask(id);
    assert.equal(task.state, TASK_STATES.RUNNING);
    assert.equal(task.finishedAt, null);
    resolveFn({}); // avoid an unresolved promise lingering past the test
    await done;
  });

  it('transitions to succeeded with the resolved value as task.result', async () => {
    const registry = createTaskRegistry();
    const { id, done } = registry.runTracked({
      kind: 'repair', collection: 'my-docs',
      fn: async () => ({ repaired: ['index x'], warnings: [] }),
    });
    await done;
    const task = registry.getTask(id);
    assert.equal(task.state, TASK_STATES.SUCCEEDED);
    assert.deepEqual(task.result, { repaired: ['index x'], warnings: [] });
    assert.equal(task.error, null);
    assert.ok(task.finishedAt);
  });

  it('transitions to failed with the error message as task.error, and never produces an unhandled rejection', async () => {
    const registry = createTaskRegistry();
    const { id, done } = registry.runTracked({
      kind: 'repair', collection: 'my-docs',
      fn: async () => { throw new Error('Qdrant unreachable'); },
    });
    await assert.rejects(done, /Qdrant unreachable/);
    const task = registry.getTask(id);
    assert.equal(task.state, TASK_STATES.FAILED);
    assert.equal(task.error, 'Qdrant unreachable');
    assert.equal(task.result, null);
  });

  // Regression: task.error used to store err.message verbatim. This
  // registry's only real caller (repair, via api/collections.js's
  // sync-schema route) always touches Qdrant, so a thrown error can
  // legitimately contain the literal QDRANT_KEY or a connection URL with
  // embedded credentials — and task.error is served back to the client
  // as-is via GET /api/operations, so an unredacted message here is a
  // direct secret leak through the API, not just a log-file concern.
  it('redacts a literal QDRANT_KEY occurrence in the error message before storing it', async () => {
    const registry = createTaskRegistry();
    const originalKey = process.env.QDRANT_KEY;
    process.env.QDRANT_KEY = 'sk-super-secret-token';
    try {
      const { id, done } = registry.runTracked({
        kind: 'repair', collection: 'my-docs',
        fn: async () => { throw new Error('auth failed with key sk-super-secret-token'); },
      });
      await assert.rejects(done);
      const task = registry.getTask(id);
      assert.doesNotMatch(task.error, /sk-super-secret-token/, 'the raw key must never be stored on the task record');
      assert.match(task.error, /\[REDACTED\]/);
    } finally {
      process.env.QDRANT_KEY = originalKey;
    }
  });

  it('redacts credentials/query string out of a URL embedded in the error message', async () => {
    const registry = createTaskRegistry();
    const { id, done } = registry.runTracked({
      kind: 'repair', collection: 'my-docs',
      fn: async () => { throw new Error('connecting to https://user:pass@qdrant.example.com/collections?api_key=sk-live-abc123'); },
    });
    await assert.rejects(done);
    const task = registry.getTask(id);
    assert.doesNotMatch(task.error, /user:pass|api_key=sk-live-abc123/, 'credentials and query params must not survive in the stored error');
    assert.match(task.error, /https:\/\/qdrant\.example\.com/, 'the host-only form should still be present, per sanitiseErrorMessage()\'s existing contract');
  });

  it('done resolves/rejects exactly like fn() itself would — a caller can await it directly for a synchronous-looking contract', async () => {
    const registry = createTaskRegistry();
    const { done } = registry.runTracked({
      kind: 'repair', collection: 'my-docs',
      fn: async () => 'the actual result',
    });
    assert.equal(await done, 'the actual result');
  });

  it('getTask() returns null for an unknown id', () => {
    const registry = createTaskRegistry();
    assert.equal(registry.getTask('nope'), null);
  });

  it('listTasks() returns newest-first, same ordering convention as listJobs()', async () => {
    const registry = createTaskRegistry({ nowFn: (() => { let t = 0; return () => new Date(t++); })() });
    const a = registry.runTracked({ kind: 'repair', collection: 'a', fn: async () => 1 });
    const b = registry.runTracked({ kind: 'repair', collection: 'b', fn: async () => 2 });
    await a.done; await b.done;
    const [first, second] = registry.listTasks();
    assert.equal(first.collection, 'b');
    assert.equal(second.collection, 'a');
  });

  it('a task record never carries a raw process/child handle or any field beyond the documented shape', async () => {
    const registry = createTaskRegistry();
    const { id, done } = registry.runTracked({ kind: 'repair', collection: 'my-docs', fn: async () => ({}) });
    await done;
    const task = registry.getTask(id);
    assert.deepEqual(
      Object.keys(task).sort(),
      ['collection', 'error', 'finishedAt', 'id', 'kind', 'result', 'startedAt', 'state'].sort()
    );
  });
});
