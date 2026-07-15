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

export const SUPPORTED_BACKENDS = Object.freeze(['ollama']);
export const SUPPORTED_DEVICE_POLICIES = Object.freeze(['auto']);

export const DEFAULTS = Object.freeze({
  backend: 'ollama',
  model: 'gemma3:4b',
  baseUrl: 'http://localhost:11434',
  numCtx: 8192,
  devicePolicy: 'auto',
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

  const model = resolveWithFallbackChain(['ASK_MODEL', 'CONTEXT_MODEL'], { osEnv, dotenvValues, defaultValue: merged.model });

  const baseUrl = resolveField('OLLAMA_URL', { osEnv, dotenvValues, defaultValue: merged.baseUrl });

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

  const devicePolicy = resolveField('GENERATION_DEVICE', { osEnv, dotenvValues, defaultValue: merged.devicePolicy });
  if (!SUPPORTED_DEVICE_POLICIES.includes(devicePolicy.value)) {
    throw new GenerationConfigError(
      'devicePolicy',
      `Unsupported GENERATION_DEVICE="${devicePolicy.value}". The "${backend.value}" backend currently only supports: ${SUPPORTED_DEVICE_POLICIES.join(', ')}.`,
      devicePolicy.value
    );
  }

  return { backend, model, baseUrl, numCtx, devicePolicy };
}
