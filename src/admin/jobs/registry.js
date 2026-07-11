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
import { parseProgressLine } from '../../indexer/progress-event.js';

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
//
// [semidex:progress] lines are parsed into job.progress and never pushed to
// job.log at all — they're machine-readable state, not something a user
// reads as a log line, and duplicating them into the log would just be
// console-like noise fighting the progress UI they're meant to replace.
// Clamps an intra-file progress fraction to the 0..1 range a percent
// calculation can trust. A non-number (missing field, bad JSON value, NaN)
// becomes null — "unknown", not "zero" — so the API layer can tell "no
// intra-file estimate yet" apart from "just started".
function clampFileProgress(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function appendLine(job, stream, line) {
  const progress = parseProgressLine(line);
  if (progress) {
    job.progress = {
      processedFiles: Number.isInteger(progress.processedFiles) ? progress.processedFiles : null,
      totalFiles: Number.isInteger(progress.totalFiles) ? progress.totalFiles : null,
      currentFile: typeof progress.currentFile === 'string' ? progress.currentFile : null,
      currentStep: typeof progress.currentStep === 'string' ? progress.currentStep : null,
      currentFileProgress: clampFileProgress(progress.currentFileProgress),
    };
    return;
  }
  const sanitised = sanitiseErrorMessage(line, process.env.QDRANT_KEY);
  job.log.push({ stream, line: sanitised });
  if (job.log.length > MAX_LOG_LINES) {
    job.log.splice(0, job.log.length - MAX_LOG_LINES);
  }
}

// child_process stdout/stderr 'data' events are not guaranteed to align
// with line boundaries — a single JSON progress line can arrive split
// across two chunks. This buffers partial trailing text per stream and
// only hands complete lines to appendLine(), so parseProgressLine() never
// sees a truncated JSON body.
//
// The last line of output very often has no trailing newline at all (the
// child process just exits right after writing it) — write() alone would
// leave that final line stuck in `carry` forever. Callers must call
// flush() once the child has exited, which sends any remaining buffered
// text through appendLine() as a line of its own. An empty carry (nothing
// buffered, or already flushed) is a no-op.
function makeLineSplitter(job, stream) {
  let carry = '';
  return {
    write(chunk) {
      carry += chunk.toString('utf-8');
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() ?? '';
      for (const line of lines) {
        if (line === '') continue;
        appendLine(job, stream, line);
      }
    },
    flush() {
      if (carry === '') return;
      appendLine(job, stream, carry);
      carry = '';
    },
  };
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
   * @param {{ collection: string, path: string, options?: object, kind?: 'index' | 'reindex' }} params
   * @returns {{ id: string }}
   * @throws if a job is already queued/running
   */
  function startIndexJob({ collection, path, options = {}, kind = 'index' }) {
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
      // 'index' (a brand-new collection) vs 'reindex' (an existing one,
      // e.g. from settings-view.js's reindex form) — purely a display-label
      // distinction for the operation modal (Phase 3S); both run through
      // the exact same indexer spawn/env/progress-parsing path below, no
      // behavioral difference at all.
      kind,
      state: STATES.QUEUED,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      log: [],
      // null until the first [semidex:progress] line arrives — the indexer
      // may not emit one at all (e.g. zero files found), so "no progress
      // data yet" must stay distinguishable from "progress at 0/0".
      progress: null,
      child: null,
    };
    jobs.set(id, job);
    activeJobId = id;

    const env = { ...process.env, ...buildJobEnv(collection, options) };
    // No shell string interpolation: argument list is a plain array, the
    // path is never concatenated into a command string.
    // windowsHide: true — no-op on non-Windows, but on Windows this admin
    // server is often run from a GUI launcher, and without it every indexing
    // job flashes a visible console window on top of everything else.
    const child = spawnFn(process.execPath, [INDEXER_ENTRY, path], { env, windowsHide: true });
    job.child = child;
    job.state = STATES.RUNNING;

    const stdoutSplitter = makeLineSplitter(job, 'stdout');
    const stderrSplitter = makeLineSplitter(job, 'stderr');
    child.stdout?.on('data', (chunk) => stdoutSplitter.write(chunk));
    child.stderr?.on('data', (chunk) => stderrSplitter.write(chunk));

    child.on('error', (err) => {
      // spawn-level failure (e.g. ENOENT) — never reached a real exit. stdout/
      // stderr are unlikely to have emitted anything at this point, but flush
      // defensively so a partial line is never silently dropped either way.
      stdoutSplitter.flush();
      stderrSplitter.flush();
      job.state = STATES.FAILED;
      job.finishedAt = new Date().toISOString();
      job.exitCode = null;
      appendLine(job, 'stderr', `[job] failed to start: ${err.message}`);
      if (activeJobId === id) activeJobId = null;
    });

    child.on('exit', (code, signal) => {
      // The child is done writing by the time 'exit' fires — flush before
      // deciding the final state so a last line with no trailing newline
      // (very common: the process just exits right after writing it) still
      // makes it into job.log/job.progress instead of being stuck in the
      // splitter's internal buffer forever.
      stdoutSplitter.flush();
      stderrSplitter.flush();
      job.finishedAt = new Date().toISOString();
      job.exitCode = code;
      if (job.state === STATES.CANCELLING) {
        // cancelJob() already requested the kill; this exit event is the
        // real end of the process — only NOW is the slot actually free.
        job.state = STATES.CANCELLED;
      } else if (signal) {
        job.state = STATES.FAILED;
        appendLine(job, 'stderr', `[job] terminated by signal ${signal}`);
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
    appendLine(job, 'stderr', '[job] cancel requested');
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
