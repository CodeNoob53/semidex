// Semidex Lite server startup — mirrors full admin's env-provenance
// sequence (src/admin/bootstrap.js) EXACTLY, so a spawned indexer job's own
// bootstrapEnv() classifies .env values as dotenv, not os_env (see
// registry.js's createJobRegistry() baseEnv doc, and bootstrap.js's own
// header comment for the two historical bugs this sequencing prevents).
// Never passes post-write-back process.env to the Lite job registry.
//
// Caller (bin/semidex-lite.js's `serve` command) is responsible for calling
// applyLiteHardPins() and applySemidexHomeEnv() BEFORE calling startLite()
// — this module does not apply them itself, since bin/semidex-lite.js must
// set them before its own bootstrapEnv() call for every subcommand
// (doctor/serve/index alike), not just serve.
import { bootstrapEnv } from '../src/core/env-bootstrap.js';
import { createSettingsService, applyEnvWriteBack } from '../src/core/settings/service.js';
import { createLiteSettingsService } from '../src/core/settings/service.lite.js';
import { createJobRegistry } from '../src/admin/jobs/registry.js';

/**
 * @param {{ semidexHome: string, settingsPath: string }} paths — from
 *   resolveSemidexHomePaths()/applySemidexHomeEnv().
 * @returns {Promise<{ server: import('node:http').Server, host: string, port: number }>}
 */
export async function startLite({ settingsPath } = {}) {
  // bootstrapEnv() FIRST — captures the clean OS-env snapshot before any
  // .env gap-fill mutates process.env, exactly like bootstrap.js.
  const { osEnv, dotenvValues } = bootstrapEnv();
  const realSettings = createSettingsService({ osEnv, dotenvValues, settingsPath });
  const settingsService = createLiteSettingsService(realSettings);

  // jobBaseEnv: the real OS-env snapshot only, captured BEFORE
  // applyEnvWriteBack() below mutates process.env — see bootstrap.js's own
  // header comment for the two provenance bugs this ordering prevents. The
  // hard pins (already applied to process.env by the CLI before this
  // function ran) are part of osEnv here since bootstrapEnv() snapshots
  // process.env as its caller left it — so a spawned indexer job inherits
  // them too, exactly as required.
  const jobBaseEnv = { ...osEnv };

  applyEnvWriteBack(realSettings);

  const { resolveHostConfig, resolvePortConfig } = await import('../src/admin/server.js');
  const { createLiteApp } = await import('../src/admin/composition/lite.js');

  const jobRegistry = createJobRegistry({ baseEnv: jobBaseEnv });
  // Host/port resolution and the generation runtime use the REAL
  // (unwrapped) settings service — ADMIN_HOST/ADMIN_PORT are Lite-allowed
  // keys anyway, and the generation runtime needs the full resolution
  // machinery, not the Settings-API-facing allow-list filter. Only the
  // settingsService passed into createLiteApp() (which backs
  // GET/PATCH /api/settings) is the wrapped, allow-list-filtered instance —
  // that is the one surface a Lite client can query directly, and it must
  // never leak the full ~65-key registry.
  const { host } = resolveHostConfig(process.env, { settingsService: realSettings });
  const port = resolvePortConfig(process.env, { settingsService: realSettings });

  const { createGenerationRuntime } = await import('../src/core/generation/runtime.js');
  const generationRuntime = createGenerationRuntime({ osEnv, dotenvValues, settingsService: realSettings });

  const server = createLiteApp({ generationRuntime, settingsService, jobRegistry, jobBaseEnv });
  return { server, host, port, settingsService };
}
