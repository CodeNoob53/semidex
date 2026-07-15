// Explicit admin bootstrap (Phase 4A.5a) — the real npm run admin entry
// point (see package.json's "admin" script). Exists to solve one problem:
// `import 'dotenv/config'` at the top of server.js mutated process.env
// before any code got a chance to see what the OS environment looked like
// on its own, so provenance ("did this value come from the OS environment,
// a .env file, or a hardcoded default?") could never be recovered later —
// diffing an already-mutated process.env against .env's contents cannot
// distinguish "the OS happened to set the same value dotenv would have
// used" from "dotenv set it." This file captures the OS snapshot FIRST,
// before importing anything that could mutate process.env, then loads
// .env explicitly via dotenv's side-effect-free parse().
//
// This bootstrap does NOT change how src/core/*.js, src/indexer/*.js, or
// src/mcp/*.js resolve .env — those keep their own `import 'dotenv/config'`
// calls untouched (out of scope for this task). dotenv's populate() never
// overrides an already-set process.env key by default, so once this
// bootstrap has populated process.env from OS-env + .env, every later
// `import 'dotenv/config'` anywhere in the import graph becomes a safe
// no-op — this file's snapshot is the one that matters for provenance.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseDotenv, populate as populateDotenv } from 'dotenv';

/**
 * Captures process.env exactly as the OS/shell handed it to this process,
 * before any import has had a chance to mutate it. Must be called as the
 * very first statement of the real entry point — this module itself does
 * no import-time work, so importing bootstrap.js is always safe, but the
 * CALLER (this file's own isMainModule block, or any other real entry
 * point) must invoke this before importing server.js or anything that
 * transitively imports 'dotenv/config'.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, string>} a plain-object snapshot (not a live
 *   reference to process.env — later mutations to process.env do not leak
 *   back into this snapshot)
 */
export function snapshotOsEnv(env = process.env) {
  return { ...env };
}

/**
 * Reads and parses .env WITHOUT touching process.env — dotenv.parse()
 * (unlike dotenv.config()/'dotenv/config') is a pure string-to-object
 * parse with no side effects, which is exactly what's needed to know what
 * .env itself contains, independent of anything the OS environment already
 * set.
 * @param {string} [envPath] — defaults to `.env` resolved from cwd, same
 *   default dotenv itself uses.
 * @returns {Record<string, string>} empty object if the file doesn't exist
 */
export function loadDotenvValues(envPath = resolve(process.cwd(), '.env')) {
  if (!existsSync(envPath)) return {};
  return parseDotenv(readFileSync(envPath, 'utf-8'));
}

/**
 * Populates process.env from the given dotenv values, filling gaps only —
 * never overrides a key the OS environment (or an earlier populate call)
 * already set. Matches dotenv's own default (non-override) semantics
 * exactly, so this bootstrap's populate() and any later
 * `import 'dotenv/config'` elsewhere in the import graph behave
 * identically and are idempotent with each other.
 * @param {Record<string, string>} dotenvValues
 * @param {NodeJS.ProcessEnv} [env]
 */
export function applyDotenvValues(dotenvValues, env = process.env) {
  populateDotenv(env, dotenvValues);
}

/**
 * Runs the full bootstrap sequence and returns both snapshots for callers
 * that need them (e.g. to construct a generation runtime with explicit
 * provenance) — snapshot OS env, load .env values, apply them to
 * process.env (gap-fill only), return { osEnv, dotenvValues }.
 * @param {{ envPath?: string, env?: NodeJS.ProcessEnv }} [opts]
 */
export function bootstrapEnv({ envPath, env = process.env } = {}) {
  const osEnv = snapshotOsEnv(env);
  const dotenvValues = envPath !== undefined ? loadDotenvValues(envPath) : loadDotenvValues();
  applyDotenvValues(dotenvValues, env);
  return { osEnv, dotenvValues };
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

// Real entry point: bootstrap env FIRST (before any import below could
// mutate process.env), then dynamically import server.js so its own module
// graph (and every `import 'dotenv/config'` inside it) only ever runs
// after this bootstrap already owns the OS-env/dotenv snapshots.
if (isMainModule) {
  const { osEnv, dotenvValues } = bootstrapEnv();
  const { resolveHostConfig, resolvePortConfig, createApp } = await import('./server.js');
  const { createGenerationRuntime } = await import('../core/generation/runtime.js');

  const generationRuntime = createGenerationRuntime({ osEnv, dotenvValues });
  const { host } = resolveHostConfig();
  const port = resolvePortConfig();
  const server = createApp({ generationRuntime });
  server.listen(port, host, () => {
    console.log(`[admin] Semidex Local API listening on http://${host}:${port}`);
  });
}
