// Provider-neutral HTTP route composition — the ONE shared route-wiring
// both createApp() (src/admin/server-full.js, full Semidex) and
// createLiteApp() (src/admin/composition/lite.js, Semidex Lite) build on,
// so the two compositions cannot drift apart the way two independently
// hand-written ~200-line functions would. Split out of server.js (Phase 3
// of docs/design/full-lite-shared-architecture-audit-2026-08-01.md) as a
// pure mechanical extraction — no behavior change, no new abstractions, no
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
import { evaluateRequestSecurity, applySecurityResponseHeaders } from '../../core/http/request-security.js';
import { applyStaticCacheHeaders } from '../../core/http/cache-policy.js';
import { registerHealthRoutes } from './api/health.js';
import { registerCollectionsRoutes } from './api/collections.js';
import { registerDocumentsRoutes } from './api/documents.js';
import { registerChunksRoutes } from './api/chunks.js';
import { registerAssemblyRoutes } from './api/assembly.js';
import { registerSkeletonRoutes } from './api/skeleton.js';
import { registerNodeRoutes } from './api/node.js';
import { registerSearchRoutes } from './api/search.js';
import { registerAskRoutesV1 } from '../../core/ask-api/v1/route.js';
import { registerAskRoutesV2 } from '../../core/ask-api/v2/route.js';
import { createAskCoordinatorBundle } from '../../core/ask/coordinator-v2.js';
import { registerGenerationRoutes } from './api/generation.js';
import { createTaskRegistry } from './jobs/task-registry.js';
import { registerOperationsRoutes } from './api/operations.js';
import { registerFolderPickRoutes } from './api/system.js';
import { registerSettingsRoutes } from './api/settings.js';
import { handleStatic } from './static.js';
import { createGenerationRuntime } from '../../core/generation/runtime.js';
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
  adapter, embedQuery, cloudEmbed, jobRegistry, taskRegistry, assemblyLogFn, pickFolderFn,
  generationRuntime, askCoordinator, askCoordinators, countTokens, settingsService,
  runQdrantCloudProbeFn, resolveNewCollectionProfileFn, generationModelsFn, jobsFn, registerQdrantCloudRoutesFn,
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
  registerSearchRoutes(router, adapter, { ...(embedQuery ? { embedQuery } : {}), cloudEmbed, settingsService });
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

  // askCoordinator (singular, existing contract, unchanged) and
  // askCoordinators (plural, new — a { v1, v2, gate } bundle) are mutually
  // exclusive: passing both is ambiguous ("which one wins?") and is
  // rejected outright rather than silently picking one.
  if (askCoordinator && askCoordinators) {
    throw new TypeError(
      'registerNeutralRoutes: pass either `askCoordinator` (v1 only, existing contract, unchanged) ' +
      'or `askCoordinators` ({ v1, v2, gate } bundle, for full v1+v2 shared-gate wiring), never both.'
    );
  }

  const resolvedCountTokens = countTokens ?? defaultCountTokens;
  let ask;
  let askV2;

  if (askCoordinators) {
    // Caller supplies its own pre-wired { v1, v2, gate } — trusted as-is,
    // zero additional construction. The explicit, structural way a caller
    // guarantees v1/v2 share one gate when supplying its own coordinators.
    ({ v1: ask, v2: askV2 } = askCoordinators);
  } else if (askCoordinator) {
    // EXISTING contract, UNCHANGED: caller supplies only a v1-shaped
    // coordinator. v2 is NOT constructed in this branch — /api/v2/ask
    // genuinely 404s for a caller using this legacy single-coordinator
    // override, exactly like it did before this feature existed. A caller
    // that wants v2 together with a custom v1 override uses the
    // `askCoordinators` bundle instead.
    ask = askCoordinator;
  } else {
    // DEFAULT path — no override of any kind: delegate to
    // createAskCoordinatorBundle(), the one factory that constructs
    // gate/core/v1/v2 together so there is no seam where they could end up
    // mismatched.
    ({ v1: ask, v2: askV2 } = createAskCoordinatorBundle({
      adapter, embedQuery, countTokens: resolvedCountTokens, generationProvider: generation, settingsService, cloudEmbed,
    }));
  }

  // POST /api/v1/ask — the ONE canonical, versioned Ask endpoint (see
  // src/core/ask-api/v1/route.js). The unversioned POST /api/ask seed route
  // has been removed entirely — this project has not released a public Ask
  // API yet, so there is no compatibility alias to preserve.
  registerAskRoutesV1(router, adapter, { askCoordinator: ask });
  // POST /api/v2/ask — only registered when a v2 coordinator actually
  // exists (the default path, or an explicit askCoordinators bundle that
  // included one).
  if (askV2) {
    registerAskRoutesV2(router, adapter, { askCoordinatorV2: askV2 });
  }
  // jobRegistry is a REQUIRED dependency (code review, round 4 — no
  // fallback default here anymore): createJobRegistry() itself now
  // requires a spawnIndexer callback with no safe generic default (Full
  // and Lite need genuinely different spawn behavior — see that
  // function's own header comment), and this file is shared/staged for
  // BOTH editions, so it can never safely import either
  // spawn-indexer-full.js or spawn-indexer-lite.js itself to build one.
  // admin/server-full.js's createApp() and admin/composition/lite.js's
  // createLiteApp() each construct their own resolvedJobRegistry (with
  // their own edition-correct spawnIndexer) BEFORE calling this function
  // and always pass it in explicitly — tests do the same, injecting a
  // fake registry directly (never a fake spawnFn threaded through here).
  if (!jobRegistry) {
    throw new TypeError('registerNeutralRoutes: jobRegistry is required — construct it via createJobRegistry({ spawnIndexer, baseEnv }) with an edition-correct spawnIndexer before calling this function.');
  }
  jobsFn(router, jobRegistry);
  registerOperationsRoutes(router, { jobRegistry, taskRegistry: tasks });
  // registerQdrantCloudRoutesFn is a REQUIRED dependency (code review,
  // Phase 8B Step 6 — this file used to statically import
  // src/cloud/admin/qdrant-cloud-api.js directly, a real
  // `shared -> cloud IMPLEMENTATION` edge). Mirrors jobRegistry's own
  // "no fallback default" contract above — this file is shared/staged for
  // BOTH editions, so it can never safely import the real cloud
  // implementation itself; the composition root (createApp(),
  // createLiteApp()) constructs it once, at composition time, via
  // src/cloud/admin/qdrant-cloud-api.js's real registerQdrantCloudRoutes,
  // and passes it in explicitly. runQdrantCloudProbeFn/
  // resolveNewCollectionProfileFn stay optional DI on TOP of that (tests
  // inject a stub so unit tests never issue a real Qdrant Cloud Inference
  // round-trip; resolveNewCollectionProfileFn lets a test prove the exact
  // sparseModel value the route received reaches this call).
  if (!registerQdrantCloudRoutesFn) {
    throw new TypeError('registerNeutralRoutes: registerQdrantCloudRoutesFn is required — pass the real registerQdrantCloudRoutes (src/cloud/admin/qdrant-cloud-api.js) from a composition root, or a test stub.');
  }
  registerQdrantCloudRoutesFn(router, {
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
// composition/lite.js's createLiteApp() reuse it without a second,
// independently-resolved implementation.
// uiDir is optional DI (default undefined -> handleStatic()/resolveStaticPath()
// fall back to static.js's own UI_DIR, i.e. dist/admin-ui/) — a test that
// wants deterministic fingerprinted-vs-not static fixtures, instead of
// depending on whatever happens to be in dist/admin-ui at test time, passes
// its own temp directory here via createApp()/createLiteApp() rather than
// this file reaching into the filesystem to fabricate one itself.
export function createHttpServer(router, { securityPolicy, uiDir } = {}) {
  const server = createServer((req, res) => {
    // /api/* belongs to the router; everything else is the static UI shell.
    // Malformed URLs fall through to the router, whose handleRequest already
    // converts them into a clean 400/404 JSON response.
    let pathname = null;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch { /* router handles it */ }

    if (pathname !== null && !pathname.startsWith('/api')) {
      // Host validation applies to the STATIC UI too, not only /api/*.
      // handleStatic() used to be reached before any security check ran,
      // which left the DNS-rebinding boundary incomplete: an attacker page
      // could still load the dashboard shell from a rebound hostname. No
      // secret leaks that way (the API itself was always checked), but the
      // boundary must be uniform for the Host guarantee to mean anything.
      //
      // Only the Host half applies here: static assets are safe GETs, so the
      // cross-site checks in evaluateRequestSecurity() would be skipped for
      // them anyway.
      if (securityPolicy) {
        const verdict = evaluateRequestSecurity(req, securityPolicy);
        if (!verdict.ok) {
          applySecurityResponseHeaders(res);
          // Static realm, conservative default — this rejection is not a
          // fingerprinted-asset success, so it must never inherit immutable
          // caching (core/http/cache-policy.js).
          applyStaticCacheHeaders(res);
          res.writeHead(verdict.status, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(verdict.message);
          return;
        }
      }
      handleStatic(req, res, pathname, uiDir);
      return;
    }
    router.handleRequest(req, res);
  });

  // Request-INGESTION ceilings (audit P2/Part G). These bound how long a
  // client may take to SEND a request and how large its headers may be —
  // deliberately NOT a cap on how long a response may take to produce.
  //
  // That distinction is the whole reason these values are safe here: Ask
  // streams SSE for as long as generation runs, and an indexing job's HTTP
  // request returns 202 immediately while the work continues in a spawned
  // subprocess. node's `requestTimeout` measures from connection to the end
  // of the REQUEST (headers + body), not the response, so a long SSE stream
  // is unaffected by it. `timeout` (the whole-socket inactivity timeout) is
  // left at node's default of 0/disabled precisely because setting it WOULD
  // kill idle-but-alive SSE streams between tokens.
  server.requestTimeout = 60_000;   // 60s to finish sending a request
  server.headersTimeout = 30_000;   // 30s to finish sending headers
  server.keepAliveTimeout = 5_000;  // node default; stated explicitly
  server.maxHeadersCount = 100;     // bounded header count (node default is 2000)

  // Expose the router's route inventory on the server so the Admin/
  // Integration classification can be asserted against what a REAL
  // composition root actually registers, rather than against a hand-kept
  // list that could drift. Read-only passthrough; adds no request behavior.
  if (typeof router.listRoutes === 'function') {
    server.listRoutes = () => router.listRoutes();
  }

  return server;
}
