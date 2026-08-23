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
import { bootstrapEnv } from '../src/shared/core/env-bootstrap.js';
import { createSettingsService, applyEnvWriteBack } from '../src/core/settings/service.js';
import { createLiteSettingsService } from '../src/core/settings/service.lite.js';
import { createJobRegistry } from '../src/shared/admin/jobs/registry.js';
import { spawnIndexer as spawnLiteIndexer } from '../src/admin/jobs/spawn-indexer-lite.js';
import { resolveAuditSink } from '../src/core/audit/resolve-sink.js';
import { ensureEditionTag } from '../src/core/audit/sink.js';

/**
 * @param {{ semidexHome: string, settingsPath: string, auditSink?: import('../src/core/audit/sink.js').AuditSink }} paths — from
 *   resolveSemidexHomePaths()/applySemidexHomeEnv().
 *   `auditSink` is optional DI (tests inject a fake to assert the job
 *   registry and router share one instance without touching real disk) —
 *   defaults to the real, edition-tagged sink resolved here. A supplied
 *   fake is edition-tagged HERE too (`ensureEditionTag`, sink.js), so the
 *   returned `auditSink` may not be reference-equal to what the caller
 *   passed in — it is always the correctly 'lite'-tagged wrapper around it,
 *   and closing it closes the caller's underlying sink. THIS function is
 *   the single audit-sink composition owner for the real `semidex-lite serve`
 *   process: it is passed to createJobRegistry() AND createLiteApp() below,
 *   so createLiteApp()'s own internal `auditSink ?? resolveAuditSink(...)`
 *   fallback never runs and never constructs a second, independent sink
 *   instance. bin/semidex-lite.js reads the returned `auditSink` back to
 *   flush/close it on graceful shutdown (see that file's own comment).
 * @returns {Promise<{ server: import('node:http').Server, host: string, port: number, auditSink: import('../src/core/audit/sink.js').AuditSink }>}
 */
export async function startLite({ settingsPath, auditSink } = {}) {
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

  const { resolveHostConfig, resolvePortConfig } = await import('../src/shared/admin/server.js');
  const { createLiteApp } = await import('../src/admin/composition/lite.js');

  // spawnIndexer: spawnLiteIndexer (code review, round 4 — real gap found
  // while migrating createJobRegistry() off its old edition parameter):
  // this file builds its OWN jobRegistry and passes it into createLiteApp()
  // explicitly, which means createLiteApp()'s own internal
  // resolvedJobRegistry fallback (which DOES inject spawn-indexer-lite.js's
  // own spawnIndexer) never runs here — createJobRegistry() itself has NO
  // default spawnIndexer at all (it throws a TypeError without one — see
  // that function's own header comment), so this call site must always
  // supply one explicitly; omitting it here would be a hard construction-
  // time failure, not a silent fall-through to Full's behavior.
  // resolvedAuditSink: constructed HERE, once, and threaded into BOTH
  // createJobRegistry() (below) and createLiteApp() (its own `auditSink`
  // param, passed further down) — this is the fix for a real production gap
  // where this file used to build its own jobRegistry with no auditSink at
  // all, silently dropping every job-lifecycle audit event even though
  // createLiteApp()'s router still audited request-path events through its
  // own, DIFFERENT internal fallback sink. One instance, shared by both, is
  // what "router and job registry share the audit sink" actually requires.
  // When the caller supplies `auditSink` (tests only — the real CLI never
  // does), ensureEditionTag() (sink.js) still guarantees it carries
  // edition:'lite' before it is shared: a raw/plain sink is wrapped once
  // here, and createLiteApp()'s OWN ensureEditionTag() call on that same,
  // already-'lite'-tagged instance below is then a no-op (returns it
  // unchanged) rather than stacking a second wrapper on top — see
  // ensureEditionTag()'s own header comment for why stacking would be
  // pointless (and, for a genuine edition mismatch, actively wrong).
  const resolvedAuditSink = auditSink ? ensureEditionTag(auditSink, 'lite') : resolveAuditSink({ edition: 'lite' });
  const jobRegistry = createJobRegistry({ baseEnv: jobBaseEnv, spawnIndexer: spawnLiteIndexer, auditSink: resolvedAuditSink });
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
  const { createGenerationProvider } = await import('../src/core/generation/registry.js');
  // createCloudGenerationCapability() (code review, Phase 8B Step 6): the
  // real Gemini GenerationProvider factory — registry.js's own BACKENDS
  // default no longer includes 'gemini', so `providers: { gemini: ... }`
  // below is what actually makes it selectable. Mirrors
  // admin/bootstrap.js's own equivalent for Full.
  const { createCloudGenerationCapability } = await import('../src/cloud/generation/cloud-generation-provider.js');
  const cloudGeneration = createCloudGenerationCapability();
  const generationRuntime = createGenerationRuntime({
    osEnv, dotenvValues, settingsService: realSettings,
    createGenerationProviderFn: (opts) => createGenerationProvider({ ...opts, providers: { gemini: cloudGeneration.createProvider } }),
  });

  const server = createLiteApp({ generationRuntime, settingsService, jobRegistry, jobBaseEnv, auditSink: resolvedAuditSink });
  return { server, host, port, settingsService, auditSink: resolvedAuditSink };
}
