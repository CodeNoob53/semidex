// semidex admin console — Phase 2A read-only shell.
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
    <p class="view-sub">Collection detail — metadata, indexed documents, skeleton navigation.</p>
    <div class="panel"><div class="panel-head">Metadata</div><div class="panel-body" id="col-meta">…</div></div>
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
      <table class="data"><thead><tr><th>source file</th><th class="num">chunks</th></tr></thead><tbody>
      ${documents.map(d => `
        <tr class="rowlink doc-row" data-sf="${esc(d.sourceFile)}">
          <td class="mono">${esc(d.sourceFile)}</td>
          <td class="num">${d.chunkCount}</td>
        </tr>`).join('')}
      </tbody></table>`;
    for (const row of box.querySelectorAll('.doc-row')) {
      row.addEventListener('click', () => loadChunkPreview(name, row.dataset.sf));
    }
  } catch (err) { box.innerHTML = errorBox(err); }
}

async function loadChunkPreview(name, sourceFile) {
  const panel = $('#chunk-panel');
  const box = $('#col-chunks');
  panel.style.display = '';
  $('#chunk-title').textContent = sourceFile;
  box.innerHTML = '<div class="empty">loading…</div>';
  try {
    const qs = `sourceFile=${encodeURIComponent(sourceFile)}&chunkIndex=0&window=2`;
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
