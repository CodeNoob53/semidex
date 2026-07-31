// semidex-lite index <path> — one-shot CLI indexing command. Reuses the
// existing admin job registry (createJobRegistry) IN-PROCESS (no HTTP
// server started) purely for its already-correct env composition/
// line-splitting/progress-parsing — the exact same mechanism the Lite
// `serve` command's job API uses, so the two paths can never drift on how
// an indexing job is spawned. Prints progress/log lines to stdout as they
// arrive and resolves with the child's exit code.
import { bootstrapEnv } from '../src/core/env-bootstrap.js';
import { createSettingsService, applyEnvWriteBack } from '../src/core/settings/service.js';
import { createJobRegistry } from '../src/admin/jobs/registry.js';

/**
 * spawnFn is dependency-injectable so unit tests never spawn a real
 * indexer child process — same DI convention as createJobRegistry() itself.
 * pollIntervalMs is injectable so tests don't wait on the real 200ms
 * polling cadence.
 * @param {string} target — file or folder path to index.
 * @param {{ semidexHome?: string, settingsPath?: string, spawnFn?: Function, pollIntervalMs?: number, argv?: string[] }} opts
 * @returns {Promise<number>} process exit code (0 success, 1 failure)
 */
export async function runIndex(target, { settingsPath, spawnFn, pollIntervalMs = 200, argv = process.argv } = {}) {
  const collection = process.env.COLLECTION;
  if (!collection) {
    console.error('COLLECTION env var is required, e.g.: COLLECTION=my-docs semidex-lite index ./docs');
    return 1;
  }

  // Same env-provenance sequence as serve-lite.js — jobBaseEnv must be the
  // pre-write-back OS-env snapshot so the spawned indexer's own
  // bootstrapEnv() resolves settings.json fresh.
  const { osEnv, dotenvValues } = bootstrapEnv();
  const settingsService = createSettingsService({ osEnv, dotenvValues, settingsPath });
  const jobBaseEnv = { ...osEnv };
  applyEnvWriteBack(settingsService);

  const jobRegistry = createJobRegistry({ baseEnv: jobBaseEnv, ...(spawnFn ? { spawnFn } : {}) });

  // Lite's own jobs policy (server.js's LITE_JOB_POLICY) rejects
  // onnxEmbed/llmSummaries/tagGen at the HTTP layer — the CLI has no HTTP
  // layer here, so it enforces the identical contract itself: no local job
  // options are ever exposed as CLI flags, and only pruneStale (via
  // --prune-stale) is passed through.
  const options = { pruneStale: argv.includes('--prune-stale') };

  return new Promise((resolve) => {
    let seenLines = 0;
    const { id } = jobRegistry.startIndexJob({ collection, path: target, options });

    const poll = setInterval(() => {
      const job = jobRegistry.getJob(id);
      if (!job) return;
      for (; seenLines < job.log.length; seenLines++) {
        const { stream, line } = job.log[seenLines];
        (stream === 'stderr' ? console.error : console.log)(line);
      }
      if (job.progress?.currentStep) {
        process.stdout.write(`\r[${job.progress.processedFiles ?? '?'}/${job.progress.totalFiles ?? '?'}] ${job.progress.currentStep}${job.progress.currentFile ? ` — ${job.progress.currentFile}` : ''}   `);
      }
      if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled') {
        clearInterval(poll);
        process.stdout.write('\n');
        resolve(job.state === 'succeeded' ? 0 : 1);
      }
    }, pollIntervalMs);
  });
}
