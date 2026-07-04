// In-memory indexing job registry. Spawns the existing indexer CLI as a
// child process — no indexer library refactor, no in-process import (design
// doc §9: process isolation, natural log capture, zero indexer changes).
//
// MVP concurrency: ONE active indexing job at a time, globally (not
// per-collection) — matches the task spec exactly. A second start attempt
// while a job is running/queued is rejected by the API layer with 409, not
// silently queued.
import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sanitiseErrorMessage } from '../../core/doctor-checks.js';

// Absolute path to src/indexer/index.js, resolved once at module load —
// spawning by absolute path avoids any dependency on the child process's cwd.
const INDEXER_ENTRY = fileURLToPath(new URL('../../indexer/index.js', import.meta.url));

const MAX_LOG_LINES = 2000;
const STATES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  CANCELLING: 'cancelling',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

/**
 * Translate the typed options object from the API request into env var
 * strings. Never composed by the UI — only here, at spawn time (design doc
 * §9). PRUNE_STALE/TAG_GEN are set only when true (task spec: "PRUNE_STALE=1
 * only when true", "TAG_GEN=1 only when true" — omitted otherwise, matching
 * how the indexer already treats an unset var as off). `llmSummaries` maps
 * to SKELETON_SUMMARY=llm (the indexer's existing opt-in for LLM-generated
 * nav-node summaries instead of deterministic ones) — omitted when false,
 * same "unset = off" convention as the other optional flags.
 *
 * @param {{ onnxEmbed?: boolean, skeletonChunking?: boolean, skeletonNav?: boolean, llmSummaries?: boolean, pruneStale?: boolean, tagGen?: boolean }} options
 */
export function buildJobEnv(collection, options = {}) {
  const env = {
    COLLECTION: collection,
    ONNX_EMBED: options.onnxEmbed ? '1' : '0',
    SKELETON_CHUNKING: options.skeletonChunking ? '1' : '0',
    SKELETON_NAV: options.skeletonNav ? '1' : '0',
  };
  if (options.llmSummaries) env.SKELETON_SUMMARY = 'llm';
  if (options.pruneStale) env.PRUNE_STALE = '1';
  if (options.tagGen) env.TAG_GEN = '1';
  return env;
}

// Redacts QDRANT_KEY (if set) and any URL with embedded credentials/query
// string before a line is ever stored — the indexer/Qdrant/Ollama can print
// secrets to stdout/stderr on error paths this registry doesn't control, and
// job.log is served back through the API verbatim, so redaction has to
// happen at capture time, not just at response time.
function appendLog(job, stream, text) {
  const sanitised = sanitiseErrorMessage(text, process.env.QDRANT_KEY);
  for (const line of sanitised.split(/\r?\n/)) {
    if (line === '') continue;
    job.log.push({ stream, line });
  }
  if (job.log.length > MAX_LOG_LINES) {
    job.log.splice(0, job.log.length - MAX_LOG_LINES);
  }
}

/**
 * Create a job registry. `spawnFn` defaults to node:child_process.spawn and
 * is dependency-injectable so unit tests never launch a real indexer
 * process — tests pass a fake that returns an EventEmitter-shaped stub.
 *
 * @param {{ spawnFn?: typeof nodeSpawn }} [options]
 */
export function createJobRegistry({ spawnFn = nodeSpawn } = {}) {
  const jobs = new Map(); // id -> job record, insertion order = start order
  let activeJobId = null;

  function isActive(job) {
    return job.state === STATES.QUEUED || job.state === STATES.RUNNING || job.state === STATES.CANCELLING;
  }

  function getActiveJob() {
    if (!activeJobId) return null;
    const job = jobs.get(activeJobId);
    return job && isActive(job) ? job : null;
  }

  /**
   * @param {{ collection: string, path: string, options?: object }} params
   * @returns {{ id: string }}
   * @throws if a job is already queued/running
   */
  function startIndexJob({ collection, path, options = {} }) {
    const active = getActiveJob();
    if (active) {
      const err = new Error(`An indexing job is already ${active.state} (id: ${active.id}). Only one job may run at a time.`);
      err.code = 'JOB_ALREADY_RUNNING';
      throw err;
    }

    const id = randomUUID();
    const job = {
      id,
      collection,
      path,
      options,
      state: STATES.QUEUED,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      log: [],
      child: null,
    };
    jobs.set(id, job);
    activeJobId = id;

    const env = { ...process.env, ...buildJobEnv(collection, options) };
    // No shell string interpolation: argument list is a plain array, the
    // path is never concatenated into a command string.
    const child = spawnFn(process.execPath, [INDEXER_ENTRY, path], { env });
    job.child = child;
    job.state = STATES.RUNNING;

    child.stdout?.on('data', (chunk) => appendLog(job, 'stdout', chunk.toString('utf-8')));
    child.stderr?.on('data', (chunk) => appendLog(job, 'stderr', chunk.toString('utf-8')));

    child.on('error', (err) => {
      // spawn-level failure (e.g. ENOENT) — never reached a real exit.
      job.state = STATES.FAILED;
      job.finishedAt = new Date().toISOString();
      job.exitCode = null;
      appendLog(job, 'stderr', `[job] failed to start: ${err.message}`);
      if (activeJobId === id) activeJobId = null;
    });

    child.on('exit', (code, signal) => {
      job.finishedAt = new Date().toISOString();
      job.exitCode = code;
      if (job.state === STATES.CANCELLING) {
        // cancelJob() already requested the kill; this exit event is the
        // real end of the process — only NOW is the slot actually free.
        job.state = STATES.CANCELLED;
      } else if (signal) {
        job.state = STATES.FAILED;
        appendLog(job, 'stderr', `[job] terminated by signal ${signal}`);
      } else {
        job.state = code === 0 ? STATES.SUCCEEDED : STATES.FAILED;
      }
      if (activeJobId === id) activeJobId = null;
    });

    return { id };
  }

  /**
   * Best-effort cancel (design doc §9): child.kill() first; a resumable,
   * not corrupted, collection is expected either way since the indexer
   * commits per-file with deterministic point IDs.
   *
   * The job moves to `cancelling` (still counted as active — see isActive())
   * rather than straight to `cancelled`, because `child.kill()` only sends a
   * signal; the process may still be writing to Qdrant for some time after
   * this call returns. Only the child's own `exit` event proves it actually
   * stopped, at which point the slot is freed and the state becomes
   * `cancelled`. Without this, a second startIndexJob() right after
   * cancelJob() could run concurrently with the still-alive first process.
   */
  function cancelJob(id) {
    const job = jobs.get(id);
    if (!job) return null;
    if (!isActive(job)) return job;

    job.state = STATES.CANCELLING;
    appendLog(job, 'stderr', '[job] cancel requested');
    job.child?.kill();
    return job;
  }

  function getJob(id) {
    return jobs.get(id) ?? null;
  }

  /** Newest first. */
  function listJobs() {
    return [...jobs.values()].reverse();
  }

  return { startIndexJob, cancelJob, getJob, listJobs, getActiveJob, STATES };
}
