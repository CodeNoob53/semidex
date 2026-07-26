// qdrant_get_content (Phase 3X) — bounded anchored content assembly.
//
// The main problem this solves: a search hit is one chunk; an agent often
// needs the coherent section/file context AROUND that hit without loading
// an entire large document into its context window. This tool resolves the
// hit's node_id through StorageAdapter, assembles its containing
// section/file via the SAME core assembly service the admin document
// reader uses (core/assembly/assemble.js), and returns a token-bounded,
// anchor-centered, paginated slice of it — never the whole document at
// once, never silently over budget.
//
// StorageAdapter-only: no direct Qdrant SDK/filter DSL import anywhere in
// this file. No search, no embeddings, no LLM calls, no filesystem access —
// this tool only ever reads already-indexed structure through the adapter.
import { createStorageAdapter } from '../../core/storage/factory.js';
import { getAnchoredContent } from '../../core/assembly/anchored-content.js';
import { getTokenCounter } from '../../core/token-count.js';

const MAX_TOKENS_DEFAULT = 2000;
const MAX_TOKENS_MIN = 200;
const MAX_TOKENS_MAX = 8000;

// The exact separator reconstructText() renders BETWEEN consecutive items.
// The literal string is passed to the window builder so each complete
// candidate is serialized and tokenized once; BPE token counts are not
// additive across separately-counted segments and separators.
const TEXT_JOIN_SEPARATOR = '\n\n';

export const schema = {
  name: 'qdrant_get_content',
  description:
    'Assemble bounded, coherent section or file context around a search-result anchor. ' +
    'Reuses the same document-assembly logic as the admin UI: prose reads continuously, ' +
    'tables/code/checklists appear at their original position with authoritative raw content, ' +
    'placeholder lines are resolved away. Token-bounded (never returns more than max_tokens of ' +
    'assembled content, including the separators rendered between items, counted with the real BGE-M3 ' +
    'tokenizer — errors clearly if that tokenizer is unavailable rather than degrading to an imprecise count) ' +
    'paginate with the returned cursor_before/cursor_after for more. ' +
    'Requires node_id from a qdrant_search hit (or a window chunk) — legacy collections without ' +
    'skeleton node identity cannot use this tool; reindex with skeleton chunking first. ' +
    'This is for CONTEXTUAL EVIDENCE around a hit, not for fetching one full original entity — ' +
    'use qdrant_get_node for that (primarily for user display).',
  inputSchema: {
    type: 'object',
    properties: {
      collection:     { type: 'string',  description: 'Collection name' },
      anchor_node_id: { type: 'string',  description: 'node_id of a search hit or window chunk to center context on' },
      scope:          { type: 'string',  enum: ['section', 'file'], default: 'section',
        description: 'Assemble the anchor\'s containing section (default, tighter/cheaper) or its whole file (use only when section context is insufficient)' },
      max_tokens:     { type: 'integer', default: MAX_TOKENS_DEFAULT, minimum: MAX_TOKENS_MIN, maximum: MAX_TOKENS_MAX,
        description: `Token budget for ASSEMBLED CONTENT only (not metadata/cursors). Default ${MAX_TOKENS_DEFAULT}, range ${MAX_TOKENS_MIN}-${MAX_TOKENS_MAX}.` },
      cursor:         { type: 'string',  description: 'Opaque pagination cursor from a previous call\'s cursor_before/cursor_after — omit for the initial anchor-centered page' },
      format:         { type: 'string',  enum: ['text', 'nodes'], default: 'text',
        description: '"text": reconstructed ordered Markdown/text plus compact metadata; oversized entities are never inlined, only listed in omitted_entities. "nodes": ordered structured items with full per-node identity, oversized ones marked oversized:true with content:null.' },
    },
    required: ['collection', 'anchor_node_id'],
  },
};

// ── Pure input validation — exported for tests ───────────────────────────────
export function validateInput({ collection, anchor_node_id, scope = 'section', max_tokens, cursor, format = 'text' }) {
  if (!collection || typeof collection !== 'string') return 'Error: "collection" is required.';
  if (!anchor_node_id || typeof anchor_node_id !== 'string') return 'Error: "anchor_node_id" is required.';
  if (scope !== 'section' && scope !== 'file') return 'Error: "scope" must be "section" or "file".';
  if (format !== 'text' && format !== 'nodes') return 'Error: "format" must be "text" or "nodes".';
  if (max_tokens !== undefined && max_tokens !== null) {
    const n = Number(max_tokens);
    if (!Number.isInteger(n) || n < MAX_TOKENS_MIN || n > MAX_TOKENS_MAX) {
      return `Error: "max_tokens" must be an integer between ${MAX_TOKENS_MIN} and ${MAX_TOKENS_MAX}, got ${max_tokens}.`;
    }
  }
  if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') {
    return 'Error: "cursor" must be a string.';
  }
  return null;
}

const ERROR_MESSAGES = {
  anchor_not_found: (id) => `Error: no content node found for anchor_node_id="${id}". It may not exist, belong to a different collection, or the collection may predate skeleton chunking (legacy collections have no node identity — reindex to enable anchored retrieval).`,
  anchor_is_navigation: (id) => `Error: anchor_node_id="${id}" is a navigation node, not retrievable content. Navigation/skeleton summary nodes are never valid anchors — pass a node_id from a qdrant_search hit instead.`,
  no_section_scope: (id) => `Error: anchor_node_id="${id}" has no section structure to assemble scope="section" from. Retry with scope="file".`,
  invalid_cursor: () => 'Error: the provided cursor is invalid, malformed, or does not match this request (collection/anchor_node_id/scope must be identical to the call that produced it). Omit cursor to start a new anchor-centered page.',
};

// Code review (P1, two rounds): the real BGE-M3 tokenizer can fail to load
// (no network, empty cache). This tool NEVER substitutes the chars/4
// heuristic for it — not on a load failure, and not even when the operator
// set TOKEN_COUNT=heuristic project-wide. chars/4 measurably UNDERCOUNTS
// real tokens for Cyrillic and code-shaped text (empirically ~1.2-1.7x
// undercounted against the real tokenizer on representative samples), so
// any heuristic count would let max_tokens quietly stop being a real bound
// while the tool's own contract keeps promising "never over max_tokens" —
// and a token_count_mode label reported AFTER the response is built does
// not protect the model from an already-overflowed page. The heuristic is
// a legitimate INDEXER speed choice; it is not acceptable for THIS tool's
// hard cap. So an unavailable accurate tokenizer is a clear, hard error,
// full stop.
export function tokenizerUnavailableMessage(err) {
  return `Error: the real BGE-M3 tokenizer failed to load (${err?.message ?? err}). `
    + 'qdrant_get_content requires the accurate BGE-M3 tokenizer to keep its max_tokens bound sound — '
    + 'chars/4 measurably undercounts real tokens for non-ASCII and code-shaped text and cannot substitute for it, '
    + 'so this tool never falls back to the heuristic counter (not even under TOKEN_COUNT=heuristic, which only affects the indexer). '
    + 'Fix tokenizer/model cache access (check network and the ONNX cache directory) and retry.';
}

function formatOmittedEntity(item) {
  return {
    node_id: item.nodeId, node_path: item.nodePath, chunk_index: item.chunkIndex,
    node_type: item.nodeType, token_count: item.tokenCount,
  };
}

// Reconstructs ordered Markdown/text from window items — reconstruction
// only, never a rewrite or summary: prose text and authoritative
// rawContent are concatenated verbatim in their assembled order. Oversized
// items are deliberately EXCLUDED from this string (never inlined as a
// bracketed note) — a per-item note's own rendered text has a real token
// cost that would otherwise silently ride along uncounted (code review:
// 20 oversized tables at max_tokens=200 previously produced
// returned_tokens=0 while the actual rendered text was ~747 heuristic
// tokens). Their existence is instead reported once, structurally, via the
// separate `omitted_entities` metadata array formatResult() builds below —
// metadata is never bounded by max_tokens, so this is the honest way to
// surface "these were skipped" without either inflating text beyond the
// budget or double-counting a bespoke per-item string against window.js's
// own fixed-cost accounting.
function reconstructText(items) {
  const parts = [];
  for (const item of items) {
    if (item.oversized) continue;
    parts.push(item.kind === 'entity' ? (item.rawContent ?? '') : (item.text ?? ''));
  }
  return parts.filter(p => p !== '').join(TEXT_JOIN_SEPARATOR);
}

function formatItemNode(item) {
  if (item.oversized) {
    return {
      ...formatOmittedEntity(item),
      oversized: true, content: null,
    };
  }
  return {
    node_id: item.nodeId ?? null,
    node_path: item.nodePath ?? null,
    chunk_index: item.chunkIndex ?? null,
    node_type: item.nodeType ?? null,
    section: item.section ?? null,
    heading_path: item.headingPath ?? null,
    content: item.kind === 'entity' ? (item.rawContent ?? '') : (item.text ?? ''),
  };
}

// Pure result formatter (both format modes) — exported for tests.
// tokenCountMode ('bge-m3' | 'heuristic' | 'injected') is always surfaced —
// "heuristic" must never be a silent substitution (code review P1): a
// caller relying on the strict max_tokens bound needs to see, in-band,
// that this response was counted with the fast/imprecise counter.
export function formatResult(result, { anchorNodeId, format, tokenCountMode }) {
  const w = result.window;
  const omittedEntities = w.items.filter(item => item.oversized).map(formatOmittedEntity);
  const base = {
    collection: result.collection,
    scope: result.scope,
    source_file: result.sourceFile,
    node_path: result.nodePath,
    assembly_mode: result.assemblyMode,
    anchor_node_id: anchorNodeId,
    token_count_mode: tokenCountMode ?? 'bge-m3',
    total_tokens: w.totalTokens,
    returned_tokens: w.returnedTokens,
    has_more_before: w.hasMoreBefore,
    has_more_after: w.hasMoreAfter,
    cursor_before: w.cursorBefore,
    cursor_after: w.cursorAfter,
  };

  if (format === 'nodes') {
    return { ...base, items: w.items.map(item => (item.oversized ? formatItemNode(item) : { ...formatItemNode(item), is_anchor: itemMatchesAnchor(item, anchorNodeId) })) };
  }

  // format=text: oversized entities are never inlined into `text` (see
  // reconstructText's own comment) — surfaced instead as structural
  // metadata, one entry per omitted entity, never bounded by max_tokens
  // (metadata never is) but also never silently absent from the response.
  return { ...base, text: reconstructText(w.items), omitted_entities: omittedEntities };
}

function itemMatchesAnchor(item, anchorNodeId) {
  return item.nodeId === anchorNodeId || item.nodePath === anchorNodeId;
}

/**
 * Factory (DI, per the task's explicit requirement) — tests inject a fake
 * adapter and either a deterministic countTokens directly, or a
 * getTokenCounterFn stand-in to exercise the load-and-possibly-fail path
 * itself (e.g. simulating a tokenizer load failure) without touching the
 * real BGE-M3 model. The real CLI entry point below supplies
 * createStorageAdapter() and the project's real getTokenCounter.
 *
 * @param {{
 *   adapter?: import('../../core/storage/adapter.js').StorageAdapter,
 *   countTokens?: (text: string) => number|Promise<number>,
 *   getTokenCounterFn?: (opts: { mode: string }) => Promise<(text: string) => number|Promise<number>>,
 * }} [deps]
 * @returns {{ handle: (args: Object) => Promise<string> }}
 */
export function createGetContentHandler({
  adapter = createStorageAdapter(),
  countTokens,
  getTokenCounterFn = getTokenCounter,
} = {}) {
  async function handle(args) {
    const { collection, anchor_node_id, scope = 'section', max_tokens, cursor, format = 'text' } = args ?? {};
    const err = validateInput(args ?? {});
    if (err) return err;

    const maxTokens = max_tokens === undefined || max_tokens === null ? MAX_TOKENS_DEFAULT : Number(max_tokens);

    let counter = countTokens;
    let tokenCountMode = 'injected'; // test-only direct-countTokens DI path; never surfaced by the real CLI entry point
    if (!counter) {
      // qdrant_get_content ALWAYS uses the real BGE-M3 tokenizer, mode
      // 'bge-m3' explicitly — never the project-wide TOKEN_COUNT setting
      // (code review, P1): a hard max_tokens cap is a promise this tool
      // makes to protect an agent's context window, and chars/4 measurably
      // undercounts real tokens for Cyrillic/code-shaped text — so an
      // operator's TOKEN_COUNT=heuristic (a legitimate speed choice for the
      // INDEXER) must not silently make THIS tool's cap unsound. If the
      // accurate tokenizer can't load (network/cache unavailable), that is
      // a hard error with a clear message, never a silent heuristic
      // substitution — the tool would rather refuse than over-fill a
      // context window it promised not to.
      tokenCountMode = 'bge-m3';
      try {
        counter = await getTokenCounterFn({ mode: 'bge-m3' });
      } catch (err) {
        return tokenizerUnavailableMessage(err);
      }
    }

    const result = await getAnchoredContent({
      adapter, collection, anchorNodeId: anchor_node_id, scope, maxTokens, cursor: cursor ?? null,
      countTokens: counter, separatorText: TEXT_JOIN_SEPARATOR,
    });

    if (result.error) {
      const messageFn = ERROR_MESSAGES[result.error];
      return messageFn ? messageFn(anchor_node_id) : `Error: ${result.error}`;
    }

    return JSON.stringify(formatResult(result, { anchorNodeId: anchor_node_id, format, tokenCountMode }), null, 2);
  }
  return { handle };
}

// Module-level default handler for server.js registration — lazily resolves
// the real adapter/token-counter on first call (never at import time, so
// importing this file for its schema alone never touches Qdrant/ONNX).
let _defaultHandler = null;
export async function handle(args) {
  if (!_defaultHandler) _defaultHandler = createGetContentHandler({});
  return _defaultHandler.handle(args);
}
