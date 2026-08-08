import 'dotenv/config';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

// ── Reachability / model-list checks ────────────────────────────────────────
// Shared by the indexer's preflight (src/indexer/preflight.js) and the admin
// API's pre-job-start check (src/admin/api/jobs.js) — one place for "is
// Ollama up, and does it have the model we need", instead of two near-
// identical implementations drifting apart.

/**
 * True if Ollama responds to GET /api/version within timeoutMs.
 */
export async function isOllamaReachable(baseUrl = OLLAMA_URL, timeoutMs = 5000) {
  try {
    const r = await fetch(`${baseUrl.replace(/\/$/, '')}/api/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * List installed model names via GET /api/tags. Throws on a non-OK response
 * or network failure — callers that want a boolean should use
 * isOllamaReachable() first.
 */
export async function listOllamaModels(baseUrl = OLLAMA_URL, timeoutMs = 5000) {
  const r = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return (data.models ?? []).map((m) => m.name);
}

// required: string[] of model names needed (e.g. ['gemma3:4b', 'gemma3:4b'])
// available: string[] of model names returned by GET /api/tags (name field)
// Returns null if ok, or an array of missing model names (deduped).
// Exact match only — if you pull gemma3:4b, set CONTEXT_MODEL=gemma3:4b.
export function validateOllamaModels(required, available) {
  const availSet = new Set(available);
  const missing = [];
  for (const model of new Set(required)) {
    if (!availSet.has(model)) missing.push(model);
  }
  return missing.length ? missing : null;
}

// Cache: "baseUrl|model" → /api/show response. Avoids repeated calls per
// process. Keyed by baseUrl too (not just model) — two callers pointed at
// different Ollama instances (e.g. a GenerationProvider constructed with a
// non-default baseUrl) must not share a cache entry, and the request itself
// must go to that same baseUrl, not the module-level OLLAMA_URL default
// (code review finding: a custom-baseUrl provider's /api/show call was
// still hitting http://localhost:11434 regardless of its configured URL).
//
// Exported (not just used internally by getModelContextLength/
// isThinkingModel) so core/ollama-models.js's capability discovery can
// reuse this same cached /api/show call rather than re-implementing a
// second /api/show client (code review finding: an earlier version of
// ollama-models.js guessed capability from the model's name/family instead
// of reading Ollama's own authoritative `capabilities` array from this
// exact endpoint).
const _showCache = new Map();
const _embeddingDimensionCache = new Map();

export async function showModel(model, baseUrl = OLLAMA_URL, { forceRefresh = false } = {}) {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  const cacheKey = `${normalizedBaseUrl}|${model}`;
  if (!forceRefresh && _showCache.has(cacheKey)) return _showCache.get(cacheKey);
  try {
    const r = await fetch(`${normalizedBaseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    _showCache.set(cacheKey, data);
    return data;
  } catch {
    return null;
  }
}

/**
 * GET /api/ps and find the entry for `model` (loaded models only — a
 * model not currently resident in Ollama has no VRAM placement to
 * report). This is the same signal `ollama ps`'s own PROCESSOR column is
 * built from: size_vram close to 0 means CPU, close to size means GPU,
 * anything in between means a partial (mixed) offload. Never cached (a
 * model's VRAM placement can change between calls — unlike /api/show's
 * static model metadata) — callers that want a TTL cache own that
 * decision themselves, one layer up.
 * Returns null on any failure (network, non-OK, model not loaded,
 * malformed shape) — never throws. Callers must treat null as "cannot
 * verify," never as "verified CPU."
 * @param {string} model
 * @param {string} [baseUrl]
 * @returns {Promise<{ size: number, size_vram: number } | null>}
 */
export async function getRunningModel(model, baseUrl = OLLAMA_URL) {
  try {
    const r = await fetch(`${baseUrl.replace(/\/$/, '')}/api/ps`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const data = await r.json();
    const entry = (data.models ?? []).find((m) => m.name === model || m.model === model);
    if (!entry) return null;
    const size = Number(entry.size);
    const sizeVram = Number(entry.size_vram);
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(sizeVram) || sizeVram < 0) return null;
    return { size, size_vram: sizeVram };
  } catch {
    return null;
  }
}

/**
 * Read the text embedding dimension from Ollama's /api/show payload.
 * Only embedding-capable models are accepted: generation models also expose
 * an architecture embedding_length, but that hidden-state width is not a
 * promise that /api/embed is supported.
 */
export function embeddingDimensionFromShow(data) {
  if (!Array.isArray(data?.capabilities) || !data.capabilities.includes('embedding')) return null;
  const info = data.model_info ?? {};
  const architecture = info['general.architecture'];
  const preferred = architecture ? Number(info[`${architecture}.embedding_length`]) : NaN;
  if (Number.isInteger(preferred) && preferred > 0) return preferred;

  const candidates = Object.entries(info)
    .filter(([key]) => key.endsWith('.embedding_length')
      && !key.includes('.vision.')
      && !key.includes('.audio.')
      && !key.includes('embedding_length_per_'))
    .map(([, value]) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Resolve the actual output dimension for an Ollama embedding model before
 * creating a Qdrant collection. /api/show is cheap and normally sufficient;
 * the one-vector /api/embed probe is the authoritative fallback for older or
 * incomplete model metadata.
 */
export async function getOllamaEmbeddingDimension(
  model,
  baseUrl = OLLAMA_URL,
  { allowProbe = true, forceRefresh = false } = {}
) {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  const cacheKey = `${normalizedBaseUrl}|${model}`;
  if (!forceRefresh && _embeddingDimensionCache.has(cacheKey)) {
    return _embeddingDimensionCache.get(cacheKey);
  }

  const shown = await showModel(model, normalizedBaseUrl, { forceRefresh });
  const metadataDimension = embeddingDimensionFromShow(shown);
  if (metadataDimension) {
    _embeddingDimensionCache.set(cacheKey, metadataDimension);
    return metadataDimension;
  }
  if (!allowProbe) return null;

  try {
    const response = await fetch(`${normalizedBaseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: 'semidex embedding dimension probe', truncate: true }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const dimension = data?.embeddings?.[0]?.length;
    if (!Number.isInteger(dimension) || dimension <= 0) return null;
    _embeddingDimensionCache.set(cacheKey, dimension);
    return dimension;
  } catch {
    return null;
  }
}

/**
 * Return the model's MAXIMUM (architectural) context length, from
 * model_info.*.context_length via /api/show. This is NOT the same as the
 * context length Ollama will actually allocate for a given request — that
 * is controlled entirely by the request's own `options.num_ctx` (Ollama
 * defaults to a much smaller runtime window, commonly 4096, when num_ctx is
 * left unset, regardless of how large the model's architectural maximum
 * is). Callers that need requests to actually use a specific context size
 * must pass that same size as `options.num_ctx` on the generation request —
 * this function only tells you the model's ceiling, not what will happen
 * to an unbounded request.
 * Falls back to `fallback` (default 4096) when unreachable or field missing.
 * @param {string} model
 * @param {number} [fallback]
 * @param {string} [baseUrl] — defaults to the module-level OLLAMA_URL;
 *   pass explicitly to query a non-default Ollama instance.
 */
export async function getModelContextLength(model, fallback = 4096, baseUrl = OLLAMA_URL) {
  const data = await showModel(model, baseUrl);
  if (!data) return fallback;
  const info  = data.model_info ?? {};
  const entry = Object.entries(info).find(([k]) => k.endsWith('.context_length'));
  const val   = entry ? Number(entry[1]) : NaN;
  return Number.isFinite(val) && val > 0 ? val : fallback;
}

/**
 * Return true if the model has the "thinking" capability (e.g. gemma4, qwq).
 * Thinking models generate a <think> block before their answer — num_predict
 * must not be capped or the response is truncated before the actual answer.
 * @param {string} model
 * @param {string} [baseUrl]
 */
export async function isThinkingModel(model, baseUrl = OLLAMA_URL) {
  const data = await showModel(model, baseUrl);
  return Array.isArray(data?.capabilities) && data.capabilities.includes('thinking');
}

export async function embed(text, model) {
  const r = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text.slice(0, 8000) }),
  });
  if (!r.ok) throw new Error(`Ollama embed failed: ${await r.text()}`);
  const data = await r.json();
  return data.embeddings[0];
}

export async function generate(model, prompt, { format, options } = {}) {
  const body = { model, prompt, stream: false };
  if (format) body.format = format;
  if (options) body.options = options;
  const r = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Ollama generate failed: ${await r.text()}`);
  const data = await r.json();
  return data.response;
}

/**
 * Streaming generation over POST /api/generate (stream: true — Ollama emits
 * newline-delimited JSON objects, one per token/chunk, terminated by an
 * object with done: true carrying prompt_eval_count/eval_count). Shares
 * OLLAMA_URL and the same request/error shape as generate() above — this is
 * the one place either the sync or streaming Ollama call touches the
 * network, so src/core/generation/ollama-provider.js calls this instead of
 * re-deriving the base URL or re-implementing NDJSON parsing.
 *
 * @param {string} model
 * @param {string} prompt
 * @param {{ system?: string, baseUrl?: string, format?: string, options?: Object, signal?: AbortSignal, onToken?: (token: string) => void }} [opts]
 *   baseUrl defaults to the module-level OLLAMA_URL — pass it explicitly to
 *   target a different Ollama instance than the process-wide default (e.g.
 *   a GenerationProvider constructed with a non-default baseUrl). `system`
 *   maps directly onto Ollama's own top-level `system` request field — its
 *   NATIVE system-instruction transport, entirely separate from `prompt` —
 *   and is omitted from the request body altogether when not supplied
 *   (never sent as an empty string, never prepended to `prompt`).
 * @returns {Promise<{ text: string, tokensIn?: number, tokensOut?: number, aborted?: boolean }>}
 */
export async function generateStream(model, prompt, { system, baseUrl = OLLAMA_URL, format, options, signal, onToken } = {}) {
  const body = { model, prompt, stream: true };
  if (system) body.system = system;
  if (format) body.format = format;
  if (options) body.options = options;

  let r;
  try {
    r = await fetch(`${baseUrl.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) return { text: '', aborted: true };
    throw new Error(`Ollama generate (stream) failed: ${err.message}`);
  }
  if (!r.ok) throw new Error(`Ollama generate (stream) failed: ${await r.text()}`);

  let text = '';
  let tokensIn;
  let tokensOut;
  let buffer = '';
  // fetch()'s r.body yields Uint8Array chunks (a web ReadableStream), not
  // Node Buffers — string-concatenating a Uint8Array directly calls its
  // default toString(), which produces a comma-separated byte-value list,
  // not UTF-8 text. A TextDecoder is required regardless of chunk type;
  // stream: true across decode() calls handles a multi-byte UTF-8
  // character split across two chunks correctly.
  const decoder = new TextDecoder('utf-8');
  try {
    for await (const chunk of r.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        const evt = JSON.parse(line);
        if (evt.response) {
          text += evt.response;
          // Awaited deliberately: onToken may return a backpressure promise
          // (the SSE layer awaits res.write()'s drain event before resolving)
          // — not awaiting it here let a slow client's socket buffer grow
          // unbounded while this loop kept reading and parsing frames from
          // Ollama as fast as the model produced them (code review finding).
          await onToken?.(evt.response);
        }
        if (evt.done) {
          tokensIn = evt.prompt_eval_count;
          tokensOut = evt.eval_count;
        }
      }
    }
  } catch (err) {
    if (signal?.aborted) return { text, tokensIn, tokensOut, aborted: true };
    throw new Error(`Ollama generate (stream) failed while reading response: ${err.message}`);
  }

  return { text, tokensIn, tokensOut, aborted: false };
}
