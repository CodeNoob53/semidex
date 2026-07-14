// ── assembled document renderer (Phase 3W) ─────────────────────────────────
// Pure DOM construction for the Document reader mode: takes an assembly API
// response (GET /api/collections/:name/assembly — the Local API contract,
// never a core/backend import) and renders its ordered segment array as one
// continuous document. Prose renders as text (textContent, never HTML, no
// Markdown parsing in this phase); structural entities (table/code_block/
// checklist) render through the SHARED renderChunkContent() from
// structural-renderer.js — this module owns no second table/code/checklist
// renderer of its own.
//
// file-view.js owns fetching, reader state, mode switching, and header
// integration; this module only builds DOM from an already-fetched assembly.
import { cloneTemplate } from './dom.js';
import { renderChunkContent } from './structural-renderer.js';

// User-facing banner copy — fixed strings only, never interpolated warning
// objects/codes/node IDs (those are internal API vocabulary, not UI text).
const FALLBACK_BANNER_TEXT = 'This document was assembled from an older index. Refresh its metadata for the most reliable structure.';
const INTEGRITY_BANNER_TEXT = 'Some structured content could not be linked automatically.';

// At most one compact banner per condition, never one per warning: the
// fallback banner when the whole assembly came from the placeholder
// fallback, and one generic integrity line when any orphan/missing-reference
// warning exists. plain_chunks is a normal legacy mode — no banner at all.
export function renderAssemblyBanners(assembly) {
  const out = [];
  if (assembly?.assemblyMode === 'placeholder_fallback') {
    out.push(buildBanner(FALLBACK_BANNER_TEXT, 'fallback'));
  }
  const integrityCount = (assembly?.warnings ?? [])
    .filter(w => w?.code && w.code !== 'placeholder_fallback').length;
  if (integrityCount > 0) {
    out.push(buildBanner(INTEGRITY_BANNER_TEXT, 'integrity'));
  }
  return out;
}

function buildBanner(text, kind) {
  const frag = cloneTemplate('tpl-assembly-warning');
  const banner = frag.querySelector('.assembly-warning');
  banner.dataset.kind = kind;
  banner.querySelector('.assembly-warning-text').textContent = text;
  return banner;
}

// Builds the continuous document: one .assembly-segment element per API
// segment, in the API's own order (the backend already emits original
// chunkIndex order — this renderer never re-sorts, dedupes, or merges).
// Every segment keeps its chunk identity in the DOM via data-chunk-index
// (a subtle gutter marker in CSS, not a visible "chunk N" label), and the
// one matching targetChunkIndex — when given — gets .assembly-target for
// the restrained search-jump highlight.
//
// Returns { root, target } — target is the first highlighted element (or
// null), so the caller can scrollIntoView() after insertion without
// re-querying.
export function renderAssemblySegments(assembly, { targetChunkIndex = null } = {}) {
  const doc = globalThis.document;
  const root = doc.createElement('div');
  root.className = 'assembly-doc';

  let target = null;
  for (const segment of assembly?.segments ?? []) {
    const frag = cloneTemplate('tpl-assembly-segment');
    const el = frag.querySelector('.assembly-segment');
    const body = el.querySelector('.assembly-segment-body');
    el.classList.add(segment.kind === 'entity' ? 'assembly-entity' : 'assembly-prose');
    if (Number.isInteger(segment.chunkIndex)) el.dataset.chunkIndex = String(segment.chunkIndex);

    if (segment.kind === 'entity') {
      // The shared structural renderer replaces this placeholder element in
      // place with its own rendered/raw subtree — the exact same rendering
      // search results and chunk cards use, not a re-implementation. It
      // reads rawContent ?? text, so rawContent is the authoritative source
      // handed through; nodeType/lang drive table-vs-code and highlighting.
      const slot = doc.createElement('pre');
      body.appendChild(slot);
      renderChunkContent(slot, {
        nodeType: segment.nodeType,
        rawContent: segment.rawContent,
        text: segment.rawContent,
        lang: segment.lang,
        context: segment.context,
      });
    } else {
      // Prose is text, only ever text: assigned via textContent (CSS
      // pre-wrap preserves the paragraphs/line breaks already in the
      // string). No Markdown parsing, no innerHTML, no per-paragraph card.
      body.textContent = segment.text ?? '';
    }

    if (targetChunkIndex !== null && targetChunkIndex !== undefined
      && segment.chunkIndex === targetChunkIndex && !target) {
      el.classList.add('assembly-target');
      target = el;
    }

    root.appendChild(el);
  }

  return { root, target };
}
