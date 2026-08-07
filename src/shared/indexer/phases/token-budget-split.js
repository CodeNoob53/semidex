// Neutral, format-agnostic token-budget splitting primitives shared by
// entity-split.js (structural entities: tables/code blocks/checklists) and
// chunk.js (general-purpose prose/section/sentence chunking). Pure — no
// I/O, no Qdrant shapes, no provider awareness; every function here takes
// a generic { maxInputTokens, countTokens } budget resolved by the caller.

async function fitsBudget(text, budget) {
  const count = await budget.countTokens(text);
  return count <= budget.maxInputTokens;
}

/**
 * Splits ONE oversized unit's raw text into character-boundary pieces, each
 * of which fits `budget` once wrapped by `renderPiece` (fence markers for a
 * code line, nothing for a checklist item or plain prose word). Used only
 * as a last resort when a single unit does not fit the budget even alone —
 * normal unit-level grouping/splitting already handles every case where
 * units CAN stay whole; this only ever runs on the oversized remainder.
 *
 * Binary search per piece (real, possibly-async countTokens — never a
 * char/4 heuristic), mirroring fitContextToBudget's own technique
 * (qdrant-cloud-catalog.js) generalized from trimming a context prefix to
 * greedily consuming successive prefixes of arbitrary text. Splits at a
 * character boundary, not a token boundary — this can fall mid-token or
 * mid-word, which is syntactically imperfect for a single line of code, a
 * checklist item, or a prose word, but always produces a fragment that
 * provably fits the budget, which is the only real requirement here (the
 * alternative — rejecting the whole file — is strictly worse).
 *
 * @param {string} text — one oversized unit's raw text (never multiple
 *   units — callers only invoke this on a single unit that alone doesn't
 *   fit)
 * @param {(piece: string) => string} renderPiece — wraps a raw text piece
 *   in whatever the unit's own render() would add (fences for code, e.g.)
 *   — used ONLY to measure the true rendered token cost per piece; the
 *   caller is responsible for actually assembling final fragments the
 *   same way once pieces are known
 * @param {{maxInputTokens: number, countTokens: (text: string) => number|Promise<number>}} budget
 * @returns {Promise<string[]>} ordered raw-text pieces; concatenating them
 *   reproduces `text` exactly (no character lost, no character duplicated)
 */
export async function splitOversizedUnitIntoPieces(text, renderPiece, budget) {
  const pieces = [];
  let offset = 0;
  while (offset < text.length) {
    // Binary search the largest end offset (> current offset) such that
    // text.slice(offset, end) still fits the budget once rendered.
    let lo = offset + 1;
    let hi = text.length;
    // A single character must always "fit" for this loop to make forward
    // progress — if even one character doesn't fit (a pathological budget
    // smaller than one rendered character's own token cost), take it
    // anyway rather than looping forever; the caller's own bookkeeping
    // still reports this as an oversized unit.
    if (!(await fitsBudget(renderPiece(text.slice(offset, offset + 1)), budget))) {
      pieces.push(text.slice(offset, offset + 1));
      offset += 1;
      continue;
    }
    while (lo < hi) {
      const mid = Math.ceil((lo + hi + 1) / 2);
      const candidate = text.slice(offset, mid);
      if (await fitsBudget(renderPiece(candidate), budget)) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    pieces.push(text.slice(offset, lo));
    offset = lo;
  }
  return pieces;
}

/**
 * Canonical whitespace form both sides of a chunk-splitting preservation
 * check are compared in. NOT a claim that splitting is literally lossless
 * at the character level (it isn't, for paragraph/sentence/word-level
 * splitting — those already collapse whitespace runs on rejoin) — only
 * that no CONTENT is lost or duplicated, modulo whitespace-run collapsing
 * the splitters already always do.
 */
export function canonicalWhitespace(text, { stripPageMarkers = false } = {}) {
  let src = text.replace(/\r\n?/g, '\n');
  if (stripPageMarkers) src = src.replace(/--\s*\d+\s*of\s*\d+\s*--/g, '');
  return src.replace(/\s+/g, ' ').trim();
}
