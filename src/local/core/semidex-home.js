// Full Semidex's own application-data home — used ONLY for the new
// managed CUDA runtimes tree (runtimes/onnxruntime-node-cuda/<id>/).
// Deliberately does NOT touch config.json/settings.json/models/ — those
// stay exactly where they are today (package-relative, see
// src/core/config.js, src/core/settings/settings-store.js,
// src/core/onnx-paths.js's ONNX_CACHE_DIR). This resolver's only job is
// resolving where a managed runtime should live, outside the repo.
//
// Full-only by design (physically lives under local/core/, already
// wholesale-excluded from the Lite package build via
// packages/lite/build.mjs's EXCLUDE_DIRS 'local' entry — zero new
// exclusion-list changes needed). Lite has its own, separately-named
// resolver at packages/lite/lite-src/semidex-home.js
// (%LOCALAPPDATA%\semidex-lite) — both delegate their platform-branching
// logic to the shared, neutral src/core/app-data-dir.js so the two
// editions' directory-naming logic can never silently drift apart, while
// staying architecturally distinct (Full: 'semidex', Lite: 'semidex-lite').
//
// Neither resolver needs bootstrapEnv()-style "run before other imports"
// discipline — nothing in Full's existing module graph reads a
// SEMIDEX_HOME-derived path at import time (unlike Lite, where
// core/onnx-paths.js's TOKENIZER_CACHE_DIR is an import-time constant).
// This is a lazily-called, pure path-computation helper.
import { join } from 'node:path';
import { resolveAppDataDir } from '../../shared/core/app-data-dir.js';

/**
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string }} [opts]
 * @returns {{ semidexHome: string, runtimesDir: string }}
 */
export function resolveSemidexHomePaths({ env = process.env, platform = process.platform } = {}) {
  const semidexHome = env.SEMIDEX_HOME || resolveAppDataDir('semidex', { platform, env });
  return {
    semidexHome,
    runtimesDir: join(semidexHome, 'runtimes'),
    // Integration API bearer keys. A DEDICATED file, never settings.json:
    // settings.json is served to the browser through GET /api/settings, so
    // key material must not live there. Same filename Lite uses, under
    // Full's own separate application home.
    keyStorePath: join(semidexHome, 'integration-keys.json'),
  };
}

/**
 * Sets process.env.SEMIDEX_HOME to the resolved Full application-data home,
 * IN PLACE, but only when it is not already set — an explicit SEMIDEX_HOME
 * (real OS env or .env) always wins. Must run before anything else in the
 * process resolves a SEMIDEX_HOME-derived path — concretely,
 * src/admin/bootstrap.js calls this before createApp(), whose default
 * resolveIntegrationPolicy() (src/core/auth/resolve-policy.js) only ever
 * consults process.env.SEMIDEX_HOME and otherwise falls back to
 * process.cwd(). Without this call, a real `npm run admin` process never
 * had SEMIDEX_HOME set, so the running server looked for
 * integration-keys.json in cwd while `npm run key --` (src/key.js) always
 * resolves the real per-OS app-data path via resolveSemidexHomePaths() —
 * every key the CLI created silently failed to authenticate against the
 * server it was meant for.
 *
 * Mirrors Lite's own applySemidexHomeEnv() (packages/lite/lite-src/
 * semidex-home.js) — Full derives far less from its home today (no
 * config.json/settings.json path; see this file's own header comment), so
 * this only ever sets the one variable, not three.
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string }} [opts]
 * @returns {string} the resolved (or already-set) SEMIDEX_HOME
 */
export function applySemidexHomeEnv({ env = process.env, platform = process.platform } = {}) {
  if (!env.SEMIDEX_HOME) {
    env.SEMIDEX_HOME = resolveSemidexHomePaths({ env, platform }).semidexHome;
  }
  return env.SEMIDEX_HOME;
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, ortVersion: string, cudaMajor: string }} opts
 * @returns {string}
 */
export function resolveManagedRuntimeDir({ env = process.env, platform = process.platform, ortVersion, cudaMajor }) {
  const { runtimesDir } = resolveSemidexHomePaths({ env, platform });
  return join(runtimesDir, 'onnxruntime-node-cuda', `${ortVersion}-cuda${cudaMajor}`);
}
