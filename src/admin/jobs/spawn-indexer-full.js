// Full's own indexer spawn function (code review, round 4) — the ONE file
// containing both the literal path to indexer/index-full.js AND the
// node:child_process spawn() call that launches it. jobs/registry.js (a
// SHARED file staged for Lite too) never imports node:child_process and
// never names an indexer entry path itself — it REQUIRES an injected
// `spawnIndexer(opts)` function with NO default of its own (a default
// importing this file would put Full's own literal path back into that
// shared, Lite-staged file's source — see registry.js's own header
// comment). Full's composition roots (admin/server-full.js's createApp(),
// admin/bootstrap.js) import this file's export directly and pass it in
// explicitly. packages/lite/build.mjs's closure validator requires every
// literal fork()/spawn() target found in a staged file's own source to
// resolve to a real staged file, with no "intentionally absent" exception
// — keeping the literal path AND the spawn() call together, in a
// Full-only file excluded from the Lite package (see build.mjs's own
// EXCLUDE_FILES), is what lets that rule stay exactly as strict as it
// already is, with no special-casing added for this seam. Lite's own
// sibling: spawn-indexer-lite.js.
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const INDEXER_ENTRY = fileURLToPath(new URL('../../indexer/index-full.js', import.meta.url));

/**
 * @param {{ args: string[], env: NodeJS.ProcessEnv, stdio?: any, windowsHide?: boolean }} opts
 *   `args` is the indexer CLI's own argument list (e.g. [path]) — this
 *   function itself supplies the leading INDEXER_ENTRY argument, so the
 *   caller (registry.js) never needs to know which file that is.
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnIndexer({ args, env, stdio, windowsHide = true }) {
  return nodeSpawn(process.execPath, [INDEXER_ENTRY, ...args], { env, ...(stdio ? { stdio } : {}), windowsHide });
}
