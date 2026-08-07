import { validateOllamaGenerateCapability } from '../../../core/generation/ollama-capability.js';
import { addContext } from './context.js';
import { addTagsWithModel } from './tag.js';

// Chunks shorter than this character count skip the combined LLM call and fall
// back to the separate context + tag path. Avoids wasting a call on near-empty
// chunks where the model reliably returns malformed output.
export const COMBINED_MIN_CHARS = 80;

// Capability injection (Phase 8B Step 3 — instance-scoped, no module-scope
// setter) — see phases/context.js's own header comment for the full
// rationale; this module follows the exact same pattern, using the narrow
// single-method OllamaGenerateCapability contract, passed as opts.ollama.
// addContextAndTags() is never reached in Lite (COMBINED_LLM is only
// meaningful under CONTEXT_MODE=llm, which Lite never selects). The
// fallback path's own addContext()/addTagsWithModel() calls
// (context.js/tag.js) receive the SAME opts object this function itself
// received — one capability, threaded through, never re-resolved from a
// module-scope binding at any point in the chain.

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

// BENCH_CONTEXT_POLICY — benchmark/ablation only, not a stable config option.
// Selects alternate prompt variant for context generation experiments.
// Valid values: "current-minimal" (default), "identifier-preserving", "section-window-aware".
// Production behavior is always "current-minimal" when unset.
const BENCH_CONTEXT_POLICY = process.env.BENCH_CONTEXT_POLICY || 'current-minimal';

// BENCH_COMBINED_CONTEXT_ONLY — benchmark/ablation only, not a stable config option.
// When '1': uses a context-only prompt that asks for {"context":"..."} with no tags field.
// Tags are stored as [] so embedding remains default (context + text).
// Purpose: isolate whether asking for tags in the same prompt degrades context quality.
// Production behavior is always unchanged when this flag is unset.
const BENCH_COMBINED_CONTEXT_ONLY = process.env.BENCH_COMBINED_CONTEXT_ONLY === '1';

function buildPromptContextOnly(chunk) {
  return `You are a document indexer. Given a text chunk, return a JSON object with:
- "context": 1-2 sentences describing what this chunk is about and where it fits in the document

Output ONLY valid JSON, nothing else. Example: {"context":"This chunk explains X."}

File: ${chunk.source_file}
Section: ${chunk.section || 'unknown'}
Chunk ${chunk.chunkIndex + 1} of ${chunk.totalChunks}

Text:
${chunk.text.slice(0, 1000)}`;
}

function parseContextOnlyResponse(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  for (const candidate of [stripped, raw.trim()]) {
    let parsed;
    try { parsed = JSON.parse(candidate); } catch { continue; }
    const obj = Array.isArray(parsed) && parsed.length >= 1 ? parsed[0] : parsed;
    if (obj !== null && typeof obj === 'object' && typeof obj.context === 'string' && obj.context.trim().length > 0) {
      return obj.context.trim();
    }
  }
  return null;
}

function buildPrompt(chunk, chunks) {
  if (BENCH_COMBINED_CONTEXT_ONLY) {
    return buildPromptContextOnly(chunk);
  }
  if (BENCH_CONTEXT_POLICY === 'identifier-preserving') {
    return buildPromptIdentifierPreserving(chunk);
  }
  if (BENCH_CONTEXT_POLICY === 'section-window-aware') {
    return buildPromptSectionWindowAware(chunk, chunks);
  }
  return buildPromptCurrentMinimal(chunk);
}

function buildPromptCurrentMinimal(chunk) {
  return `You are a document indexer. Given a text chunk from a file, return a JSON object with:
- "context": 1-2 sentences describing what this chunk is about and where it fits in the document. Be concise.
- "tags": array of 3-7 lowercase hyphenated tags (e.g. "node-js", "qdrant-hybrid-search")

Output ONLY valid JSON, nothing else. Example: {"context":"This chunk explains X.","tags":["x","y"]}

File: ${chunk.source_file}
Section: ${chunk.section || 'unknown'}
Chunk ${chunk.chunkIndex + 1} of ${chunk.totalChunks}

Text:
${chunk.text.slice(0, 1000)}`;
}

function buildPromptIdentifierPreserving(chunk) {
  return `You are a document indexer. Given a text chunk, return a JSON object with:
- "context": 1-2 sentences describing what this chunk is about and where it fits in the document
- "tags": array of 3-7 lowercase hyphenated tags (e.g. "node-js", "qdrant-hybrid-search")

Rules for context:
- Preserve exact identifiers verbatim: env vars, function names, file paths, CLI flags, error strings, config keys, model names, IDs, numbers.
- Do not paraphrase technical terms. If the chunk mentions QDRANT_URL, write QDRANT_URL.
- Help retrieve this exact chunk — write context a user would search for.
- Do not summarize the whole document. Do not invent scope.

Output ONLY valid JSON, nothing else. Example: {"context":"This chunk explains X.","tags":["x","y"]}

File: ${chunk.source_file}
Section: ${chunk.section || 'unknown'}
Chunk ${chunk.chunkIndex + 1} of ${chunk.totalChunks}

Text:
${chunk.text.slice(0, 1000)}`;
}

function buildPromptSectionWindowAware(chunk, chunks) {
  const prev = chunks ? chunks[chunk.chunkIndex - 1] : null;
  const next = chunks ? chunks[chunk.chunkIndex + 1] : null;
  const prevSnippet = prev ? prev.text.slice(-200).trim() : null;
  const nextSnippet = next ? next.text.slice(0, 200).trim() : null;

  const windowLines = [];
  if (prevSnippet) windowLines.push(`Previous chunk (end):\n${prevSnippet}`);
  if (nextSnippet) windowLines.push(`Next chunk (start):\n${nextSnippet}`);
  const windowBlock = windowLines.length
    ? '\n\n' + windowLines.join('\n\n')
    : '';

  return `You are a document indexer. Given a text chunk and its surrounding context, return a JSON object with:
- "context": 1-2 sentences (40-90 tokens) describing what this specific chunk is about and where it fits
- "tags": array of 3-7 lowercase hyphenated tags

Rules:
- Preserve exact identifiers verbatim: env vars, function names, file paths, CLI flags, error strings, config keys, model names.
- Context must be specific to this chunk, not the whole document or section.
- Use surrounding chunks only to understand position — do not describe them.
- Do not include tags in the context field.

Output ONLY valid JSON, nothing else. Example: {"context":"This chunk explains X.","tags":["x","y"]}

File: ${chunk.source_file}
Section: ${chunk.section || 'unknown'}
Chunk ${chunk.chunkIndex + 1} of ${chunk.totalChunks}${windowBlock}

Text:
${chunk.text.slice(0, 1000)}`;
}

// ── addContextAndTags ─────────────────────────────────────────────────────────

// Single combined LLM call per chunk.
// On parse failure: falls back to separate addContext + addTags.
// Short chunks (< COMBINED_MIN_CHARS) skip the combined call and fall back directly.
// chunks: full array, required for section-window-aware policy; unused by other policies.
/**
 * @param {Object} chunk
 * @param {string} model
 * @param {Object[]} chunks
 * @param {{ ollama: import('../../../core/generation/ollama-capability.js').OllamaGenerateCapability }} opts
 *   — required; no module-scope fallback exists. Threaded unchanged into
 *   the fallback path's own addContext()/addTagsWithModel() calls.
 */
export async function addContextAndTags(chunk, model, chunks, opts) {
  const tooShort = chunk.text.trim().length < COMBINED_MIN_CHARS;
  const ollama = opts?.ollama;

  if (!tooShort) {
    if (!ollama) throw new Error('phases/combined.js: addContextAndTags() requires opts.ollama (an OllamaGenerateCapability) — no module-scope capability exists to fall back to.');
    validateOllamaGenerateCapability(ollama);
    try {
      const raw = await ollama.generate(model, buildPrompt(chunk, chunks), { format: 'json' });
      if (BENCH_COMBINED_CONTEXT_ONLY) {
        const context = parseContextOnlyResponse(raw);
        if (context) return { ...chunk, context, tags: [] };
      } else {
        const parsed = parseCombinedResponse(raw);
        if (parsed) return { ...chunk, context: parsed.context, tags: parsed.tags };
      }
    } catch { /* fall through to separate path */ }

    process.stderr.write(
      `[combined] parse failed for ${chunk.source_file}#${chunk.chunkIndex}; falling back to ${BENCH_COMBINED_CONTEXT_ONLY ? 'context-only' : 'separate context/tags'}\n`,
    );
  }

  // Fallback path.
  // In context-only mode: add context but force tags=[] so the variant stays
  // pure — no fallback chunk ever contributes tags.
  if (BENCH_COMBINED_CONTEXT_ONLY) {
    const withContext = await addContext(chunk, opts);
    return { ...withContext, tags: [] };
  }
  // Normal combined fallback: separate context then tags, both using CONTEXT_MODEL
  // (TAG_MODEL is intentionally not used here).
  const withContext = await addContext(chunk, opts);
  return addTagsWithModel(withContext, model, opts);
}
