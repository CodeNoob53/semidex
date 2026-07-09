// ── top-level main-panel views: overview (no collection selected) and the
// selected collection's overview (header + search + file/section content) ──
import overviewShell from './partials/overview-shell.html?raw';
import collectionShell from './partials/collection-shell.html?raw';
import { $, esc, errorBox, emptyBox } from './dom.js';
import { api } from './api.js';
import { getExpandedCollection, setExpandedCollection } from './state.js';
import { refreshSidebarList } from './sidebar.js';
import { initSearchPanel } from './search.js';
import { showCollectionWarnings } from './toasts.js';

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
        <tr class="rowlink" data-href="#/c/${encodeURIComponent(c.name)}">
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
  // Navigating to a file/section within the collection already on screen
  // now goes through the same hash -> route() -> renderCollection() path as
  // switching collections (so back/forward works uniformly) — but a full
  // main.innerHTML/initSearchPanel reset on every file/section click would
  // silently wipe the user's in-progress search. Only reset the shell when
  // we're actually landing on a different collection than what's showing.
  const alreadyOnThisCollection = getExpandedCollection() === name && main.querySelector('#col-header');

  if (getExpandedCollection() !== name) {
    setExpandedCollection(name);
    refreshSidebarList();
  }

  if (!alreadyOnThisCollection) {
    main.innerHTML = collectionShell;
    initSearchPanel(name);
  }

  let detail;
  try {
    detail = (await api(`/api/collections/${encodeURIComponent(name)}`)).collection;
  } catch (err) {
    $('#col-header').innerHTML = errorBox(err);
    return;
  }

  renderCollectionHeader(name, detail);

  // Fire warning toasts only on an actual collection open (same condition
  // as the shell-reset guard above), not on every in-collection file/section
  // navigation — the detail fetch/header refresh above runs on both, but
  // toasts should not re-announce warnings just because the user clicked a
  // different file in a collection they already have open.
  if (!alreadyOnThisCollection) showCollectionWarnings(name, detail.warnings);
}

// Compact "provider/schema" chip row shown always-visible under the header
// (not buried in the collapsed Details panel) — per Phase 3C's brief, this is
// a secondary informational row, not the header's main content. Omitted
// entirely for a never-indexed/legacy collection where denseProvider is
// null, rather than showing a row of empty/"?" chips.
function collectionMetaRow(detail) {
  const denseProvider = detail.provider?.denseProvider;
  if (!denseProvider) return '';
  const parts = [esc(denseProvider)];
  if (detail.provider?.denseModel) parts.push(esc(detail.provider.denseModel));
  const dims = detail.vectorSchema?.dense?.size;
  if (dims) parts.push(`${dims}d`);
  parts.push(detail.vectorSchema?.sparse ? 'hybrid' : 'dense-only');
  return `<p class="col-header-meta-row mono muted">${parts.join(' · ')}</p>`;
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
      ${healthBadge}
      <button type="button" class="btn-ghost" id="col-settings-btn">settings</button>
    </div>
    ${collectionMetaRow(detail)}
    <details class="panel advanced-panel" style="margin-top:8px">
      <summary class="panel-head">Details</summary>
      <div class="panel-body">
        <p class="view-sub" style="margin:0 0 10px">${esc(detail.description || fileCountLabel)}</p>
        <span class="mono muted">${Number(detail.pointCount ?? 0).toLocaleString('en-US')} points</span>
        ${warnings.length ? warnings.map(w => `<div class="error-box" style="margin-top:10px">${esc(w)}</div>`).join('') : ''}
      </div>
    </details>`;

  $('#col-settings-btn').addEventListener('click', () => {
    location.hash = `#/c/${encodeURIComponent(name)}/settings`;
  });
}

export { renderOverview, renderCollection };
