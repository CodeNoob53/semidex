// Explicit admin bootstrap (Phase 4A.5a) — the real npm run admin entry
// point (see package.json's "admin" script). The env-snapshot-before-mutate
// logic itself now lives in src/core/env-bootstrap.js (Global Settings
// phase), shared by every real process entry point (admin, MCP, indexer
// child process, sync, doctor, backfill scripts) — this file re-exports
// those functions for backwards compatibility (existing imports of
// snapshotOsEnv/loadDotenvValues/applyDotenvValues/bootstrapEnv from here
// keep working) and keeps only the admin-specific isMainModule startup
// block: bootstrap env, construct the shared SettingsService, construct the
// generation runtime, start the HTTP server.
import { pathToFileURL } from 'node:url';
import { bootstrapEnv } from '../shared/core/env-bootstrap.js';
import { createSettingsService, applyEnvWriteBack } from '../core/settings/service.js';
import { resolveOnnxRuntimeForProcess } from '../local/core/onnx-runtime-source-resolution.js';
import { createOnnxRuntimeUnavailableCapability } from '../local/core/onnx-runtime-unavailable-capability.js';
import { applySemidexHomeEnv } from '../local/core/semidex-home.js';
import { resolveAuditSink } from '../core/audit/resolve-sink.js';

export { snapshotOsEnv, loadDotenvValues, applyDotenvValues, bootstrapEnv } from '../shared/core/env-bootstrap.js';

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

// Real entry point: bootstrap env FIRST (before any import below could
// mutate process.env), then dynamically import server.js so its own module
// graph (and every `import 'dotenv/config'` inside it) only ever runs
// after this bootstrap already owns the OS-env/dotenv snapshots.
if (isMainModule) {
  const { osEnv, dotenvValues } = bootstrapEnv();

  // Establish ONE canonical Full application-data home before anything else
  // in this process resolves a SEMIDEX_HOME-derived path — in particular
  // createApp()'s default resolveIntegrationPolicy(), which reads
  // process.env.SEMIDEX_HOME. See applySemidexHomeEnv()'s own header
  // comment (src/local/core/semidex-home.js) for the CLI/server divergence
  // this closes. Mirrors Lite's own serve-lite.js -> applySemidexHomeEnv()
  // ordering contract.
  applySemidexHomeEnv({ env: process.env });

  const settingsService = createSettingsService({ osEnv, dotenvValues });

  // jobBaseEnv is the REAL OS-env snapshot only — osEnv, captured by
  // bootstrapEnv() BEFORE it gap-filled process.env with .env's contents —
  // never process.env itself, at any point. Two separate bugs would result
  // from using process.env here:
  //  1. (fixed previously) process.env, if captured AFTER
  //     applyEnvWriteBack() below, would carry every settings-registry
  //     field admin resolved at ITS OWN startup, making a settings.json
  //     change invisible to new jobs until admin restarts.
  //  2. (this fix) even captured BEFORE applyEnvWriteBack(), process.env
  //     already has .env's values gap-filled into it by bootstrapEnv()
  //     itself (line above) — spreading that into a spawned job's env
  //     would make the child's OWN bootstrapEnv() snapshot .env's values
  //     as if they were genuine OS environment variables (there is no way
  //     for the child to tell "the OS actually set this" apart from
  //     "dotenv gap-filled this into the env object my parent handed me"),
  //     corrupting the child's os_env vs. dotenv provenance and, since
  //     os_env outranks config_json, silently letting a stale .env value
  //     shadow a settings.json override. Using bare osEnv here means the
  //     child's own bootstrapEnv() call reads the REAL .env file fresh
  //     (picking up any edit made after admin started) and classifies it
  //     correctly as dotenv, not os_env (code review finding, P2).
  const jobBaseEnv = { ...osEnv };

  // Resolve which onnxruntime-node build THIS process should load —
  // explicit ONNXRUNTIME_NODE_PATH > managed CUDA runtime selection
  // (ONNX_MANAGED_RUNTIME, only when ONNX_EXECUTION_PROVIDER=cuda — a
  // managed runtime is a CUDA-only build with no DirectML EP, so this
  // reads the settings-active provider internally and never applies the
  // managed selection for dml/cpu) > default npm package — via the one
  // shared resolution module every real caller (this file,
  // indexer/index-full.js, mcp/onnx-runtime-resolution.js, the Admin probe
  // route) goes through, so the precedence, its provider-gating, and the
  // cuDNN PATH preparation it requires never drift apart between
  // processes. Written once, at startup, for the Admin process's own
  // background embed calls (e.g. Ask/search embedding a live ONNX-backed
  // collection) — the probe route (local/admin/api/onnx.js) separately
  // resolves into its own per-request env object to test a staged/unsaved
  // selection (including a staged provider change) without mutating this
  // real process.env.
  //
  // Review finding (P2): a broken resolved runtime (prepared.ok === false)
  // must never be silently attempted later, deep inside a real embed
  // call — this server stays up (never fail-fast, unlike the indexer CLI:
  // Admin serves many non-ONNX routes fine even when the local ONNX
  // runtime is broken), but createApp() below receives a typed,
  // immediately-throwing "unavailable" onnxEmbedCapability instead of
  // ever attempting to load the runtime this resolution just proved is
  // broken.
  const onnxRuntimeResolution = resolveOnnxRuntimeForProcess({ settingsService, env: process.env });
  if (onnxRuntimeResolution.resolutionWarning) console.warn(`[admin] ${onnxRuntimeResolution.resolutionWarning}`);
  if (!onnxRuntimeResolution.prepared.ok) console.warn(`[admin] ${onnxRuntimeResolution.prepared.reason}`);
  const onnxEmbedCapability = onnxRuntimeResolution.prepared.ok
    ? undefined
    : createOnnxRuntimeUnavailableCapability(onnxRuntimeResolution.prepared.reason);

  // Writes every writable setting's active value into process.env — in
  // particular QDRANT_URL, which core/qdrant/client.js still reads via a
  // plain process.env.QDRANT_URL per call (code review finding: a
  // settings.json-saved QDRANT_URL previously never reached the real
  // client because no write-back covered it here). Must run before the
  // dynamic import of server.js below, since createApp()'s default
  // adapter construction can trigger a Qdrant client build. Only affects
  // THIS process's process.env — jobBaseEnv above was already captured,
  // so this mutation never reaches a spawned job's inherited env.
  applyEnvWriteBack(settingsService);
  // local/core/ollama-capability.js is dynamically imported HERE, after
  // bootstrapEnv()/applyEnvWriteBack() above, never as a static top-level
  // import (code review finding, P1): local/core/ollama.js — which
  // ollama-capability.js statically imports — has its own top-level
  // `import 'dotenv/config'` AND captures `OLLAMA_URL` from
  // `process.env.OLLAMA_URL` into a module-scope constant at import time
  // (see that file's own line 3). A static import chain here would have
  // let dotenv's own env gap-fill run, and OLLAMA_URL get captured, BEFORE
  // this file's own bootstrapEnv() call ever ran — silently letting a .env
  // value get misclassified as a genuine OS-env value, and letting a
  // settings.json-saved OLLAMA_URL (applied above, via applyEnvWriteBack())
  // never actually reach the real Ollama runtime, since OLLAMA_URL would
  // already be frozen into ollama.js's own constant by the time the
  // write-back ran. Importing dynamically, after the real bootstrap
  // sequence has already run, is what keeps this file's own "bootstrap env
  // FIRST" contract (see the header comment above) genuinely true for this
  // dependency too, not just for server.js's own module graph.
  const {
    isOllamaReachable, listOllamaModels, validateOllamaModels, generateStream, getModelContextLength,
  } = await import('../local/core/ollama-capability.js');
  // RERANK_CE_MODEL/RERANK_CE_DEVICE/RERANK_CE_CACHE_DIR are next_restart —
  // must be applied before this process's first (lazy) loadCEModel() call,
  // which can happen from an Ask or admin-search request that enables CE
  // reranking (see admin/api/search.js / core/ask/coordinator.js).
  const { applyCeRerankSettings, shutdownCEWorker } = await import('../core/ce-rerank.js');
  applyCeRerankSettings(settingsService);
  const { resolveHostConfig, resolvePortConfig } = await import('../shared/admin/server.js');
  const { createApp } = await import('./server-full.js');
  const { createGenerationRuntime } = await import('../core/generation/runtime.js');
  const { createGenerationProvider } = await import('../core/generation/registry.js');

  // core/generation/ollama-provider.js does not statically (or
  // dynamically) import local/core/ollama.js itself — that would give
  // generation/registry.js's BACKENDS map a real static edge onto it,
  // reachable from Lite's own module graph regardless of Lite's
  // SEMIDEX_GENERATION_BACKEND=gemini hard pin, since the map references
  // createOllamaProvider unconditionally. This file is Full-only (excluded
  // from the Lite package entirely — see packages/lite/build.mjs's
  // EXCLUDE_FILES), so it is the one safe place to supply
  // createOllamaProvider's real *Fn overrides, resolved via
  // local/core/ollama-capability.js's bare re-exports (imported dynamically
  // above, after bootstrapEnv()/applyEnvWriteBack() — see that import's own
  // comment for why; the Lite-exclusion of this whole file makes the import
  // safe regardless of edition, but the dynamic timing is what keeps this
  // file's own env-ordering contract correct).
  // createCloudGenerationCapability() (code review, Phase 8B Step 6): the
  // real Gemini GenerationProvider factory — registry.js's own BACKENDS
  // default no longer includes 'gemini', so `providers: { gemini: ... }`
  // below is what actually makes it selectable. This file is Full-only
  // (excluded from the Lite package), so it is a safe place to import
  // src/cloud/ directly, same rationale as the Ollama override above.
  const { createCloudGenerationCapability } = await import('../cloud/generation/cloud-generation-provider.js');
  const cloudGeneration = createCloudGenerationCapability();
  const createGenerationProviderFn = (opts) => {
    const withGeminiProvider = { ...opts, providers: { ...opts.providers, gemini: cloudGeneration.createProvider } };
    if (opts?.backend !== 'ollama') return createGenerationProvider(withGeminiProvider);
    return createGenerationProvider({
      ...withGeminiProvider,
      options: {
        ...opts.options,
        isOllamaReachableFn: isOllamaReachable,
        listOllamaModelsFn: listOllamaModels,
        validateOllamaModelsFn: validateOllamaModels,
        generateStreamFn: generateStream,
        getModelContextLengthFn: getModelContextLength,
      },
    });
  };

  const generationRuntime = createGenerationRuntime({ osEnv, dotenvValues, settingsService, createGenerationProviderFn });
  const { host } = resolveHostConfig(process.env, { settingsService });
  const port = resolvePortConfig(process.env, { settingsService });
  // resolvedAuditSink is constructed HERE, once, and passed into createApp()
  // explicitly — this file is the single audit-sink composition owner for
  // the real `npm run admin` process, so createApp()'s own internal
  // `auditSink ?? resolveAuditSink(...)` fallback never runs and never
  // constructs a second, independent instance. Keeping the reference here is
  // what lets gracefulShutdown() below flush/close it before the process
  // exits (docs/security/audit-logging-design-2026-08.md §4/§7).
  const resolvedAuditSink = resolveAuditSink({ edition: 'full' });
  const server = createApp({ generationRuntime, settingsService, jobBaseEnv, onnxEmbedCapability, auditSink: resolvedAuditSink });
  server.listen(port, host, () => {
    console.log(`[admin] Semidex Local API listening on http://${host}:${port}`);
  });

  // The CE worker is a persistent CHILD PROCESS (not a thread) — an
  // orphaned child left running past this server's own shutdown is a
  // real, observable leaked process. Ensures a graceful SIGTERM/SIGINT
  // (the normal way a supervisor or `docker stop` ends this long-lived
  // server) always terminates it, matching mcp/server.js's own equivalent
  // handler.
  let shuttingDown = false;
  const gracefulShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await shutdownCEWorker(); } catch { /* best effort on the way out */ }
    server.close(() => {
      // Waits for every queued audit event (a request denial, a job-lifecycle
      // event) to become durable before the process exits — previously
      // nothing invoked flush()/close() here, so a final queued event could
      // be silently lost on a normal SIGTERM/SIGINT shutdown.
      resolvedAuditSink.close().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
}
