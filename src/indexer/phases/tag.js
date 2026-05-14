import { generate } from '../../core/ollama.js';

const MODEL = process.env.TAG_MODEL || 'gemma3';

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

export async function addTags(chunk) {
  const prompt = `You are a document tagger. Generate 3-7 concise tags for this text chunk. Tags should describe the topic, technology, or concept. Use lowercase, hyphens for spaces (e.g. "node-js", "sql-join", "normalization"). Output only a comma-separated list of tags, nothing else.

File: ${chunk.source_file}
Section: ${chunk.section || 'unknown'}
Context: ${chunk.context || ''}

Text:
${chunk.text.slice(0, 800)}`;

  const raw = await generate(MODEL, prompt);
  const tags = [...new Set([...existingTags(chunk), ...parseTags(raw)])];
  return { ...chunk, tags };
}

function extractJsonArray(raw, expectedLength) {
  const isValid = (parsed) =>
    Array.isArray(parsed) && parsed.length === expectedLength && parsed.every(Array.isArray);

  // Strip markdown code fences before parsing (Gemma often wraps output in ```json ... ```)
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  for (const candidate of [stripped, raw.trim()]) {
    try {
      const parsed = JSON.parse(candidate);
      if (isValid(parsed)) return parsed;
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

export async function addTagsBatch(chunks) {
  if (chunks.length === 1) return [await addTags(chunks[0])];

  const n = chunks.length;
  const example = Array.from({ length: n }, (_, i) => [`tag${i}a`, `tag${i}b`]);
  const items = chunks.map((c, i) => `CHUNK ${i}:\n${c.text.slice(0, 400)}`).join('\n\n');

  const prompt = `You are a document tagger. Generate 3-7 lowercase hyphenated tags for each chunk.
IMPORTANT: Output ONLY a JSON array of ${n} arrays, nothing else. No explanation, no markdown.
Example output for ${n} chunks: ${JSON.stringify(example)}

${items}

Output:`;

  let result = null;
  try {
    const raw = await generate(MODEL, prompt, { format: 'json' });
    result = extractJsonArray(raw, n);
  } catch { /* fall through */ }

  if (!result) {
    console.warn('  [tag] batch parse failed, falling back to individual');
    return Promise.all(chunks.map(addTags));
  }

  return chunks.map((chunk, i) => {
    const generated = (result[i] || [])
      .map(t => String(t).trim().toLowerCase().replace(/\s+/g, '-'))
      .filter(t => t.length > 1 && t.length < 40);
    const tags = [...new Set([...existingTags(chunk), ...generated])];
    return { ...chunk, tags };
  });
}
