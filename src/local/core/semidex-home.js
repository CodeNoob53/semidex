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
  };
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, ortVersion: string, cudaMajor: string }} opts
 * @returns {string}
 */
export function resolveManagedRuntimeDir({ env = process.env, platform = process.platform, ortVersion, cudaMajor }) {
  const { runtimesDir } = resolveSemidexHomePaths({ env, platform });
  return join(runtimesDir, 'onnxruntime-node-cuda', `${ortVersion}-cuda${cudaMajor}`);
}
