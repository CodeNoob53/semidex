// ── selected file/section reader ────────────────────────────────────────────
// Clicking a file or section in the sidebar (or opening a search result)
// loads it into the main content area as a continuous DOCUMENT by default
// (Phase 3W: the assembly API's ordered prose/entity segments, rendered by
// assembly-view.js), with the original chunk-card representation kept as an
// alternate "Chunks" reader mode behind a segmented control in the header.
//
// This module owns fetching, reader state, mode switching, header
// integration, and open/routing behavior; assembly-view.js owns the pure
// DOM construction for Document mode; structural-renderer.js remains the
// single shared table/code/checklist renderer used by BOTH modes.
import { $, esc, cloneTemplate, errorBox, emptyBox, prefersReducedMotion } from './dom.js';
import { api } from './api.js';
import { nodeDisplayLabel, basename } from './format.js';
import { iconTable, iconCodeBlock, iconChecklist, iconFile, iconSection } from './icons.js';
import { renderChunkContent } from './structural-renderer.js';
import { renderAssemblySegments, renderAssemblyBanners } from './assembly-view.js';
import { showToast } from './toasts.js';

// Chunks mode pages its cards client-side, five at a time — same
// fetch-once/reveal-in-batches shape as search.js's Show more
// (SEARCH_PAGE_SIZE), unchanged from the pre-reader behavior.
const FILE_PAGE_SIZE = 5;

// Reader state, scoped to the one currently open file/section. Every open
// (openFileView/openSectionView) REPLACES this object and bumps
// readerGeneration; every async continuation re-checks isCurrent() after
// each await, so an older slow response can never overwrite a newer
// navigation, and a mode toggle after navigating away renders nothing stale.
// A deterministic generation counter — never a timeout — is the guard.
let readerState = null;
let readerGeneration = 0;

function newReaderState(partial) {
  readerGeneration += 1;
  readerState = {
    generation: readerGeneration,
    collection: null,
    scope: null,             // 'file' | 'section'
    sourceFile: null,
    nodePath: null,
    targetChunkIndex: null,  // search-jump highlight target (Document mode)
    mode: 'document',        // 'document' | 'chunks' — Document is always the default
    assembly: null,          // cached /assembly response for this open
    chunks: null,            // cached /chunks result — null until Chunks mode is first entered
    visibleCount: 0,         // Chunks-mode reveal progress
    titleText: '',
    node: null,              // section opens keep the skeleton node for header labels
    ...partial,
  };
  return readerState;
}

function isCurrent(state) {
  return readerState === state && state.generation === readerGeneration;
}

export function hideCollectionContent() {
  const panel = $('#collection-content-panel');
  if (panel) panel.style.display = 'none';
}

function scrollToPanel(panel) {
  panel.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
}

// hideCollectionContent() (above) and hideSearchResults() are the mutual-
// exclusion mechanism between search and the reader: runSearch() calls the
// former, openSectionView()/openFileView() call the latter, so main ever
// shows one content surface at a time, never both stacked.
export function hideSearchResults() {
  const status = $('#search-status');
  const results = $('#search-results');
  if (status) status.innerHTML = '';
  if (results) results.innerHTML = '';
}

// A chunk belongs to a section node if its own node_path is the section's
// node_path, or a descendant of it ("<section path>/<child>"). Exact
// structural lineage set by the indexer, not a label comparison — used only
// by the alternate Chunks mode's client-side filter; Document mode gets its
// exact section slice from the assembly API itself (resolved server-side
// through the skeleton node's parent_id).
export function chunksBelongToSection(chunks, sectionNodePath) {
  if (!sectionNodePath) return [];
  const prefix = `${sectionNodePath}/`;
  return chunks.filter(c => c.nodePath === sectionNodePath || c.nodePath?.startsWith(prefix));
}

/**
 * Open a section node — fetches the exact section assembly:
 * GET /api/collections/:name/assembly?scope=section&nodePath=...
 * The backend resolves section identity through the skeleton node and
 * parent_id (Phase 3V) — no whole-file fetch + browser-side path filtering,
 * no heading-text guessing, no anchor/window fallback on the default path.
 * A real empty section (200, segments: []) and an unknown-section 404 both
 * show the clean "no indexed content" state, with an "Open file" action
 * when the source file is known.
 */
export async function openSectionView(name, node) {
  const panel = $('#collection-content-panel');
  const title = $('#content-title');
  const box = $('#collection-content');
  if (!panel || !box) return;

  hideSearchResults();
  panel.style.display = '';
  title.textContent = nodeDisplayLabel(node);
  box.innerHTML = emptyBox('loading…');
  scrollToPanel(panel);

  const state = newReaderState({
    collection: name,
    scope: 'section',
    sourceFile: node.sourceFile ?? null,
    nodePath: node.nodePath,
    titleText: nodeDisplayLabel(node),
    node,
  });

  try {
    const qs = `scope=section&nodePath=${encodeURIComponent(node.nodePath)}`;
    const assembly = await api(`/api/collections/${encodeURIComponent(name)}/assembly?${qs}`);
    if (!isCurrent(state)) return;
    state.assembly = assembly;
    // A URL-restored node may only carry nodePath — the assembly response
    // knows the real source file (needed for Chunks mode and "Open file").
    if (!state.sourceFile && assembly.sourceFile) state.sourceFile = assembly.sourceFile;
    if (!assembly.segments?.length) {
      renderEmptySectionState(box, state);
      return;
    }
    renderReader(state);
  } catch (err) {
    if (!isCurrent(state)) return;
    if (err.status === 404) {
      renderEmptySectionState(box, state);
      return;
    }
    box.innerHTML = errorBox(err);
  }
}

function renderEmptySectionState(box, state) {
  box.innerHTML = emptyBox('This section has no indexed content.');
  if (state.sourceFile) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mini-btn';
    btn.id = 'section-open-file-start';
    btn.textContent = 'Open file';
    // Whole-file document open — "let me read the file since this section
    // has nothing" is a browse-the-file intent, not a jump to one chunk.
    btn.addEventListener('click', () => openFileView(state.collection, state.sourceFile));
    box.querySelector('.empty')?.append(' ', btn);
  }
}

/**
 * Open a file — fetches the assembled document:
 * GET /api/collections/:name/assembly?scope=file&sourceFile=...
 * and renders Document mode by default. The /chunks fetch is LAZY: it only
 * happens the first time the user switches this open file to Chunks mode,
 * and is cached on the reader state, so Document -> Chunks -> Document ->
 * Chunks never refetches either representation.
 *
 * `chunkIndex` (from a search-result open) marks the target: Document mode
 * highlights the assembled segment carrying that data-chunk-index and
 * scrolls it into view — it does not switch the reader to Chunks mode.
 */
export async function openFileView(name, sourceFile, nodePath, chunkIndex) {
  const panel = $('#collection-content-panel');
  const title = $('#content-title');
  const box = $('#collection-content');
  if (!panel || !box) return;

  hideSearchResults();
  panel.style.display = '';
  title.textContent = basename(sourceFile) || sourceFile;
  box.innerHTML = emptyBox('loading…');
  scrollToPanel(panel);

  const state = newReaderState({
    collection: name,
    scope: 'file',
    sourceFile,
    nodePath: nodePath ?? null,
    targetChunkIndex: Number.isInteger(chunkIndex) ? chunkIndex : null,
    titleText: basename(sourceFile) || sourceFile,
  });

  try {
    const qs = `scope=file&sourceFile=${encodeURIComponent(sourceFile)}`;
    const assembly = await api(`/api/collections/${encodeURIComponent(name)}/assembly?${qs}`);
    if (!isCurrent(state)) return;
    state.assembly = assembly;
    if (!assembly.segments?.length) {
      box.innerHTML = emptyBox('No searchable chunks in this file. It may only contain navigation/metadata or unsupported content.');
      return;
    }
    renderReader(state);
  } catch (err) {
    if (!isCurrent(state)) return;
    if (err.status === 404) {
      // The assembly endpoint 404s a file with zero content chunks — a
      // normal, expected state (e.g. frontmatter-only), not an error.
      box.innerHTML = emptyBox('No searchable chunks in this file. It may only contain navigation/metadata or unsupported content.');
      return;
    }
    box.innerHTML = errorBox(err);
  }
}

// ── reader rendering ────────────────────────────────────────────────────────

function renderReader(state) {
  const box = $('#collection-content');
  if (!box) return;

  if (state.mode === 'document') {
    const header = readerHeader(state);
    const banners = renderAssemblyBanners(state.assembly);
    const { root, target } = renderAssemblySegments(state.assembly, { targetChunkIndex: state.targetChunkIndex });
    box.replaceChildren(header, ...banners, root);
    target?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
    return;
  }

  // Chunks mode — cards, five-at-a-time client-side reveal.
  renderVisibleFileChunks(box, Math.min(FILE_PAGE_SIZE, state.chunks.length), readerHeader(state));
}

// The segmented Document | Chunks control (real buttons, aria-pressed) —
// presentation-only: switching modes never touches the route/history.
function readerModeToggle(state) {
  const frag = cloneTemplate('tpl-reader-mode-toggle');
  const toggle = frag.querySelector('.reader-mode-toggle');
  for (const btn of toggle.querySelectorAll('.reader-mode-btn')) {
    const mode = btn.dataset.mode;
    btn.classList.toggle('active', state.mode === mode);
    btn.setAttribute('aria-pressed', String(state.mode === mode));
    btn.addEventListener('click', () => setReaderMode(mode));
  }
  return toggle;
}

export async function setReaderMode(mode) {
  const state = readerState;
  if (!state || state.mode === mode) return;
  state.mode = mode;

  if (mode === 'chunks' && state.chunks === null) {
    const box = $('#collection-content');
    if (box) box.innerHTML = emptyBox('loading…');
    try {
      const chunks = await fetchReaderChunks(state);
      if (!isCurrent(state)) return;
      state.chunks = chunks;
    } catch (err) {
      if (!isCurrent(state)) return;
      // Recover, don't strand: the Document view is still fully cached on
      // the reader state — re-render it (header, toggle and all) so the
      // user keeps a working reader and can simply retry the toggle, and
      // surface the failure as a non-blocking toast instead of replacing
      // the whole surface with a bare error box that has no way back.
      state.mode = 'document';
      renderReader(state);
      showToast(`Couldn't load chunks: ${err.message}`, { variant: 'error' });
      return;
    }
  }

  if (!isCurrent(state)) return;
  renderReader(state);
}

// The lazy /chunks fetch behind Chunks mode. File scope: the whole file.
// Section scope: the whole file filtered by exact node_path lineage
// (chunksBelongToSection) — the same exact-identity rule as before, kept
// for the alternate view only; it never drives the default Document path.
async function fetchReaderChunks(state) {
  const qs = `sourceFile=${encodeURIComponent(state.sourceFile)}`;
  const { chunks } = await api(`/api/collections/${encodeURIComponent(state.collection)}/chunks?${qs}`);
  return state.scope === 'section' ? chunksBelongToSection(chunks, state.nodePath) : chunks;
}

// Builds the "what is actually open" header block: file/section icon +
// name, the reader-mode toggle, and a meta line giving the relative source
// path and collection name as secondary context. In Document mode the
// technical "N chunks" badge is hidden (a document reader doesn't lead with
// index internals); Chunks mode shows the real fetched count. All user/API-
// derived text goes through textContent — source paths and collection names
// are untrusted API content.
function readerHeader(state) {
  const isSection = state.scope === 'section';
  const headingPath = isSection && Array.isArray(state.node?.headingPath) && state.node.headingPath.length
    ? state.node.headingPath.join(' › ')
    : null;
  const header = fileViewHeader({
    nodeType: isSection ? 'section' : 'file',
    name: state.titleText,
    sourceFile: state.sourceFile,
    collectionName: state.collection,
    count: state.mode === 'chunks' && Array.isArray(state.chunks) ? state.chunks.length : undefined,
    metaExtra: headingPath,
  });
  header.querySelector('.file-view-title-row')?.appendChild(readerModeToggle(state));
  return header;
}

// Renders readerState.chunks[0..count) into #collection-content, plus a
// "load more" button when more remain. The header (built by the caller) is
// preserved by prepending it back in, since "load more" only ever changes
// the cards below it.
function renderVisibleFileChunks(box, count, headerEl) {
  readerState.visibleCount = count;
  const visible = readerState.chunks.slice(0, count);
  box.replaceChildren(renderFileChunks(visible, readerState.targetChunkIndex ?? undefined));
  if (count < readerState.chunks.length) {
    box.insertAdjacentHTML('beforeend', fileViewLoadMoreButton());
    wireFileViewButtons(box);
  }
  if (headerEl) box.prepend(headerEl);
}

function fileViewHeader({ nodeType, name, sourceFile, collectionName, count, metaExtra }) {
  const frag = cloneTemplate('tpl-file-view-header');
  const root = frag.querySelector('.file-view-header');
  frag.querySelector('.file-view-icon').innerHTML = nodeType === 'section' ? iconSection() : iconFile();
  frag.querySelector('.file-view-name').textContent = name;

  const countEl = frag.querySelector('.file-view-count');
  if (typeof count === 'number') {
    countEl.textContent = `${count} chunk${count === 1 ? '' : 's'}`;
  } else {
    countEl.hidden = true;
  }

  const metaParts = [sourceFile, collectionName ? `in ${collectionName}` : null, metaExtra].filter(Boolean);
  frag.querySelector('.file-view-meta').textContent = metaParts.join(' · ');

  return root;
}

// Structural node types get an inline chunk annotated with their own type +
// nearby prose (see entityContext() in the indexer) rather than a plain
// section-path breadcrumb — labeled distinctly so it doesn't read as if it
// were more prose content.
export const STRUCTURAL_NODE_TYPES = new Set(['table', 'code_block', 'checklist']);

export const NODE_TYPE_BADGE_LABEL = {
  code_block: 'code',
  table: 'table',
  checklist: 'checklist',
  list: 'list',
  paragraph: 'paragraph',
  blockquote: 'blockquote',
  image: 'image',
  section: 'section',
  file: 'file',
  directory: 'directory',
};

export function nodeTypeBadgeLabel(nodeType) {
  return NODE_TYPE_BADGE_LABEL[nodeType] ?? nodeType;
}

// Icon prefix for structural node-type badges only (table/code/checklist) —
// the rest (paragraph, list, blockquote, image, section, file, directory)
// stay plain text badges, matching the icon set actually built in icons.js.
const STRUCTURAL_NODE_TYPE_ICON = {
  table: iconTable,
  code_block: iconCodeBlock,
  checklist: iconChecklist,
};

export function nodeTypeBadgeIcon(nodeType) {
  return STRUCTURAL_NODE_TYPE_ICON[nodeType]?.() ?? '';
}

// Builds a DocumentFragment of chunk-card elements from the tpl-chunk-card
// template. Returns a fragment (not an HTML string) so callers can append it
// directly or insert it before an existing element.
//
// targetChunkIndex (optional) marks the chunk a search open resolved to —
// it gets a distinct ".chunk-target" class so it's visually obvious which of
// several same-looking cards is "the" one.
export function renderFileChunks(chunks, targetChunkIndex) {
  const out = document.createDocumentFragment();
  for (const c of chunks) {
    const isStructural = STRUCTURAL_NODE_TYPES.has(c.nodeType);
    const contextLabel = isStructural ? 'retrieval context' : 'section path';
    const frag = cloneTemplate('tpl-chunk-card');
    const card = frag.querySelector('.chunk');
    if (targetChunkIndex !== undefined && c.chunkIndex === targetChunkIndex) {
      card.classList.add('chunk-target');
    }

    card.querySelector('.chunk-index-label').textContent =
      `chunk ${c.chunkIndex}${c.totalChunks ? ` / ${c.totalChunks}` : ''}`;
    card.querySelector('.chunk-section').textContent = c.section || 'intro';

    const nodeTypeEl = card.querySelector('.chunk-node-type');
    if (c.nodeType) {
      // innerHTML (not textContent) so the structural-type icon can sit
      // alongside the label — the label text itself is still escaped, and
      // nodeTypeBadgeIcon() only ever returns this module's own static SVG
      // strings (never chunk/user data), so this stays safe.
      nodeTypeEl.innerHTML = nodeTypeBadgeIcon(c.nodeType) + esc(nodeTypeBadgeLabel(c.nodeType));
      nodeTypeEl.title = `node_type: ${c.nodeType}`;
      nodeTypeEl.hidden = false;
    }

    const contextEl = card.querySelector('.chunk-context');
    if (c.context) {
      card.querySelector('.chunk-context-label').textContent = `${contextLabel}:`;
      card.querySelector('.chunk-context-text').textContent = c.context;
      contextEl.hidden = false;
    }

    renderChunkContent(card.querySelector('.chunk-text'), c);
    out.appendChild(frag);
  }
  return out;
}

export function fileViewLoadMoreButton() {
  return '<button type="button" class="mini-btn" id="file-load-more">load more</button>';
}

export function wireFileViewButtons(box) {
  const btn = box.querySelector('#file-load-more');
  btn?.addEventListener('click', loadMoreFileChunks);
}

// Chunks mode "load more": everything is already fetched (the lazy /chunks
// call ran once when Chunks mode was first entered) — this just reveals the
// next page from memory, same as search.js's showMoreResults(), no network
// call at all. (The old windowed re-fetching branch is gone with the
// windowed open mode itself — search opens now land in Document mode.)
export async function loadMoreFileChunks() {
  if (!readerState || readerState.mode !== 'chunks' || !Array.isArray(readerState.chunks)) return;
  const box = $('#collection-content');
  if (!box) return;
  const header = box.querySelector('.file-view-header');
  const nextCount = Math.min(readerState.visibleCount + FILE_PAGE_SIZE, readerState.chunks.length);
  renderVisibleFileChunks(box, nextCount, header);
}
