// SettingsService — the single owner of settings.json resolution, caching,
// and writes. Every real process (admin, MCP, indexer child process, sync,
// doctor, backfill scripts) constructs its own instance via
// createSettingsService({ osEnv, dotenvValues, settingsPath }) using the
// real snapshots from core/env-bootstrap.js's bootstrapEnv() — never a
// placeholder dotenvValues, since that would make .env values
// indistinguishable from real OS environment values (the exact bug this
// service exists to avoid). No module outside this file touches
// settings.json directly (see settings-store.js's own header comment).
import { DEFINITIONS } from './definitions.js';
import { readSettingsFile, writeSettingsFileAtomic, statMtime, DEFAULT_SETTINGS_PATH } from './settings-store.js';

const SOURCES = Object.freeze({
  OS_ENV: 'os_env',
  DOTENV: 'dotenv',
  CONFIG_JSON: 'config_json',
  DEFAULT: 'default',
});

function resolveFromTiers(def, { osEnv, dotenvValues, localSettings }) {
  const rawOsEnv = osEnv[def.envVar];
  if (rawOsEnv !== undefined && rawOsEnv !== '') {
    return { value: def.parseExternal(rawOsEnv), source: SOURCES.OS_ENV };
  }
  const rawDotenv = dotenvValues[def.envVar];
  if (rawDotenv !== undefined && rawDotenv !== '') {
    return { value: def.parseExternal(rawDotenv), source: SOURCES.DOTENV };
  }
  if (def.writable && Object.prototype.hasOwnProperty.call(localSettings, def.key)) {
    return { value: localSettings[def.key], source: SOURCES.CONFIG_JSON };
  }
  return { value: def.default, source: SOURCES.DEFAULT };
}

function isOverridden(def, { osEnv, dotenvValues }) {
  const rawOsEnv = osEnv[def.envVar];
  if (rawOsEnv !== undefined && rawOsEnv !== '') return { overridden: true, source: SOURCES.OS_ENV };
  const rawDotenv = dotenvValues[def.envVar];
  if (rawDotenv !== undefined && rawDotenv !== '') return { overridden: true, source: SOURCES.DOTENV };
  return { overridden: false, source: null };
}

/**
 * @param {{ osEnv?: Record<string,string>, dotenvValues?: Record<string,string>, settingsPath?: string }} opts
 */
export function createSettingsService({
  osEnv = process.env, dotenvValues = {}, settingsPath = DEFAULT_SETTINGS_PATH,
} = {}) {
  const keys = Object.keys(DEFINITIONS).map((k) => ({ ...DEFINITIONS[k], key: k }));
  const byKey = new Map(keys.map((d) => [d.key, d]));

  let localSettings = readSettingsFile(settingsPath);
  let lastKnownMtime = statMtime(settingsPath);

  // next_restart fields freeze their resolved value at construction —
  // getActiveValue() never recomputes these for the lifetime of this
  // process, regardless of any later settings.json write. Only
  // configuredValue moves until an actual restart.
  const frozenActive = new Map();
  for (const def of keys) {
    if (def.appliesAt === 'next_restart') {
      frozenActive.set(def.key, resolveFromTiers(def, { osEnv, dotenvValues, localSettings }));
    }
  }

  function buildEntry(def) {
    const resolved = resolveFromTiers(def, { osEnv, dotenvValues, localSettings });
    const hasLocalOverride = def.writable
      && Object.prototype.hasOwnProperty.call(localSettings, def.key);
    const frozen = frozenActive.get(def.key);
    const active = frozen ?? resolved;
    const pendingRestart = frozen !== undefined && frozen.value !== resolved.value;

    const entry = {
      key: def.key,
      category: def.category,
      label: def.label,
      type: def.type,
      default: def.default,
      source: active.source,
      writable: def.writable,
      secret: def.secret,
      hasLocalOverride,
      pendingRestart,
      appliesAt: def.appliesAt,
      requiresReindex: def.requiresReindex,
      requiresBackfill: def.requiresBackfill,
      readOnlyReason: def.readOnlyReason,
    };
    if (def.secret) {
      entry.configured = active.value !== undefined && active.value !== null && active.value !== '';
    } else {
      entry.configuredValue = resolved.value;
      entry.activeValue = active.value;
    }
    return entry;
  }

  return {
    getAll() {
      return keys.map(buildEntry);
    },

    get(key) {
      const def = byKey.get(key);
      if (!def) return null;
      return buildEntry(def);
    },

    getActiveValue(key) {
      const def = byKey.get(key);
      if (!def) throw new Error(`Unknown setting key: ${key}`);
      const frozen = frozenActive.get(key);
      if (frozen !== undefined) return frozen.value;
      return resolveFromTiers(def, { osEnv, dotenvValues, localSettings }).value;
    },

    // Cheap mtime check against settings.json; re-reads only if it changed
    // on disk since the last read (own write or another process's write).
    // Never called automatically — callers at a request/task boundary
    // (MCP search tool, admin search route) call this explicitly.
    refreshIfChanged() {
      const mtime = statMtime(settingsPath);
      if (mtime === lastKnownMtime) return false;
      localSettings = readSettingsFile(settingsPath);
      lastKnownMtime = mtime;
      return true;
    },

    async setMany(changes) {
      const keysToChange = Object.keys(changes);
      if (keysToChange.length === 0) return [];

      // Validate every key up front — all-or-nothing. A null change is
      // never rejected for being "overridden" (removing a hidden, inactive
      // local fallback can never conflict with an active env override);
      // only a non-null change while overridden is rejected.
      for (const key of keysToChange) {
        const def = byKey.get(key);
        if (!def) {
          const err = new Error(`Unknown setting key: ${key}`);
          err.code = 'unknown_key';
          throw err;
        }
        if (!def.writable) {
          const err = new Error(`Setting "${key}" is not writable. ${def.readOnlyReason ?? ''}`.trim());
          err.code = 'not_writable';
          throw err;
        }
        const value = changes[key];
        if (value === null) continue; // deletion — never validated against tier/override below
        const { overridden, source } = isOverridden(def, { osEnv, dotenvValues });
        if (overridden) {
          const err = new Error(`Setting "${key}" is currently overridden by ${source} and cannot be written.`);
          err.code = 'setting_overridden';
          err.overriddenKey = key;
          err.overriddenSource = source;
          throw err;
        }
        const result = def.validate(value);
        if (!result.ok) {
          const err = new Error(result.error);
          err.code = 'invalid_value';
          err.invalidKey = key;
          throw err;
        }
      }

      // All validated — apply atomically to a fresh copy of localSettings,
      // then commit in one write.
      const next = { ...localSettings };
      for (const key of keysToChange) {
        const value = changes[key];
        if (value === null) {
          delete next[key];
        } else {
          const def = byKey.get(key);
          next[key] = def.serialize(value);
        }
      }
      writeSettingsFileAtomic(next, settingsPath);
      localSettings = next;
      lastKnownMtime = statMtime(settingsPath);

      return keysToChange.map((key) => buildEntry(byKey.get(key)));
    },
  };
}

/**
 * Writes every writable setting's ACTIVE value back into a plain env
 * object (process.env by default) as a string, for the many existing
 * `process.env.X` call sites throughout the codebase (core/qdrant/client.js,
 * core/config.js's resolveEnvProviders(), indexer phase modules, etc.) that
 * read env per-call with no caching — updating the underlying string is
 * sufficient to make them observe the SettingsService's resolved value with
 * zero further code changes to each call site.
 *
 * Only writes fields whose source is a GENUINE override (os_env/dotenv/
 * config_json) — a field resolved from `default` is deliberately left
 * unwritten (code review finding, P1): several readers use *presence* of an
 * env var as an explicit-override signal, not just its value —
 * core/config.js's resolveEnvProviders() checks `if (process.env.DENSE_PROVIDER)`
 * to decide whether the caller explicitly chose a provider, versus falling
 * through to the ONNX_EMBED=1 shorthand or the ollama/hashed-tf default.
 * Materializing DENSE_PROVIDER's own *default* ('ollama') into
 * process.env made every ONNX_EMBED=1-only invocation look like an
 * explicit (wrong) `ollama` override, silently breaking the shorthand.
 * Since a `default`-sourced value is by construction identical to what
 * that reader already falls back to when the var is absent, skipping it
 * changes no reader's effective behavior — it only avoids falsely
 * signaling "explicit" for presence-checking logic.
 *
 * Secret entries are never written back (their value is never exposed by
 * getActiveValue() readers outside this service in the first place — this
 * function still skips them defensively). Only fields present in
 * definitions.js with a real envVar are written.
 *
 * Callers that spawn child processes (e.g. admin/jobs/registry.js) must
 * NOT use a process.env mutated by this function as the child's inherited
 * env — a next_index_job/next_search field written back here is this
 * PROCESS's resolved value, which can go stale relative to settings.json
 * for the lifetime of this process (next_restart fields are frozen by
 * design; other fields simply aren't re-applied after the first call) and
 * must never be allowed to look like a real os_env override to a freshly
 * spawned child that should resolve settings.json on its own (code review
 * finding, P1 — see registry.js's own baseEnv parameter and header comment).
 *
 * @param {ReturnType<typeof createSettingsService>} settingsService
 * @param {NodeJS.ProcessEnv} [env]
 */
export function applyEnvWriteBack(settingsService, env = process.env) {
  for (const [key, def] of Object.entries(DEFINITIONS)) {
    if (!def.writable || def.secret || !def.envVar) continue;
    const entry = settingsService.get(key);
    if (!entry || entry.source === 'default') continue;
    const value = settingsService.getActiveValue(key);
    if (value === undefined || value === null) continue;
    env[def.envVar] = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
  }
}

export { SOURCES };
