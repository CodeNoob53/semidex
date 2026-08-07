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
import { resolveEffectiveEmbeddingBackend, assertProviderCombo } from '../../shared/core/env.js';
import { DEFAULT_MODEL_BY_BACKEND } from '../generation/config.js';

const SOURCES = Object.freeze({
  OS_ENV: 'os_env',
  DOTENV: 'dotenv',
  CONFIG_JSON: 'config_json',
  DEFAULT: 'default',
});

// EMBEDDING_BACKEND is a synthetic field (definitions.js) with no envVar/
// settings.json key of its own — its READ-side value is resolved through
// core/env.js's resolveEffectiveEmbeddingBackend(), the same shared
// resolver core/config.js's resolveEnvProviders() uses for the real
// indexer/sync collection-creation path. This is deliberate, not
// incidental: an earlier version of this derivation only ever consulted
// DENSE_PROVIDER's own registry entry, which has no concept of the legacy
// ONNX_EMBED=1 shorthand — a real .env with ONNX_EMBED=1 and no
// DENSE_PROVIDER made this service report EMBEDDING_BACKEND: 'ollama'
// while the indexer itself actually ran bge-m3-onnx (code review finding,
// reproduced live). Using the same resolver as config.js closes that gap
// structurally — the two callers can no longer independently drift.
//
// A PATCH to EMBEDDING_BACKEND is expanded into a real
// DENSE_PROVIDER+SPARSE_PROVIDER write (see setMany() below); this map is
// only used for that write-side expansion, never for reads.
const EMBEDDING_BACKEND_EXPANSION = {
  ollama: { DENSE_PROVIDER: 'ollama', SPARSE_PROVIDER: 'hashed-tf' },
  'bge-m3-onnx': { DENSE_PROVIDER: 'bge-m3-onnx', SPARSE_PROVIDER: 'bge-m3-onnx' },
  'qdrant-cloud': { DENSE_PROVIDER: 'qdrant-cloud', SPARSE_PROVIDER: 'qdrant-cloud' },
};

// ASK_MODEL's static definitions.js default ('gemma3:4b') has no notion of
// which generation backend is active — resolveGenerationRuntimeConfig()
// (core/generation/config.js) resolves the SAME "nothing set anywhere"
// case per-backend via DEFAULT_MODEL_BY_BACKEND. Reusing that exact map
// here (rather than re-deriving a second copy) is what makes it
// structurally impossible for SettingsService and the generation runtime
// to disagree on ASK_MODEL's default again (code review finding —
// confirmed live: this service reported 'gemma3:4b' while the runtime
// resolved a Gemini model for identical osEnv under
// SEMIDEX_GENERATION_BACKEND=gemini). Applied inside resolveFromTiers()
// itself (not only in buildEntry()'s post-hoc annotation) so every
// call site — buildStoredEntry, frozenActive's construction-time
// snapshot, and getActiveValue()'s next_restart fast path — agrees, not
// just the Settings API's GET response shape.
function resolveAskModelDefault({ osEnv, dotenvValues, localSettings }) {
  // Raw registry definitions do not carry their object key. Add it here so
  // resolveFromTiers() can see a backend persisted in settings.json instead
  // of resolving only OS env/.env/default values.
  const backendDef = { ...DEFINITIONS.SEMIDEX_GENERATION_BACKEND, key: 'SEMIDEX_GENERATION_BACKEND' };
  const backend = resolveFromTiers(backendDef, { osEnv, dotenvValues, localSettings }).value;
  return DEFAULT_MODEL_BY_BACKEND[backend] ?? DEFINITIONS.ASK_MODEL.default;
}

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
  const defaultValue = def.key === 'ASK_MODEL'
    ? resolveAskModelDefault({ osEnv, dotenvValues, localSettings })
    : def.default;
  return { value: defaultValue, source: SOURCES.DEFAULT };
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

  function buildStoredEntry(def) {
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
      // Deprecated alias for activeSource — kept for backward compatibility
      // with existing callers/tests that read entry.source. New code
      // (Global Settings UI) must read configuredSource/activeSource
      // explicitly: for a next_restart field right after a successful
      // PATCH, configuredValue is the new settings.json value but
      // activeValue is still the old frozen value, and a single `source`
      // cannot honestly describe both provenances at once.
      source: active.source,
      configuredSource: resolved.source,
      activeSource: active.source,
      writable: def.writable,
      secret: def.secret,
      hasLocalOverride,
      pendingRestart,
      appliesAt: def.appliesAt,
      requiresReindex: def.requiresReindex,
      requiresBackfill: def.requiresBackfill,
      readOnlyReason: def.readOnlyReason,
      description: def.description,
      advanced: def.advanced ?? false,
    };
    if (def.min !== undefined) entry.min = def.min;
    if (def.max !== undefined) entry.max = def.max;
    if (def.options !== undefined) entry.options = def.options;
    if (def.allowEmpty !== undefined) entry.allowEmpty = def.allowEmpty;
    if (def.visibleWhen !== undefined) entry.visibleWhen = def.visibleWhen;
    // hiddenWhen: the inverse of visibleWhen (see global-settings-view.js's
    // isFieldVisible() for the full rationale) — a single {key, equals}
    // condition, JSON-safe as-is (no function values), passed through
    // unchanged.
    if (def.hiddenWhen !== undefined) entry.hiddenWhen = def.hiddenWhen;
    if (def.dynamicOptions !== undefined) entry.dynamicOptions = def.dynamicOptions;
    if (def.derivedWhen !== undefined) entry.derivedWhen = def.derivedWhen;
    if (def.dynamicDerived !== undefined) entry.dynamicDerived = def.dynamicDerived;
    // catalogDerived.lookup (if ever set) is a real function — cannot
    // survive JSON serialization. Only the JSON-safe key/equals/modelKey/
    // property/unknownWarning fields are sent; the browser resolves the
    // actual catalog lookup itself against its own bundled
    // qdrant-cloud-models.js copy (findDenseModel(modelId)?.[property]),
    // never receiving a function over the wire. `property` defaults to
    // 'dimensions' client-side when omitted (VECTOR_SIZE's original shape).
    if (def.catalogDerived !== undefined) {
      entry.catalogDerived = {
        key: def.catalogDerived.key,
        equals: def.catalogDerived.equals,
        modelKey: def.catalogDerived.modelKey,
        ...(def.catalogDerived.property !== undefined ? { property: def.catalogDerived.property } : {}),
        ...(def.catalogDerived.unknownWarning !== undefined ? { unknownWarning: def.catalogDerived.unknownWarning } : {}),
      };
    }
    if (def.uiHidden !== undefined) entry.uiHidden = def.uiHidden;
    if (def.pathPicker !== undefined) entry.pathPicker = def.pathPicker;
    if (def.secret) {
      entry.configured = active.value !== undefined && active.value !== null && active.value !== '';
    } else {
      entry.configuredValue = resolved.value;
      entry.activeValue = active.value;
    }
    return entry;
  }

  // Read the unparsed winning explicit value. This is intentionally
  // separate from buildStoredEntry(): enum parsing falls back to defaults,
  // which is useful for ordinary runtime settings but would make the
  // Settings UI hide an invalid provider configuration that the indexer
  // later rejects.
  function readExplicitRaw(name) {
    const rawOsEnv = osEnv[name];
    if (rawOsEnv !== undefined && rawOsEnv !== '') {
      return { value: rawOsEnv, source: SOURCES.OS_ENV, hasLocalOverride: false };
    }
    const rawDotenv = dotenvValues[name];
    if (rawDotenv !== undefined && rawDotenv !== '') {
      return { value: rawDotenv, source: SOURCES.DOTENV, hasLocalOverride: false };
    }
    if (Object.prototype.hasOwnProperty.call(localSettings, name)) {
      return { value: localSettings[name], source: SOURCES.CONFIG_JSON, hasLocalOverride: true };
    }
    return null;
  }

  // EMBEDDING_BACKEND's read-side value comes from
  // resolveEffectiveEmbeddingBackend() (core/env.js) — the same resolver
  // core/config.js's resolveEnvProviders() uses — so this service can
  // never disagree with what the indexer/sync will actually do (see the
  // module-level comment above). Provenance (source/hasLocalOverride/
  // pendingRestart) still mirrors DENSE_PROVIDER's own already-built entry
  // whenever DENSE_PROVIDER is what actually decided the result (`via ===
  // 'DENSE_PROVIDER'`); when the legacy ONNX_EMBED shorthand is what
  // decided it instead, the entry reports os_env/dotenv (whichever tier
  // ONNX_EMBED itself came from) rather than DENSE_PROVIDER's (which would
  // be lying: DENSE_PROVIDER's own tiers are all unset in that case).
  function deriveEmbeddingBackendEntry(def) {
    const resolved = resolveEffectiveEmbeddingBackend(
      (name) => readExplicitRaw(name)?.value
    );
    const backendValue = resolved.denseProvider;
    let invalidConfiguration = null;
    try {
      assertProviderCombo(resolved.denseProvider, resolved.sparseProvider);
    } catch (err) {
      invalidConfiguration = err.message;
    }

    // "Active" (frozen-for-next_restart-aware) value: EMBEDDING_BACKEND
    // isn't itself next_restart, but DENSE_PROVIDER/ONNX_EMBED aren't
    // either (appliesAt: 'new_collection') — active and configured are
    // the same resolution here, computed once above. Kept as a separate
    // local for clarity/symmetry with buildStoredEntry's shape, not
    // because the two can differ for this particular derived field.
    const activeBackendValue = backendValue;

    let configuredSource;
    let hasLocalOverride;
    let pendingRestart;
    if (resolved.via === 'DENSE_PROVIDER') {
      const source = readExplicitRaw('DENSE_PROVIDER');
      configuredSource = source?.source ?? SOURCES.DEFAULT;
      hasLocalOverride = source?.hasLocalOverride ?? false;
      pendingRestart = false;
    } else if (resolved.via === 'ONNX_EMBED') {
      configuredSource = osEnv.ONNX_EMBED !== undefined && osEnv.ONNX_EMBED !== '' ? SOURCES.OS_ENV : SOURCES.DOTENV;
      hasLocalOverride = false; // ONNX_EMBED has no settings.json/config_json tier to hide
      pendingRestart = false;
    } else {
      configuredSource = SOURCES.DEFAULT;
      hasLocalOverride = false;
      pendingRestart = false;
    }

    return {
      key: def.key,
      category: def.category,
      label: def.label,
      type: def.type,
      default: def.default,
      source: configuredSource,
      configuredSource,
      activeSource: configuredSource,
      writable: true,
      secret: false,
      hasLocalOverride,
      pendingRestart,
      appliesAt: def.appliesAt,
      requiresReindex: def.requiresReindex,
      requiresBackfill: def.requiresBackfill,
      readOnlyReason: def.readOnlyReason,
      description: def.description,
      advanced: def.advanced ?? false,
      options: def.options,
      configuredValue: backendValue,
      activeValue: activeBackendValue,
      invalidConfiguration,
    };
  }

  // EMBED_MODEL is the canonical, UI-facing model setting for the ollama
  // embedding backend (core/config.js's resolveEnvProviders() now prefers
  // it over DENSE_MODEL — code review fix). DENSE_MODEL remains a legacy
  // alias, consulted only when EMBED_MODEL is unset at every tier. Rather
  // than silently clearing DENSE_MODEL as a side effect of saving
  // EMBED_MODEL (which would be a surprising, hidden write the user never
  // asked for), EMBED_MODEL's entry carries an extra `shadowedBy` flag so
  // the UI can show the real effective value and warn the user explicitly
  // when a legacy DENSE_MODEL override is what's actually winning —
  // exactly the case where EMBED_MODEL itself is unset (source 'default')
  // but DENSE_MODEL has an explicit value at some tier.
  function annotateEmbedModelShadow(embedModelEntry, denseModelEntry) {
    const shadowed = embedModelEntry.configuredSource === SOURCES.DEFAULT
      && denseModelEntry.configuredSource !== SOURCES.DEFAULT;
    return {
      ...embedModelEntry,
      shadowedBy: shadowed ? { key: 'DENSE_MODEL', value: denseModelEntry.configuredValue, source: denseModelEntry.configuredSource } : null,
    };
  }

  // ASK_MODEL needs no per-key special-casing here (unlike EMBED_MODEL) —
  // its backend-aware default is resolved once, at the root, inside
  // resolveFromTiers() itself (see resolveAskModelDefault() above), so
  // buildStoredEntry(), frozenActive's construction-time snapshot, and
  // getActiveValue() all agree automatically without a second derivation
  // layer here.
  function buildEntry(def, byKeyEntries) {
    if (def.key === 'EMBEDDING_BACKEND') {
      return deriveEmbeddingBackendEntry(def);
    }
    if (def.key === 'EMBED_MODEL') {
      const embedModelEntry = byKeyEntries?.get('EMBED_MODEL') ?? buildStoredEntry(def);
      const denseModelEntry = byKeyEntries?.get('DENSE_MODEL') ?? buildStoredEntry(byKey.get('DENSE_MODEL'));
      return annotateEmbedModelShadow(embedModelEntry, denseModelEntry);
    }
    return buildStoredEntry(def);
  }

  return {
    getAll() {
      // Two passes: every stored (env-backed) definition builds its real
      // entry first, then derived definitions (currently EMBEDDING_BACKEND
      // and EMBED_MODEL's shadow annotation) resolve against that
      // already-built map — so a derived field's resolution never
      // re-derives its own driver from scratch, and always reflects that
      // SAME getAll() call's view of the driver (no risk of reading a
      // different resolution than what the rest of this same response
      // reports for DENSE_PROVIDER/DENSE_MODEL).
      const byKeyEntries = new Map();
      for (const def of keys) {
        if (def.key === 'EMBEDDING_BACKEND') continue;
        byKeyEntries.set(def.key, buildStoredEntry(def));
      }
      byKeyEntries.set('EMBED_MODEL', buildEntry(byKey.get('EMBED_MODEL'), byKeyEntries));
      return keys.map((def) => (
        def.key === 'EMBEDDING_BACKEND' ? buildEntry(def, byKeyEntries) : byKeyEntries.get(def.key)
      ));
    },

    get(key) {
      const def = byKey.get(key);
      if (!def) return null;
      return buildEntry(def);
    },

    getActiveValue(key) {
      const def = byKey.get(key);
      if (!def) throw new Error(`Unknown setting key: ${key}`);
      if (key === 'EMBEDDING_BACKEND') return buildEntry(def).activeValue;
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

    async setMany(rawChanges) {
      // EMBEDDING_BACKEND expansion pre-pass: never reaches def.validate/
      // writeSettingsFileAtomic as its own key — it is expanded into the
      // real DENSE_PROVIDER+SPARSE_PROVIDER pair it represents before any
      // other validation runs. This is what makes an invalid dense/sparse
      // combination structurally unreachable through this one control: the
      // only two values EMBEDDING_BACKEND accepts (its own validate())
      // each map to an already-valid pair from core/env.js's
      // VALID_PROVIDER_COMBOS.
      let changes = rawChanges;
      if (Object.prototype.hasOwnProperty.call(rawChanges, 'EMBEDDING_BACKEND')) {
        const backendValue = rawChanges.EMBEDDING_BACKEND;
        const expansion = EMBEDDING_BACKEND_EXPANSION[backendValue];
        if (!expansion) {
          const err = new Error('EMBEDDING_BACKEND must be "ollama", "bge-m3-onnx", or "qdrant-cloud".');
          err.code = 'invalid_value';
          err.invalidKey = 'EMBEDDING_BACKEND';
          throw err;
        }
        changes = { ...rawChanges, ...expansion };
        delete changes.EMBEDDING_BACKEND;
      }

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

      // Cross-field guard (code review fix, P1): DENSE_PROVIDER/SPARSE_PROVIDER
      // remain independently PATCHable by design (power users/scripts going
      // around the UI, which now only exposes EMBEDDING_BACKEND — see
      // definitions.js's uiHidden flag on both fields), but a direct PATCH
      // of either or both must not be allowed to produce an invalid
      // dense/sparse pair. Only runs when this batch actually touches one
      // of the two keys (every other PATCH is unaffected) — computes the
      // FINAL effective pair (not just the changed key in isolation) by
      // resolving through the same os_env/dotenv/config_json/default tiers
      // every other field uses, against `next` (the post-write
      // localSettings), so e.g. PATCHing only SPARSE_PROVIDER while
      // DENSE_PROVIDER is already bge-m3-onnx (unchanged, from an earlier
      // save) is still validated against the resulting pair, not just the
      // one key in this particular request.
      if (keysToChange.includes('DENSE_PROVIDER') || keysToChange.includes('SPARSE_PROVIDER')) {
        const effective = resolveEffectiveEmbeddingBackend((name) => {
          const rawOsEnv = osEnv[name];
          if (rawOsEnv !== undefined && rawOsEnv !== '') return rawOsEnv;
          const rawDotenv = dotenvValues[name];
          if (rawDotenv !== undefined && rawDotenv !== '') return rawDotenv;
          if (Object.prototype.hasOwnProperty.call(next, name)) return next[name];
          return undefined;
        });
        try {
          assertProviderCombo(effective.denseProvider, effective.sparseProvider);
        } catch (comboErr) {
          const err = new Error(comboErr.message);
          err.code = 'invalid_value';
          err.invalidKey = keysToChange.includes('DENSE_PROVIDER') ? 'DENSE_PROVIDER' : 'SPARSE_PROVIDER';
          throw err;
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
 * core/config.js's provider resolver uses the presence of DENSE_PROVIDER
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
