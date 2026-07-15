// Shared env bootstrap (Phase: Global Settings) — every real process entry
// point (admin, MCP, indexer child process, sync, doctor, backfill scripts)
// needs the same thing: capture the OS environment BEFORE any
// `import 'dotenv/config'` mutates process.env, so provenance ("did this
// value come from the OS environment, a .env file, or a hardcoded default?")
// stays answerable later. Diffing an already-mutated process.env against
// .env's contents cannot distinguish "the OS happened to set the same value
// dotenv would have used" from "dotenv set it" — this module exists to avoid
// that ambiguity everywhere, not just in the admin server.
//
// Originally admin-only (src/admin/bootstrap.js, Phase 4A.5a). Relocated
// here so MCP/indexer/CLI entry points can depend on it without depending on
// src/admin/. src/admin/bootstrap.js now re-exports this module's functions
// for backwards compatibility and keeps only its own admin-specific
// isMainModule startup block.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseDotenv, populate as populateDotenv } from 'dotenv';

/**
 * Captures process.env exactly as the OS/shell handed it to this process,
 * before any import has had a chance to mutate it. Must be called as the
 * very first statement of the real entry point — this module itself does no
 * import-time work, so importing it is always safe, but the CALLER must
 * invoke this before importing anything that transitively imports
 * 'dotenv/config'.
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
 * (unlike dotenv.config()/'dotenv/config') is a pure string-to-object parse
 * with no side effects, which is exactly what's needed to know what .env
 * itself contains, independent of anything the OS environment already set.
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
 * `import 'dotenv/config'` elsewhere in the import graph behave identically
 * and are idempotent with each other.
 * @param {Record<string, string>} dotenvValues
 * @param {NodeJS.ProcessEnv} [env]
 */
export function applyDotenvValues(dotenvValues, env = process.env) {
  populateDotenv(env, dotenvValues);
}

/**
 * Runs the full bootstrap sequence and returns both snapshots for callers
 * that need them (e.g. to construct a SettingsService or generation runtime
 * with explicit provenance) — snapshot OS env, load .env values, apply them
 * to process.env (gap-fill only), return { osEnv, dotenvValues }.
 * @param {{ envPath?: string, env?: NodeJS.ProcessEnv }} [opts]
 */
export function bootstrapEnv({ envPath, env = process.env } = {}) {
  const osEnv = snapshotOsEnv(env);
  const dotenvValues = envPath !== undefined ? loadDotenvValues(envPath) : loadDotenvValues();
  applyDotenvValues(dotenvValues, env);
  return { osEnv, dotenvValues };
}
