// GET /api/operations, GET /api/operations/:id — a single merged,
// read-only view over the job registry (spawned indexing/reindexing jobs)
// and the task registry (in-process repair tasks), so the frontend has ONE
// shape and ONE poll target for "what operation is in flight" regardless of
// which registry actually tracks it (Phase 3S — "do not maintain separate
// incompatible job and repair status models").
//
// POST /api/jobs/index and POST /api/collections/:name/sync-schema remain
// the two write endpoints (unchanged contracts, api/jobs.js and
// api/collections.js) — this module only reads and normalizes.
import { sendJson, notFound } from '../../../core/http/http.js';
import { toJobSummary, toJobDetail } from './jobs.js';

// The concise, already-sanitised (job.log lines are redacted at capture
// time — see jobs/registry.js's appendLine()) failure reason for a failed
// job: its FIRST "[stderr] ..." log line, with the stream prefix stripped.
// Shared by both jobToOperation() (the LIST endpoint — a failure toast and
// the modal's initial card render both need this the moment a job is first
// seen as failed, not only after the separate detail fetch resolves) and
// the :id detail route below (which additionally returns the full log).
//
// First, not last: confirmed live (Phase 3S verification) that the
// indexer's uncaught-exception output is Node's default multi-line stack
// dump — "Error: ENOENT: ..." on the first stderr line, then several lines
// of "at ..." stack frames, ending with a bare "}" closing the error
// object's own util.inspect dump. The LAST stderr line is reliably the
// least useful one for exactly the failure shape this app hits most (an
// uncaught exception from a bad path/config), while the first line is the
// actual message in every case observed — a plain single-line
// console.error() also puts its one meaningful line first, so this is not
// a regression for that simpler case either.
function firstErrorLine(job) {
  if (job.state !== 'failed') return null;
  const line = job.log.find(l => l.stream === 'stderr');
  return line ? line.line : null;
}

// Every operation the UI can show, in one shape, regardless of source
// registry:
//   { id, kind: 'index'|'reindex'|'repair', collection, state,
//     startedAt, finishedAt, cancellable,
//     progress: { percent, phase, currentFile, processedFiles, totalFiles } | null,
//     error: string | null }
// `phase` here is toJobSummary()'s `progress.currentStep` renamed for a
// source-agnostic name — a repair task has no per-file phase concept, so
// its progress is always null (indeterminate bar, never a fabricated
// percentage) rather than a fake single-phase progress object.
function jobToOperation(job) {
  const summary = toJobSummary(job);
  const cancellable = summary.state === 'queued' || summary.state === 'running';
  return {
    id: summary.id,
    kind: summary.kind,
    collection: summary.collection,
    path: summary.path,
    state: summary.state,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    cancellable,
    progress: summary.progress?.processedFiles === null && summary.progress?.totalFiles === null
      ? null
      : {
          percent: summary.progress.percent,
          phase: summary.progress.currentStep,
          currentFile: summary.progress.currentFile,
          processedFiles: summary.progress.processedFiles,
          totalFiles: summary.progress.totalFiles,
        },
    error: firstErrorLine(job),
  };
}

function taskToOperation(task) {
  return {
    id: task.id,
    kind: task.kind,
    collection: task.collection,
    path: null,
    state: task.state,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    // Repair has no genuine cancel point today (a handful of already-
    // in-flight Qdrant calls with no cancellation token) — never show a
    // cancel button for something that can't actually be cancelled (task
    // requirement: "not cancellable unless cancellation is genuinely
    // supported").
    cancellable: false,
    progress: null, // always indeterminate — no per-step signal exists for repair
    error: task.state === 'failed' ? task.error : null,
  };
}

// Sorts a mixed jobs+tasks operation list newest-first by startedAt — each
// source registry already returns its own list newest-first, but merging
// two separately-sorted lists needs its own comparison, not a plain
// concatenation (which would interleave incorrectly whenever a repair task
// and an indexing job overlap in time).
function sortByStartedAtDesc(operations) {
  return [...operations].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

export function registerOperationsRoutes(router, { jobRegistry, taskRegistry }) {
  router.get('/api/operations', ({ res }) => {
    const jobs = jobRegistry.listJobs().map(jobToOperation);
    const tasks = taskRegistry.listTasks().map(taskToOperation);
    sendJson(res, 200, { operations: sortByStartedAtDesc([...jobs, ...tasks]) });
  });

  router.get('/api/operations/:id', ({ res, params }) => {
    const job = jobRegistry.getJob(params.id);
    if (job) {
      const detail = toJobDetail(job);
      sendJson(res, 200, {
        operation: {
          ...jobToOperation(job), // .error already computed via firstErrorLine() above — same value the list endpoint now carries too
          sourcePath: job.path,
          log: detail.log,
        },
      });
      return;
    }
    const task = taskRegistry.getTask(params.id);
    if (task) {
      sendJson(res, 200, {
        operation: { ...taskToOperation(task), sourcePath: null, log: [] },
      });
      return;
    }
    throw notFound(`Operation "${params.id}" not found`);
  });
}
