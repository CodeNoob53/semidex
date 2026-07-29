// Lightweight instrumentation: child-process RSS sampling (no external
// dependency — no pidusage or equivalent is installed anywhere in this
// repo), latency percentiles, and request-volume counters. Deliberately
// minimal — never a heavy profiler.
import { exec } from 'node:child_process';

function sampleViaTasklist(pid) {
  return new Promise((resolvePromise) => {
    exec(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, (err, stdout) => {
      if (err || !stdout) return resolvePromise(null);
      // CSV row: "name","pid","session","sessionnum","mem usage"
      // Mem Usage looks like "123,456 K" — strip quotes/commas/suffix.
      const match = stdout.match(/"([\d,]+)\s*K"/i);
      if (!match) return resolvePromise(null);
      const kb = Number(match[1].replace(/,/g, ''));
      resolvePromise(Number.isFinite(kb) ? kb * 1024 : null);
    });
  });
}

function sampleViaProcStatus(pid) {
  return new Promise((resolvePromise) => {
    exec(`cat /proc/${pid}/status 2>/dev/null`, (err, stdout) => {
      if (err || !stdout) return resolvePromise(null);
      const match = stdout.match(/VmRSS:\s*(\d+)\s*kB/i);
      if (!match) return resolvePromise(null);
      const kb = Number(match[1]);
      resolvePromise(Number.isFinite(kb) ? kb * 1024 : null);
    });
  });
}

function sampleViaPs(pid) {
  return new Promise((resolvePromise) => {
    exec(`ps -o rss= -p ${pid}`, (err, stdout) => {
      if (err || !stdout) return resolvePromise(null);
      const kb = Number(stdout.trim());
      resolvePromise(Number.isFinite(kb) ? kb * 1024 : null);
    });
  });
}

/**
 * Samples RSS (bytes) for ONE specific child PID — the indexer's own
 * main process, not a process tree (the indexer spawns no grandchild
 * processes today). Platform-branched: Windows via `tasklist`, macOS via
 * `ps -o rss=`, Linux via /proc/<pid>/status. Returns null (never throws)
 * on any platform-specific sampling failure — a metrics-collection
 * failure must never crash the benchmark run.
 * @param {number} pid
 * @returns {Promise<number|null>} RSS in bytes, or null if unavailable
 */
export function sampleChildRss(pid) {
  try {
    if (process.platform === 'win32') return sampleViaTasklist(pid);
    if (process.platform === 'darwin') return sampleViaPs(pid);
    return sampleViaProcStatus(pid);
  } catch {
    return Promise.resolve(null);
  }
}

/**
 * Starts a periodic RSS sampler for `pid`, tracking the peak observed
 * value. Caller must call stop() when the child process has exited.
 * @param {number} pid
 * @param {number} [intervalMs]
 * @returns {{ stop: () => Promise<number|null> }} stop() resolves the
 *   final peak RSS in bytes (or null if no sample ever succeeded)
 */
export function startRssSampler(pid, intervalMs = 1000) {
  let peakBytes = null;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    const sample = await sampleChildRss(pid);
    if (sample !== null && (peakBytes === null || sample > peakBytes)) peakBytes = sample;
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  let timer = setTimeout(tick, intervalMs);
  if (timer.unref) timer.unref();
  return {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      return peakBytes;
    },
  };
}

/**
 * Nearest-rank percentile over a numeric array (e.g. query latencies).
 * Not interpolated — matches the simplest, most defensible convention
 * used elsewhere in this codebase (harness-core.mjs's own percentile()).
 * @param {number[]} sortedAscendingValues
 * @param {number} p — 0..100
 */
export function percentile(sortedAscendingValues, p) {
  if (sortedAscendingValues.length === 0) return null;
  const idx = Math.min(sortedAscendingValues.length - 1, Math.ceil((p / 100) * sortedAscendingValues.length) - 1);
  return sortedAscendingValues[Math.max(0, idx)];
}

/**
 * Simple counters for indexer-spawn / query-call volume — NOT the same
 * as the real, exact telemetry-derived Qdrant SDK op / inference item
 * counts (see core/telemetry-reader.mjs for those). This just tracks how
 * many top-level harness actions were attempted, for progress/sanity
 * reporting.
 */
export function makeRequestCounter() {
  return {
    indexerSpawns: 0,
    queryCalls: 0,
    recordIndexerSpawn() { this.indexerSpawns += 1; },
    recordQueryCall() { this.queryCalls += 1; },
  };
}
