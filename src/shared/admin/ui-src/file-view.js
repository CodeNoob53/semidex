// Stateless rendering helpers shared by Search and the lifecycle-owned reader.
// Request ownership, navigation, mode state, and pagination live exclusively
// in features/reader/view.js.
import { $, esc, cloneTemplate } from './dom.js';
import { iconTable, iconCodeBlock, iconChecklist, iconFile, iconSection } from './icons.js';
import { renderChunkContent } from './structural-renderer.js';

// Chunks mode pages its cards client-side, five at a time — same
// fetch-once/reveal-in-batches shape as search.js's Show more
// (SEARCH_PAGE_SIZE), unchanged from the pre-reader behavior.
export const FILE_PAGE_SIZE = 5;

export function hideCollectionContent() {
  const panel = $('#collection-content-panel');
  if (panel) panel.style.display = 'none';
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

export function fileViewHeader({ nodeType, name, sourceFile, collectionName, count, metaExtra }) {
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
export function renderFileChunks(chunks, targetChunkIndex, { signal } = {}) {
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

    renderChunkContent(card.querySelector('.chunk-text'), c, { signal });
    out.appendChild(frag);
  }
  return out;
}
