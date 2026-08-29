// Overview v2 (design plan §5.1, §13 S1). The v2 replacement for
// collection-view.js's old renderOverview(): answers exactly one question —
// "is this instance working, and what is running?" — via a status strip
// (storage, generation, edition), a collections summary, and a bounded
// active/recent operations list. No charts, no promotional copy, no nested
// cards, no fake metrics (design plan §2.1, §5.1).
//
// A lifecycle-owned view controller: mount(host, params) -> { dispose() }
// (design plan §8.1/§8.4). Every fetch this module starts is either (a) the
// shared shell-owned status store / the shared operation store — neither of
// which this view starts or stops, it only subscribes — or (b) its own
// one-shot GET /api/collections, ownership-checked per §8.7 so a navigation
// away (dispose()) or a second overlapping mount can never let a stale
// response commit into a detached or superseded view.
import { createViewController } from '../../shared/lifecycle/view.js';
import { apiGet } from '../../shared/api/client.js';
import { validateCollectionsListResponse } from '../../shared/api/contracts/collections.js';
import { subscribe as subscribeStatus, getStatus, startPolling as startStatusPolling } from '../../shared/status/store.js';
import {
  whenCapabilitiesReady,
  capabilities as getBootCapabilities,
  capabilityEdition,
  capabilityError,
} from '../../shared/capabilities/boot.js';
import { subscribe as subscribeOperations, getOperations } from '../../operation-store.js';
import { openOperationModal } from '../../operation-modal.js';
import { createStatusBadge } from '../../shared/ui/status-badge.js';
import { createLiveRegion } from '../../shared/ui/live-region.js';
import { createLoadingState, createEmptyState, createErrorState } from '../../shared/ui/states.js';
import { createDataTable } from '../../shared/ui/table.js';

// Bounded list (design plan §5.1: "active + recent operations (bounded
// list)") — provisional (design plan §11.6), no measured value exists yet
// for how many rows an operator actually scans on this screen.
const RECENT_OPERATIONS_LIMIT = 8;

const KIND_LABEL = { index: 'Index', reindex: 'Reindex', repair: 'Repair' };
const STATE_TONE = {
  queued: 'unknown', running: 'warn', cancelling: 'warn',
  succeeded: 'ok', failed: 'fail', cancelled: 'unknown',
};

// Static shell markup only — no interpolated data anywhere in this string,
// so assigning it via innerHTML is safe by construction (same convention
// collection-view.js's own `main.innerHTML = overviewShell` already uses
// for its static partial). Every dynamic value below is appended as a real
// DOM node/text, never concatenated into this string.
const SHELL_HTML = `
  <h1 class="view-title">Overview</h1>
  <p class="view-sub">Is this instance working, and what is running?</p>
  <div class="ov-banner" id="ov-banner" hidden></div>
  <div class="grid-2">
    <div class="panel"><div class="panel-head">Status</div><div class="panel-body" id="ov-status"></div></div>
    <div class="panel"><div class="panel-head">Active &amp; recent operations</div><div class="panel-body" id="ov-operations"></div></div>
  </div>
  <div class="panel"><div class="panel-head">Collections</div><div class="panel-body" id="ov-collections"></div></div>
`;

/**
 * @param {HTMLElement} host
 * @param {Object} [_params] — unused; Overview takes no route params
 * @returns {{ dispose(): void }}
 */
export function mount(host, _params = {}) {
  const view = createViewController();

  host.innerHTML = SHELL_HTML;
  const els = {
    banner: host.querySelector('#ov-banner'),
    status: host.querySelector('#ov-status'),
    operations: host.querySelector('#ov-operations'),
    collections: host.querySelector('#ov-collections'),
  };
  const live = createLiveRegion();
  host.appendChild(live.el);

  // ── status strip: storage + generation + edition, from the shared
  // shell-owned status store — never a second poller (design plan §8.3,
  // §13 S1 exit gate: "topbar and Overview share status data without
  // duplicate polling/fetch loops"). Updates touch only #ov-status/
  // #ov-banner, never navigation DOM.
  const renderStatus = () => renderStatusStrip(
    els,
    live,
    getStatus(),
    getBootCapabilities(),
    capabilityEdition(),
    capabilityError(),
  );
  renderStatus();
  view.onDispose(subscribeStatus(renderStatus));
  startStatusPolling(); // idempotent — already running from app boot; safe to call from any subscriber

  whenCapabilitiesReady().then(() => {
    if (!view.signal.aborted) renderStatus();
  }).catch(() => {
    if (!view.signal.aborted) renderStatus();
  });

  // ── operations: reuse the existing shared operation-store (already
  // polling continuously since app boot) — never a second /api/operations
  // poller.
  const activateOperation = (event) => {
    const row = event.target.closest('[data-op-id]');
    if (row && els.operations.contains(row)) openOperationModal(row.dataset.opId);
  };
  els.operations.addEventListener('click', activateOperation, { signal: view.signal });
  els.operations.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('[data-op-id]');
    if (row && els.operations.contains(row)) {
      event.preventDefault();
      openOperationModal(row.dataset.opId);
    }
  }, { signal: view.signal });

  const renderOps = (operations) => renderOperations(els.operations, operations);
  renderOps(getOperations());
  view.onDispose(subscribeOperations((event) => { if (event.type === 'update') renderOps(event.operations); }));

  // ── collections: one-shot fetch per mount, ownership-checked (design
  // plan §8.7) so a navigation-away or a second overlapping mount's later
  // response can never commit into a stale/detached view.
  loadCollections(view, els, live, { showLoadingState: true });

  return { dispose: () => view.dispose() };
}

function loadCollections(view, els, live, { showLoadingState }) {
  if (showLoadingState) els.collections.replaceChildren(createLoadingState('Loading collections…'));
  const gen = view.nextGeneration();
  apiGet('/api/collections', { signal: view.signal })
    .then(validateCollectionsListResponse)
    .then((body) => {
      if (!view.isCurrent(gen)) return; // superseded by dispose()/a later mount — discard, do not render
      renderCollections(els.collections, body.collections);
      live.announce(body.collections.length ? `Loaded ${body.collections.length} collections.` : 'No collections indexed yet.');
    })
    .catch((err) => {
      if (!view.isCurrent(gen)) return;
      renderCollectionsError(els.collections, err, () => loadCollections(view, els, live, { showLoadingState: true }));
      live.announce(`Collections could not be loaded: ${err.message}`);
    });
}

// ── status strip ────────────────────────────────────────────────────────

function statusRow(label, tone, text, href) {
  const row = document.createElement('div');
  row.className = 'ov-status-row';
  const dt = document.createElement('span');
  dt.className = 'ov-status-label';
  dt.textContent = label;
  const dd = document.createElement('span');
  dd.className = 'ov-status-value';
  const badge = createStatusBadge(tone, text);
  if (href) {
    const a = document.createElement('a');
    a.className = 'ov-status-link';
    a.href = href;
    a.appendChild(badge);
    dd.appendChild(a);
  } else {
    dd.appendChild(badge);
  }
  row.append(dt, dd);
  return row;
}

function renderStatusStrip(els, live, status, caps, edition, capsError) {
  const list = document.createElement('div');
  list.className = 'ov-status-list';

  if (status.healthError) {
    const lastKnown = status.health
      ? ` · last known ${status.health.ok ? 'reachable' : 'unreachable'}`
      : '';
    list.appendChild(statusRow('Storage', 'fail', `Status check failed${lastKnown}`, '#/settings/storage'));
  } else if (status.health) {
    const tone = status.health.ok ? 'ok' : 'fail';
    const text = `${status.health.storage.backend} — ${status.health.ok ? 'reachable' : 'unreachable'}`;
    list.appendChild(statusRow('Storage', tone, text, '#/settings/storage'));
  } else {
    list.appendChild(statusRow('Storage', 'unknown', 'Checking…', null));
  }

  if (status.generationError) {
    const lastKnown = status.generation
      ? ` · last known ${status.generation.ready ? 'ready' : 'not ready'}`
      : '';
    list.appendChild(statusRow('Generation', 'fail', `Status check failed${lastKnown}`, '#/settings/ai'));
  } else if (status.generation) {
    const tone = status.generation.ready ? 'ok' : 'warn';
    const text = status.generation.ready
      ? `${status.generation.backend ?? 'unknown'}${status.generation.model ? ` — ${status.generation.model}` : ''}`
      : (status.generation.reason || 'not ready');
    list.appendChild(statusRow('Generation', tone, text, '#/settings/ai'));
  } else {
    list.appendChild(statusRow('Generation', 'unknown', 'Checking…', null));
  }

  if (caps) {
    const onCount = Object.values(caps.storage.capabilities).filter(Boolean).length;
    const text = `${caps.edition} · ${caps.storage.backend} · ${onCount} ${onCount === 1 ? 'capability' : 'capabilities'} on`;
    list.appendChild(statusRow('Edition', 'ok', text, '#/settings'));
  } else if (capsError) {
    list.appendChild(statusRow('Edition', 'warn', `${edition ?? 'unknown'} · capabilities unavailable`, '#/settings/storage'));
  } else {
    list.appendChild(statusRow('Edition', 'unknown', edition ? `${edition} · checking capabilities…` : 'Checking…', null));
  }

  els.status.replaceChildren(list);
  renderBanner(els.banner, status, live);
}

function renderBanner(bannerEl, status, live) {
  const items = [];
  if (status.healthError) {
    items.push({ label: 'Storage status', text: status.healthError.message, href: '#/settings/storage' });
  } else if (status.health && !status.health.ok) {
    items.push({ label: 'Storage', text: status.health.storage.detail || 'unreachable', href: '#/settings/storage' });
  }
  if (status.generationError) {
    items.push({ label: 'Generation status', text: status.generationError.message, href: '#/settings/ai' });
  } else if (status.generation && !status.generation.ready) {
    items.push({ label: 'Generation', text: status.generation.reason || 'not ready', href: '#/settings/ai' });
  }
  bannerEl.replaceChildren();
  if (!items.length) {
    bannerEl.hidden = true;
    return;
  }
  bannerEl.hidden = false;
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'ov-banner-row';
    row.appendChild(createStatusBadge('warn', `${item.label}: ${item.text}`));
    const a = document.createElement('a');
    a.href = item.href;
    a.textContent = 'Open settings';
    row.appendChild(a);
    bannerEl.appendChild(row);
  }
  live.announce(`Degraded: ${items.map((i) => `${i.label} ${i.text}`).join('; ')}`);
}

// ── operations panel ────────────────────────────────────────────────────

function operationLabel(op) {
  const kind = KIND_LABEL[op.kind] ?? op.kind;
  return `${kind} · ${op.collection} · ${op.state}`;
}

function renderOperations(host, operations) {
  const bounded = operations.slice(0, RECENT_OPERATIONS_LIMIT);
  if (!bounded.length) {
    host.replaceChildren(createEmptyState('No operations recorded yet.'));
    return;
  }
  const list = document.createElement('ul');
  list.className = 'ov-op-list';
  for (const op of bounded) {
    const li = document.createElement('li');
    li.className = 'ov-op-row';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.dataset.opId = op.id;
    li.appendChild(createStatusBadge(STATE_TONE[op.state] ?? 'unknown', operationLabel(op)));
    list.appendChild(li);
  }
  host.replaceChildren(list);
}

// ── collections panel ───────────────────────────────────────────────────

function schemaTone(vectorSchema) {
  if (vectorSchema === 'named') return 'ok';
  if (vectorSchema === 'flat') return 'warn';
  if (vectorSchema === 'empty') return 'fail';
  return 'unknown';
}

function renderCollections(host, collections) {
  if (!collections.length) {
    host.replaceChildren(createEmptyState('No collections indexed yet.', { href: '#/index', label: 'Index a folder' }));
    return;
  }
  const table = createDataTable({
    columns: [
      { label: 'name', mono: true, key: 'name' },
      { label: 'points', numeric: true, render: (c) => Number(c.pointCount ?? 0).toLocaleString('en-US') },
      { label: 'schema', render: (c) => createStatusBadge(schemaTone(c.vectorSchema), c.vectorSchema) },
    ],
    rows: collections,
    getRowKey: (c) => c.name,
    onActivateRow: (name) => { location.hash = `#/c/${encodeURIComponent(name)}`; },
  });
  host.replaceChildren(table);
}

function renderCollectionsError(host, err, retry) {
  host.replaceChildren(createErrorState(err, { retry }));
}
