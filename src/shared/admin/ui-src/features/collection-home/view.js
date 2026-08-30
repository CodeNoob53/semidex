// Collection Home v2 (design plan §5.3, §13 S1-style). The v2 replacement
// for collection-view.js's renderCollection()+renderCollectionHeader() on
// the BARE `#/c/:name` route only — answers "what is this collection, and
// what state is it in?" via a compact header (name/health, summary, fact
// chips) plus an expandable technical Details panel, and the real
// Search/Index/Settings actions (design plan §5.3's cross-links, minus
// Documents/Structure — neither has a v2 route yet, so neither gets a
// cross-link button here; a dead link is worse than no link).
//
// `#/c/:name/f/:sourceFile` and `#/c/:name/n/:nodePath` are NOT this module
// — they stay on collection-view.js/file-view.js unchanged (router.js keeps
// routing them to `view: 'collection'`, only the bare route now resolves to
// `view: 'collection-home'`, see routes.js).
//
// A lifecycle-owned view controller: mount(host, params) -> { dispose() }
// (design plan §8.1/§8.4), matching features/overview/view.js's shape. The
// one request this view owns (GET /api/collections/:name) is
// ownership-checked per §8.7, so a navigation away (dispose()) or a second
// overlapping mount can never let a stale response commit into a detached
// or superseded view. The embedded search panel (search.js) is the same
// real, already-working implementation collection-view.js used — including
// the `?q=...&file=...` permalink contract — not a reimplementation.
//
// SHELL_HTML below is the same static markup as
// partials/shared/collection-shell.html (byte-for-byte: #col-header, the
// search panel mount point, #collection-content-panel/#collection-content)
// — inlined here rather than imported via that partial's `?raw` Vite import,
// since this module (unlike collection-view.js, which is never imported as
// a real ES module outside Vite) is real-ESM-imported directly by
// ui-collection-home-view.test.js, and Node has no loader for `.html?raw`
// specifiers. No interpolated data anywhere in this string (same convention
// every other v2 view's own SHELL_HTML uses), so assigning it via innerHTML
// is safe by construction.
import { createViewController } from '../../shared/lifecycle/view.js';
import { apiGet } from '../../shared/api/client.js';
import { validateCollectionDetailResponse } from '../../shared/api/contracts/collection-detail.js';
import { createStatusBadge } from '../../shared/ui/status-badge.js';
import { createLiveRegion } from '../../shared/ui/live-region.js';
import { createLoadingState, createEmptyState, createErrorState } from '../../shared/ui/states.js';
import { getExpandedCollection, setExpandedCollection } from '../../state.js';
import { refreshSidebarList } from '../../sidebar.js';
import { initSearchPanel, syncSearchStateFromUrl } from '../../search.js';

const AVAILABILITY_LABEL = {
  available: 'Search available',
  runtime_unverified: 'Model cached; runtime not verified',
  download_required: 'Model will download on first use',
};

// Same status -> reason wording as collection-view.js's legacy
// availabilityChip() (design plan §5.3: "Preserve useful summary, facts…")
// — a deliberate, small duplication between this module and the legacy
// file/node reader, the same convention features/overview/view.js already
// uses for its own sibling schemaTone()/renderBanner() helpers rather than
// sharing one file.
const AVAILABILITY_REASON_FALLBACK = {
  missing_model: 'embedding model not available',
  missing_credentials: 'missing credentials',
  unsupported_backend: 'execution mode is not implemented yet',
  schema_mismatch: 'profile does not match the live vector schema',
  ambiguous_legacy: 'embedding identity could not be determined — reindex or migrate',
  legacy_unmigrated: 'not yet migrated — run `npm run sync` or reindex',
  invalid_profile: 'embedding profile metadata is invalid',
  unsupported_profile_schema: 'embedding profile metadata is a newer, unrecognized version',
};

function availabilityLabel(availability) {
  const status = availability.status;
  if (AVAILABILITY_LABEL[status]) return AVAILABILITY_LABEL[status];
  if (status === 'unknown_dependencies') return 'Search status unknown';
  const reason = availability.dense?.reason ?? availability.sparse?.reason ?? '';
  const fallback = AVAILABILITY_REASON_FALLBACK[status];
  if (fallback) return `Search unavailable: ${reason || fallback}`;
  return `Search unavailable: ${status}`;
}

function availabilityTone(status) {
  if (status === 'available') return 'ok';
  if (status === 'runtime_unverified' || status === 'download_required' || status === 'unknown_dependencies') return 'unknown';
  return 'warn';
}

const SHELL_HTML = `
  <div class="col-header" id="col-header">…</div>
  <div class="panel">
    <div class="panel-head"><span id="search-scope">Search this collection</span><span class="mono" id="search-mode"></span></div>
    <div class="panel-body" id="search-panel">…</div>
  </div>
  <div class="panel" id="collection-content-panel" style="display:none">
    <div class="panel-head"><span id="content-title">Results</span></div>
    <div class="panel-body" id="collection-content"></div>
  </div>
`;

/**
 * @param {HTMLElement} host
 * @param {{ name: string }} params
 * @returns {{ dispose(): void }}
 */
export function mount(host, params = {}) {
  const { name } = params;
  const view = createViewController();

  if (getExpandedCollection() !== name) {
    setExpandedCollection(name);
    refreshSidebarList();
  }

  // Unlike collection-view.js's legacy renderCollection(), this mount()
  // unconditionally resets the shell on every call (no "already on this
  // collection, skip the reset" optimization — there is nothing to
  // preserve across mounts, since a v2 controller is always disposed and a
  // fresh one mounted for every 'collection-home' route). SHELL_HTML's own
  // static markup already ships #collection-content-panel hidden
  // (style="display:none"), so a stray file/section view left open by a
  // PREVIOUS route is discarded for free — no explicit hideCollectionContent()
  // call needed here the way router.js's old bare-route branch required one.
  host.innerHTML = SHELL_HTML;
  const els = { header: host.querySelector('#col-header') };
  const live = createLiveRegion();
  host.appendChild(live.el);

  // Real Search action (design plan §5.3 cross-link), not a placeholder —
  // the same search.js panel/permalink contract collection-view.js already
  // used, including the "?q=..." permalink: syncSearchStateFromUrl() re-runs
  // the search when the URL carries one, and is a no-op otherwise.
  initSearchPanel(name);
  syncSearchStateFromUrl(name);

  loadDetail(view, els, live, name, { showLoadingState: true });

  return { dispose: () => view.dispose() };
}

function loadDetail(view, els, live, name, { showLoadingState }) {
  if (showLoadingState) els.header.replaceChildren(createLoadingState('Loading collection…'));
  const gen = view.nextGeneration();
  apiGet(`/api/collections/${encodeURIComponent(name)}`, { signal: view.signal })
    .then(validateCollectionDetailResponse)
    .then((body) => {
      if (!view.isCurrent(gen)) return; // superseded — discard, do not render
      renderHeader(els.header, live, name, body.collection);
    })
    .catch((err) => {
      if (!view.isCurrent(gen)) return;
      if (err.kind === 'not_found') {
        els.header.replaceChildren(createEmptyState(
          `Collection "${name}" not found.`,
          { href: '#/', label: 'Back to Overview' },
        ));
        live.announce(`Collection "${name}" not found.`);
        return;
      }
      els.header.replaceChildren(createErrorState(err, {
        retry: () => loadDetail(view, els, live, name, { showLoadingState: true }),
      }));
      live.announce(`Collection could not be loaded: ${err.message}`);
    });
}

// ── header ──────────────────────────────────────────────────────────────

function chip(text) {
  const el = document.createElement('span');
  el.className = 'chip mono';
  el.textContent = text;
  return el;
}

function factChips(detail) {
  const chips = [];
  // chunkCount (server-side, nav-points excluded), never pointCount — same
  // reasoning as collection-view.js's collectionFactChips(): pointCount
  // includes skeleton_nav points and would overstate real content.
  chips.push(chip(`${Number(detail.chunkCount ?? 0).toLocaleString('en-US')} chunks`));

  const denseProvider = detail.provider?.denseProvider;
  if (denseProvider) {
    const denseExecution = detail.embeddingProfile?.state === 'valid'
      ? detail.embeddingProfile.profile.embedding.dense.execution
      : null;
    const isLocal = denseExecution ? denseExecution === 'client' : /onnx|ollama|local/i.test(denseProvider);
    const providerLabel = detail.provider?.denseModel || denseProvider;
    chips.push(chip(`${providerLabel}${isLocal ? ' local' : ''}`));
    chips.push(chip(detail.vectorSchema?.sparse ? 'hybrid search' : 'dense search'));
  }

  chips.push(createStatusBadge(availabilityTone(detail.availability.status), availabilityLabel(detail.availability)));
  chips.push(chip(detail.hasSkeleton ? 'skeleton nav' : 'flat file list'));
  return chips;
}

function detailsSubsection(label, rows) {
  const wrap = document.createElement('div');
  wrap.className = 'details-subsection';
  const labelEl = document.createElement('div');
  labelEl.className = 'details-subsection-label';
  labelEl.textContent = label;
  const dl = document.createElement('dl');
  dl.className = 'kv';
  for (const [field, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = field;
    const dd = document.createElement('dd');
    dd.textContent = String(value);
    dl.append(dt, dd);
  }
  wrap.append(labelEl, dl);
  return wrap;
}

// Collapsed-by-default "Details" — the only place the technical/debug-ish
// facts live (dense vector size/distance, sparse yes/no, both providers,
// schema/chunk/token versions, semidex-managed), same field set as
// collection-view.js's collectionDetailsPanel(). Deliberately does NOT
// repeat overviewSummary/description (already shown in the summary block
// above) or the warnings list (already shown in the banner) — no duplicate
// metadata block.
function detailsPanel(detail) {
  const details = document.createElement('details');
  details.className = 'panel advanced-panel';
  const summary = document.createElement('summary');
  summary.className = 'panel-head';
  summary.textContent = 'Details';
  const body = document.createElement('div');
  body.className = 'panel-body';

  const hasSummary = Boolean(detail.overviewSummary || detail.description);
  if (!hasSummary) {
    body.appendChild(detailsSubsection('Overview', [['summary', 'No collection summary indexed yet.']]));
  }

  const resolvedProfile = detail.embeddingProfile?.state === 'valid' ? detail.embeddingProfile.profile : null;
  const indexingRows = [
    ['dense vector', detail.vectorSchema?.dense?.size
      ? `${detail.vectorSchema.dense.size}d${detail.vectorSchema.dense.distance ? ` · ${detail.vectorSchema.dense.distance}` : ''}`
      : 'unknown'],
    ['sparse vector', detail.vectorSchema?.sparse ? 'yes' : 'no'],
    ['dense provider', detail.provider?.denseProvider ? `${detail.provider.denseProvider}${detail.provider.denseModel ? ` (${detail.provider.denseModel})` : ''}` : 'unknown'],
    ['sparse provider', detail.provider?.sparseProvider ?? 'unknown'],
    ...(resolvedProfile ? [
      ['vector name (dense)', resolvedProfile.embedding.dense.vectorName],
      ...(resolvedProfile.embedding.sparse ? [['vector name (sparse)', resolvedProfile.embedding.sparse.vectorName]] : []),
    ] : []),
    ['skeleton navigation', detail.hasSkeleton ? 'enabled' : 'disabled'],
    ['embedding schema', detail.versions?.embeddingSchema ?? 'unknown'],
    ['chunking schema', detail.versions?.chunkingSchema ?? 'unknown'],
    ['indexing schema', detail.versions?.indexingSchema ?? 'unknown'],
    ['token count mode', detail.versions?.tokenCountMode ?? 'unknown'],
  ];
  body.appendChild(detailsSubsection('Indexing', indexingRows));

  const storageRows = [
    ['points', Number(detail.pointCount ?? 0).toLocaleString('en-US')],
    ['semidex-managed', detail.semidexManaged ? 'yes' : 'no'],
  ];
  body.appendChild(detailsSubsection('Storage', storageRows));

  details.append(summary, body);
  return details;
}

// Degraded state (design plan §5: "banner names the subsystem") — the
// collection's own reported warnings, never hidden inside the collapsed
// Details panel where they'd be easy to miss. Same visual language as
// features/overview/view.js's #ov-banner.
function buildWarningsBanner(warnings) {
  const el = document.createElement('div');
  el.className = 'ov-banner';
  el.hidden = warnings.length === 0;
  for (const warning of warnings) {
    const row = document.createElement('div');
    row.className = 'ov-banner-row';
    row.appendChild(createStatusBadge('warn', warning));
    el.appendChild(row);
  }
  return el;
}

function buildTopRow(name, warnings) {
  const top = document.createElement('div');
  top.className = 'col-header-top';

  const h1 = document.createElement('h1');
  h1.className = 'view-title';
  h1.textContent = name;
  top.appendChild(h1);

  top.appendChild(warnings.length
    ? createStatusBadge('warn', `${warnings.length} warning${warnings.length > 1 ? 's' : ''}`)
    : createStatusBadge('ok', 'healthy'));

  // Real Index action (design plan §5.3 cross-link) — links to the actual
  // indexing job screen, same "Index a folder" wording/target
  // features/overview/view.js already uses.
  const indexLink = document.createElement('a');
  indexLink.className = 'btn-ghost';
  indexLink.id = 'ch-index-cta';
  indexLink.href = '#/index';
  indexLink.textContent = 'Index a folder';
  top.appendChild(indexLink);

  // Real Settings action — navigates to the existing, fully-functional
  // settings screen (repair/reindex/delete all live there unchanged).
  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'btn-ghost';
  settingsBtn.id = 'col-settings-btn';
  settingsBtn.textContent = 'settings';
  settingsBtn.addEventListener('click', () => {
    location.hash = `#/c/${encodeURIComponent(name)}/settings`;
  });
  top.appendChild(settingsBtn);

  return top;
}

function buildSummary(detail) {
  const p = document.createElement('p');
  const summaryText = detail.overviewSummary || detail.description || null;
  p.className = summaryText ? 'col-header-desc' : 'col-header-desc col-header-desc-empty';
  p.textContent = summaryText || 'No collection summary yet. Reindex with LLM summaries to generate one.';
  return p;
}

function renderHeader(host, live, name, detail) {
  const warnings = detail.warnings ?? [];
  const factsRow = document.createElement('div');
  factsRow.className = 'col-header-facts';
  factsRow.append(...factChips(detail));

  host.replaceChildren(
    buildWarningsBanner(warnings),
    buildTopRow(name, warnings),
    buildSummary(detail),
    factsRow,
    detailsPanel(detail),
  );

  live.announce(warnings.length
    ? `${name}: ${warnings.length} warning${warnings.length > 1 ? 's' : ''} — ${warnings.join('; ')}`
    : `${name}: loaded, healthy.`);
}
