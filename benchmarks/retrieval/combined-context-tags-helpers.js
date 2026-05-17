/**
 * Pure parser helpers for combined context+tags LLM output.
 * No Ollama, no Qdrant, no side effects — safe to import in smoke tests.
 */

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

function normalizeItems(items) {
  return items.map(item => ({
    context: item.context.trim(),
    tags: normalizeTags(item.tags),
  }));
}

/**
 * Parse LLM output into [{context, tags}] array of exactly expectedLength items.
 *
 * Accepts:
 *   - direct array:         [{"context":"...","tags":["a","b"]}]
 *   - wrapper object:       {"items":[{"context":"...","tags":["a"]}]}
 *                           or any object whose first array-of-objects value fits
 *   - markdown fenced JSON: ```json\n[...]\n```
 *
 * Returns normalized array on success, null on parse/validation failure.
 */
export function extractContextTagsArray(raw, expectedLength) {
  if (typeof raw !== 'string' || !raw.trim()) return null;

  // Strip markdown code fences
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  for (const candidate of [stripped, raw.trim()]) {
    let parsed;
    try { parsed = JSON.parse(candidate); } catch { continue; }

    // Direct array
    if (Array.isArray(parsed)) {
      if (parsed.length === expectedLength && parsed.every(isValidItem)) {
        return normalizeItems(parsed);
      }
      // Wrong length or invalid items — still a direct array, don't try wrapper
      return null;
    }

    // Object wrapper — look for first array-of-valid-items value
    if (parsed !== null && typeof parsed === 'object') {
      // Single-item case: model returned {context, tags} directly instead of [{...}]
      if (expectedLength === 1 && isValidItem(parsed)) {
        return normalizeItems([parsed]);
      }
      for (const val of Object.values(parsed)) {
        if (
          Array.isArray(val) &&
          val.length === expectedLength &&
          val.every(isValidItem)
        ) {
          return normalizeItems(val);
        }
      }
      return null;
    }
  }

  return null;
}
