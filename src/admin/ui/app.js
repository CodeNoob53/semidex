(function polyfill() {
  const relList = document.createElement("link").relList;
  if (relList && relList.supports && relList.supports("modulepreload")) {
    return;
  }
  for (const link of document.querySelectorAll('link[rel="modulepreload"]')) {
    processPreload(link);
  }
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== "childList") {
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node.tagName === "LINK" && node.rel === "modulepreload")
          processPreload(node);
      }
    }
  }).observe(document, { childList: true, subtree: true });
  function getFetchOpts(link) {
    const fetchOpts = {};
    if (link.integrity) fetchOpts.integrity = link.integrity;
    if (link.referrerPolicy) fetchOpts.referrerPolicy = link.referrerPolicy;
    if (link.crossOrigin === "use-credentials")
      fetchOpts.credentials = "include";
    else if (link.crossOrigin === "anonymous") fetchOpts.credentials = "omit";
    else fetchOpts.credentials = "same-origin";
    return fetchOpts;
  }
  function processPreload(link) {
    if (link.ep)
      return;
    link.ep = true;
    const fetchOpts = getFetchOpts(link);
    fetch(link.href, fetchOpts);
  }
})();
const overviewShell = '<h1 class="view-title">overview</h1>\n<p class="view-sub">Local semidex instance — storage health, backend capabilities, indexed collections.</p>\n<div class="grid-2">\n  <div class="panel"><div class="panel-head">Storage health</div><div class="panel-body" id="ov-health">…</div></div>\n  <div class="panel"><div class="panel-head">Backend capabilities</div><div class="panel-body" id="ov-caps">…</div></div>\n</div>\n<div class="panel"><div class="panel-head">Collections</div><div class="panel-body" id="ov-collections">…</div></div>\n';
const collectionShell = '<div class="col-header" id="col-header">…</div>\n<div class="panel">\n  <div class="panel-head"><span>Search this collection</span><span class="mono" id="search-mode"></span></div>\n  <div class="panel-body" id="search-panel">…</div>\n</div>\n<div class="panel" id="collection-content-panel" style="display:none">\n  <div class="panel-head"><span id="content-title">Results</span></div>\n  <div class="panel-body" id="collection-content"></div>\n</div>\n';
const settingsShell = '<div class="col-header-top">\n  <h1 class="view-title" id="settings-title">…</h1>\n  <a href="#" class="btn-ghost" id="settings-back-link">back to collection</a>\n</div>\n<div class="panel" id="settings-health">…</div>\n\n<div class="panel">\n  <div class="panel-head">Reindex</div>\n  <div class="panel-body">\n    <p class="skel-note" style="margin-top:0">Reindex starts a background job and writes to this collection.</p>\n    <form id="settings-reindex-form" autocomplete="off">\n      <div id="settings-source-path-field"></div>\n      <div class="opt-group">\n        <div class="opt-group-label">Quality</div>\n        <label class="idx-check"><input type="checkbox" id="opt-onnx" checked> ONNX embeddings</label>\n        <label class="idx-check"><input type="checkbox" id="opt-llm-summaries"> LLM summaries <span class="mono muted">(context summaries via a local LLM)</span></label>\n      </div>\n      <div class="opt-group">\n        <div class="opt-group-label">Structure</div>\n        <label class="idx-check"><input type="checkbox" id="opt-skel-chunk" checked> Skeleton chunking</label>\n        <label class="idx-check"><input type="checkbox" id="opt-skel-nav" checked> Skeleton navigation</label>\n      </div>\n      <div class="opt-group">\n        <div class="opt-group-label">Optional enrichment</div>\n        <label class="idx-check"><input type="checkbox" id="opt-tags"> Generate tags</label>\n      </div>\n      <div class="opt-group">\n        <div class="opt-group-label">Maintenance</div>\n        <label class="idx-check"><input type="checkbox" id="opt-prune"> Prune stale</label>\n        <p class="skel-note">Use prune stale only with the full source root.</p>\n      </div>\n      <button type="submit" class="btn-amber" id="settings-reindex-submit">Reindex collection</button>\n    </form>\n    <div id="settings-reindex-result"></div>\n  </div>\n</div>\n\n<div class="panel">\n  <div class="panel-head">Repair collection compatibility</div>\n  <div class="panel-body">\n    <p class="skel-note" style="margin-top:0" title="Checks and repairs semidex metadata, vector names, and payload indexes for this collection. It does not reindex files or update document content.">\n      Checks and repairs semidex metadata, vector names, and payload indexes for this collection.\n      It does not reindex files or update document content.\n    </p>\n    <button type="button" class="btn-amber" id="settings-repair">Repair collection compatibility</button>\n    <div id="settings-repair-result"></div>\n  </div>\n</div>\n\n<details class="panel advanced-panel">\n  <summary class="panel-head">Advanced diagnostics</summary>\n  <div class="panel-body" id="settings-diagnostics">…</div>\n</details>\n\n<div class="panel maint-danger">\n  <div class="panel-head">Delete collection</div>\n  <div class="panel-body">\n    <p class="skel-note" style="margin-top:0">Deleting a collection permanently removes it from storage. This cannot be undone.</p>\n    <button type="button" class="btn-danger" id="settings-delete-btn">Delete collection</button>\n  </div>\n</div>\n<div id="delete-modal-slot"></div>\n';
const indexViewShell = `<h1 class="view-title">Create a collection</h1>
<p class="view-sub">Choose a folder on your computer to index into a new or existing collection. Indexing writes to the selected collection.</p>
<div class="panel">
  <div class="panel-head">Start an indexing job</div>
  <div class="panel-body">
    <form id="index-form" autocomplete="off">
      <label class="form-row">
        <span>collection name</span>
        <input type="text" id="idx-collection" class="q-input" placeholder="Основи Node.js" required>
      </label>
      <label class="form-row">
        <span>folder to index</span>
        <div class="path-picker-row">
          <input type="text" id="idx-path" class="q-input" placeholder="Choose a folder, or type a path" style="display:none">
          <button type="button" class="btn-ghost" id="idx-choose-folder">Choose folder…</button>
        </div>
        <div id="idx-path-fallback" style="display:none">
          <p class="skel-note" style="margin-top:6px">
            The folder picker isn't available here — enter the path manually.
          </p>
          <input type="text" id="idx-path-manual" class="q-input" placeholder="C:\\path\\to\\docs or ./docs">
        </div>
      </label>
      <div class="idx-options">
        <label class="idx-check"><input type="checkbox" id="opt-onnx" checked> ONNX embeddings</label>
        <label class="idx-check"><input type="checkbox" id="opt-llm-summaries"> LLM summaries <span class="mono muted">(requires Ollama)</span></label>
        <label class="idx-check"><input type="checkbox" id="opt-skel-chunk" checked> Skeleton chunking</label>
        <label class="idx-check"><input type="checkbox" id="opt-skel-nav" checked> Skeleton navigation</label>
        <details class="advanced-box">
          <summary>Advanced options</summary>
          <label class="idx-check"><input type="checkbox" id="opt-prune"> Prune stale</label>
          <label class="idx-check"><input type="checkbox" id="opt-tags"> Generate tags</label>
          <p class="skel-note">Prune stale should be used only with the full source root.</p>
        </details>
      </div>
      <div id="idx-ollama-status" style="display:none"></div>
      <button type="submit" class="btn-amber" id="idx-submit">start indexing</button>
    </form>
    <div id="idx-status" class="empty"></div>
  </div>
</div>
<div class="panel">
  <div class="panel-head">Indexing progress</div>
  <div class="panel-body" id="idx-jobs">…</div>
</div>
`;
const $ = (sel, root = document) => root.querySelector(sel);
async function api(path) {
  var _a;
  const res = await fetch(path);
  let body = null;
  try {
    body = await res.json();
  } catch {
  }
  if (!res.ok) {
    const message = ((_a = body == null ? void 0 : body.error) == null ? void 0 : _a.message) ?? `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return body;
}
async function apiPost(path, payload) {
  var _a;
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
  }
  if (!res.ok) {
    const message = ((_a = body == null ? void 0 : body.error) == null ? void 0 : _a.message) ?? `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return body;
}
async function apiDelete(path) {
  var _a;
  const res = await fetch(path, { method: "DELETE" });
  let body = null;
  try {
    body = await res.json();
  } catch {
  }
  if (!res.ok) {
    const message = ((_a = body == null ? void 0 : body.error) == null ? void 0 : _a.message) ?? `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return body;
}
function esc(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function cloneTemplate(id) {
  const tpl = document.getElementById(id);
  if (!tpl) throw new Error(`template #${id} not found — check index.html <load> tags`);
  return tpl.content.cloneNode(true);
}
function errorBox(err) {
  const frag = cloneTemplate("tpl-error-state");
  frag.querySelector(".error-box").textContent = err.message;
  return frag.firstElementChild.outerHTML;
}
const TOAST_AUTO_DISMISS_MS = 8e3;
function showToast(message, { variant = "warn" } = {}) {
  const host = $("#toast-host");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast toast-${variant}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), TOAST_AUTO_DISMISS_MS);
}
const shownCollectionWarnings = /* @__PURE__ */ new Set();
function showCollectionWarnings(name, warnings) {
  for (const w of warnings ?? []) {
    const key = JSON.stringify([name, w]);
    if (shownCollectionWarnings.has(key)) continue;
    shownCollectionWarnings.add(key);
    showToast(w);
  }
}
function emptyBox(message) {
  const frag = cloneTemplate("tpl-empty-state");
  frag.querySelector(".empty").textContent = message;
  return frag.firstElementChild.outerHTML;
}
async function loadTopbar() {
  const lamp = $("#health-lamp");
  const text = $("#health-text");
  try {
    const health = await api("/api/health");
    lamp.className = `lamp ${health.ok ? "lamp-ok" : "lamp-fail"}`;
    text.textContent = `${health.storage.backend} · ${health.ok ? "reachable" : "unreachable"}`;
    text.title = health.storage.detail ?? "";
  } catch (err) {
    lamp.className = "lamp lamp-fail";
    text.textContent = "local api error";
    text.title = err.message;
  }
  try {
    const caps = await api("/api/capabilities");
    const on = Object.entries(caps.capabilities).filter(([, v]) => v).map(([k]) => k);
    $("#cap-summary").textContent = on.length ? `caps: ${on.length} on` : "";
    $("#cap-summary").title = on.join(", ");
  } catch {
  }
}
let collectionsCache = [];
let expandedCollection = null;
async function loadSidebar() {
  const list = $("#collection-list");
  try {
    const { collections } = await api("/api/collections");
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
  const list = $("#collection-list");
  list.innerHTML = collections.map((c) => `
    <li class="tree-collection">
      <a href="#/c/${encodeURIComponent(c.name)}" data-name="${esc(c.name)}" class="tree-row tree-collection-row">
        <span class="tree-caret">${expandedCollection === c.name ? "▾" : "▸"}</span>
        <span class="tree-label">${esc(c.name)}</span>
        <span class="count">${Number(c.pointCount ?? 0).toLocaleString("en-US")}</span>
      </a>
      <div class="tree-children" id="tree-${cssId(c.name)}" ${expandedCollection === c.name ? "" : 'style="display:none"'}></div>
    </li>`).join("");
  for (const row of list.querySelectorAll(".tree-collection-row")) {
    row.addEventListener("click", (e) => {
      e.preventDefault();
      const name = row.dataset.name;
      location.hash = `#/c/${encodeURIComponent(name)}`;
      toggleSidebarTree(name);
    });
  }
  if (expandedCollection && collections.some((c) => c.name === expandedCollection)) {
    loadSidebarTree(expandedCollection);
  }
}
function cssId(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}
function toggleSidebarTree(name) {
  const willExpand = expandedCollection !== name;
  expandedCollection = willExpand ? name : null;
  renderSidebarList(collectionsCache);
}
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
    box.innerHTML = documents.map((d) => `
      <a href="#/c/${encodeURIComponent(name)}/f/${encodeURIComponent(d.sourceFile)}"
         class="tree-row tree-file" data-sf="${esc(d.sourceFile)}" style="--depth:1">
        <span class="tree-label mono">${esc(shortLabel(d.sourceFile))}</span>
      </a>`).join("");
  } catch (err) {
    box.innerHTML = `<div class="tree-loading">${esc(err.message)}</div>`;
  }
}
async function renderSidebarSkeletonLevel(box, name, node, depth) {
  const children = await fetchSkeletonChildren(name, node);
  box.innerHTML = children.length ? children.map((n, i) => sidebarNodeRow(n, i, depth)).join("") : '<div class="tree-loading">No child nodes.</div>';
  for (const el of box.querySelectorAll(":scope > .tree-node")) {
    const node2 = children[Number(el.dataset.i)];
    el.addEventListener("click", () => onSidebarNodeClick(name, node2, el, depth));
  }
}
async function fetchSkeletonChildren(name, node) {
  var _a;
  const mayHaveChildren = (node.childCount ?? ((_a = node.children) == null ? void 0 : _a.length) ?? 0) > 0;
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
  const isLeaf = n.nodeType === "section" || n.nodeType === "file" && !(n.childCount > 0);
  const icon = n.nodeType === "directory" ? "📁" : n.nodeType === "file" ? "📄" : "§";
  const label = nodeDisplayLabel(n);
  const tooltip = [n.summary, n.nodePath].filter(Boolean).join(" — ");
  return `
    <div class="tree-row tree-node ${isLeaf ? "tree-leaf" : ""}" data-i="${i}" style="--depth:${depth + 1}">
      <span class="tree-caret">${n.childCount > 0 ? "▸" : ""}</span>
      <span class="tree-icon">${icon}</span>
      <span class="tree-label" title="${esc(tooltip)}">${esc(label)}</span>
    </div>`;
}
function nodeDisplayLabel(n) {
  if (n.nodeType === "file") {
    const src = n.sourceFile || String(n.nodePath ?? "").replace(/#file$/, "");
    return basename(src) || shortLabel(n.nodePath ?? n.nodeId ?? "?");
  }
  if (n.nodeType === "section") {
    const last = Array.isArray(n.headingPath) ? n.headingPath.at(-1) : null;
    if (last) return shortLabel(last);
    return shortLabel(n.summary || n.nodePath || n.nodeId || "?");
  }
  if (n.nodeType === "directory") {
    const dirPath = String(n.nodePath ?? "").replace(/^[^#]*#dir\//, "");
    return basename(dirPath) || shortLabel(n.nodePath ?? n.nodeId ?? "?");
  }
  return shortLabel(n.nodePath ?? n.nodeId ?? "?");
}
function basename(path) {
  return String(path ?? "").split("/").filter(Boolean).at(-1) ?? "";
}
function shortLabel(path) {
  const tail = String(path).split("/").filter(Boolean).slice(-1)[0] ?? path;
  const clean = tail.replace(/^[^#]*#/, "");
  return clean.length > 46 ? clean.slice(0, 43) + "…" : clean;
}
async function onSidebarNodeClick(name, node, el, depth) {
  if (node.nodeType === "section") {
    location.hash = `#/c/${encodeURIComponent(name)}/n/${encodeURIComponent(node.nodePath)}`;
    return;
  }
  if (node.nodeType === "file" && !(node.childCount > 0)) {
    location.hash = `#/c/${encodeURIComponent(name)}/f/${encodeURIComponent(node.sourceFile ?? node.nodePath)}`;
    return;
  }
  let sub = el.nextElementSibling;
  if (sub == null ? void 0 : sub.classList.contains("tree-subtree")) {
    sub.remove();
    el.querySelector(".tree-caret").textContent = "▸";
    return;
  }
  el.querySelector(".tree-caret").textContent = "▾";
  sub = document.createElement("div");
  sub.className = "tree-subtree";
  el.insertAdjacentElement("afterend", sub);
  await renderSidebarSkeletonLevel(sub, name, node, depth + 1);
}
function markActive() {
  var _a;
  const current = currentRoute();
  for (const a of document.querySelectorAll(".tree-collection-row")) {
    a.classList.toggle("active", current.view !== "index" && a.dataset.name === current.name);
  }
  (_a = $("#nav-index")) == null ? void 0 : _a.classList.toggle("active", current.view === "index");
}
async function renderOverview(main) {
  main.innerHTML = overviewShell;
  try {
    const health = await api("/api/health");
    $("#ov-health").innerHTML = `
      <dl class="kv">
        <dt>backend</dt><dd>${esc(health.storage.backend)}</dd>
        <dt>status</dt><dd><span class="badge ${health.ok ? "badge-ok" : "badge-fail"}">${health.ok ? "reachable" : "unreachable"}</span></dd>
        <dt>detail</dt><dd>${esc(health.storage.detail ?? "—")}</dd>
      </dl>`;
  } catch (err) {
    $("#ov-health").innerHTML = errorBox(err);
  }
  try {
    const { backend, capabilities } = await api("/api/capabilities");
    $("#ov-caps").innerHTML = `
      <div class="caps">${Object.entries(capabilities).map(([k, v]) => `<span class="cap ${v ? "on" : ""}">${esc(k)}</span>`).join("")}</div>
      <p class="skel-note">Capabilities describe what the <b>${esc(backend)}</b> storage backend supports.
      Backend-specific panels appear only when their capability is on.</p>`;
  } catch (err) {
    $("#ov-caps").innerHTML = errorBox(err);
  }
  try {
    const { collections } = await api("/api/collections");
    if (!collections.length) {
      $("#ov-collections").innerHTML = emptyBox("No collections indexed yet.");
      return;
    }
    $("#ov-collections").innerHTML = `
      <table class="data"><thead><tr>
        <th>name</th><th class="num">points</th><th>schema</th>
      </tr></thead><tbody>
      ${collections.map((c) => `
        <tr class="rowlink" data-href="#/c/${encodeURIComponent(c.name)}">
          <td class="mono">${esc(c.name)}</td>
          <td class="num">${Number(c.pointCount ?? 0).toLocaleString("en-US")}</td>
          <td>${schemaBadge(c.vectorSchema)}</td>
        </tr>`).join("")}
      </tbody></table>`;
    for (const row of document.querySelectorAll("tr.rowlink")) {
      row.addEventListener("click", () => {
        location.hash = row.dataset.href;
      });
    }
  } catch (err) {
    $("#ov-collections").innerHTML = errorBox(err);
  }
}
function schemaBadge(schema) {
  if (schema === "named") return '<span class="badge badge-ok">named</span>';
  if (schema === "flat") return '<span class="badge badge-warn">legacy flat</span>';
  if (schema === "empty") return '<span class="badge badge-fail">empty</span>';
  return `<span class="badge">${esc(schema ?? "?")}</span>`;
}
async function renderCollection(main, name) {
  const alreadyOnThisCollection = expandedCollection === name && main.querySelector("#col-header");
  if (expandedCollection !== name) {
    expandedCollection = name;
    renderSidebarList(collectionsCache);
  }
  if (!alreadyOnThisCollection) {
    main.innerHTML = collectionShell;
    initSearchPanel(name);
  }
  let detail;
  try {
    detail = (await api(`/api/collections/${encodeURIComponent(name)}`)).collection;
  } catch (err) {
    $("#col-header").innerHTML = errorBox(err);
    return;
  }
  renderCollectionHeader(name, detail);
  if (!alreadyOnThisCollection) showCollectionWarnings(name, detail.warnings);
}
function renderCollectionHeader(name, detail) {
  const warnings = detail.warnings ?? [];
  const healthBadge = warnings.length ? `<span class="badge badge-warn">${warnings.length} warning${warnings.length > 1 ? "s" : ""}</span>` : '<span class="badge badge-ok">healthy</span>';
  const fileCountLabel = detail.hasSkeleton ? "skeleton map available" : "flat file list";
  $("#col-header").innerHTML = `
    <div class="col-header-top">
      <h1 class="view-title">${esc(name)}</h1>
      ${healthBadge}
      <button type="button" class="btn-ghost" id="col-settings-btn">settings</button>
    </div>
    <details class="panel advanced-panel" style="margin-top:8px">
      <summary class="panel-head">Details</summary>
      <div class="panel-body">
        <p class="view-sub" style="margin:0 0 10px">${esc(detail.description || fileCountLabel)}</p>
        <span class="mono muted">${Number(detail.pointCount ?? 0).toLocaleString("en-US")} points</span>
        ${warnings.length ? warnings.map((w) => `<div class="error-box" style="margin-top:10px">${esc(w)}</div>`).join("") : ""}
      </div>
    </details>`;
  $("#col-settings-btn").addEventListener("click", () => {
    location.hash = `#/c/${encodeURIComponent(name)}/settings`;
  });
}
let searchSourceFile = null;
function initSearchPanel(name) {
  searchSourceFile = null;
  const box = $("#search-panel");
  box.innerHTML = `
    <form class="search-form" id="search-form" autocomplete="off">
      <div class="search-main-row">
        <input type="text" id="q-input" class="q-input"
          placeholder="Ask a question about this collection…">
        <label class="ctl" title="Number of results to return">top
          <select id="q-top">${[3, 5, 10, 20].map((n) => `<option value="${n}" ${n === 5 ? "selected" : ""}>${n}</option>`).join("")}</select>
        </label>
        <button type="submit" class="btn-amber" id="q-submit">Search</button>
      </div>
      <details class="advanced-box">
        <summary>Advanced</summary>
        <div class="search-controls">
          <label class="ctl" title="Extra chunks to show before/after each result">window
            <select id="q-window">${[0, 1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${n === 1 ? "selected" : ""}>${n}</option>`).join("")}</select>
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
  $("#q-format").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-v]");
    if (!btn) return;
    for (const b of $("#q-format").querySelectorAll("button")) b.classList.toggle("on", b === btn);
  });
  $("#q-file-clear").addEventListener("click", () => clearSearchFile());
  $("#search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    runSearch(name);
  });
}
function clearSearchFile() {
  searchSourceFile = null;
  $("#q-file-chip").style.display = "none";
}
async function runSearch(name) {
  var _a;
  const status = $("#search-status");
  const resultsBox = $("#search-results");
  const submit = $("#q-submit");
  const query = $("#q-input").value.trim();
  if (!query) {
    status.className = "error-box";
    status.textContent = "Enter a query first.";
    return;
  }
  const top = Number($("#q-top").value);
  const window2 = Number($("#q-window").value);
  const windowFormat = ((_a = $("#q-format .on")) == null ? void 0 : _a.dataset.v) ?? "full";
  const showScore = $("#q-show-score").checked;
  const payload = { collection: name, query, top, window: window2 };
  if (window2 > 0) payload.windowFormat = windowFormat;
  if (searchSourceFile) payload.sourceFile = searchSourceFile;
  submit.disabled = true;
  status.className = "empty";
  status.textContent = "searching…";
  resultsBox.innerHTML = "";
  hideCollectionContent();
  try {
    const body = await apiPost("/api/search", payload);
    $("#search-mode").textContent = body.searchMode ? `mode: ${body.searchMode}` : "";
    if (!body.results.length) {
      status.textContent = searchSourceFile ? "No results in the filtered file — try clearing the file filter." : "No results for this query.";
      return;
    }
    status.textContent = `${body.results.length} result${body.results.length > 1 ? "s" : ""}` + (searchSourceFile ? ` · filtered to one file` : "");
    resultsBox.replaceChildren(...body.results.map((r, i) => renderResult(r, i, showScore)));
    for (const btn of resultsBox.querySelectorAll(".result-open")) {
      btn.addEventListener("click", () => openFileView(name, btn.dataset.sf, null, Number(btn.dataset.ci)));
    }
  } catch (err) {
    status.className = "error-box";
    status.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
}
function renderResult(r, i, showScore) {
  const canOpen = r.sourceFile && Number.isInteger(r.chunkIndex);
  const frag = cloneTemplate("tpl-search-result");
  const card = frag.querySelector(".result-card");
  card.querySelector(".rank").textContent = `#${i + 1}`;
  const scoreEl = card.querySelector(".score");
  if (showScore && typeof r.score === "number") {
    scoreEl.textContent = r.score.toFixed(4);
    scoreEl.hidden = false;
  }
  card.querySelector(".result-source").textContent = r.sourceFile ?? "?";
  card.querySelector(".result-chunk-index").textContent = `chunk ${r.chunkIndex ?? "?"}${r.totalChunks ? ` / ${r.totalChunks}` : ""}`;
  card.querySelector(".result-section").textContent = r.section || "intro";
  const nodeTypeEl = card.querySelector(".result-node-type");
  if (r.nodeType) {
    nodeTypeEl.textContent = r.nodeType;
    nodeTypeEl.hidden = false;
  }
  const openBtn = card.querySelector(".result-open");
  if (canOpen) {
    openBtn.dataset.sf = r.sourceFile;
    openBtn.dataset.ci = String(r.chunkIndex);
    openBtn.hidden = false;
  }
  const contextEl = card.querySelector(".chunk-context");
  if (r.context) {
    contextEl.textContent = r.context;
    contextEl.hidden = false;
  }
  card.querySelector(".chunk-text").textContent = r.text ?? "";
  if (Array.isArray(r.windowChunks) && r.windowChunks.length) {
    const winBox = card.querySelector(".win-chunks");
    winBox.hidden = false;
    for (const w of r.windowChunks) {
      const wFrag = cloneTemplate("tpl-window-chunk");
      const wEl = wFrag.querySelector(".win-chunk");
      wEl.classList.toggle("match", Boolean(w.isMatch));
      wEl.querySelector(".win-chunk-index").textContent = `#${w.chunkIndex ?? "?"}`;
      const wBadge = wEl.querySelector(".badge");
      wBadge.hidden = !w.isMatch;
      wEl.querySelector(".win-section").textContent = w.section || "";
      wEl.querySelector(".win-text").textContent = w.textSnippet ?? w.text ?? "";
      winBox.appendChild(wFrag);
    }
  }
  return card;
}
let fileViewState = null;
function hideCollectionContent() {
  const panel = $("#collection-content-panel");
  if (panel) panel.style.display = "none";
}
async function openSectionView(name, node) {
  const panel = $("#collection-content-panel");
  const title = $("#content-title");
  const box = $("#collection-content");
  if (!panel || !box) return;
  panel.style.display = "";
  title.textContent = nodeDisplayLabel(node);
  box.innerHTML = emptyBox("loading…");
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  try {
    const qs = `nodePath=${encodeURIComponent(node.nodePath)}`;
    const { chunk } = await api(`/api/collections/${encodeURIComponent(name)}/skeleton/anchor?${qs}`);
    return openFileView(name, chunk.sourceFile, node.nodePath, chunk.chunkIndex);
  } catch (err) {
    if (err.status === 404) {
      box.innerHTML = '<div class="empty">This section has no indexed content.' + (node.sourceFile ? ' <button type="button" class="mini-btn" id="section-open-file-start">Open file from start</button>' : "") + "</div>";
      const btn = box.querySelector("#section-open-file-start");
      btn == null ? void 0 : btn.addEventListener("click", () => openFileView(name, node.sourceFile, node.nodePath, 0));
      return;
    }
    box.innerHTML = errorBox(err);
  }
}
async function openFileView(name, sourceFile, nodePath, chunkIndex = 0) {
  const panel = $("#collection-content-panel");
  const title = $("#content-title");
  const box = $("#collection-content");
  if (!panel || !box) return;
  panel.style.display = "";
  title.textContent = sourceFile;
  box.innerHTML = emptyBox("loading…");
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  fileViewState = { name, sourceFile, chunkIndex, loaded: 0 };
  try {
    const qs = `sourceFile=${encodeURIComponent(sourceFile)}&chunkIndex=${chunkIndex}&window=3`;
    const { chunks } = await api(`/api/collections/${encodeURIComponent(name)}/chunks?${qs}`);
    if (!chunks.length) {
      box.innerHTML = emptyBox("No chunks found for this file/section.");
      return;
    }
    fileViewState.loaded = chunks.length;
    box.replaceChildren(renderFileChunks(chunks));
    box.insertAdjacentHTML("beforeend", fileViewLoadMoreButton());
    wireFileViewButtons(box);
  } catch (err) {
    box.innerHTML = errorBox(err);
  }
}
const STRUCTURAL_NODE_TYPES = /* @__PURE__ */ new Set(["table", "code_block", "checklist"]);
const NODE_TYPE_BADGE_LABEL = {
  code_block: "code",
  table: "table",
  checklist: "checklist",
  list: "list",
  paragraph: "paragraph",
  blockquote: "blockquote",
  image: "image",
  section: "section",
  file: "file",
  directory: "directory"
};
function nodeTypeBadgeLabel(nodeType) {
  return NODE_TYPE_BADGE_LABEL[nodeType] ?? nodeType;
}
function renderFileChunks(chunks) {
  const out = document.createDocumentFragment();
  for (const c of chunks) {
    const isStructural = STRUCTURAL_NODE_TYPES.has(c.nodeType);
    const contextLabel = isStructural ? "retrieval context" : "section path";
    const frag = cloneTemplate("tpl-chunk-card");
    const card = frag.querySelector(".chunk");
    card.querySelector(".chunk-index-label").textContent = `chunk ${c.chunkIndex}${c.totalChunks ? ` / ${c.totalChunks}` : ""}`;
    card.querySelector(".chunk-section").textContent = c.section || "intro";
    const nodeTypeEl = card.querySelector(".chunk-node-type");
    if (c.nodeType) {
      nodeTypeEl.textContent = nodeTypeBadgeLabel(c.nodeType);
      nodeTypeEl.title = `node_type: ${c.nodeType}`;
      nodeTypeEl.hidden = false;
    }
    const contextEl = card.querySelector(".chunk-context");
    if (c.context) {
      card.querySelector(".chunk-context-label").textContent = `${contextLabel}:`;
      card.querySelector(".chunk-context-text").textContent = c.context;
      contextEl.hidden = false;
    }
    card.querySelector(".chunk-text").textContent = c.text ?? "";
    out.appendChild(frag);
  }
  return out;
}
function fileViewLoadMoreButton() {
  return '<button type="button" class="mini-btn" id="file-load-more">load more</button>';
}
function wireFileViewButtons(box) {
  const btn = box.querySelector("#file-load-more");
  btn == null ? void 0 : btn.addEventListener("click", loadMoreFileChunks);
}
async function loadMoreFileChunks() {
  if (!fileViewState) return;
  const { name, sourceFile, loaded } = fileViewState;
  const box = $("#collection-content");
  const btn = $("#file-load-more");
  if (btn) btn.disabled = true;
  try {
    const nextIndex = loaded;
    const qs = `sourceFile=${encodeURIComponent(sourceFile)}&chunkIndex=${nextIndex}&window=3`;
    const { chunks } = await api(`/api/collections/${encodeURIComponent(name)}/chunks?${qs}`);
    const newOnes = chunks.filter((c) => c.chunkIndex >= loaded);
    if (!newOnes.length) {
      btn == null ? void 0 : btn.remove();
      return;
    }
    fileViewState.loaded = Math.max(loaded, ...newOnes.map((c) => c.chunkIndex + 1));
    btn == null ? void 0 : btn.before(renderFileChunks(newOnes));
    if (btn) btn.disabled = false;
  } catch (err) {
    box.insertAdjacentHTML("beforeend", errorBox(err));
  }
}
const RECENT_SOURCE_PATHS_KEY = "semidex-admin-recent-source-paths";
function getRecentSourcePaths() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_SOURCE_PATHS_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function rememberSourcePath(path) {
  const recent = [path, ...getRecentSourcePaths().filter((p) => p !== path)].slice(0, 8);
  try {
    localStorage.setItem(RECENT_SOURCE_PATHS_KEY, JSON.stringify(recent));
  } catch {
  }
}
async function renderSettingsView(main, name) {
  main.innerHTML = settingsShell;
  $("#settings-title").textContent = `${name} · settings`;
  $("#settings-back-link").setAttribute("href", `#/c/${encodeURIComponent(name)}`);
  $("#settings-source-path-field").innerHTML = renderSourcePathField();
  const modal = cloneTemplate("tpl-delete-modal");
  modal.querySelector("#delete-modal-name").textContent = name;
  $("#delete-modal-slot").replaceChildren(modal);
  $("#opt-prune").addEventListener("change", (e) => {
    e.target.closest("label").classList.toggle("warn", e.target.checked);
  });
  $("#settings-reindex-form").addEventListener("submit", (e) => {
    e.preventDefault();
    runSettingsReindex(name);
  });
  $("#settings-repair").addEventListener("click", () => runSettingsRepair(name));
  $("#settings-delete-btn").addEventListener("click", () => openDeleteModal());
  $("#delete-modal-cancel").addEventListener("click", () => closeDeleteModal());
  $("#delete-modal-confirm").addEventListener("click", () => runDeleteCollection(name));
  let detail;
  try {
    detail = (await api(`/api/collections/${encodeURIComponent(name)}`)).collection;
  } catch (err) {
    $("#settings-health").innerHTML = errorBox(err);
    $("#settings-diagnostics").innerHTML = errorBox(err);
    return;
  }
  renderSettingsHealth(detail);
  renderAdvancedDiagnostics(detail);
}
function renderSourcePathField() {
  const recent = getRecentSourcePaths();
  const options = recent.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
  return `
    <label class="form-row">
      <span>source path ${recent.length ? "" : "(no recent paths yet — choose a folder below)"}</span>
      ${recent.length ? `
        <select id="settings-path-recent" class="q-input">
          <option value="">— choose a recent source root —</option>
          ${options}
          <option value="__manual__">Choose a different folder…</option>
        </select>` : ""}
      <div class="path-picker-row" style="${recent.length ? "display:none;margin-top:6px" : ""}" id="settings-path-manual-row">
        <input type="text" id="settings-path-manual" class="q-input" placeholder="Choose a folder, or type a path">
        <button type="button" class="btn-ghost" id="settings-choose-folder">Choose folder…</button>
      </div>
    </label>`;
}
function wireSourcePathField() {
  var _a;
  const select = $("#settings-path-recent");
  const manual = $("#settings-path-manual");
  const manualRow = $("#settings-path-manual-row");
  if (select) {
    select.addEventListener("change", () => {
      if (select.value === "__manual__" || select.value === "") {
        manualRow.style.display = "";
        manualRow.style.marginTop = "6px";
        if (select.value === "__manual__") manual.focus();
      } else {
        manualRow.style.display = "none";
        manual.value = select.value;
      }
    });
  }
  (_a = $("#settings-choose-folder")) == null ? void 0 : _a.addEventListener("click", async () => {
    const btn = $("#settings-choose-folder");
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = "Choosing…";
    try {
      const { path, cancelled } = await apiPost("/api/system/pick-folder", {});
      if (!cancelled && path) manual.value = path;
    } catch {
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });
}
function currentSourcePathValue() {
  const select = $("#settings-path-recent");
  const manual = $("#settings-path-manual");
  if (select && select.value && select.value !== "__manual__") return select.value;
  return (manual == null ? void 0 : manual.value.trim()) ?? "";
}
function renderSettingsHealth(detail) {
  const warnings = detail.warnings ?? [];
  const healthBadge = warnings.length ? `<span class="badge badge-warn">${warnings.length} warning${warnings.length > 1 ? "s" : ""}</span>` : '<span class="badge badge-ok">healthy</span>';
  $("#settings-health").innerHTML = `
    <div class="panel-head">Collection health</div>
    <div class="panel-body">
      <dl class="kv">
        <dt>status</dt><dd>${healthBadge}</dd>
        <dt>points</dt><dd>${Number(detail.pointCount ?? 0).toLocaleString("en-US")}</dd>
        <dt>skeleton nav</dt><dd>${detail.hasSkeleton ? "available" : "not enabled"}</dd>
      </dl>
      ${warnings.map((w) => `<div class="error-box" style="margin-top:12px">${esc(w)}</div>`).join("")}
    </div>`;
  wireSourcePathField();
}
function renderAdvancedDiagnostics(detail) {
  var _a, _b;
  const v = detail.vectorSchema ?? {};
  const p = detail.provider ?? {};
  const ver = detail.versions ?? {};
  $("#settings-diagnostics").innerHTML = `
    <dl class="kv">
      <dt>dense vector</dt><dd>${((_a = v.dense) == null ? void 0 : _a.size) ?? "—"} · ${esc(((_b = v.dense) == null ? void 0 : _b.distance) ?? "—")}</dd>
      <dt>sparse vector</dt><dd>${v.sparse ? "yes" : "no"}</dd>
      <dt>dense provider</dt><dd>${esc(p.denseProvider ?? "—")}${p.denseModel ? ` / ${esc(p.denseModel)}` : ""}</dd>
      <dt>sparse provider</dt><dd>${esc(p.sparseProvider ?? "—")}</dd>
      <dt>versions</dt><dd>embed v${ver.embeddingSchema ?? "?"} · chunk v${ver.chunkingSchema ?? "?"} · tokens ${esc(ver.tokenCountMode ?? "?")}</dd>
      <dt>semidex-managed</dt><dd>${detail.semidexManaged ? "yes" : "no"}</dd>
    </dl>`;
}
async function runSettingsReindex(name) {
  const submit = $("#settings-reindex-submit");
  const result = $("#settings-reindex-result");
  const path = currentSourcePathValue();
  if (!path) {
    result.className = "error-box";
    result.textContent = "Source path is required.";
    return;
  }
  const payload = {
    collection: name,
    path,
    options: {
      onnxEmbed: $("#opt-onnx").checked,
      llmSummaries: $("#opt-llm-summaries").checked,
      skeletonChunking: $("#opt-skel-chunk").checked,
      skeletonNav: $("#opt-skel-nav").checked,
      tagGen: $("#opt-tags").checked,
      pruneStale: $("#opt-prune").checked
    }
  };
  submit.disabled = true;
  result.className = "empty";
  result.textContent = "starting…";
  try {
    const body = await apiPost("/api/jobs/index", payload);
    rememberSourcePath(path);
    result.className = "empty";
    result.innerHTML = `Job started (<span class="mono">${esc(body.job.id)}</span>).
      <a href="#/index">Watch it on the indexing jobs view</a>.`;
  } catch (err) {
    result.className = "error-box";
    result.textContent = err.status === 409 ? `${err.message} Wait for it to finish, or cancel it from the indexing jobs view.` : err.message;
  } finally {
    submit.disabled = false;
  }
}
async function runSettingsRepair(name) {
  var _a, _b, _c;
  const btn = $("#settings-repair");
  const result = $("#settings-repair-result");
  btn.disabled = true;
  result.className = "empty";
  result.textContent = "checking…";
  try {
    const body = await apiPost(`/api/collections/${encodeURIComponent(name)}/sync-schema`, {});
    const parts = [];
    if ((_a = body.repaired) == null ? void 0 : _a.length) parts.push(`repaired: ${body.repaired.join(", ")}`);
    if ((_b = body.warnings) == null ? void 0 : _b.length) parts.push(`warnings: ${body.warnings.join(" · ")}`);
    result.className = ((_c = body.warnings) == null ? void 0 : _c.length) ? "error-box" : "empty";
    result.textContent = parts.length ? parts.join(" — ") : "Already compatible — nothing to repair.";
    const detail = (await api(`/api/collections/${encodeURIComponent(name)}`)).collection;
    renderSettingsHealth(detail);
    renderAdvancedDiagnostics(detail);
  } catch (err) {
    result.className = "error-box";
    result.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}
function openDeleteModal() {
  $("#delete-modal-backdrop").style.display = "";
}
function closeDeleteModal() {
  $("#delete-modal-backdrop").style.display = "none";
}
async function runDeleteCollection(name) {
  const btn = $("#delete-modal-confirm");
  const result = $("#settings-delete-result");
  btn.disabled = true;
  result.className = "empty";
  result.textContent = "deleting…";
  try {
    await apiDelete(`/api/collections/${encodeURIComponent(name)}`);
    if (expandedCollection === name) expandedCollection = null;
    location.hash = "#/";
    loadSidebar();
  } catch (err) {
    result.className = "error-box";
    result.textContent = err.message;
    btn.disabled = false;
  }
}
let indexPollTimer = null;
function stopIndexPolling() {
  if (indexPollTimer) {
    clearTimeout(indexPollTimer);
    indexPollTimer = null;
  }
}
async function renderIndexingView(main) {
  stopIndexPolling();
  stopJobElapsedTicker();
  main.innerHTML = indexViewShell;
  $("#opt-prune").addEventListener("change", (e) => {
    e.target.closest("label").classList.toggle("warn", e.target.checked);
  });
  $("#opt-llm-summaries").addEventListener("change", (e) => {
    if (e.target.checked) loadOllamaStatus();
    else $("#idx-ollama-status").style.display = "none";
  });
  $("#idx-choose-folder").addEventListener("click", chooseIndexFolder);
  $("#index-form").addEventListener("submit", (e) => {
    e.preventDefault();
    startIndexJob();
  });
  await loadJobs();
}
function currentIndexPathValue() {
  const manual = $("#idx-path-manual");
  const main = $("#idx-path");
  if (manual && manual.offsetParent !== null) return manual.value.trim();
  return main.value.trim();
}
async function chooseIndexFolder() {
  const btn = $("#idx-choose-folder");
  const pathInput = $("#idx-path");
  const fallback = $("#idx-path-fallback");
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = "Choosing…";
  try {
    const { path, cancelled } = await apiPost("/api/system/pick-folder", {});
    if (!cancelled && path) {
      pathInput.style.display = "";
      pathInput.value = path;
      fallback.style.display = "none";
    }
  } catch (err) {
    fallback.style.display = "";
    $("#idx-path-manual").focus();
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}
const OLLAMA_STATUS_BADGE = {
  available: "badge badge-ok",
  missing: "badge badge-fail",
  model_missing: "badge badge-warn"
};
async function loadOllamaStatus() {
  const box = $("#idx-ollama-status");
  if (!box) return;
  box.style.display = "";
  box.innerHTML = '<span class="mono muted">checking Ollama…</span>';
  try {
    const { status, message } = await api("/api/system/ollama-status");
    const badgeClass = OLLAMA_STATUS_BADGE[status] ?? "badge";
    box.innerHTML = `LLM summaries require Ollama:
      <span class="${badgeClass}">${esc(status)}</span>
      <span class="skel-note" style="display:inline;margin:0 0 0 6px">${esc(message)}</span>`;
  } catch (err) {
    box.innerHTML = errorBox(err);
  }
}
async function startIndexJob() {
  const status = $("#idx-status");
  const submit = $("#idx-submit");
  const collection = $("#idx-collection").value.trim();
  const path = currentIndexPathValue();
  if (!collection || !path) {
    status.className = "error-box";
    status.textContent = "Collection name and folder to index are both required.";
    return;
  }
  const payload = {
    collection,
    path,
    options: {
      onnxEmbed: $("#opt-onnx").checked,
      llmSummaries: $("#opt-llm-summaries").checked,
      skeletonChunking: $("#opt-skel-chunk").checked,
      skeletonNav: $("#opt-skel-nav").checked,
      pruneStale: $("#opt-prune").checked,
      tagGen: $("#opt-tags").checked
    }
  };
  submit.disabled = true;
  status.className = "empty";
  status.textContent = "starting…";
  try {
    await apiPost("/api/jobs/index", payload);
    status.textContent = "Job started.";
    await loadJobs();
  } catch (err) {
    status.className = "error-box";
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
  queued: "badge",
  running: "badge badge-amber",
  cancelling: "badge badge-warn",
  succeeded: "badge badge-ok",
  failed: "badge badge-fail",
  cancelled: "badge"
};
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1e3));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor(totalSeconds % 3600 / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}
function formatStartedLabel(startedAtIso) {
  if (!startedAtIso) return null;
  const started = new Date(startedAtIso);
  const now = /* @__PURE__ */ new Date();
  const sameDay = started.getFullYear() === now.getFullYear() && started.getMonth() === now.getMonth() && started.getDate() === now.getDate();
  const time = started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `Started ${time}` : `Started ${started.toLocaleDateString()} ${time}`;
}
function jobFilesLabel(progress) {
  if (!progress) return "";
  if (progress.totalFiles === null) {
    return progress.processedFiles !== null ? `${progress.processedFiles} files processed` : "";
  }
  return `${progress.processedFiles ?? 0} / ${progress.totalFiles} files processed`;
}
function renderJobRow(j) {
  var _a, _b;
  const frag = cloneTemplate("tpl-job-row");
  const card = frag.querySelector(".job-card");
  card.dataset.id = j.id;
  card.dataset.startedAt = j.startedAt ?? "";
  const badge = card.querySelector(".job-status-badge");
  badge.className = `job-status-badge ${JOB_STATUS_BADGE_CLASS[j.state] ?? "badge"}`;
  badge.textContent = j.state;
  const isRunning = j.state === "queued" || j.state === "running" || j.state === "cancelling";
  const titlePrefix = j.state === "succeeded" ? "Indexed" : j.state === "failed" ? "Indexing failed" : j.state === "cancelled" ? "Indexing cancelled" : `Indexing`;
  card.querySelector(".job-title").textContent = j.state === "failed" ? titlePrefix : `${titlePrefix} ${j.collection}`;
  card.querySelector(".job-progress-count").textContent = jobFilesLabel(j.progress);
  const currentFileEl = card.querySelector(".job-progress-current");
  if (isRunning && ((_a = j.progress) == null ? void 0 : _a.currentFile)) {
    currentFileEl.textContent = `Current file: ${j.progress.currentFile}`;
  }
  const stepEl = card.querySelector(".job-progress-step");
  if (isRunning && ((_b = j.progress) == null ? void 0 : _b.currentStep)) {
    stepEl.textContent = `Step: ${j.progress.currentStep}`;
    stepEl.hidden = false;
  }
  const hasKnownTotal = j.progress && typeof j.progress.percent === "number";
  card.querySelector(".job-progress-bar").hidden = !hasKnownTotal;
  card.querySelector(".job-progress-indeterminate").hidden = !isRunning || hasKnownTotal;
  if (hasKnownTotal) {
    card.querySelector(".job-progress-fill").style.width = `${Math.min(100, Math.max(0, j.progress.percent))}%`;
  }
  const cancelBtn = card.querySelector(".job-cancel");
  if (j.state === "queued" || j.state === "running") {
    cancelBtn.dataset.id = j.id;
    cancelBtn.hidden = false;
  }
  const statusLine = card.querySelector(".job-status-line");
  if (j.state === "cancelling") {
    statusLine.textContent = "Cancelling…";
  } else if (j.state === "succeeded") {
    statusLine.textContent = j.finishedAt && j.startedAt ? `Completed in ${formatDuration(new Date(j.finishedAt) - new Date(j.startedAt))}` : "Completed";
  } else if (j.state === "failed") {
    statusLine.textContent = j.finishedAt && j.startedAt ? `Failed after ${formatDuration(new Date(j.finishedAt) - new Date(j.startedAt))}` : "Failed";
  } else if (j.state === "cancelled") {
    statusLine.textContent = j.finishedAt && j.startedAt ? `Cancelled after ${formatDuration(new Date(j.finishedAt) - new Date(j.startedAt))}` : "Cancelled";
  }
  card.querySelector(".job-details").open = j.state === "failed";
  card.querySelector(".job-path").textContent = j.path;
  const startedLabel = formatStartedLabel(j.startedAt);
  const endedLabel = j.finishedAt ? `ended ${new Date(j.finishedAt).toLocaleString()}` : null;
  card.querySelector(".job-times").textContent = [startedLabel, endedLabel].filter(Boolean).join(" · ");
  return card;
}
let jobElapsedTimer = null;
function stopJobElapsedTicker() {
  if (jobElapsedTimer) {
    clearInterval(jobElapsedTimer);
    jobElapsedTimer = null;
  }
}
function tickRunningJobRows() {
  const box = $("#idx-jobs");
  if (!box) return;
  for (const card of box.querySelectorAll(".job-card")) {
    const badge = card.querySelector(".job-status-badge");
    const state = badge == null ? void 0 : badge.textContent;
    if (state !== "running" && state !== "queued") continue;
    const startedAt = card.dataset.startedAt;
    if (!startedAt) continue;
    const elapsed = formatDuration(Date.now() - new Date(startedAt).getTime());
    card.querySelector(".job-status-line").textContent = state === "queued" ? `Queued · ${elapsed} elapsed` : `Running · ${elapsed} elapsed`;
  }
}
async function loadJobs() {
  const box = $("#idx-jobs");
  let jobs;
  try {
    ({ jobs } = await api("/api/jobs"));
  } catch (err) {
    box.innerHTML = errorBox(err);
    return;
  }
  if (!jobs.length) {
    box.innerHTML = emptyBox("No indexing jobs yet.");
  } else {
    box.replaceChildren(...jobs.map(renderJobRow));
    for (const btn of box.querySelectorAll(".job-cancel")) {
      btn.addEventListener("click", () => cancelJob(btn.dataset.id));
    }
    for (const card of box.querySelectorAll(".job-card")) {
      loadJobLog(card);
    }
  }
  const stillActive = jobs.some((j) => j.state === "queued" || j.state === "running" || j.state === "cancelling");
  stopIndexPolling();
  stopJobElapsedTicker();
  if (stillActive) {
    tickRunningJobRows();
    jobElapsedTimer = setInterval(tickRunningJobRows, 1e3);
    indexPollTimer = setTimeout(async () => {
      if (currentRoute().view !== "index") return;
      await loadJobs();
    }, 1500);
  } else if (jobs.some((j) => j.state === "succeeded")) {
    loadSidebar();
  }
}
async function loadJobLog(card) {
  const pre = card.querySelector(".job-log");
  if (!pre) return;
  const id = card.dataset.id;
  try {
    const { job } = await api(`/api/jobs/${encodeURIComponent(id)}`);
    pre.textContent = job.log.slice(-30).join("\n") || "(no output yet)";
    if (job.state === "failed") {
      const lastErrorLine = [...job.log].reverse().find((l) => l.startsWith("[stderr]"));
      if (lastErrorLine) {
        const errorEl = card.querySelector(".job-error-summary");
        errorEl.textContent = lastErrorLine.replace(/^\[stderr\]\s*/, "");
        errorEl.hidden = false;
      }
    }
  } catch (err) {
    pre.textContent = err.message;
  }
}
async function cancelJob(id) {
  try {
    await apiPost(`/api/jobs/${encodeURIComponent(id)}/cancel`, {});
    await loadJobs();
  } catch (err) {
    $("#idx-status").className = "error-box";
    $("#idx-status").textContent = err.message;
  }
}
function currentRoute(hash = location.hash || "#/") {
  let m = hash.match(/^#\/c\/([^/]+)\/settings$/);
  if (m) return { view: "settings", name: decodeURIComponent(m[1]) };
  m = hash.match(/^#\/c\/([^/]+)\/f\/(.+)$/);
  if (m) return { view: "collection", name: decodeURIComponent(m[1]), openFile: decodeURIComponent(m[2]) };
  m = hash.match(/^#\/c\/([^/]+)\/n\/(.+)$/);
  if (m) return { view: "collection", name: decodeURIComponent(m[1]), openNodePath: decodeURIComponent(m[2]) };
  m = hash.match(/^#\/c\/(.+)$/);
  if (m) return { view: "collection", name: decodeURIComponent(m[1]) };
  if (hash === "#/index") return { view: "index" };
  return { view: "overview" };
}
async function openNodeFromPath(name, nodePath) {
  try {
    const { node } = await api(`/api/collections/${encodeURIComponent(name)}/skeleton/node?nodePath=${encodeURIComponent(nodePath)}`);
    return openSectionView(name, node);
  } catch (err) {
    const box = $("#collection-content");
    if (box) box.innerHTML = errorBox(err);
  }
}
async function route() {
  const main = $("#main");
  const r = currentRoute();
  markActive();
  if (r.view === "settings") await renderSettingsView(main, r.name);
  else if (r.view === "collection") {
    await renderCollection(main, r.name);
    if (r.openFile) await openFileView(r.name, r.openFile);
    else if (r.openNodePath) await openNodeFromPath(r.name, r.openNodePath);
  } else if (r.view === "index") await renderIndexingView(main);
  else await renderOverview(main);
}
function startAdminApp() {
  window.addEventListener("hashchange", route);
  loadTopbar();
  loadSidebar();
  route();
}
startAdminApp();
