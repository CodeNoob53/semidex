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
import { createRouter } from '../shared/admin/router.js';
import { registerJobsRoutes, FULL_JOB_POLICY } from '../shared/admin/api/jobs.js';
import { registerOllamaStatusRoutes } from '../shared/admin/api/system.js';
import { registerOnnxRoutes } from '../local/admin/api/onnx.js';
import { registerOllamaModelsRoutes } from '../local/admin/api/ollama-models.js';
import { registerGenerationModelsRoutes } from '../shared/admin/api/generation-models.js';
import { discoverOllamaModels } from '../local/core/ollama-models.js';
import { checkOllama } from '../local/admin/system/ollama.js';
import { createSettingsService } from '../core/settings/service.js';
import { registerNeutralRoutes, createHttpServer } from '../shared/admin/register-neutral-routes.js';
import { embedForSearch } from '../shared/core/embeddings.js';
import { createJobRegistry } from '../shared/admin/jobs/registry.js';
import { spawnIndexer as spawnFullIndexer } from './jobs/spawn-indexer-full.js';
import { createOllamaEmbedCapability } from '../local/core/ollama-capability.js';
import { createOnnxEmbeddingCapability } from '../local/core/onnx-embed.js';
import { createCloudEmbeddingCapability } from '../cloud/embedding/cloud-embedding-provider.js';
import { createCloudGenerationCapability } from '../cloud/generation/cloud-generation-provider.js';
import { registerQdrantCloudRoutes } from '../cloud/admin/qdrant-cloud-api.js';
import { createGenerationRuntime } from '../core/generation/runtime.js';
import { createGenerationProvider } from '../core/generation/registry.js';

export function createApp({
  adapter = createStorageAdapter(), embedQuery, jobRegistry, taskRegistry, pickFolderFn, checkOllamaFn,
  assemblyLogFn, generationRuntime, askCoordinator, askCoordinators, countTokens, settingsService, jobBaseEnv,
  discoverOllamaModelsFn, discoverGeminiModelsFn, runOnnxProbeFn, runQdrantCloudProbeFn,
  resolveNewCollectionProfileFn, diagnoseCudaFailureFn,
  resolveEffectiveOnnxRuntimePathFn, writeVerificationResultFn, onnxManagedRuntimeListingCache,
  onnxEmbedCapability,
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
  // embeddings.js, but starts UNSET (null) rather than defaulting to a real
  // local-runtime implementation (see embeddings.js's own header comment):
  // a caller that hasn't been updated to pass capabilities explicitly
  // (e.g. a smoke-test script)
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
  //
  // onnxEmbed: local/core/onnx-embed.js's createOnnxEmbeddingCapability()
  // constructs ONE fresh, independent capability instance for THIS
  // createApp() call (onnx-embed.js has no module-scope singleton; every
  // composition root must construct its own instance, exactly like
  // index-full.js's own indexer-CLI composition does). Construction itself
  // is cheap and synchronous (no real onnxruntime-node load happens until
  // the first actual embed call) — safe to call once per createApp()
  // invocation even for tests that construct many apps in one process;
  // each gets its own independent, unused-until-needed capability. Imported
  // directly (Phase 8B Step 8 — the transitional core/onnx-embed-lazy.js
  // dynamic-loader wrapper is gone): this file is Full-only, already
  // wholesale-excluded from the Lite package (packages/lite/build.mjs's
  // EXCLUDE_FILES), so a static import here never reaches Lite's module
  // graph regardless.
  //
  // `onnxEmbedCapability` (review finding, P2): bootstrap.js's own
  // resolveOnnxRuntimeForProcess() call runs BEFORE createApp() and passes
  // a typed-unavailable capability here instead when the resolved
  // runtime's cuDNN PATH preparation failed (e.g. a managed selection's
  // recorded cuDNN directory vanished since install) — this admin server
  // stays up and serves every non-ONNX route fine, but never attempts to
  // load a runtime bootstrap.js already proved is broken; every ONNX
  // embed call fails immediately with a clear, specific reason instead of
  // a confusing deep failure inside a real request. Defaults to the real
  // capability, unchanged, when the caller doesn't override it (every
  // existing test and ad-hoc createApp() call).
  const onnxEmbed = onnxEmbedCapability ?? createOnnxEmbeddingCapability();
  // cloudEmbed/cloudGeneration (code review, Phase 8B Step 6): the real
  // Qdrant Cloud Inference embedding-budget/tokenizer capability and the
  // real Gemini generation/discovery capability — this composition root
  // imports src/cloud/ directly (a real `composition root -> cloud` edge,
  // explicitly allowed), so no shared file (embeddings.js, search.js,
  // token-count.js, run.js, registry.js, generation-models.js,
  // register-neutral-routes.js) needs to import it itself. Cheap,
  // stateless construction — safe to call once per createApp() invocation.
  const cloudEmbed = createCloudEmbeddingCapability();
  const cloudGeneration = createCloudGenerationCapability();
  // ollamaEmbed: the narrow embed-only capability (embed/
  // getOllamaEmbeddingDimension) — embeddings.js's own OllamaEmbedCapability
  // contract, never the full ollama.js namespace. createOllamaEmbedCapability()
  // is a stateless object literal (no session/worker lifecycle to isolate),
  // so a fresh call per createApp() invocation costs nothing.
  const ollamaEmbed = createOllamaEmbedCapability();
  const resolvedEmbedQuery = embedQuery ?? ((profile, query) => embedForSearch(profile, query, { capabilities: { ollama: ollamaEmbed, onnxEmbed, cloudEmbed } }));
  // settings (code review, P2): resolved BEFORE resolvedGenerationRuntime
  // below, and that call site is given `settings`, never the raw
  // `settingsService` parameter. settingsService is optional DI — tests
  // and ad-hoc createApp() callers that don't care about settings.json
  // provenance get a safe env-only fallback (no file I/O beyond a single
  // settings.json read, same "import/construction-safe" contract
  // generationRuntime's own fallback documents). The real production
  // entry point (bootstrap.js) always passes its own properly bootstrapped
  // instance and was never affected — this is the public
  // fallback-construction contract for ad-hoc/default createApp() calls:
  // createGenerationRuntime() treats an undefined settingsService as "no
  // settings.json tier at all" (applySettingsServiceTier() in
  // core/generation/runtime.js), so passing the raw parameter here would
  // silently make settings.json invisible to the generation runtime while
  // routes below still see the real fallback service.
  const settings = settingsService ?? createSettingsService({ osEnv: process.env, dotenvValues: {} });
  // resolvedGenerationRuntime, if the caller doesn't override it, is built
  // HERE with a createGenerationProviderFn that supplies the real Gemini
  // factory as a `providers` override — registry.js's own BACKENDS default
  // no longer includes 'gemini' (code review fix), so this is the ONE real
  // place Full's Gemini generation becomes selectable at all. Mirrors
  // resolvedJobRegistry's own "construct here if the caller didn't
  // override" convention below.
  const resolvedGenerationRuntime = generationRuntime ?? createGenerationRuntime({
    osEnv: process.env, dotenvValues: {}, settingsService: settings,
    createGenerationProviderFn: (opts) => createGenerationProvider({ ...opts, providers: { gemini: cloudGeneration.createProvider } }),
  });
  // resolvedJobRegistry, if the caller doesn't override it, is built HERE
  // with spawn-indexer-full.js's own spawnIndexer (code review, round 4):
  // Full's real, unchanged behavior. createJobRegistry() itself has no
  // default spawnIndexer and never knows which edition constructed it —
  // see that function's own header comment.
  const resolvedJobRegistry = jobRegistry ?? createJobRegistry({ baseEnv: jobBaseEnv, spawnIndexer: spawnFullIndexer });
  const router = createRouter();
  // discoverOllamaModelsFn is optional DI (tests inject a stub so unit
  // tests never probe a real Ollama instance) — same convention as
  // checkOllamaFn below. Full-only: this module is the one place that
  // imports local/core/ollama-models.js and passes it through.
  registerOllamaModelsRoutes(router, { settingsService: settings, ...(discoverOllamaModelsFn ? { discoverOllamaModelsFn } : {}) });
  registerNeutralRoutes(router, {
    adapter, embedQuery: resolvedEmbedQuery, cloudEmbed, jobRegistry: resolvedJobRegistry, taskRegistry, assemblyLogFn, pickFolderFn,
    generationRuntime: resolvedGenerationRuntime, askCoordinator, askCoordinators, countTokens, settingsService: settings,
    runQdrantCloudProbeFn, resolveNewCollectionProfileFn,
    registerQdrantCloudRoutesFn: registerQdrantCloudRoutes,
    generationModelsFn: (r, deps) => registerGenerationModelsRoutes(r, {
      ...deps,
      discoverOllamaModelsFn: discoverOllamaModelsFn ?? discoverOllamaModels,
      discoverGeminiModelsFn: discoverGeminiModelsFn ?? cloudGeneration.discoverModels,
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
  // runOnnxProbeFn/diagnoseCudaFailureFn are optional DI (tests inject
  // stubs so unit tests never spawn a real child process/nvidia-smi or
  // load onnxruntime-node) — same convention as pickFolderFn/checkOllamaFn
  // above.
  registerOnnxRoutes(router, {
    settingsService: settings,
    ...(runOnnxProbeFn ? { runProbeFn: runOnnxProbeFn } : {}),
    ...(diagnoseCudaFailureFn ? { diagnoseCudaFailureFn } : {}),
    ...(resolveEffectiveOnnxRuntimePathFn ? { resolveEffectiveOnnxRuntimePathFn } : {}),
    ...(writeVerificationResultFn ? { writeVerificationResultFn } : {}),
    ...(onnxManagedRuntimeListingCache ? { listingCache: onnxManagedRuntimeListingCache } : {}),
  });
  return createHttpServer(router);
}
