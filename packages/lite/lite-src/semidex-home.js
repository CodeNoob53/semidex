// Resolves SEMIDEX_HOME (Semidex Lite's writable application home) and
// derives the three child env vars full-Semidex's own path seams already
// support (Refactor 4: core/config.js's SEMIDEX_CONFIG_PATH,
// core/settings/settings-store.js's SEMIDEX_SETTINGS_PATH,
// core/onnx-paths.js's SEMIDEX_TOKENIZER_CACHE_DIR). Lite-specific default
// location (never shares state with full Semidex's package-relative
// config.json/settings.json/models/, nor with Full's own separate
// application-data home at src/local/core/semidex-home.js — 'semidex-lite'
// vs. 'semidex' are deliberately distinct app names):
//   Windows: %LOCALAPPDATA%\semidex-lite
//   macOS:   ~/Library/Application Support/semidex-lite
//   Linux:   $XDG_DATA_HOME/semidex-lite -> ~/.local/share/semidex-lite
//
// Platform-branching logic delegates to the shared, neutral
// ../src/core/app-data-dir.js (packages/lite/lite-src/*.js already
// imports freely from ../src/core/*.js — doctor-lite.js, index-lite.js,
// serve-lite.js all do this today) so Full and Lite's directory-naming
// logic is provably one tested function, never two copies that could
// silently drift apart.
import { join } from 'node:path';
import { resolveAppDataDir } from '../src/core/app-data-dir.js';

/**
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string}
 */
export function defaultSemidexHome({ platform = process.platform, env = process.env } = {}) {
  return resolveAppDataDir('semidex-lite', { platform, env });
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
