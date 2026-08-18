// Resolves the default integration policy for a composition root.
//
// Both composition roots (server-full.js's createApp, composition/lite.js's
// createLiteApp) call this when the caller did not inject an
// `integrationPolicy` explicitly. Keeping it here — rather than duplicating
// the construction in each root — is the same reasoning as
// resolveRequestSecurityPolicy(): Full and Lite must never drift into
// different authentication behavior.
//
// Instance-scoped: every call builds a fresh key store bound to one path, so
// two servers in one process never share authentication state.
import { join } from 'node:path';
import { createKeyStore } from './key-store.js';
import { createIntegrationPolicy } from './integration-policy.js';

/**
 * Resolves the key-store file path for this process.
 *
 * SEMIDEX_KEY_STORE_PATH is an explicit override (used by tests to point at a
 * temp directory, and available to an operator who keeps secrets on a
 * different volume). Otherwise the file sits beside the other per-edition
 * application state under SEMIDEX_HOME — never in settings.json, which is
 * readable through GET /api/settings.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveKeyStorePath(env = process.env) {
  if (env.SEMIDEX_KEY_STORE_PATH) return env.SEMIDEX_KEY_STORE_PATH;
  if (env.SEMIDEX_HOME) return join(env.SEMIDEX_HOME, 'integration-keys.json');
  // No SEMIDEX_HOME set (a bare `node src/admin/bootstrap.js` run, or a
  // script). Fall back to the repo-relative location the rest of Full's
  // unconfigured state uses. The store simply won't exist there, which means
  // the Integration API reports 503 — the correct fail-closed default.
  return join(process.cwd(), 'integration-keys.json');
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, keyStorePath?: string, logger?: Object }} [opts]
 * @returns {{ authorizeRequest: Function, authorizeCollection: Function }}
 */
export function resolveIntegrationPolicy({ env = process.env, keyStorePath, logger } = {}) {
  const path = keyStorePath ?? resolveKeyStorePath(env);
  const keyStore = createKeyStore({ path });
  return createIntegrationPolicy({ keyStore, ...(logger ? { logger } : {}) });
}
