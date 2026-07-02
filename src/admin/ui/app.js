// semidex admin console — Phase 2A shell + Phase 2B search playground.
// Vanilla JS, hash routing, Local API only. No frameworks, no build step.
// Talks exclusively to /api/* — never to any storage backend directly.
'use strict';

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

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function errorBox(err) {
  return `<div class="error-box">${esc(err.message)}</div>`;
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

// ── sidebar: collection list ──────────────────────────────────────────────
let collectionsCache = [];

async function loadSidebar() {
  const list = $('#collection-list');
  try {
    const { collections } = await api('/api/collections');
    collectionsCache = collections;
    if (!collections.length) {
      list.innerHTML = '<li class="muted">no collections yet</li>';
      return;
    }
    list.innerHTML = collections.map(c => `
      <li><a href="#/collections/${encodeURIComponent(c.name)}" data-name="${esc(c.name)}">
        <span>${esc(c.name)}</span>
        <span class="count">${Number(c.pointCount ?? 0).toLocaleString('en-US')}</span>
      </a></li>`).join('');
    markActive();
  } catch (err) {
    list.innerHTML = `<li class="muted">${esc(err.message)}</li>`;
  }
}

function markActive() {
  const current = currentRoute();
  for (const a of document.querySelectorAll('.collection-list a')) {
    a.classList.toggle('active',
      current.view === 'collection' && a.dataset.name === current.name);
  }
}

// ── views ─────────────────────────────────────────────────────────────────
async function renderOverview(main) {
  main.innerHTML = `
    <h1 class="view-title">overview</h1>
    <p class="view-sub">Local semidex instance — storage health, backend capabilities, indexed collections.</p>
    <div class="grid-2">
      <div class="panel"><div class="panel-head">Storage health</div><div class="panel-body" id="ov-health">…</div></div>
      <div class="panel"><div class="panel-head">Backend capabilities</div><div class="panel-body" id="ov-caps">…</div></div>
    </div>
    <div class="panel"><div class="panel-head">Collections</div><div class="panel-body" id="ov-collections">…</div></div>`;

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
      $('#ov-collections').innerHTML = '<div class="empty">No collections indexed yet.</div>';
      return;
    }
    $('#ov-collections').innerHTML = `
      <table class="data"><thead><tr>
        <th>name</th><th class="num">points</th><th>dense provider</th><th>sparse</th><th>schema</th>
      </tr></thead><tbody>
      ${collections.map(c => `
        <tr class="rowlink" data-href="#/collections/${encodeURIComponent(c.name)}">
          <td class="mono">${esc(c.name)}</td>
          <td class="num">${Number(c.pointCount ?? 0).toLocaleString('en-US')}</td>
          <td class="mono">${esc(c.provider?.denseProvider ?? '—')}${c.provider?.denseModel ? ` / ${esc(c.provider.denseModel)}` : ''}</td>
          <td class="mono">${esc(c.provider?.sparseProvider ?? '—')}</td>
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

async function renderCollection(main, name) {
  main.innerHTML = `
    <h1 class="view-title">${esc(name)}</h1>
    <p class="view-sub">Collection detail — metadata, search playground, indexed documents, skeleton navigation.</p>
    <div class="panel"><div class="panel-head">Metadata</div><div class="panel-body" id="col-meta">…</div></div>
    <div class="panel"><div class="panel-head"><span>Search playground</span><span class="mono" id="search-mode"></span></div>
      <div class="panel-body" id="search-panel">…</div></div>
    <div class="grid-2">
      <div class="panel"><div class="panel-head"><span>Documents</span><span id="doc-count"></span></div>
        <div class="panel-body" id="col-docs">…</div></div>
      <div class="panel"><div class="panel-head">Skeleton navigation</div>
        <div class="panel-body" id="col-skel">…</div></div>
    </div>
    <div class="panel" id="chunk-panel" style="display:none">
      <div class="panel-head"><span>Chunk preview</span><span class="mono" id="chunk-title"></span></div>
      <div class="panel-body" id="col-chunks"></div>
    </div>`;

  initSearchPanel(name);

  let detail;
  try {
    const body = await api(`/api/collections/${encodeURIComponent(name)}`);
    detail = body.collection;
  } catch (err) {
    $('#col-meta').innerHTML = errorBox(err);
    $('#col-docs').innerHTML = '<div class="empty">—</div>';
    $('#col-skel').innerHTML = '<div class="empty">—</div>';
    return;
  }

  const v = detail.vectorSchema ?? {};
  const p = detail.provider ?? {};
  const ver = detail.versions ?? {};
  $('#col-meta').innerHTML = `
    <dl class="kv">
      <dt>points</dt><dd>${Number(detail.pointCount ?? 0).toLocaleString('en-US')}</dd>
      <dt>dense vector</dt><dd>${v.dense?.size ?? '—'} · ${esc(v.dense?.distance ?? '—')}</dd>
      <dt>sparse vector</dt><dd>${v.sparse ? 'yes' : 'no'}</dd>
      <dt>dense provider</dt><dd>${esc(p.denseProvider ?? '—')}${p.denseModel ? ` / ${esc(p.denseModel)}` : ''}</dd>
      <dt>sparse provider</dt><dd>${esc(p.sparseProvider ?? '—')}</dd>
      <dt>versions</dt><dd>embed v${ver.embeddingSchema ?? '?'} · chunk v${ver.chunkingSchema ?? '?'} · tokens ${esc(ver.tokenCountMode ?? '?')}</dd>
      <dt>semidex-managed</dt><dd>${detail.semidexManaged ? 'yes' : 'no'}</dd>
      <dt>skeleton nav</dt><dd>${detail.hasSkeleton
        ? '<span class="badge badge-amber">available</span>'
        : '<span class="badge">none</span>'}</dd>
      ${detail.description ? `<dt>description</dt><dd>${esc(detail.description)}</dd>` : ''}
    </dl>
    ${(detail.warnings ?? []).map(w => `<div class="error-box" style="margin-top:12px">${esc(w)}</div>`).join('')}`;

  loadDocuments(name);
  loadSkeleton(name, detail.hasSkeleton);
}

async function loadDocuments(name) {
  const box = $('#col-docs');
  try {
    const { documents } = await api(`/api/collections/${encodeURIComponent(name)}/documents?limit=100`);
    $('#doc-count').textContent = `${documents.length}${documents.length === 100 ? '+' : ''}`;
    if (!documents.length) {
      box.innerHTML = '<div class="empty">No documents in this collection.</div>';
      return;
    }
    box.innerHTML = `
      <table class="data"><thead><tr><th>source file</th><th class="num">chunks</th><th></th></tr></thead><tbody>
      ${documents.map(d => `
        <tr class="rowlink doc-row" data-sf="${esc(d.sourceFile)}">
          <td class="mono">${esc(d.sourceFile)}</td>
          <td class="num">${d.chunkCount}</td>
          <td class="actions"><button type="button" class="mini-btn doc-search" data-sf="${esc(d.sourceFile)}" title="Search only inside this file">search in file</button></td>
        </tr>`).join('')}
      </tbody></table>`;
    for (const row of box.querySelectorAll('.doc-row')) {
      row.addEventListener('click', () => loadChunkPreview(name, row.dataset.sf));
    }
    for (const btn of box.querySelectorAll('.doc-search')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setSearchFile(btn.dataset.sf);
      });
    }
  } catch (err) { box.innerHTML = errorBox(err); }
}

async function loadChunkPreview(name, sourceFile, chunkIndex = 0) {
  const panel = $('#chunk-panel');
  const box = $('#col-chunks');
  panel.style.display = '';
  $('#chunk-title').textContent = `${sourceFile} · from chunk ${chunkIndex}`;
  box.innerHTML = '<div class="empty">loading…</div>';
  try {
    const qs = `sourceFile=${encodeURIComponent(sourceFile)}&chunkIndex=${chunkIndex}&window=2`;
    const { chunks } = await api(`/api/collections/${encodeURIComponent(name)}/chunks?${qs}`);
    if (!chunks.length) {
      box.innerHTML = '<div class="empty">No chunks found for this file.</div>';
      return;
    }
    box.innerHTML = chunks.map(c => `
      <div class="chunk">
        <div class="chunk-head">
          <span>chunk ${c.chunkIndex}${c.totalChunks ? ` / ${c.totalChunks}` : ''}</span>
          <span>${esc(c.section || 'intro')}</span>
        </div>
        ${c.context ? `<div class="chunk-context">${esc(c.context)}</div>` : ''}
        <pre class="chunk-text">${esc(c.text ?? '')}</pre>
      </div>`).join('');
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) { box.innerHTML = errorBox(err); }
}

// ── search playground ─────────────────────────────────────────────────────
// Results here are retrieval EVIDENCE (actual indexed chunks + scores).
// Skeleton summaries elsewhere on this page are navigation only — the UI
// copy keeps that distinction explicit.
let searchSourceFile = null;

function initSearchPanel(name) {
  searchSourceFile = null;
  const box = $('#search-panel');
  box.innerHTML = `
    <form class="search-form" id="search-form" autocomplete="off">
      <input type="text" id="q-input" class="q-input"
        placeholder="Test retrieval against this collection…">
      <div class="search-controls">
        <label class="ctl">top
          <select id="q-top">${[1, 2, 3, 5, 10, 20].map(n =>
            `<option value="${n}" ${n === 3 ? 'selected' : ''}>${n}</option>`).join('')}</select>
        </label>
        <label class="ctl">window
          <select id="q-window">${[0, 1, 2, 3, 4, 5].map(n =>
            `<option value="${n}" ${n === 1 ? 'selected' : ''}>${n}</option>`).join('')}</select>
        </label>
        <div class="segmented" id="q-format" role="group" aria-label="window format">
          <button type="button" data-v="compact" class="on">compact</button>
          <button type="button" data-v="full">full</button>
        </div>
        <span class="filter-chip" id="q-file-chip" style="display:none">
          <span class="mono" id="q-file-label"></span>
          <button type="button" id="q-file-clear" title="Clear file filter">×</button>
        </span>
        <button type="submit" class="btn-amber" id="q-submit">search</button>
      </div>
    </form>
    <div id="search-status" class="empty">Results are retrieval evidence — real indexed chunks with scores.
      Skeleton summaries below are navigation only.</div>
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
  const windowFormat = $('#q-format .on')?.dataset.v ?? 'compact';

  const payload = { collection: name, query, top, window };
  if (window > 0) payload.windowFormat = windowFormat;
  if (searchSourceFile) payload.sourceFile = searchSourceFile;

  submit.disabled = true;
  status.className = 'empty';
  status.textContent = 'searching…';
  resultsBox.innerHTML = '';

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
    resultsBox.innerHTML = body.results.map((r, i) => renderResult(r, i)).join('');
    for (const btn of resultsBox.querySelectorAll('.result-open')) {
      btn.addEventListener('click', () =>
        loadChunkPreview(name, btn.dataset.sf, Number(btn.dataset.ci)));
    }
  } catch (err) {
    status.className = 'error-box';
    status.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
}

function renderResult(r, i) {
  const canOpen = r.sourceFile && Number.isInteger(r.chunkIndex);
  return `
  <div class="result-card">
    <div class="result-head">
      <span class="rank">#${i + 1}</span>
      ${typeof r.score === 'number' ? `<span class="mono score" title="RRF score — compare rank order, not absolute value">${r.score.toFixed(4)}</span>` : ''}
      <span class="mono">${esc(r.sourceFile ?? '?')}</span>
      <span class="mono muted">chunk ${r.chunkIndex ?? '?'}${r.totalChunks ? ` / ${r.totalChunks}` : ''}</span>
      <span class="muted">${esc(r.section || 'intro')}</span>
      ${r.nodeType ? `<span class="badge badge-amber">${esc(r.nodeType)}</span>` : ''}
      ${canOpen ? `<button type="button" class="mini-btn result-open" data-sf="${esc(r.sourceFile)}" data-ci="${r.chunkIndex}">preview chunk</button>` : ''}
    </div>
    ${r.context ? `<div class="chunk-context">${esc(r.context)}</div>` : ''}
    <pre class="chunk-text">${esc(r.text ?? '')}</pre>
    ${Array.isArray(r.windowChunks) && r.windowChunks.length ? `
      <div class="win-chunks">
        ${r.windowChunks.map(w => `
          <div class="win-chunk ${w.isMatch ? 'match' : ''}">
            <div class="win-head">
              <span class="mono muted">#${w.chunkIndex ?? '?'}</span>
              ${w.isMatch ? '<span class="badge badge-amber">match</span>' : ''}
              <span class="muted">${esc(w.section || '')}</span>
            </div>
            <div class="win-text">${esc(w.textSnippet ?? w.text ?? '')}</div>
          </div>`).join('')}
      </div>` : ''}
  </div>`;
}

// ── skeleton navigation panel ─────────────────────────────────────────────
// Copy deliberately frames summaries as a MAP: navigation aid, not evidence.
async function loadSkeleton(name, hasSkeleton) {
  const box = $('#col-skel');
  if (!hasSkeleton) {
    box.innerHTML = '<div class="empty">No skeleton navigation for this collection.</div>' +
      '<p class="skel-note">Skeleton navigation is generated when a collection is indexed with skeleton-first chunking enabled.</p>';
    return;
  }
  try {
    const { skeleton } = await api(`/api/collections/${encodeURIComponent(name)}/skeleton`);
    if (!skeleton) {
      box.innerHTML = '<div class="empty">No skeleton navigation for this collection.</div>';
      return;
    }
    renderSkeletonLevel(box, name, skeleton, [{ label: 'root', nodePath: skeleton.nodePath }]);
  } catch (err) { box.innerHTML = errorBox(err); }
}

async function renderSkeletonLevel(box, name, parentNode, crumbs) {
  box.innerHTML = '<div class="empty">loading…</div>';
  let children = [];
  // Use the same signal the drillable-node rendering below uses (childCount),
  // not the children path array — nodes returned from /skeleton/children can
  // carry childCount without a populated children array, and the two must
  // agree or a drill-down click silently dead-ends on "No child nodes".
  const mayHaveChildren = (parentNode.childCount ?? parentNode.children?.length ?? 0) > 0;
  try {
    if (mayHaveChildren && parentNode.nodePath) {
      const qs = `nodePath=${encodeURIComponent(parentNode.nodePath)}&limit=100`;
      const body = await api(`/api/collections/${encodeURIComponent(name)}/skeleton/children?${qs}`);
      children = body.children;
    }
  } catch (err) { box.innerHTML = errorBox(err); return; }

  const crumbsHtml = crumbs.map((c, i) =>
    i === crumbs.length - 1
      ? `<span>${esc(c.label)}</span>`
      : `<a data-crumb="${i}">${esc(c.label)}</a>`
  ).join(' <span class="muted">/</span> ');

  box.innerHTML = `
    <div class="skel-crumbs">${crumbsHtml}</div>
    ${parentNode.summary ? `<p class="skel-note" style="margin-top:0">${esc(parentNode.summary)}</p>` : ''}
    ${children.length
      ? children.map((n, i) => `
        <div class="skel-node ${n.childCount > 0 ? 'drillable' : ''}" data-i="${i}">
          <span class="skel-type">${esc(n.nodeType ?? '?')}</span>
          <span class="skel-path">${esc(shortPath(n))}</span>
          ${n.childCount > 0 ? `<span class="count mono muted"> · ${n.childCount} inside</span>` : ''}
          ${n.summary ? `<div class="skel-summary">${esc(n.summary)}</div>` : ''}
        </div>`).join('')
      : '<div class="empty">No child nodes.</div>'}
    <p class="skel-note">Summaries are a navigation map for orientation — verify facts in the chunks themselves.</p>`;

  for (const el of box.querySelectorAll('.skel-node.drillable')) {
    const node = children[Number(el.dataset.i)];
    el.addEventListener('click', () =>
      renderSkeletonLevel(box, name, node, [...crumbs, { label: shortPath(node), nodePath: node.nodePath }]));
  }
  for (const a of box.querySelectorAll('[data-crumb]')) {
    a.addEventListener('click', async () => {
      const idx = Number(a.dataset.crumb);
      const target = crumbs[idx];
      // Re-fetch the crumb node so its children list is fresh.
      const qs = `nodePath=${encodeURIComponent(target.nodePath)}`;
      try {
        const { node } = await api(`/api/collections/${encodeURIComponent(name)}/skeleton/node?${qs}`);
        renderSkeletonLevel(box, name, node, crumbs.slice(0, idx + 1));
      } catch (err) { box.innerHTML = errorBox(err); }
    });
  }
}

function shortPath(node) {
  const p = node.nodePath ?? node.nodeId ?? '?';
  const tail = String(p).split('/').filter(Boolean).slice(-1)[0] ?? p;
  return tail.length > 60 ? tail.slice(0, 57) + '…' : tail;
}

// ── router ────────────────────────────────────────────────────────────────
function currentRoute() {
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/collections\/(.+)$/);
  if (m) return { view: 'collection', name: decodeURIComponent(m[1]) };
  return { view: 'overview' };
}

async function route() {
  const main = $('#main');
  const r = currentRoute();
  markActive();
  if (r.view === 'collection') await renderCollection(main, r.name);
  else await renderOverview(main);
}

window.addEventListener('hashchange', route);

loadTopbar();
loadSidebar();
route();
