// Shared server bind configuration — resolveHostConfig()/resolvePortConfig()
// — used by both the Full composition root (server-full.js, via
// bootstrap.js) and the Lite composition root (composition/lite.js's
// createLiteApp(), via packages/lite/lite-src/serve-lite.js). Lite's own
// provider composition (createLiteApp(), LITE_JOB_POLICY) moved to
// admin/composition/lite.js in Phase 4 of
// docs/design/full-lite-shared-architecture-audit-2026-08-01.md — this
// file no longer hosts any composition-root logic, only the bind-config
// resolution both roots share. createApp() (the FULL composition root)
// lives in server-full.js; createLiteApp() lives in composition/lite.js —
// neither is re-exported here.
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
