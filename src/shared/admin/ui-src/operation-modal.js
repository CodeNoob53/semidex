// ── global operation status modal (Phase 3S) ────────────────────────────────
// One modal mounted at the application-shell level (index.html's
// #operation-modal-slot, outside #main — same "survives every view swap"
// placement as #toast-host), replacing the route-bound #/index jobs list as
// the way a user watches indexing/reindexing/repair progress. Subscribes to
// operation-store.js (the one shared poller) — never polls on its own.
import { $, cloneTemplate } from './dom.js';
import { api, apiPost } from './api.js';
import { subscribe, getOperations, pollNow } from './operation-store.js';
import { renderOperationCard, formatDuration, tickElapsedRows } from './operation-render.js';
import { showToast } from './toasts.js';

// Toast copy uses the noun form ("Repair"), distinct from operation-render.js's
// KIND_LABEL (the gerund form, "Repairing", used as a card title prefix) —
// "Repair complete" reads naturally where "Repairing complete" would not.
const TOAST_KIND_LABEL = { index: 'Indexing', reindex: 'Reindexing', repair: 'Repair' };

// Success/failure completion toast (requirement 5) — fired exactly once per
// state transition into a terminal state (see handleTransition() below,
// which only calls this from operation-store.js's own once-per-transition
// 'transition' event, never on every poll tick). The failure branch shows
// only op.error (already a short, sanitised message — see
// api/operations.js's toJobDetail()-derived error field and
// jobs/registry.js's capture-time redaction) — never a raw log dump, env
// var, API key, or URL-with-credentials.
export function showOperationToast(op) {
  const label = TOAST_KIND_LABEL[op.kind] ?? 'Operation';
  const duration = op.finishedAt && op.startedAt
    ? ` (${formatDuration(new Date(op.finishedAt) - new Date(op.startedAt))})`
    : '';
  if (op.state === 'succeeded') {
    showToast(`${label} complete: ${op.collection}${duration}`, {
      variant: 'success',
      action: { label: 'View', onClick: () => openOperationModal(op.id) },
    });
  } else if (op.state === 'failed') {
    const reason = op.error ? ` — ${op.error}` : '';
    showToast(`${label} failed: ${op.collection}${reason}`, {
      variant: 'error',
      action: { label: 'View details', onClick: () => openOperationModal(op.id) },
    });
  } else if (op.state === 'cancelled') {
    showToast(`${label} cancelled: ${op.collection}${duration}`, {
      variant: 'warn',
      action: { label: 'View', onClick: () => openOperationModal(op.id) },
    });
  }
}

let mounted = false;
let openOperationId = null; // which operation the modal is currently showing, or null when closed
// True only when the caller asked for "whatever's newest" (openOperationModal()
// called with no id — e.g. from the topbar chip with no specific operation
// in mind). False whenever a SPECIFIC id was requested. render()'s "id not
// in the current snapshot yet -> fall back to the newest" rescue path must
// only ever run in the true case — otherwise a specific id requested for an
// operation the store simply hasn't polled yet (the normal case right after
// starting a brand-new operation: openOperationModal(job.id) fires before
// the concurrent pollNow() has resolved even once) gets silently swapped
// for a stale, unrelated operation and STAYS on it forever, since render()
// used to unconditionally overwrite openOperationId with whatever it fell
// back to.
let openOperationIsPinnedToLatest = false;
let unsubscribeStore = null;
let elapsedTimer = null;
let lastFocusedBeforeOpen = null;

// Same "user's own explicit toggle always wins over any auto-open default"
// pattern jobs-view.js's jobDetailsManualState used — kept here (not in
// operation-render.js, which is pure/stateless) since it's UI interaction
// state the modal itself owns.
const detailsManualState = new Map();

function resolveDetailsOpen(op) {
  if (detailsManualState.has(op.id)) return detailsManualState.get(op.id);
  return op.state === 'failed';
}

/** Mounts the modal template into the given host element. Call once, at app
 * boot (app.js) — idempotent, so a second call is a harmless no-op. */
export function mountOperationModal(host) {
  if (mounted) return;
  mounted = true;
  const frag = cloneTemplate('tpl-operation-modal');
  host.appendChild(frag);

  $('#op-modal-close').addEventListener('click', closeOperationModal);
  $('#op-modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'op-modal-backdrop') closeOperationModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openOperationId !== null) closeOperationModal();
  });

  unsubscribeStore = subscribe((event) => {
    if (event.type === 'update') renderIfOpen();
    if (event.type === 'transition') handleTransition(event);
  });
}

// Fires the completion toast exactly once per transition INTO a terminal
// state (succeeded/failed/cancelled) — operation-store.js already guarantees
// this handler only runs once per actual state change (not once per poll
// tick, since it diffs against lastSeenState internally), so this function
// doesn't need its own dedupe on top of that.
function handleTransition({ operation, to }) {
  if (to === 'succeeded' || to === 'failed' || to === 'cancelled') {
    showOperationToast(operation);
  }
}

/**
 * Opens the modal on a specific operation id (or the most recent one if
 * omitted) and forces an immediate poll so the modal never shows a stale
 * snapshot from before the user's action.
 *
 * When `operationId` is given but isn't in the store's CURRENT snapshot
 * yet (the common case: this is called right after starting a brand-new
 * operation, before the concurrent pollNow() below has resolved even
 * once), the modal shows a loading state rather than falling back to
 * whatever operation happens to already be in the stale snapshot — see
 * render()'s use of openOperationIsPinnedToLatest.
 */
export function openOperationModal(operationId) {
  const backdrop = $('#op-modal-backdrop');
  if (!backdrop) return; // modal not mounted (e.g. a bare test fixture) — never throw over a UI nicety
  lastFocusedBeforeOpen = document.activeElement;
  openOperationIsPinnedToLatest = operationId === undefined;
  openOperationId = operationId ?? getOperations()[0]?.id ?? null;
  backdrop.style.display = '';
  pollNow();
  render();
  startElapsedTicker();
  // Focus the close button once the modal is actually visible — the
  // accessible-title (aria-labelledby) is already wired via the template's
  // static markup, this just moves keyboard focus INTO the dialog so
  // Escape/Tab work immediately without a manual click first.
  $('#op-modal-close')?.focus();
}

export function closeOperationModal() {
  const backdrop = $('#op-modal-backdrop');
  if (!backdrop) return;
  backdrop.style.display = 'none';
  openOperationId = null;
  stopElapsedTicker();
  // Focus return (task requirement: "focus return") — back to whatever
  // triggered the open (the topbar chip, a toast's View button, etc.), not
  // just document.body, so keyboard users don't lose their place.
  if (lastFocusedBeforeOpen && document.contains(lastFocusedBeforeOpen)) {
    lastFocusedBeforeOpen.focus();
  }
  lastFocusedBeforeOpen = null;
}

export function isOperationModalOpen() {
  return openOperationId !== null;
}

function renderIfOpen() {
  if (openOperationId !== null) render();
}

async function render() {
  const body = $('#op-modal-body');
  const historyList = $('#op-history-list');
  if (!body || !historyList) return;

  const operations = getOperations();
  const match = operations.find(op => op.id === openOperationId);

  // A SPECIFIC id was requested (openOperationIsPinnedToLatest is false)
  // but it isn't in the store's current snapshot yet — the normal
  // just-started-a-new-operation window, before the concurrent pollNow()
  // triggered by openOperationModal() has resolved even once. This must
  // show a loading state, NOT silently fall back to some other operation
  // and permanently rebind openOperationId to it (the bug this fix
  // targets — every subsequent poll would keep re-confirming that wrong
  // id, since it genuinely does exist in the snapshot, and the modal would
  // never recover to show the operation the caller actually asked for).
  if (!match && !openOperationIsPinnedToLatest) {
    body.innerHTML = '<div class="empty">Loading operation…</div>';
    historyList.innerHTML = '';
    return;
  }

  // Either a match was found, or the caller explicitly asked for "whatever
  // is newest" (pinned-to-latest mode) — in the latter case, re-resolve to
  // the current newest on every render, same as the original fallback
  // behavior, since that's the whole point of pinned-to-latest.
  const current = match ?? operations[0] ?? null;

  if (!current) {
    body.innerHTML = '<div class="empty">No operations yet.</div>';
    historyList.innerHTML = '';
    return;
  }
  openOperationId = current.id;

  const card = renderOperationCard(current, {
    detailsOpen: resolveDetailsOpen(current),
    onToggleDetails: (open) => detailsManualState.set(current.id, open),
  });
  body.replaceChildren(card);

  const cancelBtn = card.querySelector('.job-cancel');
  cancelBtn?.addEventListener('click', () => cancelOperation(current.id));

  // Log is only present on the detail endpoint, not the list — fetch it
  // once per render for whichever operation is currently open, same
  // "detail fetch per visible card" shape jobs-view.js's loadJobLog() used,
  // just scoped to one card instead of every row in a list.
  loadOperationLog(card, current.id);

  renderHistory(historyList, operations, current.id);
}

async function loadOperationLog(card, id) {
  const pre = card.querySelector('.job-log');
  if (!pre) return;
  try {
    const { operation } = await api(`/api/operations/${encodeURIComponent(id)}`);
    pre.textContent = operation.log.slice(-30).join('\n') || '(no output yet)';
  } catch (err) {
    pre.textContent = err.message;
  }
}

// Compact recent-operations list (requirement 6) — operation, collection,
// status, duration only, never the old full technical jobs page's field set
// (no raw path, no per-row log, no per-row cancel button). Selecting one
// switches the modal's main card to that operation.
function renderHistory(historyList, operations, currentId) {
  const rest = operations.filter(op => op.id !== currentId).slice(0, 8);
  if (!rest.length) {
    historyList.innerHTML = '';
    return;
  }
  historyList.replaceChildren(...rest.map(op => {
    const frag = cloneTemplate('tpl-op-history-row');
    const row = frag.querySelector('.op-history-row');
    row.dataset.id = op.id;
    const badge = row.querySelector('.op-history-badge');
    badge.textContent = op.state;
    badge.className = `badge op-history-badge ${
      op.state === 'succeeded' ? 'badge-ok' : op.state === 'failed' ? 'badge-fail' : op.state === 'running' ? 'badge-amber' : ''
    }`;
    row.querySelector('.op-history-label').textContent = `${op.kind} · ${op.collection}`;
    row.querySelector('.op-history-duration').textContent = op.finishedAt && op.startedAt
      ? formatHistoryDuration(new Date(op.finishedAt) - new Date(op.startedAt))
      : '';
    row.addEventListener('click', () => { openOperationIsPinnedToLatest = false; openOperationId = op.id; render(); });
    row.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      openOperationIsPinnedToLatest = false;
      openOperationId = op.id;
      render();
    });
    return row;
  }));
}

function formatHistoryDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  return `${m}m`;
}

async function cancelOperation(id) {
  try {
    await apiPost(`/api/jobs/${encodeURIComponent(id)}/cancel`, {});
    pollNow();
  } catch {
    // A failed cancel attempt is surfaced by the next poll tick's state
    // (still "running"/"queued", cancel button still visible to retry) —
    // no separate error UI needed for what's already a best-effort action.
  }
}

function startElapsedTicker() {
  stopElapsedTicker();
  const body = $('#op-modal-body');
  if (!body) return;
  elapsedTimer = setInterval(() => tickElapsedRows(body), 1000);
}

function stopElapsedTicker() {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
}

// Test-only: undoes mountOperationModal()'s module-level `mounted` latch so
// a fresh test can mount into a fresh fixture document. Production never
// calls this — the modal mounts exactly once, at app boot.
export function resetForTests() {
  mounted = false;
  openOperationId = null;
  openOperationIsPinnedToLatest = false;
  unsubscribeStore?.();
  unsubscribeStore = null;
  stopElapsedTicker();
  detailsManualState.clear();
  lastFocusedBeforeOpen = null;
}
