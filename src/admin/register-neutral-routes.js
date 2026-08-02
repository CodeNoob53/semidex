// Provider-neutral HTTP route composition — the ONE shared route-wiring
// both createApp() (src/admin/server-full.js, full Semidex) and
// createLiteApp() (src/admin/server.js, Semidex Lite) build on, so the two
// compositions cannot drift apart the way two independently hand-written
// ~200-line functions would. Split out of server.js (Phase 3 of
// docs/design/full-lite-shared-architecture-audit-2026-08-01.md) as a pure
// mechanical extraction — no behavior change, no new abstractions, no
// route/contract/status-code/middleware-order changes. See that phase's
// entry in the audit doc for the extraction rationale and exit gate.
//
// Every route registered here is genuinely cloud-safe / Ollama-free — no
// import in this file reaches Ollama, ONNX Runtime, Transformers.js, or
// any CUDA/DirectML probe, and none reaches src/admin/server-full.js (the
// full-only composition root). This is what makes it safe for Semidex
// Lite's package build (packages/lite/build.mjs) to stage this file
// unmodified: importing it never pulls in a local-runtime module.
//
// Design doc §7/§10: JSON-only, localhost-only by default, no CORS, no auth
// (the loopback bind IS the auth boundary for MVP). Every route handler
// depends on the StorageAdapter contract only — no direct Qdrant SDK or
// src/core/qdrant/store.js import anywhere under src/admin/.
import { createServer } from 'node:http';
import { registerHealthRoutes } from './api/health.js';
import { registerCollectionsRoutes } from './api/collections.js';
import { registerDocumentsRoutes } from './api/documents.js';
import { registerChunksRoutes } from './api/chunks.js';
import { registerAssemblyRoutes } from './api/assembly.js';
import { registerSkeletonRoutes } from './api/skeleton.js';
import { registerNodeRoutes } from './api/node.js';
import { registerSearchRoutes } from './api/search.js';
import { registerAskRoutesV1 } from '../core/ask-api/v1/route.js';
import { registerGenerationRoutes } from './api/generation.js';
import { createJobRegistry } from './jobs/registry.js';
import { createTaskRegistry } from './jobs/task-registry.js';
import { registerOperationsRoutes } from './api/operations.js';
import { registerFolderPickRoutes } from './api/system.js';
import { registerQdrantCloudRoutes } from './api/qdrant-cloud.js';
import { registerSettingsRoutes } from './api/settings.js';
import { handleStatic } from './static.js';
import { createGenerationRuntime } from '../core/generation/runtime.js';
import { createAskCoordinator } from '../core/ask/coordinator.js';
import { getTokenCounter } from '../core/token-count.js';

// Lazily resolves the real BGE-M3 tokenizer on first Ask request, never at
// import/startup time — importing this module (e.g. for its route wiring
// in a test) must not eagerly load the ONNX tokenizer model. Mirrors
// getContent.js's own lazy-resolution pattern for the same tokenizer.
async function defaultCountTokens(text) {
  const counter = await getTokenCounter({ mode: 'bge-m3' });
  return counter(text);
}

// Registers every cloud-safe/Ollama-free route onto `router`, and returns
// the shared instances (settings service, task registry, job registry,
// generation runtime, ask coordinator) so the caller's OWN local-only or
// full-vs-Lite-specific registrations can reuse them instead of
// constructing a second, independently-resolved copy (which could disagree
// with this one — the exact bug class the pre-split single function's own
// comments already guarded against for generationRuntime/askCoordinator).
//
// jobsFn lets the caller supply its own registerJobsRoutes call (full vs
// Lite pass different jobPolicy/checkOllamaFn) — jobs are registered here,
// inside the shared function, so the SAME job registry instance is reused
// by registerOperationsRoutes below rather than constructed twice.
export function registerNeutralRoutes(router, {
  adapter, embedQuery, jobRegistry, taskRegistry, assemblyLogFn, pickFolderFn,
  generationRuntime, askCoordinator, countTokens, settingsService, jobBaseEnv,
  runQdrantCloudProbeFn, resolveNewCollectionProfileFn, generationModelsFn, jobsFn,
}) {
  registerSettingsRoutes(router, { settingsService });
  generationModelsFn(router, { settingsService });
  registerHealthRoutes(router, adapter);
  // taskRegistry is optional DI (tests inject a fake with a pinned clock, or
  // a stub that captures the tracked fn without actually running it) — same
  // convention as jobRegistry below. Defaulted once here so the SAME
  // instance is shared between the repair route (writes) and the operations
  // route (reads) — two independently-constructed registries would each
  // track their own separate, half-empty view of what's running.
  const tasks = taskRegistry ?? createTaskRegistry();
  registerCollectionsRoutes(router, adapter, { taskRegistry: tasks });
  registerDocumentsRoutes(router, adapter);
  registerChunksRoutes(router, adapter);
  registerAssemblyRoutes(router, adapter, assemblyLogFn ? { logFn: assemblyLogFn } : {});
  registerSkeletonRoutes(router, adapter);
  registerNodeRoutes(router, adapter);
  // embedQuery is optional DI (tests inject a stub so unit tests never load
  // ONNX/Ollama); production default lives in api/search.js. settingsService
  // is always passed (the same instance every other route already shares)
  // so HYBRID_PREFETCH_LIMIT/RRF_K settings apply to admin search too, not
  // just MCP (code review finding).
  registerSearchRoutes(router, adapter, { ...(embedQuery ? { embedQuery } : {}), settingsService });
  // generationRuntime/askCoordinator/countTokens are optional DI — tests
  // inject stubs so unit tests never initialize Ollama or the real BGE-M3
  // tokenizer. Defaulted here (not inside the ask-api route module) so the
  // SAME runtime/coordinator instance is shared between
  // GET /api/generation/status and POST /api/v1/ask — both must observe
  // identical readiness, never two independently-resolved configs that
  // could disagree.
  //
  // The default here (process.env as "osEnv", no dotenv values) is a safe
  // fallback for direct createApp()/createLiteApp() callers that never
  // bootstrap explicitly (e.g. a quick script, or a test that doesn't care
  // about provenance) — it reads process.env but does NOT read any file or
  // touch the network, so this stays import/construction-safe. The real
  // production entry points always pass their own properly snapshotted
  // generationRuntime instead, which is what makes provenance (os_env vs
  // dotenv vs default) meaningful in practice.
  const generation = generationRuntime ?? createGenerationRuntime({ osEnv: process.env, dotenvValues: {}, settingsService });
  registerGenerationRoutes(router, { generationRuntime: generation });
  const ask = askCoordinator ?? createAskCoordinator({
    adapter, embedQuery, countTokens: countTokens ?? defaultCountTokens, generationProvider: generation,
    settingsService,
  });
  // POST /api/v1/ask — the ONE canonical, versioned Ask endpoint (see
  // src/core/ask-api/v1/route.js). The unversioned POST /api/ask seed route
  // has been removed entirely — this project has not released a public Ask
  // API yet, so there is no compatibility alias to preserve.
  registerAskRoutesV1(router, adapter, { askCoordinator: ask });
  // jobRegistry is optional DI (tests inject a fake spawnFn-backed registry
  // so unit tests never launch a real indexer child process). jobBaseEnv is
  // the env snapshot spawned indexer jobs inherit — MUST be the
  // pre-applyEnvWriteBack() snapshot (bootstrap.js passes this explicitly);
  // falling back to live process.env here is only safe for callers that
  // never called applyEnvWriteBack() against it (e.g. tests, or a caller
  // that doesn't care about settings.json provenance) — see
  // jobs/registry.js's own createJobRegistry() header comment for why this
  // matters (code review finding, P1: a spawned job must resolve
  // settings.json fresh, not inherit admin's own already-resolved values).
  const jobs = jobRegistry ?? createJobRegistry({ baseEnv: jobBaseEnv });
  jobsFn(router, jobs);
  registerOperationsRoutes(router, { jobRegistry: jobs, taskRegistry: tasks });
  // runQdrantCloudProbeFn is optional DI (tests inject a stub so unit
  // tests never issue a real Qdrant Cloud Inference round-trip).
  // resolveNewCollectionProfileFn is optional DI (tests inject a spy so a
  // test can prove the exact sparseModel value the route received reaches
  // this call, independent of what the real catalog's current default
  // sparse model happens to be — see qdrant-cloud.js's own header comment).
  registerQdrantCloudRoutes(router, {
    settingsService,
    ...(runQdrantCloudProbeFn ? { runProbeFn: runQdrantCloudProbeFn } : {}),
    ...(resolveNewCollectionProfileFn ? { resolveNewCollectionProfileFn } : {}),
  });
  // pick-folder is a neutral OS dialog integration — unrelated to Ollama,
  // kept in both full and Lite. pickFolderFn is optional DI (tests inject a
  // stub so unit tests never spawn a real powershell.exe/dialog). Registered
  // exactly once, here — the router matches the FIRST route registered for
  // a given method+path (routes.push(), matched in registration order), so
  // registering this route a second time elsewhere with a different
  // pickFolderFn would silently have no effect (a real bug caught in
  // testing: an earlier version of this split registered it here AND again
  // in createApp() when a caller passed pickFolderFn, and the second
  // registration's stub was never reached).
  registerFolderPickRoutes(router, pickFolderFn ? { pickFolderFn } : {});
}

// Shared HTTP + static-UI server tail — identical for the full and Lite
// composition roots. Exported so both server-full.js's createApp() and
// server.js's createLiteApp() reuse it without a second, independently-
// resolved implementation.
export function createHttpServer(router) {
  return createServer((req, res) => {
    // /api/* belongs to the router; everything else is the static UI shell.
    // Malformed URLs fall through to the router, whose handleRequest already
    // converts them into a clean 400/404 JSON response.
    let pathname = null;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch { /* router handles it */ }

    if (pathname !== null && !pathname.startsWith('/api')) {
      handleStatic(req, res, pathname);
      return;
    }
    router.handleRequest(req, res);
  });
}
