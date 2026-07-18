// Pure generation runtime configuration resolver (Phase 4A.5a). No I/O, no
// process.env reads — every input is passed in explicitly, so provenance
// (which layer supplied each value) is known by construction instead of
// inferred by diffing an already-mutated process.env against a .env file
// (unreliable: once dotenv has populated process.env, an OS-env key and a
// .env key with the same name are indistinguishable after the fact).
//
// Precedence per field: osEnv > dotenvValues > default. Every resolved
// field carries { value, source } so a status endpoint (or future Settings
// UI) can honestly show WHERE a setting came from, never just what its
// current value is.

export const SOURCES = Object.freeze({
  OS_ENV: 'os_env',
  DOTENV: 'dotenv',
  DEFAULT: 'default',
});

export const SUPPORTED_BACKENDS = Object.freeze(['ollama', 'gemini']);
export const SUPPORTED_DEVICE_POLICIES = Object.freeze(['auto']);

// Per-backend default model. Switching SEMIDEX_GENERATION_BACKEND must
// never silently reuse the other backend's model name (an Ollama model
// name like "gemma3:4b" is not a valid Gemini model, and vice versa) — see
// resolveGenerationRuntimeConfig()'s model resolution below, which picks
// the default from this map keyed by the RESOLVED backend, not a single
// flat default.
//
// Exported so core/settings/service.js's ASK_MODEL resolution (the
// Settings UI/API's "configuredValue when nothing is set" case) can share
// this EXACT map — a second, independently-maintained default (e.g. a flat
// stringField default in definitions.js) previously let the Settings API
// report ASK_MODEL=gemma3:4b under SEMIDEX_GENERATION_BACKEND=gemini while
// this runtime resolved gemini-2.5-flash for the same unset state (code
// review finding — confirmed live via createSettingsService() vs
// createGenerationRuntime() disagreeing on the same osEnv). There must be
// exactly one provider-aware default resolver, not two.
export const DEFAULT_MODEL_BY_BACKEND = Object.freeze({
  ollama: 'gemma3:4b',
  gemini: 'gemini-2.5-flash',
});

export const DEFAULTS = Object.freeze({
  backend: 'ollama',
  model: DEFAULT_MODEL_BY_BACKEND.ollama,
  baseUrl: 'http://localhost:11434',
  numCtx: 8192,
  devicePolicy: 'auto',
  geminiApiKey: '',
});

// Documented bound for ASK_NUM_CTX — generous enough for any locally-run
// model's realistic context window, small enough to reject an obvious typo
// (e.g. a stray extra digit) before it reaches a provider request.
export const NUM_CTX_MIN = 256;
export const NUM_CTX_MAX = 1_000_000;

export class GenerationConfigError extends Error {
  constructor(field, message, value) {
    super(message);
    this.field = field;
    this.value = value; // the raw, invalid value that was supplied — lets callers (e.g. the status endpoint) report it without re-parsing the message
  }
}

function resolveField(key, { osEnv, dotenvValues, defaultValue }) {
  if (osEnv[key] !== undefined && osEnv[key] !== '') {
    return { value: osEnv[key], source: SOURCES.OS_ENV };
  }
  if (dotenvValues[key] !== undefined && dotenvValues[key] !== '') {
    return { value: dotenvValues[key], source: SOURCES.DOTENV };
  }
  return { value: defaultValue, source: SOURCES.DEFAULT };
}

function resolveWithFallbackChain(keys, { osEnv, dotenvValues, defaultValue }) {
  // Layer-first, not key-first: EVERY key is checked at OS-env layer before
  // ANY key is checked at dotenv layer. This means an OS-env CONTEXT_MODEL
  // beats a .env-only ASK_MODEL — the documented "OS env > .env > default"
  // precedence governs across all candidate keys, and "ASK_MODEL falls back
  // to CONTEXT_MODEL" only decides which NAME wins within a single layer
  // (code review finding — an earlier version of this comment claimed
  // ASK_MODEL wins "regardless of which layer either one was set in", which
  // is exactly backwards from the two loops below and was never true; see
  // config.test.js's "layer precedence... governs across all candidate
  // keys" test for the pinned behavior). A bare CONTEXT_MODEL (no ASK_MODEL
  // anywhere) still resolves with its own real provenance rather than being
  // silently reported as a "default".
  for (const key of keys) {
    if (osEnv[key] !== undefined && osEnv[key] !== '') return { value: osEnv[key], source: SOURCES.OS_ENV };
  }
  for (const key of keys) {
    if (dotenvValues[key] !== undefined && dotenvValues[key] !== '') return { value: dotenvValues[key], source: SOURCES.DOTENV };
  }
  return { value: defaultValue, source: SOURCES.DEFAULT };
}

/**
 * @param {{
 *   osEnv: Record<string, string>,
 *   dotenvValues: Record<string, string>,
 *   defaults?: Partial<typeof DEFAULTS>,
 * }} opts
 * @returns {{
 *   backend: { value: string, source: string },
 *   model: { value: string, source: string },
 *   baseUrl: { value: string, source: string },
 *   numCtx: { value: number, source: string },
 *   devicePolicy: { value: string, source: string },
 *   geminiApiKey: { value: string, source: string },
 * }}
 * @throws {GenerationConfigError} when the caller explicitly supplied an
 *   invalid value (unknown backend, out-of-bounds/non-integer ASK_NUM_CTX,
 *   unsupported device policy) — never silently falls back to a default in
 *   that case, since a wrong-but-accepted value is worse than a clear error.
 */
export function resolveGenerationRuntimeConfig({ osEnv, dotenvValues, defaults = {} }) {
  const merged = { ...DEFAULTS, ...defaults };

  const backend = resolveField('SEMIDEX_GENERATION_BACKEND', { osEnv, dotenvValues, defaultValue: merged.backend });
  if (!SUPPORTED_BACKENDS.includes(backend.value)) {
    throw new GenerationConfigError(
      'backend',
      `Unknown generation backend "${backend.value}" (SEMIDEX_GENERATION_BACKEND). Supported: ${SUPPORTED_BACKENDS.join(', ')}.`,
      backend.value
    );
  }

  // CONTEXT_MODEL is a legacy Ollama-only fallback name — it must never be
  // picked up for the Gemini backend (an Ollama model name silently passing
  // as a Gemini model would be exactly the "silently reuse
  // CONTEXT_MODEL=gemma3:4b" failure mode this task explicitly forbids).
  // ASK_MODEL itself is backend-neutral and always honored regardless of
  // backend. When neither is set, the default is looked up by the RESOLVED
  // backend (DEFAULT_MODEL_BY_BACKEND), not a single flat default — so
  // switching backend with no explicit ASK_MODEL set never carries the old
  // backend's default model name forward.
  const modelKeys = backend.value === 'ollama' ? ['ASK_MODEL', 'CONTEXT_MODEL'] : ['ASK_MODEL'];
  // defaults.model (an explicit caller override, e.g. a test) always wins;
  // otherwise the default is looked up by the RESOLVED backend, never the
  // flat merged.model (which is only ever Ollama's default).
  const modelDefault = defaults.model ?? DEFAULT_MODEL_BY_BACKEND[backend.value] ?? merged.model;
  const model = resolveWithFallbackChain(modelKeys, { osEnv, dotenvValues, defaultValue: modelDefault });

  const baseUrl = resolveField('OLLAMA_URL', { osEnv, dotenvValues, defaultValue: merged.baseUrl });

  // GEMINI_API_KEY is environment-only by design (task requirement: "must
  // never be persisted to settings.json") — resolved with the same OS env >
  // .env > default precedence as every other field here, but
  // applySettingsServiceTier() in runtime.js deliberately excludes this key
  // from its settings-service tier (see GENERATION_SETTINGS_KEYS there), so
  // a config_json value can never surface even if one somehow existed.
  const geminiApiKey = resolveField('GEMINI_API_KEY', { osEnv, dotenvValues, defaultValue: merged.geminiApiKey });

  const numCtxRaw = resolveField('ASK_NUM_CTX', { osEnv, dotenvValues, defaultValue: String(merged.numCtx) });
  const numCtxNum = Number(numCtxRaw.value);
  if (!Number.isInteger(numCtxNum) || numCtxNum < NUM_CTX_MIN || numCtxNum > NUM_CTX_MAX) {
    if (numCtxRaw.source === SOURCES.DEFAULT) {
      // The built-in default itself must always be valid — this branch only
      // fires if DEFAULTS/defaults was misconfigured by a caller, not by
      // user input, so it is a programming error, not a user-facing config
      // error.
      throw new Error(`resolveGenerationRuntimeConfig: default numCtx "${numCtxRaw.value}" is invalid — this is a bug, not user input.`);
    }
    throw new GenerationConfigError(
      'numCtx',
      `Invalid ASK_NUM_CTX="${numCtxRaw.value}" — must be an integer between ${NUM_CTX_MIN} and ${NUM_CTX_MAX}.`,
      numCtxRaw.value
    );
  }
  const numCtx = { value: numCtxNum, source: numCtxRaw.source };

  // GENERATION_DEVICE is a local-inference concept (which local accelerator
  // Ollama should use) — it has no meaning for a cloud API like Gemini, so
  // it is validated only for the ollama backend. Gemini's resolved
  // devicePolicy is reported as-is (value/source still resolved normally,
  // for provenance display) but never rejected for being "unsupported",
  // since the concept doesn't apply rather than being misconfigured.
  const devicePolicy = resolveField('GENERATION_DEVICE', { osEnv, dotenvValues, defaultValue: merged.devicePolicy });
  if (backend.value === 'ollama' && !SUPPORTED_DEVICE_POLICIES.includes(devicePolicy.value)) {
    throw new GenerationConfigError(
      'devicePolicy',
      `Unsupported GENERATION_DEVICE="${devicePolicy.value}". The "${backend.value}" backend currently only supports: ${SUPPORTED_DEVICE_POLICIES.join(', ')}.`,
      devicePolicy.value
    );
  }

  return { backend, model, baseUrl, numCtx, devicePolicy, geminiApiKey };
}
