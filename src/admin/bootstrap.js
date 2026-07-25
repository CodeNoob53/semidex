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
import { bootstrapEnv } from '../core/env-bootstrap.js';
import { createSettingsService, applyEnvWriteBack } from '../core/settings/service.js';

export { snapshotOsEnv, loadDotenvValues, applyDotenvValues, bootstrapEnv } from '../core/env-bootstrap.js';

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

// Real entry point: bootstrap env FIRST (before any import below could
// mutate process.env), then dynamically import server.js so its own module
// graph (and every `import 'dotenv/config'` inside it) only ever runs
// after this bootstrap already owns the OS-env/dotenv snapshots.
if (isMainModule) {
  const { osEnv, dotenvValues } = bootstrapEnv();
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
  // RERANK_CE_MODEL/RERANK_CE_DEVICE/RERANK_CE_CACHE_DIR are next_restart —
  // must be applied before this process's first (lazy) loadCEModel() call,
  // which can happen from an Ask or admin-search request that enables CE
  // reranking (see admin/api/search.js / core/ask/coordinator.js).
  const { applyCeRerankSettings, shutdownCEWorker } = await import('../core/ce-rerank.js');
  applyCeRerankSettings(settingsService);
  const { resolveHostConfig, resolvePortConfig, createApp } = await import('./server.js');
  const { createGenerationRuntime } = await import('../core/generation/runtime.js');

  const generationRuntime = createGenerationRuntime({ osEnv, dotenvValues, settingsService });
  const { host } = resolveHostConfig(process.env, { settingsService });
  const port = resolvePortConfig(process.env, { settingsService });
  const server = createApp({ generationRuntime, settingsService, jobBaseEnv });
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
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
}
