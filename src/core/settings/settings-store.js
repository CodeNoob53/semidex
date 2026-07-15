// Lowest-level settings.json file I/O — the only module that touches the
// settings.json path directly. SettingsService (service.js) is the only
// caller; every other module (production or UI) goes through the service,
// never this file.
import { readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SETTINGS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)), '../../../settings.json'
);

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
