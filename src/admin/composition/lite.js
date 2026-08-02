// Semidex Lite composition root — createLiteApp() — moved out of
// ../server.js (Phase 4 of
// ../../../docs/design/full-lite-shared-architecture-audit-2026-08-01.md)
// as a pure mechanical extraction — no behavior change, same DI arguments
// and defaults, same route registration order. ../server.js now owns only
// shared bind configuration (resolveHostConfig/resolvePortConfig); this
// file owns Lite's own provider composition. The provider-neutral route
// wiring itself (registerNeutralRoutes, createHttpServer) still lives in
// ../register-neutral-routes.js — this file imports it, it does not define
// it. createApp() (the FULL composition root) lives in ../server-full.js
// and must never be imported from here — that is exactly the edge this
// module's existence prevents Lite's dependency graph from having.
//
// No self-start block here — packages/lite/lite-src/serve-lite.js snapshots
// the OS environment (bootstrapEnv()) BEFORE dynamically importing this
// file, same ordering guarantee ../server.js's own header comment used to
// document for createLiteApp() when it lived there.
import { createStorageAdapter } from '../../core/storage/factory.js';
import { createRouter } from '../router.js';
import { registerJobsRoutes } from '../api/jobs.js';
import { registerGenerationModelsRoutesGeminiOnly } from '../api/generation-models.js';
import { createSettingsService } from '../../core/settings/service.js';
import { registerNeutralRoutes, createHttpServer } from '../register-neutral-routes.js';

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
