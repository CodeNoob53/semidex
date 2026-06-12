import 'dotenv/config';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

// Cache: model name → /api/show response. Avoids repeated calls per process.
const _showCache = new Map();

async function showModel(model) {
  if (_showCache.has(model)) return _showCache.get(model);
  try {
    const r = await fetch(`${OLLAMA_URL}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) { _showCache.set(model, null); return null; }
    const data = await r.json();
    _showCache.set(model, data);
    return data;
  } catch {
    _showCache.set(model, null);
    return null;
  }
}

/**
 * Return the model's maximum context length.
 * Falls back to `fallback` (default 4096) when unreachable or field missing.
 */
export async function getModelContextLength(model, fallback = 4096) {
  const data = await showModel(model);
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
 */
export async function isThinkingModel(model) {
  const data = await showModel(model);
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
