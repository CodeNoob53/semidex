// Semidex Local API — HTTP entry point (npm run admin).
//
// Design doc §7/§10: JSON-only, localhost-only by default, no CORS, no auth
// (the loopback bind IS the auth boundary for MVP). Every route handler
// depends on the StorageAdapter contract only — no direct Qdrant SDK or
// src/core/qdrant/store.js import anywhere under src/admin/.
import 'dotenv/config';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createStorageAdapter } from '../core/storage/factory.js';
import { createRouter } from './router.js';
import { registerHealthRoutes } from './api/health.js';
import { registerCollectionsRoutes } from './api/collections.js';
import { registerDocumentsRoutes } from './api/documents.js';
import { registerChunksRoutes } from './api/chunks.js';
import { registerSkeletonRoutes } from './api/skeleton.js';
import { registerNodeRoutes } from './api/node.js';

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

export function createApp({ adapter = createStorageAdapter() } = {}) {
  const router = createRouter();
  registerHealthRoutes(router, adapter);
  registerCollectionsRoutes(router, adapter);
  registerDocumentsRoutes(router, adapter);
  registerChunksRoutes(router, adapter);
  registerSkeletonRoutes(router, adapter);
  registerNodeRoutes(router, adapter);
  return createServer((req, res) => {
    router.handleRequest(req, res);
  });
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const { host } = resolveHostConfig();
  const port = resolvePortConfig();
  const server = createApp();
  server.listen(port, host, () => {
    console.log(`[admin] Semidex Local API listening on http://${host}:${port}`);
  });
}
