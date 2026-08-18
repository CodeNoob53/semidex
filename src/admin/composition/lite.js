// Semidex Lite composition root — createLiteApp() — moved out of
// server.js (Phase 4 of
// ../../../docs/design/full-lite-shared-architecture-audit-2026-08-01.md)
// as a pure mechanical extraction — no behavior change, same DI arguments
// and defaults, same route registration order. src/shared/admin/server.js
// (physically relocated, Phase 8B Step 7C) now owns only shared bind
// configuration (resolveHostConfig/resolvePortConfig); this file owns
// Lite's own provider composition. The provider-neutral route wiring
// itself (registerNeutralRoutes, createHttpServer) still lives in
// src/shared/admin/register-neutral-routes.js — this file imports it, it
// does not define it. createApp() (the FULL composition root) lives in
// ../server-full.js and must never be imported from here — that is
// exactly the edge this module's existence prevents Lite's dependency
// graph from having.
//
// No self-start block here — packages/lite/lite-src/serve-lite.js snapshots
// the OS environment (bootstrapEnv()) BEFORE dynamically importing this
// file, same ordering guarantee ../server.js's own header comment used to
// document for createLiteApp() when it lived there.
import { createStorageAdapter } from '../../core/storage/factory.js';
import { createRouter } from '../../shared/admin/router.js';
import { registerJobsRoutes } from '../../shared/admin/api/jobs.js';
import { registerGenerationModelsRoutesGeminiOnly } from '../../shared/admin/api/generation-models.js';
import { createSettingsService } from '../../core/settings/service.js';
import { registerNeutralRoutes, createHttpServer } from '../../shared/admin/register-neutral-routes.js';
import { resolveRequestSecurityPolicy } from '../../shared/admin/server.js';
import { embedForSearch } from '../../shared/core/embeddings.js';
import { createJobRegistry } from '../../shared/admin/jobs/registry.js';
import { spawnIndexer as spawnLiteIndexer } from '../jobs/spawn-indexer-lite.js';
import { REQUIRED_OLLAMA_EMBED_CAPABILITY_METHODS } from '../../core/generation/ollama-capability.js';
import { REQUIRED_ONNX_EMBED_CAPABILITY_METHODS } from '../../shared/core/onnx-embed-capability.js';
import { createCloudEmbeddingCapability } from '../../cloud/embedding/cloud-embedding-provider.js';
import { createCloudGenerationCapability } from '../../cloud/generation/cloud-generation-provider.js';
import { registerQdrantCloudRoutes } from '../../cloud/admin/qdrant-cloud-api.js';
import { createGenerationRuntime } from '../../core/generation/runtime.js';
import { createGenerationProvider } from '../../core/generation/registry.js';

// Phase 8B Step 1 (revised, round 3/4) — explicit capability wiring.
// core/embeddings.js is statically imported by this server's own
// request-handling call graph (registerNeutralRoutes -> api/search.js ->
// core/retrieval/search.js -> core/embeddings.js), so this composition
// root is a REAL place a wrong EMBEDDING_BACKEND value could otherwise
// reach embeddings.js's Ollama/ONNX dispatch branches — those branches
// are policy-unreachable today (Lite hard-pins DENSE_PROVIDER=qdrant-cloud
// and rejects any other value at the settings-service layer), but this
// file, not embeddings.js itself, is where that "never actually
// reachable" guarantee is asserted explicitly, per this phase's own
// "composition root is the only place that selects an implementation"
// requirement — shared orchestration code must never branch on
// SEMIDEX_LITE/edition itself to make this choice. The mechanism is
// createLiteApp()'s own resolvedEmbedQuery closure (below), bound to the
// two disabled capability objects constructed here, passed explicitly
// into the search/Ask call chain — never a mutation of
// embeddings.js's shared module-scope state (see createLiteApp()'s own
// comment for why that mutation was removed in round 4).
//
// Deliberately does NOT import core/ollama-lazy.lite.js/
// core/onnx-embed-lazy.lite.js: those files are dead code now
// (packages/lite/build.mjs no longer does any *-lazy.js content
// substitution at all — core/ollama-lazy.js/core/onnx-embed-lazy.js and
// their .lite.js siblings are simply excluded from the Lite package
// outright, like any other local-only file; see build.mjs's own
// EXCLUDE_FILES comment). The typed error classes are therefore small,
// local, throwaway classes here — not a reuse of the *-lazy.lite.js
// shim's own class — since this file must never statically depend on
// local/core/ollama.js/local/core/onnx-embed.js either way.
class OllamaNotAvailableInLiteCompositionError extends Error {
  constructor(fnName) {
    super(`${fnName}() is not available in Semidex Lite — Ollama is a local-only provider and is not included in this package.`);
    this.name = 'OllamaNotAvailableInLiteError';
    this.code = 'not_available_in_lite';
  }
}

class OnnxEmbedNotAvailableInLiteCompositionError extends Error {
  constructor(fnName) {
    super(`${fnName}() is not available in Semidex Lite — the local ONNX embedding runtime is not included in this package.`);
    this.name = 'OnnxEmbedNotAvailableInLiteError';
    this.code = 'not_available_in_lite';
  }
}

function unavailableOllamaEmbedCapability() {
  const capability = {};
  for (const m of REQUIRED_OLLAMA_EMBED_CAPABILITY_METHODS) capability[m] = async () => { throw new OllamaNotAvailableInLiteCompositionError(m); };
  return capability;
}

function unavailableOnnxEmbedCapability() {
  const capability = {};
  for (const m of REQUIRED_ONNX_EMBED_CAPABILITY_METHODS) capability[m] = async () => { throw new OnnxEmbedNotAvailableInLiteCompositionError(m); };
  // shutdown is DIFFERENT from loadOnnx/loadOnnxBatch: it is cleanup code,
  // unconditionally called from indexer/run.js's own `finally` block on
  // every indexing run regardless of whether ONNX embedding was ever used
  // — the real local/core/onnx-embed.js documents this exact function as a
  // safe no-op when no session was ever created (mirrors tagOnnx's own
  // shutdownOnnxTagWorker() always-safe-no-op contract, itself fixed after
  // a real production incident — see tag-onnx-capability.js's own header
  // comment). Since a session can never have been created in Lite (the
  // whole point of this function), this must preserve that same no-op
  // contract rather than throw.
  capability.shutdown = async () => { /* no-op: no ONNX session is ever created in Semidex Lite */ };
  return capability;
}

// Semidex Lite composition root — cloud-only. Never registers
// registerOnnxRoutes/registerOllamaStatusRoutes/registerOllamaModelsRoutes,
// and its generation-models route is the Gemini-only variant — so none of
// their handlers, and none of the modules behind them
// (admin/api/onnx.js -> local/core/onnx-provider-probe.js, admin/system/ollama.js
// -> local/core/ollama.js, admin/api/ollama-models.js -> local/core/ollama-models.js),
// are ever imported by this function's own call graph. jobPolicy defaults
// to a cloud-safe policy (no onnxEmbed/llmSummaries/tagGen; pruneStale
// stays allowed — pure Qdrant-Cloud-compatible stale cleanup) and no
// checkOllamaFn is ever passed, matching jobs.js's own contract that
// checkOllamaFn is only required when jobPolicy.allowLlmSummaries is true.
//
// core/embeddings.js's applyEmbeddingCapabilities() (the process-wide
// module-scope fallback) is deliberately NEVER called from this function
// (code review, round 4 — removed after round 3 made it redundant): every
// real request path this composition root serves (search, Ask) now
// receives its capability explicitly via resolvedEmbedQuery below, which
// bypasses that shared fallback entirely — mutating it here would be pure
// global side-effecting noise with no real consumer, and (round 1/2's own
// finding) any mutation of that shared singleton risks affecting whatever
// OTHER composition root happens to share this process. The fallback
// itself still exists in embeddings.js, but now starts UNSET (null) rather
// than defaulting to the real ollama-lazy.js/onnx-embed-lazy.js modules
// (code review, round 4 — see embeddings.js's own header comment): a
// caller that hasn't been updated to pass capabilities explicitly (e.g. a
// smoke-test script) gets a clear "no capability injected" error instead
// of a silent real-network default — this composition root has no reason
// to touch it in either direction.
export function createLiteApp({
  adapter = createStorageAdapter(), embedQuery, jobRegistry, taskRegistry,
  assemblyLogFn, generationRuntime, askCoordinator, askCoordinators, countTokens, settingsService, jobBaseEnv,
  discoverGeminiModelsFn, runQdrantCloudProbeFn, resolveNewCollectionProfileFn, jobPolicy = LITE_JOB_POLICY,
  securityPolicy, integrationPolicy,
} = {}) {
  const ollamaCapability = unavailableOllamaEmbedCapability();
  const onnxEmbedCapability = unavailableOnnxEmbedCapability();
  // cloudEmbed/cloudGeneration (code review, Phase 8B Step 6): UNLIKE
  // ollama/onnxEmbed above, Lite constructs the REAL implementation here —
  // Lite is cloud-only by design, so Qdrant Cloud embedding and Gemini
  // generation are the ONE local vs. cloud pair where Lite's own
  // composition root supplies the working implementation rather than a
  // typed-unavailable stub. A real `composition root -> cloud` edge,
  // explicitly allowed by the task's own dependency rules.
  const cloudEmbed = createCloudEmbeddingCapability();
  const cloudGeneration = createCloudGenerationCapability();
  // embedQuery, if the caller doesn't override it, is bound HERE to this
  // composition root's own typed-unavailable capability (code review,
  // round 3 — the real per-call isolation fix, matching
  // admin/server-full.js's createApp() own equivalent): this server's own
  // search request path never consults embeddings.js's shared module-scope
  // fallback at all, regardless of what any other composition root does.
  const resolvedEmbedQuery = embedQuery ?? ((profile, query) => embedForSearch(profile, query, { capabilities: { ollama: ollamaCapability, onnxEmbed: onnxEmbedCapability, cloudEmbed } }));
  // settings (code review, P2): resolved BEFORE resolvedGenerationRuntime
  // below, and that call site is given `settings`, never the raw
  // `settingsService` parameter — createGenerationRuntime() treats an
  // undefined settingsService as "no settings.json tier at all" (see
  // applySettingsServiceTier() in core/generation/runtime.js), so a
  // default (no-DI) construction of createLiteApp() previously handed the
  // runtime a real fallback SettingsService further down. Production
  // bootstrap always passes settingsService explicitly and was never
  // affected — this is the public fallback-construction contract.
  const settings = settingsService ?? createSettingsService({ osEnv: process.env, dotenvValues: {} });
  // resolvedGenerationRuntime, if the caller doesn't override it, is built
  // HERE with a createGenerationProviderFn that supplies the real Gemini
  // factory as a `providers` override — mirrors server-full.js's own
  // equivalent; this is the ONE real place Lite's Gemini generation
  // becomes selectable, since registry.js's own BACKENDS default no longer
  // includes 'gemini'.
  const resolvedGenerationRuntime = generationRuntime ?? createGenerationRuntime({
    osEnv: process.env, dotenvValues: {}, settingsService: settings,
    createGenerationProviderFn: (opts) => createGenerationProvider({ ...opts, providers: { gemini: cloudGeneration.createProvider } }),
  });
  // resolvedJobRegistry, if the caller doesn't override it, is built HERE
  // with spawn-indexer-lite.js's own spawnIndexer (code review, round 4):
  // this is where Lite tells createJobRegistry() to spawn
  // indexer/index-lite.js (its own disabled/cloud capability set, never
  // core/ollama-lazy.js/core/onnx-embed-lazy.js/phases/tag-onnx-lazy.js).
  // createJobRegistry() itself has NO default spawnIndexer at all (it
  // throws a TypeError without one — see that function's own header
  // comment), so this call site must always supply one explicitly.
  const resolvedJobRegistry = jobRegistry ?? createJobRegistry({ baseEnv: jobBaseEnv, spawnIndexer: spawnLiteIndexer });
  // Same shared policy resolution Full uses (shared/admin/server.js) — Host
  // allow-list + cross-site rejection, applied before route dispatch. Passing
  // the caller's settingsService keeps ADMIN_PORT/ADMIN_ALLOW_REMOTE
  // resolution identical to the listener's own.
  const resolvedSecurityPolicy = securityPolicy
    ?? resolveRequestSecurityPolicy(process.env, { settingsService: settings });
  const router = createRouter({ securityPolicy: resolvedSecurityPolicy, integrationPolicy });
  registerNeutralRoutes(router, {
    adapter, embedQuery: resolvedEmbedQuery, cloudEmbed, jobRegistry: resolvedJobRegistry, taskRegistry, assemblyLogFn,
    generationRuntime: resolvedGenerationRuntime, askCoordinator, askCoordinators, countTokens, settingsService: settings,
    runQdrantCloudProbeFn, resolveNewCollectionProfileFn,
    registerQdrantCloudRoutesFn: registerQdrantCloudRoutes,
    generationModelsFn: (r, deps) => registerGenerationModelsRoutesGeminiOnly(r, {
      ...deps,
      discoverGeminiModelsFn: discoverGeminiModelsFn ?? cloudGeneration.discoverModels,
    }),
    jobsFn: (r, jobs) => registerJobsRoutes(r, jobs, { jobPolicy }),
  });
  return createHttpServer(router, { securityPolicy: resolvedSecurityPolicy });
}

// Cloud-safe default policy for createLiteApp() — no local-model options,
// pruneStale allowed (see jobs.js's own FULL_JOB_POLICY comment for why
// pruneStale is Qdrant-Cloud-safe, not local-model-shaped).
export const LITE_JOB_POLICY = Object.freeze({
  allowOnnxEmbed: false, allowLlmSummaries: false, allowTagGen: false, allowPruneStale: true,
});
