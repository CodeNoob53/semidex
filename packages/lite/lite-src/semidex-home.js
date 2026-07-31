// Resolves SEMIDEX_HOME (Semidex Lite's writable application home) and
// derives the three child env vars full-Semidex's own path seams already
// support (Refactor 4: core/config.js's SEMIDEX_CONFIG_PATH,
// core/settings/settings-store.js's SEMIDEX_SETTINGS_PATH,
// core/onnx-paths.js's SEMIDEX_TOKENIZER_CACHE_DIR). Lite-specific default
// location (never shares state with full Semidex's package-relative
// config.json/settings.json/models/):
//   Windows: %LOCALAPPDATA%\semidex-lite
//   macOS:   ~/Library/Application Support/semidex-lite
//   Linux:   $XDG_DATA_HOME/semidex-lite -> ~/.local/share/semidex-lite
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string}
 */
export function defaultSemidexHome({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'semidex-lite');
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'semidex-lite');
  }
  const base = env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'semidex-lite');
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string }} [opts]
 * @returns {{ semidexHome: string, configPath: string, settingsPath: string, tokenizerCacheDir: string }}
 */
export function resolveSemidexHomePaths({ env = process.env, platform = process.platform } = {}) {
  const semidexHome = env.SEMIDEX_HOME || defaultSemidexHome({ platform, env });
  return {
    semidexHome,
    configPath: join(semidexHome, 'config.json'),
    settingsPath: join(semidexHome, 'settings.json'),
    tokenizerCacheDir: join(semidexHome, 'cache', 'tokenizers'),
  };
}

/**
 * Sets SEMIDEX_HOME + the three derived env vars on `env`, in place — must
 * run before any import that reads them at module-evaluation time
 * (core/config.js, core/settings/settings-store.js, core/onnx-paths.js are
 * all import-time constants). Returns the resolved paths for convenience
 * (e.g. to mkdir them before first use).
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string }} [opts]
 */
export function applySemidexHomeEnv({ env = process.env, platform = process.platform } = {}) {
  const paths = resolveSemidexHomePaths({ env, platform });
  env.SEMIDEX_HOME = paths.semidexHome;
  env.SEMIDEX_CONFIG_PATH = paths.configPath;
  env.SEMIDEX_SETTINGS_PATH = paths.settingsPath;
  env.SEMIDEX_TOKENIZER_CACHE_DIR = paths.tokenizerCacheDir;
  return paths;
}
