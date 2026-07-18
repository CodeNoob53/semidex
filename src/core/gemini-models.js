// Gemini generation-model discovery — mirrors ollama-models.js's shape and
// contract so admin/api/generation-models.js can present both backends
// through one provider-neutral response (Stage B1). No process.env
// reads — apiKey/createClientFn arrive from the caller.
//
// Reports the real API capability field (models.list()'s supportedActions),
// never capabilities guessed from name/family heuristics. The shared admin
// UI filters this provider-neutral result for the capability required by a
// particular setting.
const DEFAULT_PAGE_SIZE = 100;

// A short, in-process cache — avoids repeating a full paginated
// models.list() walk (a real network round trip per page) on every
// Settings UI category render. Keyed by apiKey so a key change never
// serves another key's cached list. Not persisted, not shared across
// admin server restarts — this is a request-debounce, not a durable store.
const CACHE_TTL_MS = 60_000;
const cache = new Map(); // apiKey -> { at: number, result: Object }

function redact(message, apiKey) {
  if (!message) return message;
  let out = String(message);
  if (apiKey) out = out.split(apiKey).join('[REDACTED]');
  return out;
}

// The real API returns resource names ("models/gemini-2.5-flash" — see
// Model.name's own doc comment: "Resource name of the model."), but
// generateContentStream()/models.get() both accept the bare form too
// (verified directly: both error identically on an invalid key regardless
// of which form is passed), and every bare name this codebase already
// uses — DEFAULT_MODEL_BY_BACKEND.gemini, the Settings UI's configured/
// default value comparisons, ASK_MODEL's stored value — is bare. Without
// normalizing here, a freshly-installed default model would render as
// "(not installed)" in the Settings UI purely because discovery's
// "models/gemini-2.5-flash" never string-equals the configured
// "gemini-2.5-flash" (code review finding, confirmed live against the
// real API response shape). Stripping the prefix at this one adapter
// boundary — not scattered across every comparison site — keeps the rest
// of the codebase's bare-name assumption correct.
function normalizeModelName(name) {
  return typeof name === 'string' ? name.replace(/^models\//, '') : name;
}

/**
 * @param {{
 *   apiKey?: string,
 *   createClientFn?: (opts: { apiKey: string }) => Object,
 *   forceRefresh?: boolean,
 * }} [opts] createClientFn is DI-only (tests stub the SDK; production
 *   callers never pass it, so the real @google/genai client is always
 *   constructed).
 * @returns {Promise<{available: boolean, reason: string|null, models: Array<{
 *   name: string,
 *   capabilities: string[]|null,
 *   embeddingDimension: null,
 *   parameterSize: null,
 *   family: null,
 *   inputTokenLimit: number|null,
 * }>}>}
 */
export async function discoverGeminiModels({ apiKey = '', createClientFn, forceRefresh = false } = {}) {
  if (!apiKey) {
    return { available: false, reason: 'GEMINI_API_KEY is not set. Model discovery is unavailable until it is configured.', models: [] };
  }

  if (!forceRefresh) {
    const cached = cache.get(apiKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;
  }

  let client;
  try {
    if (createClientFn) {
      client = createClientFn({ apiKey });
    } else {
      const { GoogleGenAI } = await import('@google/genai');
      client = new GoogleGenAI({ apiKey });
    }
  } catch (err) {
    return { available: false, reason: `Failed to initialize the Gemini client: ${redact(err.message, apiKey)}`, models: [] };
  }

  const models = [];
  try {
    let pager = await client.models.list({ config: { pageSize: DEFAULT_PAGE_SIZE } });
    // Pager is an async-iterable page cursor (per @google/genai's
    // documented Promise<Pager<Model>> return type) — iterate every page
    // it yields, not just the first, so a key with more installed/enabled
    // models than one page doesn't silently truncate.
    for await (const model of pager) {
      const supportedActions = Array.isArray(model?.supportedActions) ? model.supportedActions : null;
      // Real-API-capability filtering, not a name heuristic: a model is
      // generation-capable only if the API itself says so via
      // supportedActions including 'generateContent'. A model missing this
      // field entirely is reported as capabilities:null (unverified),
      // mirroring ollama-models.js's identical "never guess" rule — never
      // silently excluded, never silently assumed supported.
      models.push({
        name: normalizeModelName(model?.name) ?? '',
        capabilities: supportedActions,
        embeddingDimension: null,
        parameterSize: null,
        family: null,
        inputTokenLimit: typeof model?.inputTokenLimit === 'number' ? model.inputTokenLimit : null,
      });
    }
  } catch (err) {
    return { available: false, reason: `Failed to list Gemini models: ${redact(err.message, apiKey)}`, models: [] };
  }

  const result = { available: true, reason: null, models };
  cache.set(apiKey, { at: Date.now(), result });
  return result;
}
