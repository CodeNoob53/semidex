// Lite's own indexer spawn function (code review, round 4) — sibling of
// spawn-indexer-full.js; see that file's own header comment for the full
// rationale. Spawns indexer/index-lite.js, which never imports any
// local-runtime module.
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const INDEXER_ENTRY = fileURLToPath(new URL('../../indexer/index-lite.js', import.meta.url));

/**
 * @param {{ args: string[], env: NodeJS.ProcessEnv, stdio?: any, windowsHide?: boolean }} opts
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnIndexer({ args, env, stdio, windowsHide = true }) {
  return nodeSpawn(process.execPath, [INDEXER_ENTRY, ...args], { env, ...(stdio ? { stdio } : {}), windowsHide });
}
