// Semidex Lite composition root — createLiteApp() — plus
// resolveHostConfig()/resolvePortConfig() (bind config resolution shared
// by both composition roots). The provider-neutral route wiring itself
// (registerNeutralRoutes, createHttpServer) lives in
// register-neutral-routes.js (Phase 3 of
// docs/design/full-lite-shared-architecture-audit-2026-08-01.md) — this
// file imports it, it does not define it. createApp() (the FULL
// composition root) lives in server-full.js and must be imported from
// there. It is intentionally not re-exported here so the Lite dependency
// graph has no edge to the full-only composition root.
//
// No self-start block here: the real process entry points are
// src/admin/bootstrap.js (npm run admin, full Semidex) and Semidex Lite's
// serve command (packages/lite/lite-src/serve-lite.js), both of which
// snapshot the OS environment BEFORE importing this file. This file itself
// has no top-level 'dotenv/config' import and never calls server.listen()
// — but it is NOT free of transitive import-time side effects:
// createStorageAdapter() (imported below) pulls in core/qdrant/client.js,
// which still does `import 'dotenv/config'` (that bootstrap predates this
// file and is intentionally NOT refactored here, per this phase's own
// scope). Functional correctness does not depend on this file being
// side-effect-free — bootstrap.js's/serve-lite.js's snapshot happens before
// either dynamically imports this file at all, so the snapshot is already
// taken by the time any transitive dotenv/config runs. What this file DOES
// guarantee is narrower: importing it never starts a server and never
// loads a generation/embedding model, so tests (and any other caller) can
// import it freely without binding a port or touching Ollama/ONNX.
//
// ── Semidex Lite package boundary ─────────────────────────────────────────
// createApp() (server-full.js) = registerNeutralRoutes() + the full
// generation-models/jobs registration (Ollama allowed) + the local-only
// routes (registerOnnxRoutes, registerOllamaStatusRoutes,
// registerOllamaModelsRoutes). createLiteApp() (this file) =
// registerNeutralRoutes() + the Gemini-only generation-models route + a
// Lite jobs policy (no Ollama-shaped options, no Ollama check) — the
// local-only routes are never registered, so their handlers AND the
// modules behind them (system/ollama.js -> core/ollama.js,
// ollama-models.js, onnx-provider-probe.js) are never reachable.
//
// server-full.js is EXCLUDED from the Lite package (build.mjs, Part F) —
// this file (server.js) IS staged, since createLiteApp() lives here and
// needs no Ollama/ONNX-only import; register-neutral-routes.js is also
// staged, for the same reason. server-full.js imports the shared route and
// HTTP helpers from register-neutral-routes.js directly; server.js does
// not import server-full.js, so the dependency is deliberately one-way.
import { createStorageAdapter } from '../core/storage/factory.js';
import { createRouter } from './router.js';
import { registerJobsRoutes } from './api/jobs.js';
import { registerGenerationModelsRoutesGeminiOnly } from './api/generation-models.js';
import { createSettingsService } from '../core/settings/service.js';
import { registerNeutralRoutes, createHttpServer } from './register-neutral-routes.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

// settingsService is optional DI (ADMIN_HOST/ADMIN_PORT are next_restart
// settings — see core/settings/definitions.js — so a settings.json value
// only ever affects the NEXT process's resolution, never the currently
// running one; passing no settingsService here falls back to env-only
// resolution, which is correct for any caller that hasn't bootstrapped a
// service of its own, e.g. a quick script or a test).
export function resolveHostConfig(env = process.env, { settingsService } = {}) {
  const host = settingsService ? settingsService.getActiveValue('ADMIN_HOST') : (env.ADMIN_HOST || '127.0.0.1');
  const allowRemote = settingsService ? settingsService.getActiveValue('ADMIN_ALLOW_REMOTE') : env.ADMIN_ALLOW_REMOTE === '1';
  if (!LOOPBACK_HOSTS.has(host) && !allowRemote) {
    throw new Error(
      `ADMIN_HOST="${host}" is not a loopback address. Refusing to bind a non-loopback host ` +
      `without ADMIN_ALLOW_REMOTE=1 (this exposes the Local API beyond this machine — unsafe by default).`
    );
  }
  return { host, allowRemote };
}

export function resolvePortConfig(env = process.env, { settingsService } = {}) {
  if (settingsService) return settingsService.getActiveValue('ADMIN_PORT');
  const raw = env.ADMIN_PORT;
  if (raw === undefined || raw === '') return 8642;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`ADMIN_PORT="${raw}" is not a valid port number (1-65535).`);
  }
  return port;
}

// createApp() (the full composition root) lives in server-full.js — import
// it from there directly, NOT re-exported here. A re-export would give
// this file (which Lite DOES stage) a real edge to server-full.js (which
// Lite does NOT stage), defeating the whole point of the split — see
// server-full.js's own header comment.

// Semidex Lite composition root — cloud-only. Never registers
// registerOnnxRoutes/registerOllamaStatusRoutes/registerOllamaModelsRoutes,
// and its generation-models route is the Gemini-only variant — so none of
// their handlers, and none of the modules behind them
// (admin/api/onnx.js -> core/onnx-provider-probe.js, admin/system/ollama.js
// -> core/ollama.js, admin/api/ollama-models.js -> core/ollama-models.js),
// are ever imported by this function's own call graph. jobPolicy defaults
// to a cloud-safe policy (no onnxEmbed/llmSummaries/tagGen; pruneStale
// stays allowed — pure Qdrant-Cloud-compatible stale cleanup) and no
// checkOllamaFn is ever passed, matching jobs.js's own contract that
// checkOllamaFn is only required when jobPolicy.allowLlmSummaries is true.
export function createLiteApp({
  adapter = createStorageAdapter(), embedQuery, jobRegistry, taskRegistry,
  assemblyLogFn, generationRuntime, askCoordinator, countTokens, settingsService, jobBaseEnv,
  discoverGeminiModelsFn, runQdrantCloudProbeFn, resolveNewCollectionProfileFn, jobPolicy = LITE_JOB_POLICY,
} = {}) {
  const router = createRouter();
  const settings = settingsService ?? createSettingsService({ osEnv: process.env, dotenvValues: {} });
  registerNeutralRoutes(router, {
    adapter, embedQuery, jobRegistry, taskRegistry, assemblyLogFn,
    generationRuntime, askCoordinator, countTokens, settingsService: settings, jobBaseEnv,
    runQdrantCloudProbeFn, resolveNewCollectionProfileFn,
    generationModelsFn: (r, deps) => registerGenerationModelsRoutesGeminiOnly(r, {
      ...deps,
      ...(discoverGeminiModelsFn ? { discoverGeminiModelsFn } : {}),
    }),
    jobsFn: (r, jobs) => registerJobsRoutes(r, jobs, { jobPolicy }),
  });
  return createHttpServer(router);
}

// Cloud-safe default policy for createLiteApp() — no local-model options,
// pruneStale allowed (see jobs.js's own FULL_JOB_POLICY comment for why
// pruneStale is Qdrant-Cloud-safe, not local-model-shaped).
export const LITE_JOB_POLICY = Object.freeze({
  allowOnnxEmbed: false, allowLlmSummaries: false, allowTagGen: false, allowPruneStale: true,
});
