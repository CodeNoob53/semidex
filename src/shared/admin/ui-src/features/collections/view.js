// Collections directory v2 (design plan §5.2, §13 S2). Answers "what
// collections exist, which ones need attention, and how do I open or index
// one?" via a dense, work-focused table — not a card grid, no invented
// pagination/trends/health metrics (design plan §2.1). Opening a row routes
// to the existing #/c/:name surface (preserved byte-for-byte); the primary
// page action is "Index a folder" -> #/index, since there is no
// create-collection endpoint (GAP-04, design plan §5.2).
//
// A lifecycle-owned view controller: mount(host, params) -> { dispose() }
// (design plan §8.1/§8.4), matching features/overview/view.js's shape. The
// one request this view owns (GET /api/collections) is ownership-checked
// per §8.7; the shared shell-owned status store is only ever subscribed to,
// never polled a second time here (design plan §8.3).
import { createViewController } from '../../shared/lifecycle/view.js';
import { apiGet } from '../../shared/api/client.js';
import { validateCollectionsListResponse } from '../../shared/api/contracts/collections.js';
import { subscribe as subscribeStatus, getStatus, startPolling as startStatusPolling } from '../../shared/status/store.js';
import { createStatusBadge } from '../../shared/ui/status-badge.js';
import { createLiveRegion } from '../../shared/ui/live-region.js';
import { createLoadingState, createEmptyState, createErrorState } from '../../shared/ui/states.js';
import { createDataTable } from '../../shared/ui/table.js';

const SCHEMA_TONE = { named: 'ok', flat: 'warn', empty: 'fail' };
const PROFILE_TONE = { valid: 'ok', missing: 'warn', invalid: 'fail', schema_mismatch: 'fail', unsupported_schema_version: 'fail' };

// Static shell markup only — no interpolated data anywhere in this string
// (same convention features/overview/view.js's own SHELL_HTML uses). Every
// dynamic value below is appended as a real DOM node/text, never
// concatenated into this string.
const SHELL_HTML = `
  <div class="view-head">
    <div>
      <h1 class="view-title">Collections</h1>
      <p class="view-sub">What collections exist, which ones need attention, and how to open or index one.</p>
    </div>
    <a class="btn-amber" href="#/index" id="col-index-cta">Index a folder</a>
  </div>
  <div class="ov-banner" id="col-banner" hidden></div>
  <div class="panel"><div class="panel-body" id="col-body"></div></div>
`;

/**
 * @param {HTMLElement} host
 * @param {Object} [_params] — unused; the Collections directory takes no route params
 * @returns {{ dispose(): void }}
 */
export function mount(host, _params = {}) {
  const view = createViewController();

  host.innerHTML = SHELL_HTML;
  const els = {
    banner: host.querySelector('#col-banner'),
    body: host.querySelector('#col-body'),
  };
  const live = createLiveRegion();
  host.appendChild(live.el);

  // Local view state — combined with the shared status store's live
  // snapshot on every render, since either can change independently
  // (the collections fetch resolves once; the status store keeps polling
  // for the lifetime of the page).
  let collectionsPhase = 'loading'; // 'loading' | 'ready' | 'error'
  let collections = [];
  let lastError = null;

  const renderAll = () => renderCollectionsPanel(els, live, {
    phase: collectionsPhase,
    collections,
    error: lastError,
    status: getStatus(),
    retry: () => loadCollections(),
  });

  // ── shared status store: subscribed only, never a second poller (design
  // plan §8.3/§13 S1 exit gate carried forward into S2).
  view.onDispose(subscribeStatus(renderAll));
  startStatusPolling(); // idempotent — already running from app boot; safe to call from any subscriber

  function loadCollections() {
    collectionsPhase = 'loading';
    renderAll();
    const gen = view.nextGeneration();
    apiGet('/api/collections', { signal: view.signal })
      .then(validateCollectionsListResponse)
      .then((body) => {
        if (!view.isCurrent(gen)) return; // superseded by dispose()/a later request — discard, do not render
        collectionsPhase = 'ready';
        collections = body.collections;
        lastError = null;
        renderAll();
      })
      .catch((err) => {
        if (!view.isCurrent(gen)) return;
        collectionsPhase = 'error';
        lastError = err;
        renderAll();
      });
  }

  loadCollections();

  return { dispose: () => view.dispose() };
}

// ── classification: which of the fixed states (design plan §5) applies ────

// "Shared status polling currently reports an error" (design plan §5.2's
// `partial` state) is not just the storage/health poll — the same shared
// store also polls GET /api/generation/status (design plan §8.3), and a
// failure there is just as much "a subsystem this screen depends on for its
// banner is currently unknown" as a failed health poll. Each subsystem is
// named honestly and independently — a generation-status failure must never
// be reported as a "Storage" problem, and vice versa (both can fail at once).
function partialBanners(status) {
  const storageDown = !!(status.health && status.health.ok === false);
  const banners = [];
  if (storageDown) {
    banners.push({ subsystem: 'storage', href: '#/settings/storage', message: 'Storage is reported unreachable — this list may be out of date.' });
  } else if (status.healthError) {
    banners.push({ subsystem: 'storage', href: '#/settings/storage', message: 'Storage status check is currently failing — reachability is unknown.' });
  }
  if (status.generationError) {
    banners.push({ subsystem: 'generation', href: '#/settings/ai', message: 'Generation status check is currently failing — readiness is unknown.' });
  }
  return banners;
}

function classify({ phase, collections: rows, status }) {
  const storageDown = !!(status.health && status.health.ok === false);

  if (phase === 'loading') return { kind: 'loading' };

  const isEmpty = phase === 'ready' && rows.length === 0;
  const isFailed = phase === 'error';

  // "degraded/unavailable when storage health is known to be down, without
  // presenting an empty list as if there were zero collections" — only
  // overrides when the collections fetch itself has nothing trustworthy to
  // show (failed, or genuinely empty); a real, non-empty result is trusted
  // over a possibly-racy separate health poll (still bannered below).
  if (storageDown && (isFailed || isEmpty)) return { kind: 'unavailable' };
  if (isFailed) return { kind: 'error' };
  if (isEmpty) return { kind: 'empty' };
  return { kind: 'ready', banners: partialBanners(status) };
}

function renderCollectionsPanel(els, live, state) {
  const result = classify(state);

  if (result.kind === 'loading') {
    els.body.replaceChildren(createLoadingState('Loading collections…'));
    renderBanner(els.banner, null, live);
    return;
  }

  if (result.kind === 'error') {
    els.body.replaceChildren(createErrorState(state.error, { retry: state.retry }));
    renderBanner(els.banner, null, live);
    live.announce(`Collections could not be loaded: ${state.error?.message ?? 'unknown error'}`);
    return;
  }

  if (result.kind === 'unavailable') {
    els.body.replaceChildren(createUnavailableState(state.retry));
    renderBanner(els.banner, null, live);
    live.announce('Storage is unreachable; collections cannot be listed right now.');
    return;
  }

  if (result.kind === 'empty') {
    els.body.replaceChildren(createEmptyState('No collections indexed yet.', { href: '#/index', label: 'Index a folder' }));
    renderBanner(els.banner, null, live);
    live.announce('No collections indexed yet.');
    return;
  }

  // ready, non-empty
  els.body.replaceChildren(createCollectionsTable(state.collections));
  renderBanner(els.banner, result.banners, live);
  const count = state.collections.length;
  // Deterministic from state alone (no timestamps/object identity) so the
  // shared live-region primitive's own de-dupe (identical consecutive
  // message -> no-op, see shared/ui/live-region.js) actually holds across
  // unrelated status-store ticks that change nothing this screen cares about.
  const suffix = result.banners.length ? ` ${result.banners.map((b) => b.message).join(' ')}` : '';
  live.announce(`Loaded ${count} ${count === 1 ? 'collection' : 'collections'}.${suffix}`);
}

function renderBanner(bannerEl, banners, _live) {
  bannerEl.replaceChildren();
  if (!banners || !banners.length) {
    bannerEl.hidden = true;
    return;
  }
  bannerEl.hidden = false;
  for (const b of banners) {
    const row = document.createElement('div');
    row.className = 'ov-banner-row';
    row.appendChild(createStatusBadge('warn', b.message));
    const a = document.createElement('a');
    a.href = b.href;
    a.textContent = 'Open settings';
    row.appendChild(a);
    bannerEl.appendChild(row);
  }
}

// A confirmed-down storage backend gets its own explicit panel — never the
// plain empty state (which would read as "zero collections exist, index
// one"), and never the plain error state (this isn't our own request
// failing; it's a known cause). Built with the same shared-primitive visual
// language (state-box/state-partial) as shared/ui/states.js's own
// createPartialState(), plus a Retry action since the operator's next step
// really is "try again once storage is back."
function createUnavailableState(retry) {
  const el = document.createElement('div');
  el.className = 'state-box state-partial';
  el.setAttribute('role', 'status');
  const p = document.createElement('p');
  p.className = 'state-message';
  p.textContent = 'Storage is unreachable. Collections cannot be listed until it recovers.';
  el.appendChild(p);
  if (retry) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-ghost state-retry';
    btn.textContent = 'Retry';
    btn.addEventListener('click', retry);
    el.appendChild(btn);
  }
  return el;
}

// ── table ───────────────────────────────────────────────────────────────

function schemaTone(vectorSchema) {
  return SCHEMA_TONE[vectorSchema] ?? 'unknown';
}

function profileTone(embeddingProfileState) {
  return PROFILE_TONE[embeddingProfileState] ?? 'unknown';
}

function providerText(provider) {
  const parts = [provider.denseProvider, provider.denseModel].filter(Boolean);
  return parts.length ? parts.join(' · ') : '—';
}

function createCollectionsTable(collections) {
  return createDataTable({
    columns: [
      { label: 'name', mono: true, key: 'name' },
      { label: 'points', numeric: true, render: (c) => Number(c.pointCount ?? 0).toLocaleString('en-US') },
      { label: 'vector schema', render: (c) => createStatusBadge(schemaTone(c.vectorSchema), c.vectorSchema) },
      { label: 'embedding profile', render: (c) => createStatusBadge(profileTone(c.embeddingProfileState), c.embeddingProfileState) },
      { label: 'dense provider / model', mono: true, render: (c) => providerText(c.provider) },
    ],
    rows: collections,
    getRowKey: (c) => c.name,
    onActivateRow: (name) => { location.hash = `#/c/${encodeURIComponent(name)}`; },
  });
}
