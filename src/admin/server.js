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
import { handleStatic } from './static.js';
import { createGenerationRuntime } from '../core/generation/runtime.js';
import { createAskCoordinator } from '../core/ask/coordinator.js';
import { getTokenCounter } from '../core/token-count.js';

// Lazily resolves the real BGE-M3 tokenizer on first Ask request, never at
// import/startup time — importing server.js (e.g. for its route wiring in
// a test) must not eagerly load the ONNX tokenizer model. Mirrors
// getContent.js's own lazy-resolution pattern for the same tokenizer.
async function defaultCountTokens(text) {
  const counter = await getTokenCounter({ mode: 'bge-m3' });
  return counter(text);
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function resolveHostConfig(env = process.env) {
  const host = env.ADMIN_HOST || '127.0.0.1';
  const allowRemote = env.ADMIN_ALLOW_REMOTE === '1';
  if (!LOOPBACK_HOSTS.has(host) && !allowRemote) {
    throw new Error(
      `ADMIN_HOST="${host}" is not a loopback address. Refusing to bind a non-loopback host ` +
      `without ADMIN_ALLOW_REMOTE=1 (this exposes the Local API beyond this machine — unsafe by default).`
    );
  }
  return { host, allowRemote };
}

export function resolvePortConfig(env = process.env) {
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
  assemblyLogFn, generationRuntime, askCoordinator, countTokens,
} = {}) {
  const router = createRouter();
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
  // ONNX/Ollama); production default lives in api/search.js.
  registerSearchRoutes(router, adapter, embedQuery ? { embedQuery } : {});
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
  const generation = generationRuntime ?? createGenerationRuntime({ osEnv: process.env, dotenvValues: {} });
  registerGenerationRoutes(router, { generationRuntime: generation });
  const ask = askCoordinator ?? createAskCoordinator({
    adapter, embedQuery, countTokens: countTokens ?? defaultCountTokens, generationProvider: generation,
  });
  registerAskRoutes(router, adapter, { askCoordinator: ask });
  // jobRegistry/checkOllamaFn are optional DI (tests inject a fake spawnFn-
  // backed registry and a stub Ollama check so unit tests never launch a
  // real indexer child process or probe a real Ollama instance).
  const jobs = jobRegistry ?? createJobRegistry();
  registerJobsRoutes(router, jobs, checkOllamaFn ? { checkOllamaFn } : {});
  registerOperationsRoutes(router, { jobRegistry: jobs, taskRegistry: tasks });
  // pickFolderFn/checkOllamaFn are optional DI (tests inject stubs so unit
  // tests never spawn a real powershell.exe/dialog or probe a real Ollama
  // instance).
  registerSystemRoutes(router, {
    ...(pickFolderFn ? { pickFolderFn } : {}),
    ...(checkOllamaFn ? { checkOllamaFn } : {}),
  });
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
