// semidex admin console - Phase 2E navigation-first dashboard.
// Vanilla JS, hash routing, Local API only. Built by Vite from ui-src to ui/.
// Talks exclusively to /api/* - never to any storage backend directly.
//
// Core model: the sidebar is the primary navigation surface (collection ->
// skeleton tree -> file -> section, matching the design doc's semidex-first
// framing). The main panel shows exactly one of: collection overview,
// search results, selected file/section content, or collection settings —
// never a stack of always-visible technical panels.
'use strict';

// Static view shells — the parts of each view that never depend on runtime
// data (loading placeholders, panel/form structure). Imported as raw text
// (Vite's `?raw` suffix) and swapped into `main.innerHTML` as-is; the
// dynamic content that fills the placeholder ids below is still rendered
// from JS, same as before.
import overviewShell from './partials/overview-shell.html?raw';
import collectionShell from './partials/collection-shell.html?raw';
import settingsShell from './partials/settings-shell.html?raw';
import indexViewShell from './partials/index-view.html?raw';

const $ = (sel, root = document) => root.querySelector(sel);

// ── tiny fetch client ─────────────────────────────────────────────────────
async function api(path) {
  const res = await fetch(path);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON is a bug upstream */ }
  if (!res.ok) {
    const message = body?.error?.message ?? `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function apiPost(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON is a bug upstream */ }
  if (!res.ok) {
    const message = body?.error?.message ?? `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function apiDelete(path) {
  const res = await fetch(path, { method: 'DELETE' });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON is a bug upstream */ }
  if (!res.ok) {
    const message = body?.error?.message ?? `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return body;
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// Clones a <template> declared in index.html (via <load ...> from
// partials/templates/*.html) and returns its content fragment. Callers fill
// in data with textContent/dataset/setAttribute, never innerHTML — the
// template markup itself is the only trusted HTML in play.
function cloneTemplate(id) {
  const tpl = document.getElementById(id);
  if (!tpl) throw new Error(`template #${id} not found — check index.html <load> tags`);
  return tpl.content.cloneNode(true);
}

// Returns an HTML string built from the error-state template + textContent
// (never string interpolation into markup) — err.message is untrusted API/
// network content. Callers still assign the result via innerHTML, but the
// string itself is always produced safely (textContent, not concatenation).
function errorBox(err) {
  const frag = cloneTemplate('tpl-error-state');
  frag.querySelector('.error-box').textContent = err.message;
  return frag.firstElementChild.outerHTML;
}

// Same idea as errorBox() for the empty-state template.
function emptyBox(message) {
  const frag = cloneTemplate('tpl-empty-state');
  frag.querySelector('.empty').textContent = message;
  return frag.firstElementChild.outerHTML;
}

// ── top bar: health + capabilities ────────────────────────────────────────
async function loadTopbar() {
  const lamp = $('#health-lamp');
  const text = $('#health-text');
  try {
    const health = await api('/api/health');
    lamp.className = `lamp ${health.ok ? 'lamp-ok' : 'lamp-fail'}`;
    text.textContent = `${health.storage.backend} · ${health.ok ? 'reachable' : 'unreachable'}`;
    text.title = health.storage.detail ?? '';
  } catch (err) {
    lamp.className = 'lamp lamp-fail';
    text.textContent = 'local api error';
    text.title = err.message;
  }
  try {
    const caps = await api('/api/capabilities');
    const on = Object.entries(caps.capabilities).filter(([, v]) => v).map(([k]) => k);
    $('#cap-summary').textContent = on.length ? `caps: ${on.length} on` : '';
    $('#cap-summary').title = on.join(', ');
  } catch { /* capability summary is decorative; health already reported */ }
}

// ── sidebar: collection list + embedded navigation tree ───────────────────
// This is the main navigation surface (design correction, Phase 2E): a
// collection's skeleton (or a flat file list when no skeleton exists) is
// shown INSIDE the sidebar, under the selected collection — not as a
// separate main-panel card. Selecting a file/section changes the main
// panel's content; it does not navigate away from the sidebar tree.
let collectionsCache = [];
let expandedCollection = null; // name of the collection whose tree is open

async function loadSidebar() {
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

function renderSidebarList(collections) {
  const list = $('#collection-list');
  list.innerHTML = collections.map(c => `
    <li class="tree-collection">
      <a href="#/collections/${encodeURIComponent(c.name)}" data-name="${esc(c.name)}" class="tree-row tree-collection-row">
        <span class="tree-caret">${expandedCollection === c.name ? '▾' : '▸'}</span>
        <span class="tree-label">${esc(c.name)}</span>
        <span class="count">${Number(c.pointCount ?? 0).toLocaleString('en-US')}</span>
      </a>
      <div class="tree-children" id="tree-${cssId(c.name)}" ${expandedCollection === c.name ? '' : 'style="display:none"'}></div>
    </li>`).join('');

  for (const row of list.querySelectorAll('.tree-collection-row')) {
    row.addEventListener('click', (e) => {
      e.preventDefault();
      const name = row.dataset.name;
      location.hash = `#/collections/${encodeURIComponent(name)}`;
      toggleSidebarTree(name);
    });
  }

  if (expandedCollection && collections.some(c => c.name === expandedCollection)) {
    loadSidebarTree(expandedCollection);
  }
}

function cssId(name) {
  // Sidebar node ids only need to be unique+stable, not reversible — a
  // simple non-alnum strip keeps CSS.escape out of hot render paths.
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function toggleSidebarTree(name) {
  const willExpand = expandedCollection !== name;
  expandedCollection = willExpand ? name : null;
  renderSidebarList(collectionsCache);
}

/**
 * Populate the sidebar tree for a collection: skeleton root -> children if
 * skeleton nav exists, otherwise a flat file list from listSourceDocuments.
 * This is the "main purpose of skeleton in UI" — a navigator, not a panel.
 */
async function loadSidebarTree(name) {
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

async function loadSidebarFileList(name, box) {
  try {
    const { documents } = await api(`/api/collections/${encodeURIComponent(name)}/documents?limit=200`);
    if (!documents.length) {
      box.innerHTML = '<div class="tree-loading">No documents.</div>';
      return;
    }
    box.innerHTML = documents.map(d => `
      <a href="#/collections/${encodeURIComponent(name)}/file/${encodeURIComponent(d.sourceFile)}"
         class="tree-row tree-file" data-sf="${esc(d.sourceFile)}" style="--depth:1">
        <span class="tree-label mono">${esc(shortLabel(d.sourceFile))}</span>
      </a>`).join('');
    for (const a of box.querySelectorAll('.tree-file')) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        openFileView(name, a.dataset.sf);
      });
    }
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
    el.addEventListener('click', () => onSidebarNodeClick(name, node2, el, depth));
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

function sidebarNodeRow(n, i, depth) {
  const isLeaf = n.nodeType === 'section' || n.nodeType === 'file' && !(n.childCount > 0);
  const icon = n.nodeType === 'directory' ? '📁' : n.nodeType === 'file' ? '📄' : '§';
  const label = nodeDisplayLabel(n);
  const tooltip = [n.summary, n.nodePath].filter(Boolean).join(' — ');
  return `
    <div class="tree-row tree-node ${isLeaf ? 'tree-leaf' : ''}" data-i="${i}" style="--depth:${depth + 1}">
      <span class="tree-caret">${n.childCount > 0 ? '▸' : ''}</span>
      <span class="tree-icon">${icon}</span>
      <span class="tree-label" title="${esc(tooltip)}">${esc(label)}</span>
    </div>`;
}

/**
 * Human-readable label for a skeleton node, per node type — node_path is a
 * synthetic key ("<file>#file", "<collection>#dir/<path>",
 * "<file>#<slug>") meant for API lookups, not for display; showing it
 * directly used to render literal fragments like "file" for every file node
 * (the tail after the "#" in "pitch-en.md#file" is just the string "file").
 * node_path/node_id remain available only via the tooltip (see sidebarNodeRow).
 *   - file:      basename of sourceFile (or the node_path's file segment)
 *   - section:   last entry of heading_path, falling back to summary/node_path
 *   - directory: last path segment of the directory's own path
 *   - anything else: shortLabel(node_path) as before
 */
function nodeDisplayLabel(n) {
  if (n.nodeType === 'file') {
    const src = n.sourceFile || String(n.nodePath ?? '').replace(/#file$/, '');
    return basename(src) || shortLabel(n.nodePath ?? n.nodeId ?? '?');
  }
  if (n.nodeType === 'section') {
    const last = Array.isArray(n.headingPath) ? n.headingPath.at(-1) : null;
    if (last) return shortLabel(last);
    return shortLabel(n.summary || n.nodePath || n.nodeId || '?');
  }
  if (n.nodeType === 'directory') {
    // node_path is "<collection>#dir/<dirPath>" where dirPath may itself
    // contain "/" for nested directories — the display name is just the
    // last segment of dirPath, not the whole nested path.
    const dirPath = String(n.nodePath ?? '').replace(/^[^#]*#dir\//, '');
    return basename(dirPath) || shortLabel(n.nodePath ?? n.nodeId ?? '?');
  }
  return shortLabel(n.nodePath ?? n.nodeId ?? '?');
}

function basename(path) {
  return String(path ?? '').split('/').filter(Boolean).at(-1) ?? '';
}

function shortLabel(path) {
  const tail = String(path).split('/').filter(Boolean).slice(-1)[0] ?? path;
  const clean = tail.replace(/^[^#]*#/, ''); // drop "collection#" prefix if present
  return clean.length > 46 ? clean.slice(0, 43) + '…' : clean;
}

async function onSidebarNodeClick(name, node, el, depth) {
  if (node.nodeType === 'section') {
    // A section nav node and its content chunks are separate points —
    // resolve to the actual first chunk under this section instead of
    // guessing chunkIndex 0 for the whole file (that would silently open
    // the wrong place whenever a file has more than one section).
    return openSectionView(name, node);
  }
  if (node.nodeType === 'file' && !(node.childCount > 0)) {
    return openFileView(name, node.sourceFile ?? node.nodePath, node.nodePath);
  }
  // directory or file-with-children: expand/collapse inline, indented.
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

function markActive() {
  const current = currentRoute();
  for (const a of document.querySelectorAll('.tree-collection-row')) {
    a.classList.toggle('active', current.view !== 'index' && a.dataset.name === current.name);
  }
  $('#nav-index')?.classList.toggle('active', current.view === 'index');
}

// ── views ─────────────────────────────────────────────────────────────────
async function renderOverview(main) {
  main.innerHTML = overviewShell;

  try {
    const health = await api('/api/health');
    $('#ov-health').innerHTML = `
      <dl class="kv">
        <dt>backend</dt><dd>${esc(health.storage.backend)}</dd>
        <dt>status</dt><dd><span class="badge ${health.ok ? 'badge-ok' : 'badge-fail'}">${health.ok ? 'reachable' : 'unreachable'}</span></dd>
        <dt>detail</dt><dd>${esc(health.storage.detail ?? '—')}</dd>
      </dl>`;
  } catch (err) { $('#ov-health').innerHTML = errorBox(err); }

  try {
    const { backend, capabilities } = await api('/api/capabilities');
    $('#ov-caps').innerHTML = `
      <div class="caps">${Object.entries(capabilities).map(([k, v]) =>
        `<span class="cap ${v ? 'on' : ''}">${esc(k)}</span>`).join('')}</div>
      <p class="skel-note">Capabilities describe what the <b>${esc(backend)}</b> storage backend supports.
      Backend-specific panels appear only when their capability is on.</p>`;
  } catch (err) { $('#ov-caps').innerHTML = errorBox(err); }

  try {
    const { collections } = await api('/api/collections');
    if (!collections.length) {
      $('#ov-collections').innerHTML = emptyBox('No collections indexed yet.');
      return;
    }
    $('#ov-collections').innerHTML = `
      <table class="data"><thead><tr>
        <th>name</th><th class="num">points</th><th>schema</th>
      </tr></thead><tbody>
      ${collections.map(c => `
        <tr class="rowlink" data-href="#/collections/${encodeURIComponent(c.name)}">
          <td class="mono">${esc(c.name)}</td>
          <td class="num">${Number(c.pointCount ?? 0).toLocaleString('en-US')}</td>
          <td>${schemaBadge(c.vectorSchema)}</td>
        </tr>`).join('')}
      </tbody></table>`;
    for (const row of document.querySelectorAll('tr.rowlink')) {
      row.addEventListener('click', () => { location.hash = row.dataset.href; });
    }
  } catch (err) { $('#ov-collections').innerHTML = errorBox(err); }
}

function schemaBadge(schema) {
  if (schema === 'named') return '<span class="badge badge-ok">named</span>';
  if (schema === 'flat') return '<span class="badge badge-warn">legacy flat</span>';
  if (schema === 'empty') return '<span class="badge badge-fail">empty</span>';
  return `<span class="badge">${esc(schema ?? '?')}</span>`;
}

// ── collection overview (main panel default for a selected collection) ───
// Header is deliberately thin: name, one-line summary, health badge,
// point/file count, settings button. No dense/sparse/provider/schema-version
// strings here — those are "Advanced diagnostics" inside Collection settings.
async function renderCollection(main, name) {
  if (expandedCollection !== name) {
    expandedCollection = name;
    renderSidebarList(collectionsCache);
  }

  main.innerHTML = collectionShell;

  initSearchPanel(name);

  let detail;
  try {
    detail = (await api(`/api/collections/${encodeURIComponent(name)}`)).collection;
  } catch (err) {
    $('#col-header').innerHTML = errorBox(err);
    return;
  }

  renderCollectionHeader(name, detail);
}

function renderCollectionHeader(name, detail) {
  const warnings = detail.warnings ?? [];
  const healthBadge = warnings.length
    ? `<span class="badge badge-warn">${warnings.length} warning${warnings.length > 1 ? 's' : ''}</span>`
    : '<span class="badge badge-ok">healthy</span>';
  const fileCountLabel = detail.hasSkeleton ? 'skeleton map available' : 'flat file list';

  $('#col-header').innerHTML = `
    <div class="col-header-top">
      <h1 class="view-title">${esc(name)}</h1>
      <button type="button" class="btn-ghost" id="col-settings-btn">settings</button>
    </div>
    <p class="view-sub">${esc(detail.description || fileCountLabel)}</p>
    <div class="col-header-meta">
      ${healthBadge}
      <span class="mono muted">${Number(detail.pointCount ?? 0).toLocaleString('en-US')} points</span>
    </div>
    ${warnings.length ? warnings.map(w => `<div class="error-box" style="margin-top:10px">${esc(w)}</div>`).join('') : ''}`;

  $('#col-settings-btn').addEventListener('click', () => {
    location.hash = `#/collections/${encodeURIComponent(name)}/settings`;
  });
}

// ── search: "Search this collection" ───────────────────────────────────────
// Default view is minimal: query + top-k + submit. Everything else (window
// size, compact/full, score display, file scoping) lives inside a native
// <details> "advanced" block so a first-time user sees a plain search box.
// Default result format is FULL (readable prose), not compact — compact is
// an advanced/debug option now.
let searchSourceFile = null;

function initSearchPanel(name) {
  searchSourceFile = null;
  const box = $('#search-panel');
  box.innerHTML = `
    <form class="search-form" id="search-form" autocomplete="off">
      <div class="search-main-row">
        <input type="text" id="q-input" class="q-input"
          placeholder="Ask a question about this collection…">
        <label class="ctl" title="Number of results to return">top
          <select id="q-top">${[3, 5, 10, 20].map(n =>
            `<option value="${n}" ${n === 5 ? 'selected' : ''}>${n}</option>`).join('')}</select>
        </label>
        <button type="submit" class="btn-amber" id="q-submit">Search</button>
      </div>
      <details class="advanced-box">
        <summary>Advanced</summary>
        <div class="search-controls">
          <label class="ctl" title="Extra chunks to show before/after each result">window
            <select id="q-window">${[0, 1, 2, 3, 4, 5].map(n =>
              `<option value="${n}" ${n === 1 ? 'selected' : ''}>${n}</option>`).join('')}</select>
          </label>
          <div class="segmented" id="q-format" role="group" aria-label="window format"
               title="Full shows complete neighboring text; compact shows short snippets (debug view)">
            <button type="button" data-v="full" class="on">full</button>
            <button type="button" data-v="compact">compact</button>
          </div>
          <label class="ctl" title="Show the retrieval rank score on each result"><input type="checkbox" id="q-show-score"> score</label>
          <span class="filter-chip" id="q-file-chip" style="display:none">
            <span class="mono" id="q-file-label"></span>
            <button type="button" id="q-file-clear" title="Clear file filter">×</button>
          </span>
        </div>
      </details>
    </form>
    <div id="search-status" class="empty">Results are retrieval evidence — real indexed chunks with scores.
      The sidebar tree is navigation only.</div>
    <div id="search-results"></div>`;

  $('#q-format').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-v]');
    if (!btn) return;
    for (const b of $('#q-format').querySelectorAll('button')) b.classList.toggle('on', b === btn);
  });

  $('#q-file-clear').addEventListener('click', () => clearSearchFile());

  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch(name);
  });
}

function setSearchFile(sourceFile) {
  searchSourceFile = sourceFile;
  $('#q-file-label').textContent = sourceFile;
  $('#q-file-chip').style.display = '';
  $('#search-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('#q-input').focus();
}

function clearSearchFile() {
  searchSourceFile = null;
  $('#q-file-chip').style.display = 'none';
}

async function runSearch(name) {
  const status = $('#search-status');
  const resultsBox = $('#search-results');
  const submit = $('#q-submit');

  const query = $('#q-input').value.trim();
  if (!query) {
    status.className = 'error-box';
    status.textContent = 'Enter a query first.';
    return;
  }

  const top = Number($('#q-top').value);
  const window = Number($('#q-window').value);
  const windowFormat = $('#q-format .on')?.dataset.v ?? 'full';
  const showScore = $('#q-show-score').checked;

  const payload = { collection: name, query, top, window };
  if (window > 0) payload.windowFormat = windowFormat;
  if (searchSourceFile) payload.sourceFile = searchSourceFile;

  submit.disabled = true;
  status.className = 'empty';
  status.textContent = 'searching…';
  resultsBox.innerHTML = '';
  hideCollectionContent();

  try {
    const body = await apiPost('/api/search', payload);
    $('#search-mode').textContent = body.searchMode ? `mode: ${body.searchMode}` : '';
    if (!body.results.length) {
      status.textContent = searchSourceFile
        ? 'No results in the filtered file — try clearing the file filter.'
        : 'No results for this query.';
      return;
    }
    status.textContent = `${body.results.length} result${body.results.length > 1 ? 's' : ''}`
      + (searchSourceFile ? ` · filtered to one file` : '');
    resultsBox.replaceChildren(...body.results.map((r, i) => renderResult(r, i, showScore)));
    for (const btn of resultsBox.querySelectorAll('.result-open')) {
      btn.addEventListener('click', () =>
        openFileView(name, btn.dataset.sf, null, Number(btn.dataset.ci)));
    }
  } catch (err) {
    status.className = 'error-box';
    status.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
}

// Builds a result-card element from the tpl-search-result template — all
// user/API content (source file, section, score, chunk text, window
// chunks) is filled via textContent/dataset, never string-concatenated
// into markup. Returns the element (not an HTML string) so callers append
// it directly instead of round-tripping through innerHTML.
function renderResult(r, i, showScore) {
  const canOpen = r.sourceFile && Number.isInteger(r.chunkIndex);
  const frag = cloneTemplate('tpl-search-result');
  const card = frag.querySelector('.result-card');

  card.querySelector('.rank').textContent = `#${i + 1}`;

  const scoreEl = card.querySelector('.score');
  if (showScore && typeof r.score === 'number') {
    scoreEl.textContent = r.score.toFixed(4);
    scoreEl.hidden = false;
  }

  card.querySelector('.result-source').textContent = r.sourceFile ?? '?';
  card.querySelector('.result-chunk-index').textContent =
    `chunk ${r.chunkIndex ?? '?'}${r.totalChunks ? ` / ${r.totalChunks}` : ''}`;
  card.querySelector('.result-section').textContent = r.section || 'intro';

  const nodeTypeEl = card.querySelector('.result-node-type');
  if (r.nodeType) {
    nodeTypeEl.textContent = r.nodeType;
    nodeTypeEl.hidden = false;
  }

  const openBtn = card.querySelector('.result-open');
  if (canOpen) {
    openBtn.dataset.sf = r.sourceFile;
    openBtn.dataset.ci = String(r.chunkIndex);
    openBtn.hidden = false;
  }

  const contextEl = card.querySelector('.chunk-context');
  if (r.context) {
    contextEl.textContent = r.context;
    contextEl.hidden = false;
  }

  card.querySelector('.chunk-text').textContent = r.text ?? '';

  if (Array.isArray(r.windowChunks) && r.windowChunks.length) {
    const winBox = card.querySelector('.win-chunks');
    winBox.hidden = false;
    for (const w of r.windowChunks) {
      const wFrag = cloneTemplate('tpl-window-chunk');
      const wEl = wFrag.querySelector('.win-chunk');
      wEl.classList.toggle('match', Boolean(w.isMatch));
      wEl.querySelector('.win-chunk-index').textContent = `#${w.chunkIndex ?? '?'}`;
      const wBadge = wEl.querySelector('.badge');
      wBadge.hidden = !w.isMatch;
      wEl.querySelector('.win-section').textContent = w.section || '';
      wEl.querySelector('.win-text').textContent = w.textSnippet ?? w.text ?? '';
      winBox.appendChild(wFrag);
    }
  }

  return card;
}

// ── selected file/section view ────────────────────────────────────────────
// Replaces the old standalone "Documents" card: clicking a file or section
// in the sidebar tree loads its chunks directly into the main content area,
// with "load more" pagination and a scoped search-within-file shortcut.
// No separate document list lives in the main panel anymore.
let fileViewState = null; // { name, sourceFile, chunkIndex, loaded }

function hideCollectionContent() {
  const panel = $('#collection-content-panel');
  if (panel) panel.style.display = 'none';
}

/**
 * Resolve a section nav node to its actual first content chunk via
 * GET .../skeleton/anchor, then open the file view there. If the section
 * has no content chunks (e.g. an empty section), this does NOT silently
 * open chunk 0 of the file — that would look identical to a resolved
 * section and hide the fact that the section itself is empty. Instead it
 * shows an explicit message with an opt-in "Open file from start" button.
 */
async function openSectionView(name, node) {
  const panel = $('#collection-content-panel');
  const title = $('#content-title');
  const box = $('#collection-content');
  if (!panel || !box) return;

  panel.style.display = '';
  title.textContent = nodeDisplayLabel(node);
  box.innerHTML = emptyBox('loading…');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

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

async function openFileView(name, sourceFile, nodePath, chunkIndex = 0) {
  const panel = $('#collection-content-panel');
  const title = $('#content-title');
  const box = $('#collection-content');
  if (!panel || !box) return;

  panel.style.display = '';
  title.textContent = sourceFile;
  box.innerHTML = emptyBox('loading…');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  fileViewState = { name, sourceFile, chunkIndex, loaded: 0 };

  try {
    const qs = `sourceFile=${encodeURIComponent(sourceFile)}&chunkIndex=${chunkIndex}&window=3`;
    const { chunks } = await api(`/api/collections/${encodeURIComponent(name)}/chunks?${qs}`);
    if (!chunks.length) {
      box.innerHTML = emptyBox('No chunks found for this file/section.');
      return;
    }
    fileViewState.loaded = chunks.length;
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
const STRUCTURAL_NODE_TYPES = new Set(['table', 'code_block', 'checklist']);

const NODE_TYPE_BADGE_LABEL = {
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

function nodeTypeBadgeLabel(nodeType) {
  return NODE_TYPE_BADGE_LABEL[nodeType] ?? nodeType;
}

// Builds a DocumentFragment of chunk-card elements from the tpl-chunk-card
// template. Returns a fragment (not an HTML string) so callers can append it
// directly or insert it before an existing element.
function renderFileChunks(chunks) {
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

function fileViewLoadMoreButton() {
  return '<button type="button" class="mini-btn" id="file-load-more">load more</button>';
}

function wireFileViewButtons(box) {
  const btn = box.querySelector('#file-load-more');
  btn?.addEventListener('click', loadMoreFileChunks);
}

async function loadMoreFileChunks() {
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

// ── collection settings (was "Maintenance") ────────────────────────────────
// User-facing settings (health, reindex) are separated from "Advanced
// diagnostics" (dense/sparse vector details, provider strings, schema
// versions, semidex-managed flag, raw warnings) — the latter collapsed by
// default so the default view is not filled with developer-only labels.
const RECENT_SOURCE_PATHS_KEY = 'semidex-admin-recent-source-paths';

function getRecentSourcePaths() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_SOURCE_PATHS_KEY) ?? '[]');
  } catch { return []; }
}

function rememberSourcePath(path) {
  const recent = [path, ...getRecentSourcePaths().filter(p => p !== path)].slice(0, 8);
  try { localStorage.setItem(RECENT_SOURCE_PATHS_KEY, JSON.stringify(recent)); } catch { /* storage unavailable — non-fatal */ }
}

async function renderSettingsView(main, name) {
  main.innerHTML = settingsShell;
  $('#settings-title').textContent = `${name} · settings`;
  $('#settings-back-link').setAttribute('href', `#/collections/${encodeURIComponent(name)}`);
  $('#settings-source-path-field').innerHTML = renderSourcePathField();

  const modal = cloneTemplate('tpl-delete-modal');
  modal.querySelector('#delete-modal-name').textContent = name;
  $('#delete-modal-slot').replaceChildren(modal);

  $('#opt-prune').addEventListener('change', (e) => {
    e.target.closest('label').classList.toggle('warn', e.target.checked);
  });
  $('#settings-reindex-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runSettingsReindex(name);
  });
  $('#settings-repair').addEventListener('click', () => runSettingsRepair(name));
  $('#settings-delete-btn').addEventListener('click', () => openDeleteModal());
  $('#delete-modal-cancel').addEventListener('click', () => closeDeleteModal());
  $('#delete-modal-confirm').addEventListener('click', () => runDeleteCollection(name));

  let detail;
  try {
    detail = (await api(`/api/collections/${encodeURIComponent(name)}`)).collection;
  } catch (err) {
    $('#settings-health').innerHTML = errorBox(err);
    $('#settings-diagnostics').innerHTML = errorBox(err);
    return;
  }

  renderSettingsHealth(detail);
  renderAdvancedDiagnostics(detail);
}

function renderSourcePathField() {
  const recent = getRecentSourcePaths();
  const options = recent.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  return `
    <label class="form-row">
      <span>source path ${recent.length ? '' : '(no recent paths yet — choose a folder below)'}</span>
      ${recent.length ? `
        <select id="settings-path-recent" class="q-input">
          <option value="">— choose a recent source root —</option>
          ${options}
          <option value="__manual__">Choose a different folder…</option>
        </select>` : ''}
      <div class="path-picker-row" style="${recent.length ? 'display:none;margin-top:6px' : ''}" id="settings-path-manual-row">
        <input type="text" id="settings-path-manual" class="q-input" placeholder="Choose a folder, or type a path">
        <button type="button" class="btn-ghost" id="settings-choose-folder">Choose folder…</button>
      </div>
    </label>`;
}

function wireSourcePathField() {
  const select = $('#settings-path-recent');
  const manual = $('#settings-path-manual');
  const manualRow = $('#settings-path-manual-row');
  if (select) {
    select.addEventListener('change', () => {
      if (select.value === '__manual__' || select.value === '') {
        manualRow.style.display = '';
        manualRow.style.marginTop = '6px';
        if (select.value === '__manual__') manual.focus();
      } else {
        manualRow.style.display = 'none';
        manual.value = select.value;
      }
    });
  }
  $('#settings-choose-folder')?.addEventListener('click', async () => {
    const btn = $('#settings-choose-folder');
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Choosing…';
    try {
      const { path, cancelled } = await apiPost('/api/system/pick-folder', {});
      if (!cancelled && path) manual.value = path;
    } catch { /* picker unavailable — manual input stays available as-is */ }
    finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });
}

function currentSourcePathValue() {
  const select = $('#settings-path-recent');
  const manual = $('#settings-path-manual');
  if (select && select.value && select.value !== '__manual__') return select.value;
  return manual?.value.trim() ?? '';
}

function renderSettingsHealth(detail) {
  const warnings = detail.warnings ?? [];
  const healthBadge = warnings.length
    ? `<span class="badge badge-warn">${warnings.length} warning${warnings.length > 1 ? 's' : ''}</span>`
    : '<span class="badge badge-ok">healthy</span>';

  $('#settings-health').innerHTML = `
    <div class="panel-head">Collection health</div>
    <div class="panel-body">
      <dl class="kv">
        <dt>status</dt><dd>${healthBadge}</dd>
        <dt>points</dt><dd>${Number(detail.pointCount ?? 0).toLocaleString('en-US')}</dd>
        <dt>skeleton nav</dt><dd>${detail.hasSkeleton ? 'available' : 'not enabled'}</dd>
      </dl>
      ${warnings.map(w => `<div class="error-box" style="margin-top:12px">${esc(w)}</div>`).join('')}
    </div>`;

  wireSourcePathField();
}

function renderAdvancedDiagnostics(detail) {
  const v = detail.vectorSchema ?? {};
  const p = detail.provider ?? {};
  const ver = detail.versions ?? {};
  $('#settings-diagnostics').innerHTML = `
    <dl class="kv">
      <dt>dense vector</dt><dd>${v.dense?.size ?? '—'} · ${esc(v.dense?.distance ?? '—')}</dd>
      <dt>sparse vector</dt><dd>${v.sparse ? 'yes' : 'no'}</dd>
      <dt>dense provider</dt><dd>${esc(p.denseProvider ?? '—')}${p.denseModel ? ` / ${esc(p.denseModel)}` : ''}</dd>
      <dt>sparse provider</dt><dd>${esc(p.sparseProvider ?? '—')}</dd>
      <dt>versions</dt><dd>embed v${ver.embeddingSchema ?? '?'} · chunk v${ver.chunkingSchema ?? '?'} · tokens ${esc(ver.tokenCountMode ?? '?')}</dd>
      <dt>semidex-managed</dt><dd>${detail.semidexManaged ? 'yes' : 'no'}</dd>
    </dl>`;
}

async function runSettingsReindex(name) {
  const submit = $('#settings-reindex-submit');
  const result = $('#settings-reindex-result');

  const path = currentSourcePathValue();
  if (!path) {
    result.className = 'error-box';
    result.textContent = 'Source path is required.';
    return;
  }

  const payload = {
    collection: name,
    path,
    options: {
      onnxEmbed: $('#opt-onnx').checked,
      llmSummaries: $('#opt-llm-summaries').checked,
      skeletonChunking: $('#opt-skel-chunk').checked,
      skeletonNav: $('#opt-skel-nav').checked,
      tagGen: $('#opt-tags').checked,
      pruneStale: $('#opt-prune').checked,
    },
  };

  submit.disabled = true;
  result.className = 'empty';
  result.textContent = 'starting…';

  try {
    const body = await apiPost('/api/jobs/index', payload);
    rememberSourcePath(path);
    result.className = 'empty';
    result.innerHTML = `Job started (<span class="mono">${esc(body.job.id)}</span>).
      <a href="#/index">Watch it on the indexing jobs view</a>.`;
  } catch (err) {
    result.className = 'error-box';
    result.textContent = err.status === 409
      ? `${err.message} Wait for it to finish, or cancel it from the indexing jobs view.`
      : err.message;
  } finally {
    submit.disabled = false;
  }
}

async function runSettingsRepair(name) {
  const btn = $('#settings-repair');
  const result = $('#settings-repair-result');
  btn.disabled = true;
  result.className = 'empty';
  result.textContent = 'checking…';

  try {
    const body = await apiPost(`/api/collections/${encodeURIComponent(name)}/sync-schema`, {});
    const parts = [];
    if (body.repaired?.length) parts.push(`repaired: ${body.repaired.join(', ')}`);
    if (body.warnings?.length) parts.push(`warnings: ${body.warnings.join(' · ')}`);
    result.className = body.warnings?.length ? 'error-box' : 'empty';
    result.textContent = parts.length ? parts.join(' — ') : 'Already compatible — nothing to repair.';
    const detail = (await api(`/api/collections/${encodeURIComponent(name)}`)).collection;
    renderSettingsHealth(detail);
    renderAdvancedDiagnostics(detail);
  } catch (err) {
    result.className = 'error-box';
    result.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

function openDeleteModal() {
  $('#delete-modal-backdrop').style.display = '';
}

function closeDeleteModal() {
  $('#delete-modal-backdrop').style.display = 'none';
}

async function runDeleteCollection(name) {
  const btn = $('#delete-modal-confirm');
  const result = $('#settings-delete-result');
  btn.disabled = true;
  result.className = 'empty';
  result.textContent = 'deleting…';

  try {
    await apiDelete(`/api/collections/${encodeURIComponent(name)}`);
    if (expandedCollection === name) expandedCollection = null;
    location.hash = '#/';
    loadSidebar();
  } catch (err) {
    result.className = 'error-box';
    result.textContent = err.message;
    btn.disabled = false;
  }
}

// ── indexing jobs view (unchanged from Phase 2C/2D) ────────────────────────
let indexPollTimer = null;

function stopIndexPolling() {
  if (indexPollTimer) { clearTimeout(indexPollTimer); indexPollTimer = null; }
}

async function renderIndexingView(main) {
  stopIndexPolling();
  main.innerHTML = indexViewShell;

  $('#opt-prune').addEventListener('change', (e) => {
    e.target.closest('label').classList.toggle('warn', e.target.checked);
  });

  $('#opt-llm-summaries').addEventListener('change', (e) => {
    if (e.target.checked) loadOllamaStatus(); else $('#idx-ollama-status').style.display = 'none';
  });

  $('#idx-choose-folder').addEventListener('click', chooseIndexFolder);

  $('#index-form').addEventListener('submit', (e) => {
    e.preventDefault();
    startIndexJob();
  });

  await loadJobs();
}

function currentIndexPathValue() {
  const manual = $('#idx-path-manual');
  const main = $('#idx-path');
  if (manual && manual.offsetParent !== null) return manual.value.trim();
  return main.value.trim();
}

async function chooseIndexFolder() {
  const btn = $('#idx-choose-folder');
  const pathInput = $('#idx-path');
  const fallback = $('#idx-path-fallback');
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Choosing…';

  try {
    const { path, cancelled } = await apiPost('/api/system/pick-folder', {});
    if (!cancelled && path) {
      pathInput.style.display = '';
      pathInput.value = path;
      fallback.style.display = 'none';
    }
  } catch (err) {
    // Picker unavailable (non-Windows, powershell.exe missing, timed out,
    // etc.) — fall back to manual entry instead of leaving the user stuck
    // with a broken button and no way to proceed.
    fallback.style.display = '';
    $('#idx-path-manual').focus();
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

const OLLAMA_STATUS_BADGE = {
  available: 'badge badge-ok',
  missing: 'badge badge-fail',
  model_missing: 'badge badge-warn',
};

async function loadOllamaStatus() {
  const box = $('#idx-ollama-status');
  if (!box) return;
  box.style.display = '';
  box.innerHTML = '<span class="mono muted">checking Ollama…</span>';
  try {
    const { status, message } = await api('/api/system/ollama-status');
    const badgeClass = OLLAMA_STATUS_BADGE[status] ?? 'badge';
    box.innerHTML = `LLM summaries require Ollama:
      <span class="${badgeClass}">${esc(status)}</span>
      <span class="skel-note" style="display:inline;margin:0 0 0 6px">${esc(message)}</span>`;
  } catch (err) {
    box.innerHTML = errorBox(err);
  }
}

async function startIndexJob() {
  const status = $('#idx-status');
  const submit = $('#idx-submit');

  const collection = $('#idx-collection').value.trim();
  const path = currentIndexPathValue();
  if (!collection || !path) {
    status.className = 'error-box';
    status.textContent = 'Collection name and folder to index are both required.';
    return;
  }

  const payload = {
    collection,
    path,
    options: {
      onnxEmbed: $('#opt-onnx').checked,
      llmSummaries: $('#opt-llm-summaries').checked,
      skeletonChunking: $('#opt-skel-chunk').checked,
      skeletonNav: $('#opt-skel-nav').checked,
      pruneStale: $('#opt-prune').checked,
      tagGen: $('#opt-tags').checked,
    },
  };

  submit.disabled = true;
  status.className = 'empty';
  status.textContent = 'starting…';

  try {
    await apiPost('/api/jobs/index', payload);
    status.textContent = 'Job started.';
    await loadJobs();
  } catch (err) {
    status.className = 'error-box';
    if (err.status === 409) {
      status.textContent = `${err.message} Wait for it to finish, or cancel it below.`;
    } else if (err.status === 503) {
      status.textContent = err.message;
      loadOllamaStatus();
    } else {
      status.textContent = err.message;
    }
  } finally {
    submit.disabled = false;
  }
}

const JOB_STATUS_BADGE_CLASS = {
  queued: 'badge', running: 'badge badge-amber', cancelling: 'badge badge-warn',
  succeeded: 'badge badge-ok', failed: 'badge badge-fail', cancelled: 'badge',
};

// Builds a job-card element from the tpl-job-row template.
function renderJobRow(j) {
  const frag = cloneTemplate('tpl-job-row');
  const card = frag.querySelector('.job-card');
  card.dataset.id = j.id;

  const badge = card.querySelector('.job-status-badge');
  badge.className = JOB_STATUS_BADGE_CLASS[j.state] ?? 'badge';
  badge.textContent = j.state;

  card.querySelector('.job-collection').textContent = j.collection;
  card.querySelector('.job-path').textContent = j.path;

  const exitEl = card.querySelector('.job-exit-code');
  if (j.exitCode !== null && j.exitCode !== 0) {
    exitEl.textContent = `exit ${j.exitCode}`;
    exitEl.hidden = false;
  }

  const cancelBtn = card.querySelector('.job-cancel');
  if (j.state === 'queued' || j.state === 'running') {
    cancelBtn.dataset.id = j.id;
    cancelBtn.hidden = false;
  }

  card.querySelector('.job-cancelling').hidden = j.state !== 'cancelling';

  card.querySelector('.job-started').textContent =
    `started ${j.startedAt ? new Date(j.startedAt).toLocaleString() : '—'}`;
  if (j.finishedAt) {
    card.querySelector('.job-ended').textContent = ` · ended ${new Date(j.finishedAt).toLocaleString()}`;
  }

  return card;
}

async function loadJobs() {
  const box = $('#idx-jobs');
  let jobs;
  try {
    ({ jobs } = await api('/api/jobs'));
  } catch (err) {
    box.innerHTML = errorBox(err);
    return;
  }

  if (!jobs.length) {
    box.innerHTML = emptyBox('No indexing jobs yet.');
  } else {
    box.replaceChildren(...jobs.map(renderJobRow));

    for (const btn of box.querySelectorAll('.job-cancel')) {
      btn.addEventListener('click', () => cancelJob(btn.dataset.id));
    }
    for (const card of box.querySelectorAll('.job-card')) {
      loadJobLog(card);
    }
  }

  const stillActive = jobs.some(j => j.state === 'queued' || j.state === 'running' || j.state === 'cancelling');
  stopIndexPolling();
  if (stillActive) {
    indexPollTimer = setTimeout(async () => {
      if (currentRoute().view !== 'index') return; // navigated away
      await loadJobs();
    }, 1500);
  } else if (jobs.some(j => j.state === 'succeeded')) {
    loadSidebar();
  }
}

async function loadJobLog(card) {
  const pre = card.querySelector('.job-log');
  if (!pre) return;
  const id = card.dataset.id;
  try {
    const { job } = await api(`/api/jobs/${encodeURIComponent(id)}`);
    pre.textContent = job.log.slice(-30).join('\n') || '(no output yet)';
  } catch (err) {
    pre.textContent = err.message;
  }
}

async function cancelJob(id) {
  try {
    await apiPost(`/api/jobs/${encodeURIComponent(id)}/cancel`, {});
    await loadJobs();
  } catch (err) {
    $('#idx-status').className = 'error-box';
    $('#idx-status').textContent = err.message;
  }
}

// ── router ────────────────────────────────────────────────────────────────
function currentRoute() {
  const hash = location.hash || '#/';
  let m = hash.match(/^#\/collections\/([^/]+)\/settings$/);
  if (m) return { view: 'settings', name: decodeURIComponent(m[1]) };
  m = hash.match(/^#\/collections\/([^/]+)\/file\/(.+)$/);
  if (m) return { view: 'collection', name: decodeURIComponent(m[1]), openFile: decodeURIComponent(m[2]) };
  m = hash.match(/^#\/collections\/(.+)$/);
  if (m) return { view: 'collection', name: decodeURIComponent(m[1]) };
  if (hash === '#/index') return { view: 'index' };
  return { view: 'overview' };
}

async function route() {
  const main = $('#main');
  const r = currentRoute();
  markActive();
  if (r.view === 'settings') await renderSettingsView(main, r.name);
  else if (r.view === 'collection') {
    await renderCollection(main, r.name);
    if (r.openFile) await openFileView(r.name, r.openFile);
  } else if (r.view === 'index') await renderIndexingView(main);
  else await renderOverview(main);
}

export function startAdminApp() {
  window.addEventListener('hashchange', route);

  loadTopbar();
  loadSidebar();
  route();
}
