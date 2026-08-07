// In-memory registry for in-process async operations (repair/sync-schema) —
// a smaller state machine than createJobRegistry() (jobs/registry.js):
// running/succeeded/failed only, no queued (an in-process function starts
// immediately, there's no OS scheduling delay to represent) and no
// cancelling/cancelled (no genuine cancellation point exists for a repair
// call today — see api/operations.js's taskToOperation(), which always
// reports cancellable: false for this registry's tasks). No log capture,
// no stdout/stderr, no kill() — a repair call is a handful of network
// round-trips against Qdrant, not a long-running process with its own
// output stream.
//
// Kept as a SEPARATE registry from createJobRegistry() rather than folding
// repair into it: the job registry's spawn/kill/line-splitter machinery is
// unrelated to what a repair task needs, and job.child/job.log would either
// have to be faked or made nullable throughout jobs/registry.js's existing
// (and thoroughly tested) code for a task type that has neither. Instead,
// api/operations.js merges both registries into one read-only view for the
// UI — this file's job is only to track repair tasks; the merge point is
// what makes the modal render both through a single shared shape (Phase 3S).
import { randomUUID } from 'node:crypto';
import { sanitiseErrorMessage } from '../../shared/core/doctor-checks.js';

export const TASK_STATES = Object.freeze({
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
});

/**
 * @param {{ nowFn?: () => Date }} [options] nowFn is injectable so tests can
 *   pin timestamps without faking the global clock.
 */
export function createTaskRegistry({ nowFn = () => new Date() } = {}) {
  const tasks = new Map(); // id -> task record, insertion order = start order

  /**
   * Starts tracking a task immediately (state: running — there is no
   * separate queueing stage for an in-process function, unlike a spawned
   * job that must wait for the OS to actually schedule the process), runs
   * `fn`, and ALSO returns the underlying promise so a caller that needs to
   * respond synchronously once the task finishes (e.g. the repair endpoint,
   * which keeps its original synchronous 200-with-result HTTP contract) can
   * `await` the exact same execution the registry is tracking — rather than
   * the caller running `fn` a second time itself. `fn`'s resolved value
   * becomes `task.result` (repair's own `{ repaired, warnings }` shape,
   * opaque to this registry); a thrown/rejected error becomes `task.error`,
   * redacted via sanitiseErrorMessage() (same QDRANT_KEY/URL-credential
   * scrubbing jobs/registry.js's appendLine() applies to job logs) before
   * being stored — this registry's only caller today (repair) always
   * touches Qdrant, so an unredacted error could leak a key or a
   * credentialed connection URL straight into an API response.
   *
   * @param {{ kind: string, collection: string, fn: () => Promise<any> }} params
   * @returns {{ id: string, done: Promise<any> }} `done` resolves/rejects
   *   exactly like `fn()` itself would.
   */
  function runTracked({ kind, collection, fn }) {
    const id = randomUUID();
    const task = {
      id,
      kind,
      collection,
      state: TASK_STATES.RUNNING,
      startedAt: nowFn().toISOString(),
      finishedAt: null,
      result: null,
      error: null,
    };
    tasks.set(id, task);

    const done = Promise.resolve().then(fn).then(
      (result) => {
        task.state = TASK_STATES.SUCCEEDED;
        task.result = result ?? null;
        task.finishedAt = nowFn().toISOString();
        return result;
      },
      (err) => {
        task.state = TASK_STATES.FAILED;
        // Redacted at capture time, same convention as jobs/registry.js's
        // appendLine() — a repair task's `fn` always touches Qdrant
        // (api/collections.js's sync-schema route is task-registry.js's
        // only caller today), so a thrown error can legitimately contain
        // QDRANT_KEY or a connection URL with embedded credentials. task.error
        // is served back to the client verbatim via /api/operations, so
        // redaction has to happen here, not just hoped for downstream.
        task.error = sanitiseErrorMessage(err?.message ?? String(err), process.env.QDRANT_KEY);
        task.finishedAt = nowFn().toISOString();
        throw err;
      }
    );

    return { id, done };
  }

  function getTask(id) {
    return tasks.get(id) ?? null;
  }

  /** Newest first — same ordering convention as listJobs(). */
  function listTasks() {
    return [...tasks.values()].reverse();
  }

  return { runTracked, getTask, listTasks, TASK_STATES };
}
