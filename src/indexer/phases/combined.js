import { generate } from '../../core/ollama.js';
import { addContext } from './context.js';
import { addTagsWithModel } from './tag.js';

// Chunks shorter than this character count skip the combined LLM call and fall
// back to the separate context + tag path. Avoids wasting a call on near-empty
// chunks where the model reliably returns malformed output.
export const COMBINED_MIN_CHARS = 80;

// ── Parser ────────────────────────────────────────────────────────────────────

const TAG_MIN = 2;
const TAG_MAX = 40;

function normalizeTags(raw) {
  return [...new Set(
    raw
      .map(t => String(t).trim().toLowerCase().replace(/\s+/g, '-'))
      .filter(t => t.length >= TAG_MIN && t.length <= TAG_MAX),
  )];
}

function isValidItem(item) {
  return (
    item !== null &&
    typeof item === 'object' &&
    typeof item.context === 'string' &&
    item.context.trim().length > 0 &&
    Array.isArray(item.tags)
  );
}

// Parse a single {context, tags} response from the combined LLM call.
// Accepts:
//   - direct object:        {"context":"...","tags":["a","b"]}
//   - single-element array: [{"context":"...","tags":["a","b"]}]
//   - markdown fenced JSON: ```json\n{...}\n```
// Returns { context, tags } on success, null on failure.
export function parseCombinedResponse(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;

  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  for (const candidate of [stripped, raw.trim()]) {
    let parsed;
    try { parsed = JSON.parse(candidate); } catch { continue; }

    if (isValidItem(parsed)) {
      return { context: parsed.context.trim(), tags: normalizeTags(parsed.tags) };
    }

    if (Array.isArray(parsed) && parsed.length >= 1 && isValidItem(parsed[0])) {
      return { context: parsed[0].context.trim(), tags: normalizeTags(parsed[0].tags) };
    }
  }

  return null;
}

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(chunk) {
  return `You are a document indexer. Given a text chunk, return a JSON object with:
- "context": 1-2 sentences describing what this chunk is about and where it fits in the document
- "tags": array of 3-7 lowercase hyphenated tags (e.g. "node-js", "qdrant-hybrid-search")

Output ONLY valid JSON, nothing else. Example: {"context":"This chunk explains X.","tags":["x","y"]}

File: ${chunk.source_file}
Section: ${chunk.section || 'unknown'}
Chunk ${chunk.chunkIndex + 1} of ${chunk.totalChunks}

Text:
${chunk.text.slice(0, 1000)}`;
}

// ── addContextAndTags ─────────────────────────────────────────────────────────

// Single combined LLM call per chunk.
// On parse failure: falls back to separate addContext + addTags.
// Short chunks (< COMBINED_MIN_CHARS) skip the combined call and fall back directly.
export async function addContextAndTags(chunk, model) {
  const tooShort = chunk.text.trim().length < COMBINED_MIN_CHARS;

  if (!tooShort) {
    try {
      const raw    = await generate(model, buildPrompt(chunk), { format: 'json' });
      const parsed = parseCombinedResponse(raw);
      if (parsed) {
        return { ...chunk, context: parsed.context, tags: parsed.tags };
      }
    } catch { /* fall through to separate path */ }

    process.stderr.write(
      `[combined] parse failed for ${chunk.source_file}#${chunk.chunkIndex}; falling back to separate context/tags\n`,
    );
  }

  // Fallback: separate context then tags, both using CONTEXT_MODEL (same model
  // as the combined call — TAG_MODEL is intentionally not used here).
  const withContext = await addContext(chunk);
  return addTagsWithModel(withContext, model);
}
