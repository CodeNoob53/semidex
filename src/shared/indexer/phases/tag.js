import { validateOllamaGenerateCapability } from '../../../core/generation/ollama-capability.js';

export function resolveTagModel(env = process.env) {
  return env.TAG_MODEL || env.CONTEXT_MODEL || 'gemma3:4b';
}

// let (not const): TAG_MODEL/CONTEXT_MODEL are next_index_job settings
// (core/settings/definitions.js) — re-resolved once via
// applyTagSettings() below, called by indexer/index.js at process startup.
// Mirrors chunk.js's applyChunkingSettings() pattern exactly.
let MODEL = resolveTagModel();

/**
 * Re-resolves MODEL from a SettingsService's TAG_MODEL/CONTEXT_MODEL
 * (same fallback order as resolveTagModel()). Call once, at indexer
 * process startup, before tagging any chunk.
 * @param {Object} settingsService
 */
export function applyTagSettings(settingsService) {
  MODEL = settingsService.getActiveValue('TAG_MODEL') || settingsService.getActiveValue('CONTEXT_MODEL') || 'gemma3:4b';
}

// Capability injection (Phase 8B Step 3 — instance-scoped, no module-scope
// setter) — see phases/context.js's own header comment for the full
// rationale; this module follows the exact same pattern (never imports
// local/core/ollama.js, not even indirectly through a *-lazy.js default; depends
// only on the narrow single-method OllamaGenerateCapability contract).
// Every exported function below takes its capability as opts.ollama — no
// module-scope binding exists for a concurrently constructed Full/Lite
// composition to contaminate. addTags()/addTagsBatch() are never reached
// in Lite (TAG_GEN=0 hard pin) regardless.

// Tags are optional navigation metadata. Generate them only when explicitly
// requested so normal indexing does not spend LLM time on payload-only tags.
export function shouldGenerateTags(env = process.env) {
  return env.TAG_GEN === '1';
}

function parseTags(raw) {
  return raw
    .split(',')
    .map(t => t.trim().toLowerCase().replace(/\s+/g, '-'))
    .filter(t => t.length > 1 && t.length < 40);
}

function existingTags(chunk) {
  const t = chunk.meta?.tags;
  return Array.isArray(t) ? t : t ? [t] : [];
}

/**
 * @param {Object} chunk
 * @param {string} model
 * @param {{ ollama: import('../../../core/generation/ollama-capability.js').OllamaGenerateCapability }} opts
 *   — required; no module-scope fallback exists.
 */
export async function addTagsWithModel(chunk, model, opts) {
  const prompt = `You are a document tagger. Generate 3-7 concise tags for this text chunk. Tags should describe the topic, technology, or concept. Use lowercase, hyphens for spaces (e.g. "node-js", "sql-join", "normalization"). Output only a comma-separated list of tags, nothing else.

File: ${chunk.source_file}
Section: ${chunk.section || 'unknown'}
Context: ${chunk.context || ''}

Text:
${chunk.text.slice(0, 800)}`;

  const ollama = opts?.ollama;
  if (!ollama) throw new Error('phases/tag.js: addTagsWithModel() requires opts.ollama (an OllamaGenerateCapability) — no module-scope capability exists to fall back to.');
  validateOllamaGenerateCapability(ollama);
  const raw = await ollama.generate(model, prompt);
  const tags = [...new Set([...existingTags(chunk), ...parseTags(raw)])];
  return { ...chunk, tags };
}

/**
 * @param {Object} chunk
 * @param {{ ollama: import('../../../core/generation/ollama-capability.js').OllamaGenerateCapability }} opts — required, see addTagsWithModel().
 */
export async function addTags(chunk, opts) {
  return addTagsWithModel(chunk, MODEL, opts);
}

export function extractJsonArray(raw, expectedLength) {
  const isValid = (parsed) =>
    Array.isArray(parsed) && parsed.length === expectedLength && parsed.every(Array.isArray);

  // Strip markdown code fences before parsing (Gemma often wraps output in ```json ... ```)
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  for (const candidate of [stripped, raw.trim()]) {
    try {
      const parsed = JSON.parse(candidate);
      if (isValid(parsed)) return parsed;
      // Gemma wraps in {"tags":[[...]],"tags2":[[...]],...} — collect all array values
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const vals = Object.values(parsed).filter(Array.isArray);
        const flat = [];
        for (const v of vals) {
          if (v.length > 0 && v.every(Array.isArray)) flat.push(...v);
          else if (v.length === 0 || v.every(s => typeof s === 'string')) flat.push(v);
        }
        if (flat.length === expectedLength) return flat;
      }
    } catch { /* try extraction */ }
  }

  const allArrays = [];
  for (const m of stripped.matchAll(/\[(?:[^\[\]]|\[(?:[^\[\]]|\[[^\[\]]*\])*\])*\]/g)) {
    try {
      const parsed = JSON.parse(m[0]);
      if (Array.isArray(parsed)) {
        if (isValid(parsed)) return parsed;
        if (parsed.every(Array.isArray)) allArrays.push(...parsed);
        else if (parsed.every(s => typeof s === 'string')) allArrays.push(parsed);
      }
    } catch { /* skip */ }
  }
  if (allArrays.length === expectedLength) return allArrays;
  return null;
}

/**
 * @param {Object[]} chunks
 * @param {{ ollama: import('../../../core/generation/ollama-capability.js').OllamaGenerateCapability }} opts — required, see addTagsWithModel().
 */
export async function addTagsBatch(chunks, opts) {
  if (chunks.length === 1) return [await addTags(chunks[0], opts)];

  const n = chunks.length;
  const example = Array.from({ length: n }, (_, i) => [`tag${i}a`, `tag${i}b`]);
  const items = chunks.map((c, i) => `CHUNK ${i}:\n${c.text.slice(0, 400)}`).join('\n\n');

  const prompt = `You are a document tagger. Generate 3-7 lowercase hyphenated tags for each chunk.
IMPORTANT: Output ONLY a JSON array of ${n} arrays, nothing else. No explanation, no markdown.
Example output for ${n} chunks: ${JSON.stringify(example)}

${items}

Output:`;

  const ollama = opts?.ollama;
  if (!ollama) throw new Error('phases/tag.js: addTagsBatch() requires opts.ollama (an OllamaGenerateCapability) — no module-scope capability exists to fall back to.');
  validateOllamaGenerateCapability(ollama);
  let result = null;
  let raw = null;
  try {
    raw = await ollama.generate(MODEL, prompt, { format: 'json' });
    result = extractJsonArray(raw, n);
  } catch { /* fall through */ }

  if (!result) {
    console.warn('  [tag] batch parse failed, falling back to individual');
    return Promise.all(chunks.map(chunk => addTags(chunk, opts)));
  }

  return chunks.map((chunk, i) => {
    const generated = (result[i] || [])
      .map(t => String(t).trim().toLowerCase().replace(/\s+/g, '-'))
      .filter(t => t.length > 1 && t.length < 40);
    const tags = [...new Set([...existingTags(chunk), ...generated])];
    return { ...chunk, tags };
  });
}
