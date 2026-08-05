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
// share); composition/lite.js holds createLiteApp() itself; server.js holds
// only shared bind-config resolution (resolveHostConfig/resolvePortConfig)
// — all three are files Lite needs and stages. Full callers import
// createApp directly from this file, which is excluded from the Lite
// package.
import { createStorageAdapter } from '../core/storage/factory.js';
import { createRouter } from './router.js';
import { registerJobsRoutes, FULL_JOB_POLICY } from './api/jobs.js';
import { registerOllamaStatusRoutes } from './api/system.js';
import { registerOnnxRoutes } from './api/onnx.js';
import { registerOllamaModelsRoutes } from './api/ollama-models.js';
import { registerGenerationModelsRoutes } from './api/generation-models.js';
import { discoverOllamaModels } from '../local/core/ollama-models.js';
import { checkOllama } from './system/ollama.js';
import { createSettingsService } from '../core/settings/service.js';
import { registerNeutralRoutes, createHttpServer } from './register-neutral-routes.js';
import { embedForSearch } from '../core/embeddings.js';
import { createJobRegistry } from './jobs/registry.js';
import { spawnIndexer as spawnFullIndexer } from './jobs/spawn-indexer-full.js';
import * as ollamaLazy from '../core/ollama-lazy.js';
import * as onnxEmbedLazy from '../core/onnx-embed-lazy.js';

export function createApp({
  adapter = createStorageAdapter(), embedQuery, jobRegistry, taskRegistry, pickFolderFn, checkOllamaFn,
  assemblyLogFn, generationRuntime, askCoordinator, countTokens, settingsService, jobBaseEnv,
  discoverOllamaModelsFn, discoverGeminiModelsFn, runOnnxProbeFn, runQdrantCloudProbeFn,
  resolveNewCollectionProfileFn,
} = {}) {
  // core/embeddings.js's applyEmbeddingCapabilities() (the process-wide
  // module-scope fallback) is deliberately NEVER called from this function
  // (code review, round 4 — removed after round 3 made it redundant, same
  // rationale as composition/lite.js's createLiteApp()): every real request
  // path this composition root serves reaches embeddings.js exclusively
  // through resolvedEmbedQuery below, which passes capabilities explicitly
  // per call — mutating the shared module-scope fallback here would be pure
  // global side-effecting noise with no real consumer, and (round 1/2's own
  // finding) risks stomping whatever OTHER composition root (e.g.
  // createLiteApp(), constructed in the same process by a test) happens to
  // share embeddings.js's module scope. The fallback itself still exists in
  // embeddings.js, but now starts UNSET (null) rather than defaulting to
  // the real ollama-lazy.js/onnx-embed-lazy.js modules (code review, round
  // 4 — see embeddings.js's own header comment): a caller that hasn't been
  // updated to pass capabilities explicitly (e.g. a smoke-test script)
  // gets a clear "no capability injected" error instead of a silent
  // real-network default — this composition root has no reason to touch
  // it in either direction.
  //
  // embedQuery, if the caller doesn't override it, is bound HERE to this
  // composition root's own real capability (code review, round 3 — the
  // actual per-call isolation fix): registerSearchRoutes()/runHybridSearch()
  // would otherwise default to embeddings.js's bare embedForSearch, which
  // falls through to that same shared module-scope fallback — correct
  // today, but not isolated from whatever createLiteApp() might do with it
  // if both ran in one process. Binding explicitly here means this server's
  // own search requests never consult that shared fallback at all,
  // regardless of what any other composition root does with it.
  const resolvedEmbedQuery = embedQuery ?? ((profile, query) => embedForSearch(profile, query, { capabilities: { ollama: ollamaLazy, onnxEmbed: onnxEmbedLazy } }));
  // resolvedJobRegistry, if the caller doesn't override it, is built HERE
  // with spawn-indexer-full.js's own spawnIndexer (code review, round 4):
  // Full's real, unchanged behavior. createJobRegistry() itself has no
  // default spawnIndexer and never knows which edition constructed it —
  // see that function's own header comment.
  const resolvedJobRegistry = jobRegistry ?? createJobRegistry({ baseEnv: jobBaseEnv, spawnIndexer: spawnFullIndexer });
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
  // imports local/core/ollama-models.js and passes it through.
  registerOllamaModelsRoutes(router, { settingsService: settings, ...(discoverOllamaModelsFn ? { discoverOllamaModelsFn } : {}) });
  registerNeutralRoutes(router, {
    adapter, embedQuery: resolvedEmbedQuery, jobRegistry: resolvedJobRegistry, taskRegistry, assemblyLogFn, pickFolderFn,
    generationRuntime, askCoordinator, countTokens, settingsService: settings,
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
