// Generation runtime service (Phase 4A.5a) — the one backend-neutral object
// that sits above a concrete GenerationProvider. Owns: resolving runtime
// configuration (resolveGenerationRuntimeConfig), constructing the active
// provider through the registry, and exposing both (a) the
// GenerationProvider contract itself, so AskCoordinator needs no
// provider-specific or runtime-specific branches, and (b) a safe public
// status for GET /api/generation/status.
//
// Invalid configuration (unknown backend, bad ASK_NUM_CTX, unsupported
// device policy) is captured at construction time and represented as a
// permanently-not-ready provider — ready() resolves { ok: false, reason }
// instead of throwing, so a misconfigured .env never prevents the admin
// dashboard from starting or crashes createApp(). generate() on an invalid
// runtime rejects clearly rather than attempting a request with unresolved
// config.
import { resolveGenerationRuntimeConfig, GenerationConfigError, SUPPORTED_DEVICE_POLICIES } from './config.js';
import { createGenerationProvider } from './registry.js';
import { redactUrl } from '../../shared/core/doctor-checks.js';

// Generation settings (ASK_MODEL/OLLAMA_URL/ASK_NUM_CTX/GENERATION_DEVICE)
// are tagged `next_restart` in core/settings/definitions.js — when a
// SettingsService is supplied, it becomes the sole resolver for these
// fields (it already implements the identical os_env > dotenv >
// config_json > default chain, plus the next_restart freezing this runtime
// itself needs), so config.js's pure algorithm is not duplicated or
// forked. Falls back to config.js's own os_env > dotenv > default
// resolution when no settingsService is supplied (existing behavior,
// unchanged for any caller that doesn't pass one).
//
// geminiApiKey is DELIBERATELY ABSENT from this map — GEMINI_API_KEY must
// never be persisted to settings.json (task requirement), so it is never
// eligible for the config_json tier here. It only ever resolves through
// config.js's own os_env > dotenv > default chain, straight from
// resolveGenerationRuntimeConfig() below, regardless of whether a
// settingsService is supplied.
const GENERATION_SETTINGS_KEYS = Object.freeze({
  backend: 'SEMIDEX_GENERATION_BACKEND', model: 'ASK_MODEL', baseUrl: 'OLLAMA_URL',
  numCtx: 'ASK_NUM_CTX', devicePolicy: 'GENERATION_DEVICE',
});

// Builds the options object passed to the registry's per-backend factory —
// each backend receives ONLY the fields its own provider constructor
// actually reads (ollama-provider.js never sees apiKey; gemini-provider.js
// never sees baseUrl), so neither provider can accidentally branch on or
// be confused by the other backend's fields.
function buildProviderOptions(config) {
  if (config.backend.value === 'gemini') {
    return { apiKey: config.geminiApiKey.value, model: config.model.value, askNumCtx: config.numCtx.value };
  }
  return { model: config.model.value, baseUrl: config.baseUrl.value, askNumCtx: config.numCtx.value };
}

function applySettingsServiceTier(config, settingsService) {
  if (!settingsService) return config;
  const merged = { ...config };
  for (const [field, key] of Object.entries(GENERATION_SETTINGS_KEYS)) {
    const entry = settingsService.get(key);
    if (!entry) continue;
    // SettingsService owns the complete precedence chain and next-restart
    // snapshot. Taking only config_json values loses derived defaults, such
    // as a provider-aware Gemini default when the backend itself came from
    // settings.json.
    merged[field] = {
      value: entry.activeValue,
      source: entry.activeSource ?? entry.source,
    };
  }
  return merged;
}

/**
 * @param {{
 *   osEnv?: Record<string, string>,
 *   dotenvValues?: Record<string, string>,
 *   defaults?: Object,
 *   settingsService?: ReturnType<typeof import('../settings/service.js').createSettingsService>,
 *   createGenerationProviderFn?: typeof createGenerationProvider,
 * }} [opts] osEnv/dotenvValues default to empty objects (NOT process.env) —
 *   the caller (the admin bootstrap) is responsible for supplying the real
 *   snapshots explicitly, so this module never reads process.env itself and
 *   stays trivially testable/importable without touching the real
 *   environment.
 * @returns {import('./provider.js').GenerationProvider & {
 *   getStatus: () => Promise<Object>,
 *   getConfig: () => Object,
 * }}
 */
export function createGenerationRuntime({
  osEnv = {}, dotenvValues = {}, defaults = {}, settingsService, createGenerationProviderFn = createGenerationProvider,
} = {}) {
  let config = null;
  let configError = null;
  let provider = null;

  try {
    config = applySettingsServiceTier(
      resolveGenerationRuntimeConfig({ osEnv, dotenvValues, defaults }),
      settingsService
    );
    provider = createGenerationProviderFn({
      backend: config.backend.value,
      options: buildProviderOptions(config),
    });
  } catch (err) {
    // A GenerationConfigError (invalid user input) and an unknown-backend
    // Error from the registry are both configuration problems, not runtime
    // crashes — represented identically as a not-ready runtime. Any other
    // unexpected throw here is a real bug and should NOT be swallowed
    // (fail loudly at construction rather than quietly pretend to be a
    // config error), so it re-throws.
    if (err instanceof GenerationConfigError || /unknown backend/.test(err.message ?? '')) {
      configError = err;
    } else {
      throw err;
    }
  }

  const backendName = config?.backend.value ?? (configError?.field === 'backend' ? configError.value : undefined);

  return {
    name: () => provider?.name() ?? backendName ?? 'unknown',

    capabilities: () => provider?.capabilities() ?? { streaming: false, clientAbort: false, upstreamCancellation: false },

    async ready() {
      if (configError) return { ok: false, reason: configError.message };
      return provider.ready();
    },

    async generate(opts) {
      if (configError) {
        throw new Error(`Generation runtime is not configured correctly: ${configError.message}`);
      }
      return provider.generate(opts);
    },

    /**
     * Resolved configuration with provenance, independent of provider
     * readiness — used by the status endpoint's `configuration` block.
     * Available even when the runtime is not ready (e.g. a bad
     * ASK_NUM_CTX), except for the one field that was itself invalid,
     * which is only knowable from configError.
     */
    getConfig() {
      return config;
    },

    /**
     * @returns {Promise<{
     *   backend: string, model: string|null, ready: boolean, reason: string|null,
     *   numCtx: number|null, capabilities: Object,
     *   devicePolicy: { value: string, supported: string[] },
     *   configuration: Object|null,
     * }>}
     * Safe-by-construction: baseUrl is reported only as `display`, always
     * passed through redactUrl() (protocol+host+port only — credentials,
     * path, and query string are stripped) before it ever leaves this
     * function. A prior version of this method skipped that step and
     * returned config.baseUrl.value verbatim — confirmed live to leak
     * embedded credentials, a path, and a `?token=...` query string
     * straight into the JSON response (code review finding). No other
     * resolved field (backend/model/numCtx/devicePolicy) is URL- or
     * secret-shaped, so baseUrl is the only one that needs this treatment;
     * this also avoids ever echoing a full env object or unrelated fields.
     * geminiApiKey.configured is a boolean derived from whether the
     * resolved value is non-empty — the key's actual value never appears
     * anywhere in this return object.
     */
    async getStatus() {
      if (configError) {
        return {
          backend: backendName ?? null,
          model: null,
          ready: false,
          reason: configError.message,
          numCtx: null,
          capabilities: { streaming: false, clientAbort: false, upstreamCancellation: false },
          devicePolicy: { value: null, supported: [...SUPPORTED_DEVICE_POLICIES] },
          configuration: null,
        };
      }

      const readiness = await provider.ready();
      return {
        backend: config.backend.value,
        model: readiness.model ?? config.model.value,
        ready: readiness.ok,
        reason: readiness.ok ? null : (readiness.reason ?? null),
        numCtx: readiness.ok ? (readiness.numCtx ?? null) : null,
        capabilities: provider.capabilities(),
        devicePolicy: { value: config.devicePolicy.value, supported: [...SUPPORTED_DEVICE_POLICIES] },
        configuration: {
          backend: { source: config.backend.source },
          model: { source: config.model.source },
          // baseUrl/devicePolicy are Ollama-only concepts (a cloud API has
          // no local URL to reach and no local accelerator to pick) — only
          // included when that's the active backend, per the task's "show
          // Ollama URL only for Ollama" / "hide local generation device
          // controls for Gemini" requirements. geminiApiKey is the mirror
          // image: only included for the gemini backend, and NEVER carries
          // the actual key value — only { configured: boolean, source }.
          ...(config.backend.value === 'ollama'
            ? {
                baseUrl: { source: config.baseUrl.source, display: redactUrl(config.baseUrl.value) },
                devicePolicy: { source: config.devicePolicy.source },
              }
            : {
                geminiApiKey: { configured: config.geminiApiKey.value !== '', source: config.geminiApiKey.source },
              }),
          numCtx: { source: config.numCtx.source },
        },
      };
    },
  };
}
