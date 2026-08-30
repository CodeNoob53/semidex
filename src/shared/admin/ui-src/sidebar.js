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

// A calm, non-technical message for a failed fetch inside the sidebar tree
// — sidebar.js used to render the raw err.message (an internal server
// string, or the bare fallback "HTTP 500" from api.js) directly into the
// tree with the exact same styling as a legitimate "nothing here yet"
// empty state, which read like leaked debug output and gave the user no
// way to tell "this collection is empty" apart from "this failed to
// load." The real error is still in the DOM (title attribute) for anyone
// who needs it, but the visible text and styling are now both distinct
// from an empty state.
function treeErrorBox(err) {
  // .tree-loading for layout (padding/indent, shared with the loading/
  // empty states so nothing shifts), .tree-error for the distinct color.
  return `<div class="tree-loading tree-error" title="${esc(err.message)}">Couldn't load this. Try again.</div>`;
}

export async function loadSidebar() {
  const list = $('#collection-list');
  try {
    const { collections } = await api('/api/collections');
    collectionsCache = collections;
    if (!collections.length) {
      list.innerHTML = '<li class="muted">No collections yet. Create one to get started.</li>';
      return;
    }
    renderSidebarList(collections);
    markActive();
  } catch (err) {
    list.innerHTML = `<li class="muted tree-error" title="${esc(err.message)}">Couldn't load collections. Try again.</li>`;
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
    box.innerHTML = treeErrorBox(err);
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
      box.innerHTML = '<div class="tree-loading">No documents indexed in this collection yet.</div>';
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
    box.innerHTML = treeErrorBox(err);
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

// Expands whatever collapsed ancestor directories stand between the
// sidebar tree's root and a given sourceFile, then highlights that file's
// row — the "minimal expansion required to reveal the active file" the
// task asks for (Phase 3R), used when a file is opened from somewhere
// other than a direct sidebar click (currently: search-result "Open").
// A plain sidebar click never needs this — the row the user clicked is
// already visible by definition.
//
// Directory node_path follows the indexer's own fixed convention
// ("<collection>#dir/<dirPath>", skeleton-index.js) — derivable purely
// from sourceFile's own directory segments, no extra API round-trip needed
// to discover the ancestor chain itself. Each level is still expanded one
// at a time via the real skeleton/children fetch (not guessed/skipped),
// since which nodes actually exist under a given ancestor is only known
// once that level has been fetched.
export async function revealSidebarPath(name, sourceFile) {
  const segments = String(sourceFile).split('/').filter(Boolean);
  segments.pop(); // drop the filename itself — only directory segments expand
  if (!segments.length) return; // file lives at the collection root — nothing to expand

  const box = $(`#tree-${cssId(name)}`);
  if (!box) return;

  let container = box;
  let depth = 0;
  let dirPath = '';
  for (const segment of segments) {
    dirPath = dirPath ? `${dirPath}/${segment}` : segment;
    const targetPath = `${name}#dir/${dirPath}`;
    let row = container.querySelector(`:scope > .tree-node[data-path="${cssEscapeAttr(targetPath)}"]`);
    if (!row) return; // this ancestor isn't in the currently-rendered level — give up quietly, no error UI for a best-effort reveal
    let sub = row.nextElementSibling;
    if (!sub?.classList.contains('tree-subtree')) {
      row.querySelector('.tree-caret').textContent = '▾';
      sub = document.createElement('div');
      sub.className = 'tree-subtree';
      row.insertAdjacentElement('afterend', sub);
      await renderSidebarSkeletonLevel(sub, name, { nodePath: targetPath, childCount: 1 }, depth + 1);
    }
    container = sub;
    depth += 1;
  }
}

// Phase 4A.5c: settings category navigation, rendered into #settings-nav-list
// (a sibling of the collection tree inside <nav class="sidebar">, see
// index.html). Categories always come from GET /api/settings's own
// `categories` array — never a hardcoded order here — so the sidebar and
// the API can never drift apart.
export function renderSettingsNav(categories, activeCategory) {
  const list = $('#settings-nav-list');
  if (!list) return;
  list.innerHTML = categories.map((c) => `
    <li><a href="#/settings/${encodeURIComponent(c.id)}" data-category="${esc(c.id)}" class="${c.id === activeCategory ? 'active' : ''}">${esc(c.label)}</a></li>
  `).join('');
}

// Toggles which sidebar block is visible: the collection tree
// (#collection-nav) or the settings category list (#settings-nav) — exactly
// one of the two, based on route.view. Also toggles `.settings-compact` on
// `.layout`, which (below the existing 720px breakpoint) hides the sidebar
// column entirely in favor of global-settings-view.js's own inline category
// selector — see app.css.
export function syncSidebarMode(route) {
  const isSettings = route.view === 'global-settings';
  const collectionNav = document.getElementById('collection-nav');
  const settingsNav = document.getElementById('settings-nav');
  if (collectionNav) collectionNav.hidden = isSettings;
  if (settingsNav) settingsNav.hidden = !isSettings;
  document.querySelector('.layout')?.classList.toggle('settings-compact', isSettings);
}

// Toggles both the visual .active class and aria-current="page" together —
// aria-current must be genuinely absent on an inactive link, not just set
// to a falsy string, so it is removed via removeAttribute() rather than
// setAttribute(..., 'false').
function setShellNavActive(el, isActive) {
  if (!el) return;
  el.classList.toggle('active', isActive);
  if (isActive) el.setAttribute('aria-current', 'page');
  else el.removeAttribute('aria-current');
}

export function markActive(route = currentRoute()) {
  for (const a of document.querySelectorAll('.tree-collection-row')) {
    a.classList.toggle('active', route.view !== 'index' && a.dataset.name === route.name);
  }
  $('#nav-index')?.classList.toggle('active', route.view === 'index');
  // S2A shell-level navigation (design plan §4.1/§4.2): distinct from the
  // topbar brand link (#nav-home, always "#/") — these are the sidebar's
  // own Overview/Collections entries, kept in sync the same way every other
  // nav row already is. aria-current="page" is set/removed alongside the
  // .active class (not just the class alone) so assistive tech gets the
  // same "this is where you are" signal a sighted user gets from the
  // active row's background/border/weight — and is explicitly removed
  // (not merely left stale) on every inactive link.
  setShellNavActive($('#nav-overview'), route.view === 'overview');
  setShellNavActive($('#nav-collections'), route.view === 'collections');
  // Phase 4A.5b: topbar gear link -> #/settings (global runtime settings) —
  // lives outside the sidebar tree but shares this same active-state pass
  // since router.js already calls markActive() on every navigation. Now
  // means "any settings route is active" (Phase 4A.5c), not tied to a
  // single flat state.
  $('#nav-global-settings')?.classList.toggle('active', route.view === 'global-settings');
  if (route.view === 'global-settings') {
    for (const a of document.querySelectorAll('#settings-nav-list a')) {
      a.classList.toggle('active', a.dataset.category === route.category);
    }
  }

  // Extend active-state sync to the open file/section row inside the
  // expanded tree (Phase 3A) — file fallback rows carry data-sf, skeleton
  // tree rows carry data-path (added alongside this).
  for (const row of document.querySelectorAll('.tree-file, .tree-node')) {
    row.classList.remove('active');
  }
  if (route.openFile) {
    // A route.openFile (an "#/c/:name/f/:sourceFile" URL — a plain file
    // open with no section target) can be showing in either sidebar mode:
    // the flat-fallback file list (.tree-file, keyed by the raw sourceFile
    // in data-sf) or a skeleton tree's own file row (.tree-node, keyed by
    // its nodePath in data-path). Both are tried — at most one will ever
    // match, since a given collection only ever renders one mode at a time
    // — rather than requiring the caller to know which mode is active.
    // "<sourceFile>#file" is the indexer's own file-node-path convention
    // (skeleton-index.js), not a guess: every skeleton file node's
    // node_path is built exactly this way, so this is a stable derivation,
    // not a heuristic.
    document.querySelector(`.tree-file[data-sf="${cssEscapeAttr(route.openFile)}"]`)?.classList.add('active');
    document.querySelector(`.tree-node[data-path="${cssEscapeAttr(`${route.openFile}#file`)}"]`)?.classList.add('active');
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
