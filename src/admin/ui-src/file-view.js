// ── selected file/section view ────────────────────────────────────────────
// Replaces the old standalone "Documents" card: clicking a file or section
// in the sidebar tree loads its chunks directly into the main content area,
// with "load more" pagination and a scoped search-within-file shortcut.
// No separate document list lives in the main panel anymore.
import { $, cloneTemplate, errorBox, emptyBox, prefersReducedMotion } from './dom.js';
import { api } from './api.js';
import { nodeDisplayLabel } from './format.js';

let fileViewState = null; // { name, sourceFile, chunkIndex, loaded }

export function hideCollectionContent() {
  const panel = $('#collection-content-panel');
  if (panel) panel.style.display = 'none';
}

function scrollToPanel(panel) {
  panel.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
}

// hideCollectionContent() (above) and hideSearchResults() are the mutual-
// exclusion mechanism between search and file/section view: runSearch()
// calls the former, openSectionView()/openFileView() call the latter, so
// main ever shows one content surface at a time, never both stacked.
export function hideSearchResults() {
  const status = $('#search-status');
  const results = $('#search-results');
  if (status) status.innerHTML = '';
  if (results) results.innerHTML = '';
}

/**
 * Resolve a section nav node to its actual first content chunk via
 * GET .../skeleton/anchor, then open the file view there. If the section
 * has no content chunks (e.g. an empty section), this does NOT silently
 * open chunk 0 of the file — that would look identical to a resolved
 * section and hide the fact that the section itself is empty. Instead it
 * shows an explicit message with an opt-in "Open file from start" button.
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

  try {
    const qs = `nodePath=${encodeURIComponent(node.nodePath)}`;
    const { chunk } = await api(`/api/collections/${encodeURIComponent(name)}/skeleton/anchor?${qs}`);
    return openFileView(name, chunk.sourceFile, node.nodePath, chunk.chunkIndex);
  } catch (err) {
    if (err.status === 404) {
      box.innerHTML = '<div class="empty">This section has no indexed content.'
        + (node.sourceFile ? ' <button type="button" class="mini-btn" id="section-open-file-start">Open file from start</button>' : '')
        + '</div>';
      const btn = box.querySelector('#section-open-file-start');
      btn?.addEventListener('click', () => openFileView(name, node.sourceFile, node.nodePath, 0));
      return;
    }
    box.innerHTML = errorBox(err);
  }
}

export async function openFileView(name, sourceFile, nodePath, chunkIndex = 0) {
  const panel = $('#collection-content-panel');
  const title = $('#content-title');
  const box = $('#collection-content');
  if (!panel || !box) return;

  hideSearchResults();
  panel.style.display = '';
  title.textContent = sourceFile;
  box.innerHTML = emptyBox('loading…');
  scrollToPanel(panel);

  fileViewState = { name, sourceFile, chunkIndex, loaded: 0 };

  try {
    const qs = `sourceFile=${encodeURIComponent(sourceFile)}&chunkIndex=${chunkIndex}&window=3`;
    const { chunks } = await api(`/api/collections/${encodeURIComponent(name)}/chunks?${qs}`);
    if (!chunks.length) {
      box.innerHTML = emptyBox('No chunks found for this file/section.');
      return;
    }
    // `loaded` tracks the next not-yet-shown chunk index, not a count — the
    // /chunks endpoint centers its window on chunkIndex (returns
    // [chunkIndex-window, chunkIndex+window]), so when chunkIndex > 0 the
    // returned chunks don't start at 0 and chunks.length would under-count
    // how far into the file we actually are, making loadMoreFileChunks()
    // re-fetch and duplicate chunks already shown instead of continuing.
    fileViewState.loaded = Math.max(...chunks.map(c => c.chunkIndex + 1));
    title.textContent = typeof chunks[0].totalChunks === 'number'
      ? `${sourceFile} — ${chunks[0].totalChunks} chunks`
      : sourceFile;
    box.replaceChildren(renderFileChunks(chunks));
    box.insertAdjacentHTML('beforeend', fileViewLoadMoreButton());
    wireFileViewButtons(box);
  } catch (err) {
    box.innerHTML = errorBox(err);
  }
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

// Builds a DocumentFragment of chunk-card elements from the tpl-chunk-card
// template. Returns a fragment (not an HTML string) so callers can append it
// directly or insert it before an existing element.
export function renderFileChunks(chunks) {
  const out = document.createDocumentFragment();
  for (const c of chunks) {
    const isStructural = STRUCTURAL_NODE_TYPES.has(c.nodeType);
    const contextLabel = isStructural ? 'retrieval context' : 'section path';
    const frag = cloneTemplate('tpl-chunk-card');
    const card = frag.querySelector('.chunk');

    card.querySelector('.chunk-index-label').textContent =
      `chunk ${c.chunkIndex}${c.totalChunks ? ` / ${c.totalChunks}` : ''}`;
    card.querySelector('.chunk-section').textContent = c.section || 'intro';

    const nodeTypeEl = card.querySelector('.chunk-node-type');
    if (c.nodeType) {
      nodeTypeEl.textContent = nodeTypeBadgeLabel(c.nodeType);
      nodeTypeEl.title = `node_type: ${c.nodeType}`;
      nodeTypeEl.hidden = false;
    }

    const contextEl = card.querySelector('.chunk-context');
    if (c.context) {
      card.querySelector('.chunk-context-label').textContent = `${contextLabel}:`;
      card.querySelector('.chunk-context-text').textContent = c.context;
      contextEl.hidden = false;
    }

    card.querySelector('.chunk-text').textContent = c.text ?? '';
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

export async function loadMoreFileChunks() {
  if (!fileViewState) return;
  const { name, sourceFile, loaded } = fileViewState;
  const box = $('#collection-content');
  const btn = $('#file-load-more');
  if (btn) btn.disabled = true;

  try {
    const nextIndex = loaded; // window fetch below re-centers; simplest
                              // "more" step is the next un-seen chunk index.
    const qs = `sourceFile=${encodeURIComponent(sourceFile)}&chunkIndex=${nextIndex}&window=3`;
    const { chunks } = await api(`/api/collections/${encodeURIComponent(name)}/chunks?${qs}`);
    const newOnes = chunks.filter(c => c.chunkIndex >= loaded);
    if (!newOnes.length) {
      btn?.remove();
      return;
    }
    fileViewState.loaded = Math.max(loaded, ...newOnes.map(c => c.chunkIndex + 1));
    btn?.before(renderFileChunks(newOnes));
    if (btn) btn.disabled = false;
  } catch (err) {
    box.insertAdjacentHTML('beforeend', errorBox(err));
  }
}
