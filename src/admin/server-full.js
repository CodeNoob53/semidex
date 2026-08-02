// Full Semidex admin composition root — createApp(). Split out of server.js
// (Semidex Lite package boundary) because createApp() needs four
// local-only, static imports (registerOnnxRoutes, registerOllamaModelsRoutes,
// discoverOllamaModels, checkOllama) that Semidex Lite's package build
// (packages/lite/build.mjs) excludes entirely — an ES module's top-level
// import statements are unconditional (they exist in the file regardless of
// which function actually calls them), so createApp() and createLiteApp()
// cannot safely live in the same file once Lite needs to stage that file
// without ALSO staging these four Ollama/ONNX-only modules.
// register-neutral-routes.js holds registerNeutralRoutes()/createHttpServer()
// (the provider-neutral route wiring both createApp() and createLiteApp()
// share); server.js holds createLiteApp() itself plus bind-config
// resolution — both are files Lite needs and stages. Full callers import
// createApp directly from this file, which is excluded from the Lite
// package.
import { createStorageAdapter } from '../core/storage/factory.js';
import { createRouter } from './router.js';
import { registerJobsRoutes, FULL_JOB_POLICY } from './api/jobs.js';
import { registerOllamaStatusRoutes } from './api/system.js';
import { registerOnnxRoutes } from './api/onnx.js';
import { registerOllamaModelsRoutes } from './api/ollama-models.js';
import { registerGenerationModelsRoutes } from './api/generation-models.js';
import { discoverOllamaModels } from '../core/ollama-models.js';
import { checkOllama } from './system/ollama.js';
import { createSettingsService } from '../core/settings/service.js';
import { registerNeutralRoutes, createHttpServer } from './register-neutral-routes.js';

export function createApp({
  adapter = createStorageAdapter(), embedQuery, jobRegistry, taskRegistry, pickFolderFn, checkOllamaFn,
  assemblyLogFn, generationRuntime, askCoordinator, countTokens, settingsService, jobBaseEnv,
  discoverOllamaModelsFn, discoverGeminiModelsFn, runOnnxProbeFn, runQdrantCloudProbeFn,
  resolveNewCollectionProfileFn,
} = {}) {
  const router = createRouter();
  // settingsService is optional DI — tests and ad-hoc createApp() callers
  // that don't care about settings.json provenance get a safe env-only
  // fallback (no file I/O beyond a single settings.json read, same
  // "import/construction-safe" contract generationRuntime's own fallback
  // documents). The real production entry point (bootstrap.js) always
  // passes its own properly bootstrapped instance.
  const settings = settingsService ?? createSettingsService({ osEnv: process.env, dotenvValues: {} });
  // discoverOllamaModelsFn is optional DI (tests inject a stub so unit
  // tests never probe a real Ollama instance) — same convention as
  // checkOllamaFn below. Full-only: this module is the one place that
  // imports core/ollama-models.js and passes it through.
  registerOllamaModelsRoutes(router, { settingsService: settings, ...(discoverOllamaModelsFn ? { discoverOllamaModelsFn } : {}) });
  registerNeutralRoutes(router, {
    adapter, embedQuery, jobRegistry, taskRegistry, assemblyLogFn, pickFolderFn,
    generationRuntime, askCoordinator, countTokens, settingsService: settings, jobBaseEnv,
    runQdrantCloudProbeFn, resolveNewCollectionProfileFn,
    generationModelsFn: (r, deps) => registerGenerationModelsRoutes(r, {
      ...deps,
      discoverOllamaModelsFn: discoverOllamaModelsFn ?? discoverOllamaModels,
      ...(discoverGeminiModelsFn ? { discoverGeminiModelsFn } : {}),
    }),
    jobsFn: (r, jobs) => registerJobsRoutes(r, jobs, {
      jobPolicy: FULL_JOB_POLICY,
      checkOllamaFn: checkOllamaFn ?? checkOllama,
    }),
  });
  // checkOllamaFn is optional DI (tests inject a stub so unit tests never
  // probe a real Ollama instance). pickFolderFn is threaded into
  // registerNeutralRoutes above (registered exactly once there — see that
  // function's own comment on why a second registration here would be
  // silently ineffective, not an override).
  registerOllamaStatusRoutes(router, { checkOllamaFn: checkOllamaFn ?? checkOllama });
  // runOnnxProbeFn is optional DI (tests inject a stub so unit tests never
  // spawn a real child process/load onnxruntime-node) — same convention as
  // pickFolderFn/checkOllamaFn above.
  registerOnnxRoutes(router, { settingsService: settings, ...(runOnnxProbeFn ? { runProbeFn: runOnnxProbeFn } : {}) });
  return createHttpServer(router);
}
