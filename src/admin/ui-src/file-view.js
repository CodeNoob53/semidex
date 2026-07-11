// ── selected file/section view ────────────────────────────────────────────
// Replaces the old standalone "Documents" card: clicking a file or section
// in the sidebar tree loads its chunks directly into the main content area,
// with "load more" pagination and a scoped search-within-file shortcut.
// No separate document list lives in the main panel anymore.
import { $, esc, cloneTemplate, errorBox, emptyBox, prefersReducedMotion } from './dom.js';
import { api } from './api.js';
import { nodeDisplayLabel, basename } from './format.js';
import { iconTable, iconCodeBlock, iconChecklist, iconFile, iconSection } from './icons.js';
import { renderChunkContent } from './structural-renderer.js';

// Whole-file mode (no target chunkIndex — a plain sidebar file click) fetches
// every chunk once via getFileChunks and pages through it client-side, the
// same "fetch once, reveal in batches" shape as search.js's Show more —
// FILE_PAGE_SIZE mirrors search.js's SEARCH_PAGE_SIZE for a consistent feel.
// Section-targeted opens (an explicit chunkIndex, from openSectionView's
// anchor resolution) keep the existing windowed fetch instead: the point
// there is "show me this one chunk in its immediate neighborhood," not "the
// whole file," and a file can be far too large to fetch in full just to
// jump to one chunk.
const FILE_PAGE_SIZE = 5;

let fileViewState = null; // { name, sourceFile, mode: 'whole' | 'windowed', allChunks, visibleCount } | { ..., mode: 'windowed', loaded }

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

// A chunk belongs to a section node if its own node_path is the section's
// node_path, or a descendant of it ("<section path>/<child>"). This is an
// exact structural match (parent/child node_path is authoritative, set by
// the indexer at index time), not a fuzzy label/string comparison — chunks
// don't carry a heading_path array (only skeleton nav nodes do), but they
// do carry the same node_path lineage as everything else in the skeleton
// tree, which is the reliable key to filter on.
export function chunksBelongToSection(chunks, sectionNodePath) {
  if (!sectionNodePath) return [];
  const prefix = `${sectionNodePath}/`;
  return chunks.filter(c => c.nodePath === sectionNodePath || c.nodePath?.startsWith(prefix));
}

function renderExactSectionMatch(box, title, name, sourceFile, node, sectionChunks) {
  fileViewState = { name, sourceFile, mode: 'whole', allChunks: sectionChunks, visibleCount: 0 };
  title.textContent = nodeDisplayLabel(node);
  const headingPath = Array.isArray(node.headingPath) && node.headingPath.length
    ? node.headingPath.join(' › ')
    : null;
  const header = fileViewHeader({
    nodeType: 'section', name: nodeDisplayLabel(node), sourceFile, collectionName: name,
    count: sectionChunks.length, metaExtra: headingPath ? `${headingPath} · exact section match` : 'exact section match',
  });
  renderVisibleFileChunks(box, Math.min(FILE_PAGE_SIZE, sectionChunks.length), header);
}

/**
 * Open a section node. Tries an exact match first: fetch every chunk in the
 * section's file (the existing whole-file /chunks endpoint — no new backend
 * needed) and keep only the ones whose node_path falls under the section's
 * own node_path. This is exact, not heuristic, because node_path lineage is
 * a structural fact the indexer sets, not a label comparison.
 *
 * This exact-match attempt runs BEFORE the /skeleton/anchor lookup, not
 * after — the backend's anchor resolver only finds chunks whose parent_id
 * is directly this section's node_id (getFirstContentChunkByParent), so a
 * section with no direct prose/table/code of its own but with content
 * nested under a CHILD section (a real, common shape: "## Setup" with no
 * prose of its own, just "### Step 1"/"### Step 2" subsections) would 404
 * out of the anchor call before chunksBelongToSection() — which explicitly
 * treats descendants as belonging to the section — ever got a chance to
 * run. Whole-file + prefix-filter has no such parent_id restriction, so it
 * must run first; /skeleton/anchor is now purely the fallback for when the
 * exact attempt finds nothing (either no sourceFile is known yet, or
 * filtering came up empty).
 *
 * If the exact attempt finds nothing, falls back to the existing
 * anchor-resolution + windowed-fetch + highlight behavior (GET
 * .../skeleton/anchor -> openFileView with a chunkIndex), which was already
 * correct and remains the safety net rather than inventing a fragile
 * secondary matching heuristic. The fallback header calls this out
 * explicitly ("showing nearby chunks") so the user knows they're looking at
 * a neighborhood, not a guaranteed-exact section slice — this is the
 * documented limitation the task's "if exact section filtering is not
 * reliable, document the limitation" instruction asks for. Only if BOTH the
 * exact attempt and the anchor fallback come up empty (a genuinely
 * content-free section) does this show the "no indexed content" empty
 * state.
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
    // Exact-match attempt first: only possible when the node already tells
    // us its file (sidebar section nodes carry sourceFile from the skeleton
    // API; a bare nodePath-only node, e.g. from a URL/back-forward restore,
    // does not — that case skips straight to the anchor fallback below).
    if (node.sourceFile) {
      const fileQs = `sourceFile=${encodeURIComponent(node.sourceFile)}`;
      const { chunks: fileChunks } = await api(`/api/collections/${encodeURIComponent(name)}/chunks?${fileQs}`);
      const sectionChunks = chunksBelongToSection(fileChunks, node.nodePath);
      if (sectionChunks.length) {
        renderExactSectionMatch(box, title, name, node.sourceFile, node, sectionChunks);
        return;
      }
    }

    // Exact attempt found nothing (or sourceFile wasn't known yet) — fall
    // back to anchor resolution. A 404 here means genuinely no content
    // anywhere under this section, handled in the catch block below.
    const qs = `nodePath=${encodeURIComponent(node.nodePath)}`;
    const { chunk } = await api(`/api/collections/${encodeURIComponent(name)}/skeleton/anchor?${qs}`);

    // sourceFile wasn't available on the node itself (the skip-straight-to-
    // anchor path above) — now that the anchor resolved it, retry the exact
    // match once more before falling back to the windowed view, so a
    // sourceFile-less node still gets the same exact-match treatment.
    if (!node.sourceFile) {
      const fileQs = `sourceFile=${encodeURIComponent(chunk.sourceFile)}`;
      const { chunks: fileChunks } = await api(`/api/collections/${encodeURIComponent(name)}/chunks?${fileQs}`);
      const sectionChunks = chunksBelongToSection(fileChunks, node.nodePath);
      if (sectionChunks.length) {
        renderExactSectionMatch(box, title, name, chunk.sourceFile, node, sectionChunks);
        return;
      }
    }

    // No chunk's node_path fell under this section — fall back to the
    // anchor-resolved windowed view rather than showing a false "empty"
    // section when the anchor lookup itself already found real content.
    return openFileView(name, chunk.sourceFile, node.nodePath, chunk.chunkIndex);
  } catch (err) {
    if (err.status === 404) {
      box.innerHTML = '<div class="empty">This section has no indexed content.'
        + (node.sourceFile ? ' <button type="button" class="mini-btn" id="section-open-file-start">Open file from start</button>' : '')
        + '</div>';
      const btn = box.querySelector('#section-open-file-start');
      // No chunkIndex -> whole-file mode: "open file from start" means
      // "let me read the file since this section has nothing," which is a
      // genuine "browse the whole file" intent, not a jump to one specific
      // chunk — the file view already renders top-to-bottom in order, so
      // whole-file mode already reads "from the start" without needing a
      // targeted chunkIndex=0 window fetch.
      btn?.addEventListener('click', () => openFileView(name, node.sourceFile));
      return;
    }
    box.innerHTML = errorBox(err);
  }
}

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

  // No target chunk given (a plain file click) -> whole-file mode: fetch
  // every chunk once, page through client-side. A target chunk given (a
  // section click, resolved to its anchor chunk) -> windowed mode: fetch a
  // small neighborhood around that one chunk and highlight it, matching
  // what a "jump to this specific part of a possibly-huge file" action
  // should do rather than pulling the entire file just to show one chunk.
  if (chunkIndex === undefined || chunkIndex === null) {
    fileViewState = { name, sourceFile, mode: 'whole', allChunks: [], visibleCount: 0 };
    try {
      const qs = `sourceFile=${encodeURIComponent(sourceFile)}`;
      const { chunks } = await api(`/api/collections/${encodeURIComponent(name)}/chunks?${qs}`);
      if (!chunks.length) {
        // Exact wording per the file/section-view cleanup brief: a file can
        // legitimately have zero retrieval chunks (e.g. it's entirely
        // frontmatter/metadata, or a type the indexer doesn't chunk) — this
        // is a normal, expected state, not an error, so it gets a plain
        // explanatory sentence rather than raw API/debug text.
        box.innerHTML = emptyBox('No searchable chunks in this file. It may only contain navigation/metadata or unsupported content.');
        return;
      }
      fileViewState.allChunks = chunks;
      title.textContent = basename(sourceFile) || sourceFile;
      const header = fileViewHeader({
        nodeType: 'file', name: basename(sourceFile) || sourceFile, sourceFile, collectionName: name, count: chunks.length,
      });
      renderVisibleFileChunks(box, Math.min(FILE_PAGE_SIZE, chunks.length), header);
    } catch (err) {
      box.innerHTML = errorBox(err);
    }
    return;
  }

  fileViewState = { name, sourceFile, mode: 'windowed', chunkIndex, loaded: 0 };
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
    const totalChunks = typeof chunks[0].totalChunks === 'number' ? chunks[0].totalChunks : null;
    title.textContent = basename(sourceFile) || sourceFile;
    const header = fileViewHeader({
      nodeType: 'file', name: basename(sourceFile) || sourceFile, sourceFile, collectionName: name,
      count: totalChunks, metaExtra: 'showing nearby chunks',
    });
    box.replaceChildren(header, renderFileChunks(chunks, chunkIndex));
    box.insertAdjacentHTML('beforeend', fileViewLoadMoreButton());
    wireFileViewButtons(box);
    box.querySelector('.chunk-target')?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
  } catch (err) {
    box.innerHTML = errorBox(err);
  }
}

// Renders fileViewState.allChunks[0..count) (whole-file mode) into
// #collection-content, plus a "load more" button when more remain — the
// same fetch-once/reveal-in-batches shape as search.js's
// renderVisibleResults(), reused here for a consistent feel between the two
// surfaces. The header (built once by the caller) is preserved by
// prepending it back in, rather than being part of the chunk render itself,
// since "load more" only ever changes the chunk cards below it.
function renderVisibleFileChunks(box, count, headerEl) {
  fileViewState.visibleCount = count;
  const visible = fileViewState.allChunks.slice(0, count);
  box.replaceChildren(renderFileChunks(visible));
  if (count < fileViewState.allChunks.length) {
    box.insertAdjacentHTML('beforeend', fileViewLoadMoreButton());
    wireFileViewButtons(box);
  }
  if (headerEl) box.prepend(headerEl);
}

// Builds the "what is actually open" header block (Phase 3H): file/section
// icon + name, a chunk-count badge, and a meta line giving the relative
// source path and collection name as secondary context — sits above the
// chunk cards, distinct from the small uppercase .panel-head label in the
// panel chrome above it. All user/API-derived text goes through
// textContent, never string-concatenated into markup, since source paths
// and collection names are untrusted API content.
//
// `count` is `undefined`/non-numeric to hide the badge, or a number once
// known. `metaExtra` is an optional extra phrase appended to the meta line
// (e.g. "exact section match" for an exact section view, or "showing
// nearby chunks" for any windowed/fallback open) — plain text, same
// escaping rule.
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
// targetChunkIndex (optional) marks the one chunk a section click actually
// resolved to — openFileView() scrolls to it and gives it a distinct
// ".chunk-target" class so it's visually obvious which of several
// same-looking chunk cards is "the" section content, not just "some chunk
// near the top of a window." Whole-file opens (no target) render every
// chunk plainly, since there's no one "the" chunk to single out.
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

export async function loadMoreFileChunks() {
  if (!fileViewState) return;

  // Whole-file mode: everything is already fetched (getFileChunks ran once
  // in openFileView) — "load more" just reveals the next page from memory,
  // same as search.js's showMoreResults(), no network call at all.
  if (fileViewState.mode === 'whole') {
    const box = $('#collection-content');
    // renderVisibleFileChunks() replaces every child of box (chunk cards +
    // load-more button), so the header built in openFileView() must be
    // detached and handed back in, or "load more" would silently drop it.
    const header = box.querySelector('.file-view-header');
    const nextCount = Math.min(fileViewState.visibleCount + FILE_PAGE_SIZE, fileViewState.allChunks.length);
    renderVisibleFileChunks(box, nextCount, header);
    return;
  }

  // Windowed mode (a section-anchored open): each "load more" click still
  // fetches the next window from the server, since the initial open
  // deliberately did NOT fetch the whole file.
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
