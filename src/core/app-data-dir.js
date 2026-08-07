// Neutral, edition-agnostic per-user application-data directory resolver.
// No knowledge of "semidex," "semidex-lite," or any specific app — given
// an app name, resolves where that app's data should live on this
// platform, with the same explicit, predictable fallback chain on every
// OS. Both Full (src/local/core/semidex-home.js) and Lite
// (packages/lite/lite-src/semidex-home.js) delegate their own
// edition-specific directory naming to this one function, so their
// platform-branching logic can never drift apart — packages/lite/lite-src/
// already imports freely from ../src/core/*.js (confirmed: doctor-lite.js,
// index-lite.js, serve-lite.js all do this today), and src/core/ never
// imports back from packages/lite/, so this is a safe one-way dependency
// for both editions.
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * @param {string} appName — e.g. 'semidex' or 'semidex-lite'.
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string}
 */
export function resolveAppDataDir(appName, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, appName);
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', appName);
  }
  const base = env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, appName);
}
