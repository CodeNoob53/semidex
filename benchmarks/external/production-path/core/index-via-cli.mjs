// Spawns the REAL indexer CLI (src/indexer/index.js — same entry point
// `npm run index` uses) as a subprocess. Mirrors
// benchmarks/spikes/qdrant-cloud-inference-accept.mjs's own runIndexer()
// recipe, extracted so all four suite runners share it. Also starts/stops
// a child-PID RSS sampler for the spawned indexer process (never the
// harness's own process.pid).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startRssSampler } from './instrumentation.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
export const INDEX_ENTRY = resolve(REPO_ROOT, 'src/indexer/index.js');

/**
 * Spawns `node src/indexer/index.js <targetPath>` with the given env
 * merged over process.env (the same {...process.env, ...env} merge the
 * proven spike recipe uses), samples the child's own RSS while it runs,
 * and resolves with stdout/stderr/exitCode/peakChildRssBytes.
 * @param {Object} env
 * @param {string} targetPath — absolute path to a file or directory
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number, peakChildRssBytes: number|null, ms: number }>}
 */
export function runIndexer(env, targetPath) {
  return new Promise((resolvePromise, reject) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [INDEX_ENTRY, targetPath], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const sampler = startRssSampler(child.pid);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', async (err) => {
      await sampler.stop();
      reject(err);
    });
    child.on('close', async (exitCode) => {
      const peakChildRssBytes = await sampler.stop();
      const ms = Date.now() - t0;
      if (exitCode === 0) {
        resolvePromise({ stdout, stderr, exitCode, peakChildRssBytes, ms });
      } else {
        const err = new Error(`indexer exited with code ${exitCode}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
        err.stdout = stdout;
        err.stderr = stderr;
        err.exitCode = exitCode;
        reject(err);
      }
    });
  });
}
