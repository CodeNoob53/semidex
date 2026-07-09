// ── sidebar: collection list + embedded navigation tree ───────────────────
// This is the main navigation surface (design correction, Phase 2E): a
// collection's skeleton (or a flat file list when no skeleton exists) is
// shown INSIDE the sidebar, under the selected collection — not as a
// separate main-panel card. Selecting a file/section changes the main
// panel's content; it does not navigate away from the sidebar tree.
import { $, esc } from './dom.js';
import { api } from './api.js';
import { nodeDisplayLabel, shortLabel } from './format.js';
import { currentRoute } from './routes.js';
import { getExpandedCollection, setExpandedCollection } from './state.js';
import { iconCollection, iconFile, iconForNodeType } from './icons.js';

let collectionsCache = [];

export async function loadSidebar() {
  const list = $('#collection-list');
  try {
    const { collections } = await api('/api/collections');
    collectionsCache = collections;
    if (!collections.length) {
      list.innerHTML = '<li class="muted">no collections yet</li>';
      return;
    }
    renderSidebarList(collections);
    markActive();
  } catch (err) {
    list.innerHTML = `<li class="muted">${esc(err.message)}</li>`;
  }
}

export function renderSidebarList(collections) {
  const list = $('#collection-list');
  list.innerHTML = collections.map(c => `
    <li class="tree-collection">
      <a href="#/c/${encodeURIComponent(c.name)}" data-name="${esc(c.name)}" class="tree-row tree-collection-row">
        <span class="tree-caret">${getExpandedCollection() === c.name ? '▾' : '▸'}</span>
        <span class="tree-icon">${iconCollection()}</span>
        <span class="tree-label">${esc(c.name)}</span>
        <span class="count">${Number(c.pointCount ?? 0).toLocaleString('en-US')}</span>
      </a>
      <div class="tree-children" id="tree-${cssId(c.name)}" ${getExpandedCollection() === c.name ? '' : 'style="display:none"'}></div>
    </li>`).join('');

  for (const row of list.querySelectorAll('.tree-collection-row')) {
    row.addEventListener('click', (e) => {
      e.preventDefault();
      const name = row.dataset.name;
      location.hash = `#/c/${encodeURIComponent(name)}`;
      toggleSidebarTree(name);
    });
  }

  if (getExpandedCollection() && collections.some(c => c.name === getExpandedCollection())) {
    loadSidebarTree(getExpandedCollection());
  }
}

export function cssId(name) {
  // Sidebar node ids only need to be unique+stable, not reversible — a
  // simple non-alnum strip keeps CSS.escape out of hot render paths.
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function toggleSidebarTree(name) {
  const willExpand = getExpandedCollection() !== name;
  setExpandedCollection(willExpand ? name : null);
  renderSidebarList(collectionsCache);
}

// Re-renders the sidebar list from its own cached collections — used by
// collection-view.js when it changes which collection is expanded (via
// state.js's setExpandedCollection) so the sidebar's caret/highlight state
// stays in sync without collection-view.js needing access to sidebar.js's
// private collectionsCache.
export function refreshSidebarList() {
  renderSidebarList(collectionsCache);
}

/**
 * Populate the sidebar tree for a collection: skeleton root -> children if
 * skeleton nav exists, otherwise a flat file list from listSourceDocuments.
 * This is the "main purpose of skeleton in UI" — a navigator, not a panel.
 */
export async function loadSidebarTree(name) {
  const box = $(`#tree-${cssId(name)}`);
  if (!box) return;
  box.innerHTML = '<div class="tree-loading">loading…</div>';

  let detail;
  try {
    detail = (await api(`/api/collections/${encodeURIComponent(name)}`)).collection;
  } catch (err) {
    box.innerHTML = `<div class="tree-loading">${esc(err.message)}</div>`;
    return;
  }

  if (!detail.hasSkeleton) {
    return loadSidebarFileList(name, box);
  }

  try {
    const { skeleton } = await api(`/api/collections/${encodeURIComponent(name)}/skeleton`);
    if (!skeleton) return loadSidebarFileList(name, box);
    renderSidebarSkeletonLevel(box, name, skeleton, 0);
  } catch {
    return loadSidebarFileList(name, box);
  }
}

export async function loadSidebarFileList(name, box) {
  try {
    const { documents } = await api(`/api/collections/${encodeURIComponent(name)}/documents?limit=200`);
    if (!documents.length) {
      box.innerHTML = '<div class="tree-loading">No documents.</div>';
      return;
    }
    box.innerHTML = documents.map(d => `
      <a href="#/c/${encodeURIComponent(name)}/f/${encodeURIComponent(d.sourceFile)}"
         class="tree-row tree-file" data-sf="${esc(d.sourceFile)}" style="--depth:1">
        <span class="tree-icon">${iconFile()}</span>
        <span class="tree-label mono">${esc(shortLabel(d.sourceFile))}</span>
      </a>`).join('');
    // Left as plain <a href="#/c/...">: no click handler needed — the
    // browser's default navigation already updates location.hash and
    // hashchange -> route() opens the file, same single path used
    // everywhere else (back/forward, sidebar clicks, pasted URLs).
  } catch (err) {
    box.innerHTML = `<div class="tree-loading">${esc(err.message)}</div>`;
  }
}

async function renderSidebarSkeletonLevel(box, name, node, depth) {
  const children = await fetchSkeletonChildren(name, node);
  box.innerHTML = children.length
    ? children.map((n, i) => sidebarNodeRow(n, i, depth)).join('')
    : '<div class="tree-loading">No child nodes.</div>';

  for (const el of box.querySelectorAll(':scope > .tree-node')) {
    const node2 = children[Number(el.dataset.i)];
    const caret = el.querySelector('.tree-caret[data-caret]');
    // Caret gets its own click target (a directory/file-with-sections
    // expand toggle, independent of the row's own open/navigate action) —
    // stopPropagation so clicking it never also fires the row's handler.
    caret?.addEventListener('click', (e) => {
      e.stopPropagation();
      onSidebarCaretClick(name, node2, el, depth);
    });
    caret?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      onSidebarCaretClick(name, node2, el, depth);
    });
    el.addEventListener('click', () => onSidebarNodeClick(name, node2, el, depth));
    // .tree-node is a <div role="button">, not a native <button>/<a> — Enter
    // and Space don't trigger "click" on it automatically, so wire them here.
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target === caret) return; // caret has its own keydown handler above
      e.preventDefault();
      onSidebarNodeClick(name, node2, el, depth);
    });
  }
}

async function fetchSkeletonChildren(name, node) {
  const mayHaveChildren = (node.childCount ?? node.children?.length ?? 0) > 0;
  if (!mayHaveChildren || !node.nodePath) return [];
  try {
    const qs = `nodePath=${encodeURIComponent(node.nodePath)}&limit=200`;
    const body = await api(`/api/collections/${encodeURIComponent(name)}/skeleton/children?${qs}`);
    return body.children;
  } catch {
    return [];
  }
}

export function sidebarNodeRow(n, i, depth) {
  const isLeaf = n.nodeType === 'section' || n.nodeType === 'file' && !(n.childCount > 0);
  const label = nodeDisplayLabel(n);
  const tooltip = [n.summary, n.nodePath].filter(Boolean).join(' — ');
  // A file node with sections has BOTH a real action (open the whole file)
  // and an expand affordance (browse its sections) — those used to be the
  // same click target, which meant a file with any sections could never be
  // opened directly from the sidebar (every real file in a skeleton
  // collection has at least one section, so this made "click a file, see
  // its chunks" almost unreachable). The caret is now its own click target
  // (data-caret) for expand/collapse; clicking the row body always opens
  // the node when it's a file, and only expands for a directory.
  const caretIsClickable = n.nodeType === 'directory' || n.nodeType === 'file' && n.childCount > 0;
  // tabindex="0" + role="button": unlike .tree-collection-row/.tree-file
  // (real <a> tags, natively focusable), this is a plain <div> with a
  // click handler — without these it was unreachable by keyboard entirely.
  //
  // KNOWN A11Y DEBT (flagged in code review, not blocking): when
  // caretIsClickable, this nests a role="button" <span> (the caret) inside
  // a role="button" <div> (the row) — invalid ARIA nesting (interactive
  // roles must not nest). Works fine today for mouse/keyboard/tests since
  // the caret's own click/keydown handlers stopPropagation() before the
  // row's, but a screen reader may announce this oddly. A future cleanup
  // should restructure the row as a non-interactive container holding two
  // real sibling controls (an expand <button> + the file/section action),
  // rather than a role="button" wrapping another role="button".
  return `
    <div class="tree-row tree-node ${isLeaf ? 'tree-leaf' : ''}" data-i="${i}" data-path="${esc(n.nodePath ?? '')}" style="--depth:${depth + 1}" tabindex="0" role="button" aria-label="${esc(label)}">
      <span class="tree-caret"${caretIsClickable ? ' data-caret="1" role="button" tabindex="0" aria-label="Expand"' : ''}>${n.childCount > 0 ? '▸' : ''}</span>
      <span class="tree-icon">${iconForNodeType(n.nodeType)}</span>
      <span class="tree-label" title="${esc(tooltip)}">${esc(label)}</span>
    </div>`;
}

async function toggleSidebarNodeExpand(name, node, el, depth) {
  let sub = el.nextElementSibling;
  if (sub?.classList.contains('tree-subtree')) {
    sub.remove();
    el.querySelector('.tree-caret').textContent = '▸';
    return;
  }
  el.querySelector('.tree-caret').textContent = '▾';
  sub = document.createElement('div');
  sub.className = 'tree-subtree';
  el.insertAdjacentElement('afterend', sub);
  await renderSidebarSkeletonLevel(sub, name, node, depth + 1);
}

export async function onSidebarNodeClick(name, node, el, depth) {
  if (node.nodeType === 'section') {
    // Route through the hash (not a direct openSectionView call) so this
    // navigation is a single code path with clicking back/forward or
    // pasting a URL — route() resolves #/c/:name/n/:nodePath the same way,
    // including the anchor resolution to the section's first content chunk.
    location.hash = `#/c/${encodeURIComponent(name)}/n/${encodeURIComponent(node.nodePath)}`;
    return;
  }
  if (node.nodeType === 'file') {
    // A file always opens on a row-body click, whether or not it has
    // sections — expanding to browse sections is the caret's job now (see
    // onSidebarCaretClick), not this handler's.
    location.hash = `#/c/${encodeURIComponent(name)}/f/${encodeURIComponent(node.sourceFile ?? node.nodePath)}`;
    return;
  }
  // directory: expand/collapse inline, indented.
  await toggleSidebarNodeExpand(name, node, el, depth);
}

export async function onSidebarCaretClick(name, node, el, depth) {
  // Caret click must never also trigger the row's own open/navigate
  // behavior — expand/collapse only, for directories and files-with-
  // sections alike.
  await toggleSidebarNodeExpand(name, node, el, depth);
}

export function markActive(route = currentRoute()) {
  for (const a of document.querySelectorAll('.tree-collection-row')) {
    a.classList.toggle('active', route.view !== 'index' && a.dataset.name === route.name);
  }
  $('#nav-index')?.classList.toggle('active', route.view === 'index');

  // Extend active-state sync to the open file/section row inside the
  // expanded tree (Phase 3A) — file fallback rows carry data-sf, skeleton
  // tree rows carry data-path (added alongside this).
  for (const row of document.querySelectorAll('.tree-file, .tree-node')) {
    row.classList.remove('active');
  }
  if (route.openFile) {
    document.querySelector(`.tree-file[data-sf="${cssEscapeAttr(route.openFile)}"]`)?.classList.add('active');
  } else if (route.openNodePath) {
    document.querySelector(`.tree-node[data-path="${cssEscapeAttr(route.openNodePath)}"]`)?.classList.add('active');
  }
}

// Minimal CSS.escape-alike for building an attribute-value selector from
// arbitrary sourceFile/nodePath strings (which may contain quotes/backslashes)
// — avoids pulling in the full CSS.escape polyfill for one narrow use.
function cssEscapeAttr(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}
