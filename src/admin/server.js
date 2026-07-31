// Semidex Local API — createLiteApp() (Lite composition root) plus the
// shared building blocks (registerNeutralRoutes, createHttpServer,
// resolveHostConfig/resolvePortConfig) both composition roots use.
// createApp() (the FULL composition root) lives in server-full.js and must
// be imported from there. It is intentionally not re-exported here so the
// Lite dependency graph has no edge to the full-only composition root.
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
// Design doc §7/§10: JSON-only, localhost-only by default, no CORS, no auth
// (the loopback bind IS the auth boundary for MVP). Every route handler
// depends on the StorageAdapter contract only — no direct Qdrant SDK or
// src/core/qdrant/store.js import anywhere under src/admin/.
//
// ── Semidex Lite package boundary ─────────────────────────────────────────
// registerNeutralRoutes() below registers every route that is genuinely
// cloud-safe / Ollama-free — this is the ONE shared route-wiring both
// createApp() (server-full.js) and createLiteApp() (this file) build on, so
// the two compositions cannot drift apart the way two independently-
// hand-written ~200-line functions would. createHttpServer() is the shared
// HTTP+static server tail. createApp() = registerNeutralRoutes() + the full
// generation-models/jobs registration (Ollama allowed) + the local-only
// routes (registerOnnxRoutes, registerOllamaStatusRoutes,
// registerOllamaModelsRoutes) — behavior identical to this file's
// pre-split form. createLiteApp() = registerNeutralRoutes() + the
// Gemini-only generation-models route + a Lite jobs policy (no
// Ollama-shaped options, no Ollama check) — the local-only routes are never
// registered, so their handlers AND the modules behind them
// (system/ollama.js -> core/ollama.js, ollama-models.js,
// onnx-provider-probe.js) are never reachable.
//
// server-full.js is EXCLUDED from the Lite package (build.mjs, Part F) —
// this file (server.js) IS staged, since createLiteApp() lives here and
// needs no Ollama/ONNX-only import. server-full.js imports the shared route
// and HTTP helpers from this file; server.js does not import server-full.js,
// so the dependency is deliberately one-way.
import { createServer } from 'node:http';
import { createStorageAdapter } from '../core/storage/factory.js';
import { createRouter } from './router.js';
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
import { registerJobsRoutes } from './api/jobs.js';
import { createJobRegistry } from './jobs/registry.js';
import { createTaskRegistry } from './jobs/task-registry.js';
import { registerOperationsRoutes } from './api/operations.js';
import { registerFolderPickRoutes } from './api/system.js';
import { registerQdrantCloudRoutes } from './api/qdrant-cloud.js';
import { registerSettingsRoutes } from './api/settings.js';
import { registerGenerationModelsRoutesGeminiOnly } from './api/generation-models.js';
import { handleStatic } from './static.js';
import { createGenerationRuntime } from '../core/generation/runtime.js';
import { createAskCoordinator } from '../core/ask/coordinator.js';
import { getTokenCounter } from '../core/token-count.js';
import { createSettingsService } from '../core/settings/service.js';

// Lazily resolves the real BGE-M3 tokenizer on first Ask request, never at
// import/startup time — importing server.js (e.g. for its route wiring in
// a test) must not eagerly load the ONNX tokenizer model. Mirrors
// getContent.js's own lazy-resolution pattern for the same tokenizer.
async function defaultCountTokens(text) {
  const counter = await getTokenCounter({ mode: 'bge-m3' });
  return counter(text);
}

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
  runQdrantCloudProbeFn, generationModelsFn, jobsFn,
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
  registerQdrantCloudRoutes(router, { settingsService, ...(runQdrantCloudProbeFn ? { runProbeFn: runQdrantCloudProbeFn } : {}) });
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
// composition roots. Exported (not module-private) so server-full.js's
// createApp() can reuse it without a second, independently-resolved
// implementation.
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
  discoverGeminiModelsFn, runQdrantCloudProbeFn, jobPolicy = LITE_JOB_POLICY,
} = {}) {
  const router = createRouter();
  const settings = settingsService ?? createSettingsService({ osEnv: process.env, dotenvValues: {} });
  registerNeutralRoutes(router, {
    adapter, embedQuery, jobRegistry, taskRegistry, assemblyLogFn,
    generationRuntime, askCoordinator, countTokens, settingsService: settings, jobBaseEnv,
    runQdrantCloudProbeFn,
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
