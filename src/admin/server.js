// Semidex Local API — createApp() factory. No self-start block here: the
// real process entry point is src/admin/bootstrap.js (npm run admin),
// which snapshots the OS environment BEFORE importing this file, then
// constructs a generationRuntime and passes it into createApp(). This file
// itself has no top-level 'dotenv/config' import and never calls
// server.listen() — but it is NOT free of transitive import-time side
// effects: createStorageAdapter() (imported below) pulls in
// core/qdrant/client.js, which still does `import 'dotenv/config'` (that
// bootstrap predates this file and is intentionally NOT refactored here,
// per this phase's own scope). Functional correctness does not depend on
// this file being side-effect-free — bootstrap.js's snapshot happens
// before it dynamically imports this file at all, so the snapshot is
// already taken by the time any transitive dotenv/config runs. What this
// file DOES guarantee is narrower: importing it never starts a server and
// never loads a generation/embedding model, so tests (and any other
// caller) can import it freely without binding a port or touching Ollama/
// ONNX.
//
// Design doc §7/§10: JSON-only, localhost-only by default, no CORS, no auth
// (the loopback bind IS the auth boundary for MVP). Every route handler
// depends on the StorageAdapter contract only — no direct Qdrant SDK or
// src/core/qdrant/store.js import anywhere under src/admin/.
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
import { registerAskRoutes } from './api/ask.js';
import { registerGenerationRoutes } from './api/generation.js';
import { registerJobsRoutes } from './api/jobs.js';
import { createJobRegistry } from './jobs/registry.js';
import { createTaskRegistry } from './jobs/task-registry.js';
import { registerOperationsRoutes } from './api/operations.js';
import { registerSystemRoutes } from './api/system.js';
import { registerOnnxRoutes } from './api/onnx.js';
import { registerSettingsRoutes } from './api/settings.js';
import { registerOllamaModelsRoutes } from './api/ollama-models.js';
import { registerGenerationModelsRoutes } from './api/generation-models.js';
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

export function createApp({
  adapter = createStorageAdapter(), embedQuery, jobRegistry, taskRegistry, pickFolderFn, checkOllamaFn,
  assemblyLogFn, generationRuntime, askCoordinator, countTokens, settingsService, jobBaseEnv,
  discoverOllamaModelsFn, discoverGeminiModelsFn, runOnnxProbeFn,
} = {}) {
  const router = createRouter();
  // settingsService is optional DI — tests and ad-hoc createApp() callers
  // that don't care about settings.json provenance get a safe env-only
  // fallback (no file I/O beyond a single settings.json read, same
  // "import/construction-safe" contract generationRuntime's own fallback
  // below already documents). The real production entry point
  // (bootstrap.js) always passes its own properly bootstrapped instance.
  const settings = settingsService ?? createSettingsService({ osEnv: process.env, dotenvValues: {} });
  registerSettingsRoutes(router, { settingsService: settings });
  // discoverOllamaModelsFn is optional DI (tests inject a stub so unit
  // tests never probe a real Ollama instance) — same convention as
  // checkOllamaFn below.
  registerOllamaModelsRoutes(router, { settingsService: settings, ...(discoverOllamaModelsFn ? { discoverOllamaModelsFn } : {}) });
  // Provider-neutral generation-model discovery (Stage B1) — same optional
  // DI convention as discoverOllamaModelsFn above (tests inject stubs so
  // unit tests never probe a real Ollama instance or call the real Gemini
  // API).
  registerGenerationModelsRoutes(router, {
    settingsService: settings,
    ...(discoverOllamaModelsFn ? { discoverOllamaModelsFn } : {}),
    ...(discoverGeminiModelsFn ? { discoverGeminiModelsFn } : {}),
  });
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
  registerSearchRoutes(router, adapter, { ...(embedQuery ? { embedQuery } : {}), settingsService: settings });
  // generationRuntime/askCoordinator/countTokens are optional DI — tests
  // inject stubs so unit tests never initialize Ollama or the real BGE-M3
  // tokenizer. Defaulted here (not inside ask.js) so the SAME runtime/
  // coordinator instance is shared between GET /api/generation/status and
  // POST /api/ask — both must observe identical readiness, never two
  // independently-resolved configs that could disagree.
  //
  // The default here (process.env as "osEnv", no dotenv values) is a safe
  // fallback for direct createApp() callers that never bootstrap explicitly
  // (e.g. a quick script, or a test that doesn't care about provenance) —
  // it reads process.env but does NOT read any file or touch the network,
  // so createApp() itself stays import/construction-safe. The real
  // production entry point (bootstrap.js) always passes its own properly
  // snapshotted generationRuntime instead, which is what makes provenance
  // (os_env vs dotenv vs default) meaningful in practice.
  const generation = generationRuntime ?? createGenerationRuntime({ osEnv: process.env, dotenvValues: {}, settingsService: settings });
  registerGenerationRoutes(router, { generationRuntime: generation });
  const ask = askCoordinator ?? createAskCoordinator({
    adapter, embedQuery, countTokens: countTokens ?? defaultCountTokens, generationProvider: generation,
    settingsService: settings,
  });
  registerAskRoutes(router, adapter, { askCoordinator: ask });
  // jobRegistry/checkOllamaFn are optional DI (tests inject a fake spawnFn-
  // backed registry and a stub Ollama check so unit tests never launch a
  // real indexer child process or probe a real Ollama instance). jobBaseEnv
  // is the env snapshot spawned indexer jobs inherit — MUST be the
  // pre-applyEnvWriteBack() snapshot (bootstrap.js passes this explicitly);
  // falling back to live process.env here is only safe for callers that
  // never called applyEnvWriteBack() against it (e.g. tests, or a caller
  // that doesn't care about settings.json provenance) — see
  // jobs/registry.js's own createJobRegistry() header comment for why this
  // matters (code review finding, P1: a spawned job must resolve
  // settings.json fresh, not inherit admin's own already-resolved values).
  const jobs = jobRegistry ?? createJobRegistry({ baseEnv: jobBaseEnv });
  registerJobsRoutes(router, jobs, checkOllamaFn ? { checkOllamaFn } : {});
  registerOperationsRoutes(router, { jobRegistry: jobs, taskRegistry: tasks });
  // pickFolderFn/checkOllamaFn are optional DI (tests inject stubs so unit
  // tests never spawn a real powershell.exe/dialog or probe a real Ollama
  // instance).
  registerSystemRoutes(router, {
    ...(pickFolderFn ? { pickFolderFn } : {}),
    ...(checkOllamaFn ? { checkOllamaFn } : {}),
  });
  // runOnnxProbeFn is optional DI (tests inject a stub so unit tests never
  // spawn a real child process/load onnxruntime-node) — same convention as
  // pickFolderFn/checkOllamaFn above.
  registerOnnxRoutes(router, { settingsService: settings, ...(runOnnxProbeFn ? { runProbeFn: runOnnxProbeFn } : {}) });
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
