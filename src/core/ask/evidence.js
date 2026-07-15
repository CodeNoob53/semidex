// Ask evidence assembly (Phase 4A) — question -> numbered evidence blocks.
//
// Retrieval runs through the SAME core service /api/search uses
// (src/core/retrieval/search.js) — identical ranking, identical excludeNav
// filter, one implementation for both surfaces.
//
// For a skeleton hit with nodeId, evidence text is expanded to section scope
// via the Phase 3X primitive getAnchoredContent() (bounded per-source
// budget) — never the whole file, never unbounded. Multiple hits resolving
// to the same section are deduplicated to one evidence block. A legacy hit
// with no node identity falls back to its own chunk text, truncated to the
// same per-source budget.
//
// Token counting here uses the real BGE-M3 tokenizer (via
// core/token-count.js) for retrieval-assembly budgeting. This is EXACT for
// what it measures — the indexed chunk text — but it is only a PROXY for
// the generation model's own tokenizer (e.g. Gemma's SentencePiece vocab).
// Do not read the evidence token counts here as an exact prediction of the
// generation model's context usage — see prompt.js for the conservative
// headroom this proxy relationship requires.
import { runHybridSearch } from '../retrieval/search.js';
import { getAnchoredContent } from '../assembly/anchored-content.js';
import { buildPrompt, RESERVED_HEADROOM_TOKENS } from './prompt.js';

export const DEFAULT_TOP = 5;
export const DEFAULT_PER_SOURCE_TOKEN_BUDGET = 700;
const EVIDENCE_SEPARATOR = '\n\n';

function sectionKey(hit) {
  // Dedup key for "which section would this hit expand to": prefer the
  // resolved section identity (parentId, the section's own nodeId is not on
  // the hit itself — parentId IS the section's nodeId for a prose/entity
  // chunk), fall back to sourceFile+section heading text for legacy hits
  // with no node identity at all.
  if (hit.nodeId) return `node-scope:${hit.parentId ?? hit.nodeId}`;
  return `legacy:${hit.sourceFile}::${hit.section ?? ''}`;
}

async function truncateToBudget(text, maxTokens, countTokens) {
  // Legacy-hit fallback only — no assembly service involved. countTokens
  // may be sync (heuristic mode) or async (bge-m3 mode) per
  // token-count.js's own contract — awaiting a non-Promise value is a
  // no-op, so this handles both.
  const full = text ?? '';
  const count = await countTokens(full);
  if (count <= maxTokens) return { text: full, truncated: false };

  // Binary search on character offset from the start (mirrors
  // token-count.js's takeLastTokens(), which does the same search from the
  // end) — a single ratio-based char slice was NOT re-verified against the
  // real tokenizer and could overshoot the budget, since token density is
  // not uniform across text (code review finding: budget=5 produced a
  // 21-token result). This guarantees the returned prefix's real token
  // count is <= maxTokens, at the cost of O(log n) tokenizer calls instead
  // of one.
  let lo = 0;
  let hi = full.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const prefix = full.slice(0, mid);
    const prefixCount = await countTokens(prefix);
    if (prefixCount <= maxTokens) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return { text: full.slice(0, lo), truncated: true };
}

/**
 * @param {{
 *   adapter: import('../storage/adapter.js').StorageAdapter,
 *   embedQuery?: Function,
 *   countTokens: (text: string) => number|Promise<number>,
 *   collection: string,
 *   question: string,
 *   sourceFile?: string,
 *   top?: number,
 *   perSourceTokenBudget?: number,
 * }} opts
 * @returns {Promise<{ error: string, message: string } | { sources: Array<Object>, searchMode: string }>}
 *   Each source: { n, sourceFile, chunkIndex, section, snippet, nodeId,
 *   nodePath, nodeType, truncated }. `sources` is [] when retrieval found no
 *   hits — the caller (coordinator) treats [] as a deterministic refusal,
 *   never a reason to call the LLM. `searchMode` reflects the retrieval
 *   mode that ran (currently always 'hybrid' on success), independent of
 *   whether any hits came back.
 */
export async function buildEvidence({
  adapter, embedQuery, countTokens, collection, question, sourceFile, top = DEFAULT_TOP,
  perSourceTokenBudget = DEFAULT_PER_SOURCE_TOKEN_BUDGET,
}) {
  const result = await runHybridSearch({
    adapter, embedQuery, collection, query: question, top, filters: { sourceFile },
  });
  if (result.error) return result;

  const { hits, searchMode } = result;
  const seen = new Set();
  const sources = [];

  for (const hit of hits) {
    const key = sectionKey(hit);
    if (seen.has(key)) continue;
    seen.add(key);

    let text;
    let truncated = false;
    // The anchor hit's own identity — never overwritten by section-scope
    // expansion below (see the comment at the anchored-content branch).
    const nodeId = hit.nodeId ?? null;
    const nodePath = hit.nodePath ?? null;
    const nodeType = hit.nodeType ?? null;
    const section = hit.section ?? null;

    if (hit.nodeId) {
      const anchored = await getAnchoredContent({
        adapter, collection, anchorNodeId: hit.nodeId, scope: 'section',
        maxTokens: perSourceTokenBudget, countTokens, separatorText: EVIDENCE_SEPARATOR,
      });
      if (anchored.error) {
        // Section expansion failed for a structural reason (e.g. a legacy
        // file with no section structure, or a nav-only id that shouldn't
        // occur for a search hit) — fall back to the hit's own chunk text
        // rather than dropping the source entirely.
        const trimmed = await truncateToBudget(hit.text, perSourceTokenBudget, countTokens);
        text = trimmed.text;
        truncated = trimmed.truncated;
      } else {
        const items = anchored.window.items ?? [];
        const parts = items
          .filter(item => !item.oversized)
          .map(item => (item.kind === 'entity' ? (item.rawContent ?? '') : (item.text ?? '')))
          .filter(p => p !== '');
        text = parts.join(EVIDENCE_SEPARATOR);
        truncated = anchored.window.hasMoreBefore || anchored.window.hasMoreAfter || items.some(i => i.oversized);
        // anchored.nodePath is the SECTION's own nodePath (getAnchoredContent's
        // scope identity), not the anchor entity's — nodePath/nodeType/nodeId
        // above already hold the anchor hit's own identity and must not be
        // overwritten here. Overwriting used to point [node: <path>] citations
        // at the section, not the table/code_block that was actually
        // retrieved, breaking prompt.js's node-marker instruction entirely
        // (code review finding).
      }
    } else {
      const trimmed = await truncateToBudget(hit.text, perSourceTokenBudget, countTokens);
      text = trimmed.text;
      truncated = trimmed.truncated;
    }

    sources.push({
      n: sources.length + 1,
      sourceFile: hit.sourceFile ?? null,
      chunkIndex: hit.chunkIndex ?? null,
      section,
      snippet: text,
      nodeId,
      nodePath,
      nodeType,
      truncated,
    });
  }

  // searchMode reflects which retrieval mode actually ran (always 'hybrid'
  // here — runHybridSearch already returned successfully, meaning
  // resolveSearchMode() resolved a supported mode), NOT whether any hits
  // came back. A zero-hit hybrid search still used hybrid search — deriving
  // searchMode from sources.length instead (as the caller previously did)
  // wrongly reported null for a real, completed hybrid search that simply
  // found nothing (code review finding).
  return { sources, searchMode };
}

/**
 * Bounds the WHOLE prompt (system rules + all evidence + question) against
 * the generation model's real context window, not just each source's own
 * per-source cap — per-source budgets alone let top=5 x ~700 tokens = ~3.5k
 * ride into the prompt with no check against a smaller/already-loaded
 * model's actual num_ctx, the question's own length, or output headroom
 * (code review finding: RESERVED_HEADROOM_TOKENS was declared but never
 * consulted). Drops lowest-ranked sources (highest `n`, i.e. weakest
 * retrieval rank) one at a time — never re-truncates a kept source's text
 * (that would silently weaken evidence that already passed its own
 * per-source budget) — until the reconstructed prompt's real token count
 * fits `numCtx - RESERVED_HEADROOM_TOKENS`, then renumbers sequentially so
 * citation numbers stay contiguous from 1.
 *
 * @param {Array<Object>} sources — as returned by buildEvidence(), rank order
 * @param {string} question
 * @param {number|undefined} numCtx — the model's context length; when
 *   undefined/non-finite, no trimming is applied (caller didn't supply a
 *   readiness numCtx — treated as "unknown," not "unlimited," but there is
 *   nothing safe to bound against, so the per-source budgets are the only
 *   guarantee in that case)
 * @param {(text: string) => number|Promise<number>} countTokens
 * @returns {Promise<{ sources: Array<Object>, dropped: number }>}
 */
export async function fitEvidenceToContextBudget(sources, question, numCtx, countTokens) {
  if (!Number.isFinite(numCtx) || numCtx <= 0) return { sources, dropped: 0 };
  const budget = numCtx - RESERVED_HEADROOM_TOKENS;

  let kept = sources;
  while (kept.length > 0) {
    const promptTokens = await countTokens(buildPrompt(kept, question));
    if (promptTokens <= budget) break;
    kept = kept.slice(0, -1);
  }

  const renumbered = kept.map((s, i) => ({ ...s, n: i + 1 }));
  return { sources: renumbered, dropped: sources.length - kept.length };
}
