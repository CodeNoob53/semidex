// Lowest-level settings.json file I/O — the only module that touches the
// settings.json path directly. SettingsService (service.js) is the only
// caller; every other module (production or UI) goes through the service,
// never this file.
import { readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// SEMIDEX_SETTINGS_PATH redirects settings.json to a writable application
// home (e.g. Semidex Lite's SEMIDEX_HOME/settings.json) instead of the
// package-relative default — a globally-installed npm package must never
// write into its own node_modules directory. Backward compatible: when the
// env var is unset it resolves to the exact package-relative location full
// Semidex has always used, so a checked-out repo is unchanged. Read fresh
// at import; a caller that needs to redirect it sets the env var before
// this module is first imported.
export const DEFAULT_SETTINGS_PATH = process.env.SEMIDEX_SETTINGS_PATH
  ? resolve(process.env.SEMIDEX_SETTINGS_PATH)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../../../settings.json');

export function readSettingsFile(path = DEFAULT_SETTINGS_PATH) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// Atomic write: tmp file + rename, mirroring core/config.js's saveConfig()
// exactly — never leaves a partially-written settings.json on disk even if
// the process is killed mid-write.
export function writeSettingsFileAtomic(data, path = DEFAULT_SETTINGS_PATH) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, path);
}

export function statMtime(path = DEFAULT_SETTINGS_PATH) {
  if (!existsSync(path)) return null;
  return statSync(path).mtimeMs;
}
