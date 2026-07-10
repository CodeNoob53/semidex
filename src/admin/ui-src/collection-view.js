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

// Tracks which collection's shell is actually mounted in #main right now —
// deliberately separate from state.js's getExpandedCollection(), which is
// sidebar-tree UI state (which row is expanded) and can be mutated by
// sidebar.js's toggleSidebarTree() synchronously, ahead of this module's own
// async renderCollection() call for the SAME click (location.hash triggers
// hashchange -> route() asynchronously, but the sidebar click handler calls
// toggleSidebarTree() synchronously right after setting the hash). Using
// getExpandedCollection() here to decide "is this a same-collection
// navigation" was reading a value already advanced to the new collection
// name before the DOM/search panel had actually been reset for it.
let renderedCollectionName = null;

async function renderOverview(main) {
  renderedCollectionName = null;
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
// Header (Phase 3E, reworked Phase 3G into a "library overview"):
// name/health/settings on top, a summary block (skeleton-generated overview
// preferred, falling back to config description, then a quiet empty state),
// then compact user-facing fact chips (chunk count, model/local, hybrid
// search, navigation map) — see collectionFactChips() and
// renderCollectionHeader() below. The more technical/debug-ish facts (dense
// vector size/distance, sparse yes/no, both providers, schema/chunk/token
// versions, semidex-managed) live only in the collapsed Details disclosure
// (collectionDetailsPanel()), not duplicated in the header body itself.
async function renderCollection(main, name) {
  // Navigating to a file/section within the collection already on screen
  // now goes through the same hash -> route() -> renderCollection() path as
  // switching collections (so back/forward works uniformly) — but a full
  // main.innerHTML/initSearchPanel reset on every file/section click would
  // silently wipe the user's in-progress search. Only reset the shell when
  // we're actually landing on a different collection than what's showing —
  // tracked via renderedCollectionName (this module's own record of what's
  // actually mounted), not getExpandedCollection() (sidebar-tree UI state
  // that a sidebar click's synchronous toggleSidebarTree() call can advance
  // to the new name before this async function even starts, which
  // previously made a genuine collection switch look like a same-collection
  // re-render and left the old collection's search results on screen).
  const alreadyOnThisCollection = renderedCollectionName === name && main.querySelector('#col-header');

  if (getExpandedCollection() !== name) {
    setExpandedCollection(name);
    refreshSidebarList();
  }

  if (!alreadyOnThisCollection) {
    main.innerHTML = collectionShell;
    initSearchPanel(name);
    renderedCollectionName = name;
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

// Compact fact chips shown always-visible under the summary block (Phase
// 3E, reworded Phase 3G) — a user-facing "what is this collection, what
// state is it in" summary, not the technical metadata table (that stays in
// the collapsed Details below). Each fact is its own chip so a missing one
// can be omitted individually — a collection that's never been indexed
// still gets a clean, non-broken-looking header instead of a row of
// empty/"?" chips. Labeled in semidex vocabulary ("chunks", "navigation
// map", "flat file list") rather than Qdrant terms ("points") — Details
// still uses "points" since that panel is explicitly the technical/advanced
// view.
function collectionFactChips(detail) {
  const chips = [];
  // chunkCount (server-side, nav-points excluded) is what "chunks" must mean
  // here — detail.pointCount is Qdrant's raw total and includes skeleton_nav
  // points on any collection with skeleton navigation on, which would
  // overstate real content. Never fall back to pointCount for this label:
  // if chunkCount is genuinely missing, showing 0 is more honest than
  // silently mislabeling a nav-inflated number as "chunks".
  chips.push(`<span class="chip mono">${Number(detail.chunkCount ?? 0).toLocaleString('en-US')} chunks</span>`);

  const denseProvider = detail.provider?.denseProvider;
  if (denseProvider) {
    // "local" vs the raw provider id is the one semidex-level distinction a
    // user actually cares about here (does this call out to a cloud API or
    // not) — the exact provider/model string is still available in Details
    // for anyone who needs it.
    const providerLabel = detail.provider?.denseModel
      ? esc(detail.provider.denseModel)
      : esc(denseProvider);
    const localHint = /onnx|ollama|local/i.test(denseProvider) ? ' local' : '';
    chips.push(`<span class="chip mono">${providerLabel}${localHint}</span>`);
    chips.push(`<span class="chip mono">${detail.vectorSchema?.sparse ? 'hybrid search' : 'dense search'}</span>`);
  }

  chips.push(`<span class="chip mono">${detail.hasSkeleton ? 'navigation map' : 'flat file list'}</span>`);
  return chips.join('');
}

// Collapsed-by-default "Details" disclosure — the one place the more
// technical/debug-ish facts live (dense vector size/distance, sparse yes/no,
// both providers, schema/chunk/token versions, semidex-managed, skeleton nav
// status again in full technical terms, and any warnings). Deliberately the
// ONLY place these appear — collectionFactChips() above shows a user-facing
// summary of some of the same underlying data, not a duplicate technical
// table.
function collectionDetailsPanel(detail) {
  const warnings = detail.warnings ?? [];
  const rows = [
    ['points', Number(detail.pointCount ?? 0).toLocaleString('en-US')],
    ['dense vector', detail.vectorSchema?.dense?.size
      ? `${detail.vectorSchema.dense.size}d${detail.vectorSchema.dense.distance ? ` · ${detail.vectorSchema.dense.distance}` : ''}`
      : 'unknown'],
    ['sparse vector', detail.vectorSchema?.sparse ? 'yes' : 'no'],
    ['dense provider', detail.provider?.denseProvider ? `${detail.provider.denseProvider}${detail.provider.denseModel ? ` (${detail.provider.denseModel})` : ''}` : 'unknown'],
    ['sparse provider', detail.provider?.sparseProvider ?? 'unknown'],
    ['skeleton navigation', detail.hasSkeleton ? 'enabled' : 'disabled'],
    ['semidex-managed', detail.semidexManaged ? 'yes' : 'no'],
    ['embedding schema', detail.versions?.embeddingSchema ?? 'unknown'],
    ['chunking schema', detail.versions?.chunkingSchema ?? 'unknown'],
    ['indexing schema', detail.versions?.indexingSchema ?? 'unknown'],
    ['token count mode', detail.versions?.tokenCountMode ?? 'unknown'],
  ];

  return `
    <details class="panel advanced-panel">
      <summary class="panel-head">Details</summary>
      <div class="panel-body">
        <dl class="kv">
          ${rows.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(String(value))}</dd>`).join('')}
        </dl>
        ${warnings.length ? warnings.map(w => `<div class="error-box" style="margin-top:10px">${esc(w)}</div>`).join('') : ''}
      </div>
    </details>`;
}

function renderCollectionHeader(name, detail) {
  const warnings = detail.warnings ?? [];
  const healthBadge = warnings.length
    ? `<span class="badge badge-warn">${warnings.length} warning${warnings.length > 1 ? 's' : ''}</span>`
    : '<span class="badge badge-ok">healthy</span>';

  // Phase 3G: the header's job is "let the user understand this library
  // before they search or browse it" — so the summary block prefers the
  // skeleton root's generated overview (built from the actual indexed
  // content) over the config-level `description` (typed once at index time,
  // often stale or never set), and falls back to a quiet empty-state hint
  // rather than silently showing nothing when neither exists. A missing
  // summary is not an error — it just means the collection hasn't been
  // indexed with LLM summaries, which is common and not broken-looking.
  const summaryText = detail.overviewSummary || detail.description || null;
  const summaryBlock = summaryText
    ? `<p class="col-header-desc">${esc(summaryText)}</p>`
    : '<p class="col-header-desc col-header-desc-empty">No collection summary yet. Reindex with LLM summaries to generate one.</p>';

  $('#col-header').innerHTML = `
    <div class="col-header-top">
      <h1 class="view-title">${esc(name)}</h1>
      ${healthBadge}
      <button type="button" class="btn-ghost" id="col-settings-btn">settings</button>
    </div>
    ${summaryBlock}
    <div class="col-header-facts">${collectionFactChips(detail)}</div>
    ${collectionDetailsPanel(detail)}`;

  $('#col-settings-btn').addEventListener('click', () => {
    location.hash = `#/c/${encodeURIComponent(name)}/settings`;
  });
}

export { renderOverview, renderCollection };
