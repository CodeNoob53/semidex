// Per-run isolated config.json path plumbing. src/core/config.js supports
// an additive SEMIDEX_CONFIG_PATH override (production change, this
// task) — every benchmark indexer spawn uses a fresh, gitignored path
// under this directory's own .cache/, so a disposable benchmark
// collection never writes into the user's real repo config.json.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_ROOT = resolve(__dirname, '../.cache');

export function isolatedConfigPath(suiteId, profileId, runSuffix) {
  return resolve(CACHE_ROOT, 'config', `${suiteId}-${profileId}-${runSuffix}.json`);
}

export function telemetryPath(suiteId, profileId, runSuffix) {
  return resolve(CACHE_ROOT, 'telemetry', `${suiteId}-${profileId}-${runSuffix}.jsonl`);
}

export function materializedDir(suiteId, profileId, runSuffix) {
  return resolve(CACHE_ROOT, 'materialized', suiteId, `${profileId}-${runSuffix}`);
}

/**
 * Ensures the parent directory of a path exists (recursive) — must be
 * called before the indexer subprocess spawns (it may write config.json)
 * and before any appendFileSync-based telemetry write, since neither
 * creates its own parent directory.
 */
export function ensureParentDirExists(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}
