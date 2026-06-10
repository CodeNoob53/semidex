import 'dotenv/config';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

// Cache: model name → context length (tokens). Avoids repeated /api/show calls
// within a single indexer run. Cleared only on process restart.
const _ctxCache = new Map();

/**
 * Return the model's maximum context length by reading model_info from Ollama.
 * Falls back to `fallback` (default 4096) when unreachable or field missing.
 * Result is cached per model name for the lifetime of the process.
 *
 * Why this matters: Ollama defaults to 4096 tokens regardless of the model's
 * architecture limit unless `num_ctx` is passed in the request options. A
 * gemma3:4b that supports 128k will still truncate at 4096 without this.
 */
export async function getModelContextLength(model, fallback = 4096) {
  if (_ctxCache.has(model)) return _ctxCache.get(model);
  try {
    const r = await fetch(`${OLLAMA_URL}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) { _ctxCache.set(model, fallback); return fallback; }
    const data = await r.json();
    const info = data.model_info ?? {};
    // Field name varies by architecture: gemma3.context_length, llama.context_length, etc.
    const entry = Object.entries(info).find(([k]) => k.endsWith('.context_length'));
    const val = entry ? Number(entry[1]) : NaN;
    const ctx = Number.isFinite(val) && val > 0 ? val : fallback;
    _ctxCache.set(model, ctx);
    return ctx;
  } catch {
    _ctxCache.set(model, fallback);
    return fallback;
  }
}

export async function embed(text, model) {
  const r = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text.slice(0, 8000) }),
    // Note: input is truncated to 8000 chars (not tokens) — long chunks lose their tail.
  });
  if (!r.ok) throw new Error(`Ollama embed failed: ${await r.text()}`);
  const data = await r.json();
  return data.embeddings[0];
}

export async function generate(model, prompt, { format, options } = {}) {
  const body = { model, prompt, stream: false };
  if (format) body.format = format;
  if (options) body.options = options;  // e.g. { temperature, num_predict }
  const r = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Ollama generate failed: ${await r.text()}`);
  const data = await r.json();
  return data.response;
}
