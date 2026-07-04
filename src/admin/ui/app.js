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
const shell = '<header class="topbar">\n  <div class="brand">\n    <span class="brand-bracket">[</span>semidex<span class="brand-bracket">]</span>\n    <span class="brand-sub">admin console</span>\n  </div>\n  <div class="topbar-status" id="topbar-status">\n    <span class="lamp lamp-unknown" id="health-lamp" title="storage status"></span>\n    <span class="mono" id="health-text">probing...</span>\n    <span class="cap-summary mono" id="cap-summary"></span>\n  </div>\n</header>\n\n<div class="layout">\n  <nav class="sidebar">\n    <ul class="nav-list">\n      <li><a href="#/index" id="nav-index">Create a collection</a></li>\n    </ul>\n    <div class="panel-label">Collections</div>\n    <ul class="collection-list" id="collection-list">\n      <li class="muted">loading...</li>\n    </ul>\n    <div class="sidebar-foot mono">local - 127.0.0.1</div>\n  </nav>\n\n  <main class="main" id="main">\n    <!-- views rendered by app.js -->\n  </main>\n</div>\n';
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
function errorBox(err) {
  return `<div class="error-box">${esc(err.message)}</div>`;
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
      <a href="#/collections/${encodeURIComponent(c.name)}" data-name="${esc(c.name)}" class="tree-row tree-collection-row">
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
      location.hash = `#/collections/${encodeURIComponent(name)}`;
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
      <a href="#/collections/${encodeURIComponent(name)}/file/${encodeURIComponent(d.sourceFile)}"
         class="tree-row tree-file" data-sf="${esc(d.sourceFile)}" style="--depth:1">
        <span class="tree-label mono">${esc(shortLabel(d.sourceFile))}</span>
      </a>`).join("");
    for (const a of box.querySelectorAll(".tree-file")) {
      a.addEventListener("click", (e) => {
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
    return openSectionView(name, node);
  }
  if (node.nodeType === "file" && !(node.childCount > 0)) {
    return openFileView(name, node.sourceFile ?? node.nodePath, node.nodePath);
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
  main.innerHTML = `
    <h1 class="view-title">overview</h1>
    <p class="view-sub">Local semidex instance — storage health, backend capabilities, indexed collections.</p>
    <div class="grid-2">
      <div class="panel"><div class="panel-head">Storage health</div><div class="panel-body" id="ov-health">…</div></div>
      <div class="panel"><div class="panel-head">Backend capabilities</div><div class="panel-body" id="ov-caps">…</div></div>
    </div>
    <div class="panel"><div class="panel-head">Collections</div><div class="panel-body" id="ov-collections">…</div></div>`;
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
      $("#ov-collections").innerHTML = '<div class="empty">No collections indexed yet.</div>';
      return;
    }
    $("#ov-collections").innerHTML = `
      <table class="data"><thead><tr>
        <th>name</th><th class="num">points</th><th>schema</th>
      </tr></thead><tbody>
      ${collections.map((c) => `
        <tr class="rowlink" data-href="#/collections/${encodeURIComponent(c.name)}">
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
  if (expandedCollection !== name) {
    expandedCollection = name;
    renderSidebarList(collectionsCache);
  }
  main.innerHTML = `
    <div class="col-header" id="col-header">…</div>
    <div class="panel">
      <div class="panel-head"><span>Search this collection</span><span class="mono" id="search-mode"></span></div>
      <div class="panel-body" id="search-panel">…</div>
    </div>
    <div class="panel" id="collection-content-panel" style="display:none">
      <div class="panel-head"><span id="content-title">Results</span></div>
      <div class="panel-body" id="collection-content"></div>
    </div>`;
  initSearchPanel(name);
  let detail;
  try {
    detail = (await api(`/api/collections/${encodeURIComponent(name)}`)).collection;
  } catch (err) {
    $("#col-header").innerHTML = errorBox(err);
    return;
  }
  renderCollectionHeader(name, detail);
}
function renderCollectionHeader(name, detail) {
  const warnings = detail.warnings ?? [];
  const healthBadge = warnings.length ? `<span class="badge badge-warn">${warnings.length} warning${warnings.length > 1 ? "s" : ""}</span>` : '<span class="badge badge-ok">healthy</span>';
  const fileCountLabel = detail.hasSkeleton ? "skeleton map available" : "flat file list";
  $("#col-header").innerHTML = `
    <div class="col-header-top">
      <h1 class="view-title">${esc(name)}</h1>
      <button type="button" class="btn-ghost" id="col-settings-btn">settings</button>
    </div>
    <p class="view-sub">${esc(detail.description || fileCountLabel)}</p>
    <div class="col-header-meta">
      ${healthBadge}
      <span class="mono muted">${Number(detail.pointCount ?? 0).toLocaleString("en-US")} points</span>
    </div>
    ${warnings.length ? warnings.map((w) => `<div class="error-box" style="margin-top:10px">${esc(w)}</div>`).join("") : ""}`;
  $("#col-settings-btn").addEventListener("click", () => {
    location.hash = `#/collections/${encodeURIComponent(name)}/settings`;
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
    resultsBox.innerHTML = body.results.map((r, i) => renderResult(r, i, showScore)).join("");
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
  return `
  <div class="result-card">
    <div class="result-head">
      <span class="rank">#${i + 1}</span>
      ${showScore && typeof r.score === "number" ? `<span class="mono score" title="Rank score — compare order, not absolute value">${r.score.toFixed(4)}</span>` : ""}
      <span class="mono">${esc(r.sourceFile ?? "?")}</span>
      <span class="mono muted">chunk ${r.chunkIndex ?? "?"}${r.totalChunks ? ` / ${r.totalChunks}` : ""}</span>
      <span class="muted">${esc(r.section || "intro")}</span>
      ${r.nodeType ? `<span class="badge badge-amber">${esc(r.nodeType)}</span>` : ""}
      ${canOpen ? `<button type="button" class="mini-btn result-open" data-sf="${esc(r.sourceFile)}" data-ci="${r.chunkIndex}">open</button>` : ""}
    </div>
    ${r.context ? `<div class="chunk-context">${esc(r.context)}</div>` : ""}
    <pre class="chunk-text">${esc(r.text ?? "")}</pre>
    ${Array.isArray(r.windowChunks) && r.windowChunks.length ? `
      <div class="win-chunks">
        ${r.windowChunks.map((w) => `
          <div class="win-chunk ${w.isMatch ? "match" : ""}">
            <div class="win-head">
              <span class="mono muted">#${w.chunkIndex ?? "?"}</span>
              ${w.isMatch ? '<span class="badge badge-amber">match</span>' : ""}
              <span class="muted">${esc(w.section || "")}</span>
            </div>
            <div class="win-text">${esc(w.textSnippet ?? w.text ?? "")}</div>
          </div>`).join("")}
      </div>` : ""}
  </div>`;
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
  box.innerHTML = '<div class="empty">loading…</div>';
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
  box.innerHTML = '<div class="empty">loading…</div>';
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  fileViewState = { name, sourceFile, chunkIndex, loaded: 0 };
  try {
    const qs = `sourceFile=${encodeURIComponent(sourceFile)}&chunkIndex=${chunkIndex}&window=3`;
    const { chunks } = await api(`/api/collections/${encodeURIComponent(name)}/chunks?${qs}`);
    if (!chunks.length) {
      box.innerHTML = '<div class="empty">No chunks found for this file/section.</div>';
      return;
    }
    fileViewState.loaded = chunks.length;
    box.innerHTML = renderFileChunks(chunks) + fileViewLoadMoreButton();
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
  return chunks.map((c) => {
    const isStructural = STRUCTURAL_NODE_TYPES.has(c.nodeType);
    const contextLabel = isStructural ? "retrieval context" : "section path";
    return `
    <div class="chunk">
      <div class="chunk-head">
        <span>chunk ${c.chunkIndex}${c.totalChunks ? ` / ${c.totalChunks}` : ""}</span>
        <span>${esc(c.section || "intro")}</span>
        ${c.nodeType ? `<span class="badge badge-amber" title="node_type: ${esc(c.nodeType)}">${esc(nodeTypeBadgeLabel(c.nodeType))}</span>` : ""}
      </div>
      ${c.context ? `<div class="chunk-context"><span class="chunk-context-label">${esc(contextLabel)}:</span> ${esc(c.context)}</div>` : ""}
      <pre class="chunk-text">${esc(c.text ?? "")}</pre>
    </div>`;
  }).join("");
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
    btn == null ? void 0 : btn.insertAdjacentHTML("beforebegin", renderFileChunks(newOnes));
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
  main.innerHTML = `
    <div class="col-header-top">
      <h1 class="view-title">${esc(name)} · settings</h1>
      <a href="#/collections/${encodeURIComponent(name)}" class="btn-ghost">back to collection</a>
    </div>
    <div class="panel" id="settings-health">…</div>

    <div class="panel">
      <div class="panel-head">Reindex</div>
      <div class="panel-body">
        <p class="skel-note" style="margin-top:0">Reindex starts a background job and writes to this collection.</p>
        <form id="settings-reindex-form" autocomplete="off">
          ${renderSourcePathField()}
          <div class="opt-group">
            <div class="opt-group-label">Quality</div>
            <label class="idx-check"><input type="checkbox" id="opt-onnx" checked> ONNX embeddings</label>
            <label class="idx-check"><input type="checkbox" id="opt-llm-summaries"> LLM summaries <span class="mono muted">(context summaries via a local LLM)</span></label>
          </div>
          <div class="opt-group">
            <div class="opt-group-label">Structure</div>
            <label class="idx-check"><input type="checkbox" id="opt-skel-chunk" checked> Skeleton chunking</label>
            <label class="idx-check"><input type="checkbox" id="opt-skel-nav" checked> Skeleton navigation</label>
          </div>
          <div class="opt-group">
            <div class="opt-group-label">Optional enrichment</div>
            <label class="idx-check"><input type="checkbox" id="opt-tags"> Generate tags</label>
          </div>
          <div class="opt-group">
            <div class="opt-group-label">Maintenance</div>
            <label class="idx-check"><input type="checkbox" id="opt-prune"> Prune stale</label>
            <p class="skel-note">Use prune stale only with the full source root.</p>
          </div>
          <button type="submit" class="btn-amber" id="settings-reindex-submit">Reindex collection</button>
        </form>
        <div id="settings-reindex-result"></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">Repair collection compatibility</div>
      <div class="panel-body">
        <p class="skel-note" style="margin-top:0" title="Checks and repairs semidex metadata, vector names, and payload indexes for this collection. It does not reindex files or update document content.">
          Checks and repairs semidex metadata, vector names, and payload indexes for this collection.
          It does not reindex files or update document content.
        </p>
        <button type="button" class="btn-amber" id="settings-repair">Repair collection compatibility</button>
        <div id="settings-repair-result"></div>
      </div>
    </div>

    <details class="panel advanced-panel">
      <summary class="panel-head">Advanced diagnostics</summary>
      <div class="panel-body" id="settings-diagnostics">…</div>
    </details>

    <div class="panel maint-danger">
      <div class="panel-head">Delete collection</div>
      <div class="panel-body">
        <p class="skel-note" style="margin-top:0">Deleting a collection permanently removes it from storage. This cannot be undone.</p>
        <button type="button" class="btn-danger" id="settings-delete-btn">Delete collection</button>
      </div>
    </div>
    <div class="modal-backdrop" id="delete-modal-backdrop" style="display:none">
      <div class="modal">
        <h2 class="modal-title">Delete collection?</h2>
        <p>You are about to permanently delete <b class="mono">${esc(name)}</b>. This cannot be undone.</p>
        <div class="modal-actions">
          <button type="button" class="btn-ghost" id="delete-modal-cancel">Cancel</button>
          <button type="button" class="btn-danger" id="delete-modal-confirm">Delete collection</button>
        </div>
        <div id="settings-delete-result"></div>
      </div>
    </div>`;
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
  main.innerHTML = `
    <h1 class="view-title">Create a collection</h1>
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
            <label class="idx-check"><input type="checkbox" id="opt-prune"> Prune stale</label>
            <label class="idx-check"><input type="checkbox" id="opt-tags"> Generate tags</label>
          </div>
          <div id="idx-ollama-status" style="display:none"></div>
          <p class="skel-note">Prune stale should be used only with the full source root.</p>
          <button type="submit" class="btn-amber" id="idx-submit">start indexing</button>
        </form>
        <div id="idx-status" class="empty"></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head">Jobs</div>
      <div class="panel-body" id="idx-jobs">…</div>
    </div>`;
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
function jobStatusBadge(state) {
  const map = {
    queued: "badge",
    running: "badge badge-amber",
    cancelling: "badge badge-warn",
    succeeded: "badge badge-ok",
    failed: "badge badge-fail",
    cancelled: "badge"
  };
  return `<span class="${map[state] ?? "badge"}">${esc(state)}</span>`;
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
    box.innerHTML = '<div class="empty">No indexing jobs yet.</div>';
  } else {
    box.innerHTML = jobs.map((j) => `
      <div class="job-card" data-id="${esc(j.id)}">
        <div class="job-head">
          ${jobStatusBadge(j.state)}
          <span class="mono">${esc(j.collection)}</span>
          <span class="mono muted">${esc(j.path)}</span>
          ${j.exitCode !== null && j.exitCode !== 0 ? `<span class="mono muted">exit ${j.exitCode}</span>` : ""}
          ${j.state === "queued" || j.state === "running" ? `<button type="button" class="mini-btn job-cancel" data-id="${esc(j.id)}">cancel</button>` : ""}
          ${j.state === "cancelling" ? '<span class="mono muted">stopping…</span>' : ""}
        </div>
        <div class="mono muted job-times">
          started ${j.startedAt ? new Date(j.startedAt).toLocaleString() : "—"}
          ${j.finishedAt ? ` · ended ${new Date(j.finishedAt).toLocaleString()}` : ""}
        </div>
        <pre class="job-log" id="job-log-${esc(j.id)}">…</pre>
      </div>`).join("");
    for (const btn of box.querySelectorAll(".job-cancel")) {
      btn.addEventListener("click", () => cancelJob(btn.dataset.id));
    }
    for (const card of box.querySelectorAll(".job-card")) {
      loadJobLog(card.dataset.id);
    }
  }
  const stillActive = jobs.some((j) => j.state === "queued" || j.state === "running" || j.state === "cancelling");
  stopIndexPolling();
  if (stillActive) {
    indexPollTimer = setTimeout(async () => {
      if (currentRoute().view !== "index") return;
      await loadJobs();
    }, 1500);
  } else if (jobs.some((j) => j.state === "succeeded")) {
    loadSidebar();
  }
}
async function loadJobLog(id) {
  const pre = $(`#job-log-${CSS.escape(id)}`);
  if (!pre) return;
  try {
    const { job } = await api(`/api/jobs/${encodeURIComponent(id)}`);
    pre.textContent = job.log.slice(-30).join("\n") || "(no output yet)";
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
function currentRoute() {
  const hash = location.hash || "#/";
  let m = hash.match(/^#\/collections\/([^/]+)\/settings$/);
  if (m) return { view: "settings", name: decodeURIComponent(m[1]) };
  m = hash.match(/^#\/collections\/([^/]+)\/file\/(.+)$/);
  if (m) return { view: "collection", name: decodeURIComponent(m[1]), openFile: decodeURIComponent(m[2]) };
  m = hash.match(/^#\/collections\/(.+)$/);
  if (m) return { view: "collection", name: decodeURIComponent(m[1]) };
  if (hash === "#/index") return { view: "index" };
  return { view: "overview" };
}
async function route() {
  const main = $("#main");
  const r = currentRoute();
  markActive();
  if (r.view === "settings") await renderSettingsView(main, r.name);
  else if (r.view === "collection") {
    await renderCollection(main, r.name);
    if (r.openFile) await openFileView(r.name, r.openFile);
  } else if (r.view === "index") await renderIndexingView(main);
  else await renderOverview(main);
}
function startAdminApp() {
  window.addEventListener("hashchange", route);
  loadTopbar();
  loadSidebar();
  route();
}
document.body.innerHTML = shell;
startAdminApp();
