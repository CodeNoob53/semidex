// ── shared operation card renderer (Phase 3S) ──────────────────────────────
// The ONE place that turns an /api/operations item into a .job-card element
// (reusing the existing tpl-job-row template — index/reindex/repair all
// render through this, not three separate renderers). Used by
// operation-modal.js only; the old per-route jobs-view.js renderer this
// replaced is deleted, not duplicated (task requirement 7: "duplicate
// progress rendering and duplicate formatting helpers" must be removed).
//
// Pure rendering: takes an operation object + a manual-details-open lookup,
// returns a DOM element. No API calls, no module-level state of its own —
// operation-store.js already owns polling; this module only knows how to
// draw one operation.
import { $, cloneTemplate } from './dom.js';

const STATUS_BADGE_CLASS = {
  queued: 'badge', running: 'badge badge-amber', cancelling: 'badge badge-warn',
  succeeded: 'badge badge-ok', failed: 'badge badge-fail', cancelled: 'badge',
};

const KIND_LABEL = {
  index: 'Indexing', reindex: 'Reindexing', repair: 'Repairing',
};

const KIND_PAST_LABEL = {
  index: 'Indexed', reindex: 'Reindexed', repair: 'Repaired',
};

// "31s", "4m 12s", "1h 03m" — short, human duration. Never shows raw
// timestamps; that's what "Show details" is for.
export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// "Started 14:19" for same-day operations; only falls back to a full date
// if the operation actually started on a different calendar day than "now".
export function formatStartedLabel(startedAtIso) {
  if (!startedAtIso) return null;
  const started = new Date(startedAtIso);
  const now = new Date();
  const sameDay = started.getFullYear() === now.getFullYear()
    && started.getMonth() === now.getMonth()
    && started.getDate() === now.getDate();
  const time = started.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `Started ${time}` : `Started ${started.toLocaleDateString()} ${time}`;
}

function filesLabel(progress) {
  if (!progress) return '';
  if (progress.totalFiles === null) {
    return progress.processedFiles !== null ? `${progress.processedFiles} files processed` : '';
  }
  return `${progress.processedFiles ?? 0} / ${progress.totalFiles} files processed`;
}

/**
 * @param {object} op - one item from GET /api/operations (or /api/operations/:id's `operation`)
 * @param {{ detailsOpen?: boolean, onToggleDetails?: (open: boolean) => void }} [opts]
 *   detailsOpen: whether "Show details" should render open — the caller
 *   (operation-modal.js) owns the "has the user manually toggled this"
 *   decision, same separation jobs-view.js's resolveJobDetailsOpenState()
 *   already established; this module just applies whatever the caller says.
 */
export function renderOperationCard(op, { detailsOpen = false, onToggleDetails } = {}) {
  const frag = cloneTemplate('tpl-job-row');
  const card = frag.querySelector('.job-card');
  card.dataset.id = op.id;
  card.dataset.startedAt = op.startedAt ?? '';
  card.dataset.kind = op.kind;

  const badge = card.querySelector('.job-status-badge');
  badge.className = `job-status-badge ${STATUS_BADGE_CLASS[op.state] ?? 'badge'}`;
  badge.textContent = op.state;

  const isRunning = op.state === 'queued' || op.state === 'running' || op.state === 'cancelling';
  const titlePrefix = op.state === 'succeeded' ? (KIND_PAST_LABEL[op.kind] ?? 'Completed')
    : op.state === 'failed' ? `${KIND_LABEL[op.kind] ?? 'Operation'} failed`
    : op.state === 'cancelled' ? `${KIND_LABEL[op.kind] ?? 'Operation'} cancelled`
    : (KIND_LABEL[op.kind] ?? 'Operation');
  card.querySelector('.job-title').textContent =
    op.state === 'failed' ? titlePrefix : `${titlePrefix} ${op.collection}`;

  card.querySelector('.job-progress-count').textContent = filesLabel(op.progress);
  const currentFileEl = card.querySelector('.job-progress-current');
  if (isRunning && op.progress?.currentFile) {
    currentFileEl.textContent = `Current file: ${op.progress.currentFile}`;
  }

  const stepEl = card.querySelector('.job-progress-step');
  if (isRunning && op.progress?.phase) {
    stepEl.textContent = `Step: ${op.progress.phase}`;
    stepEl.hidden = false;
  }

  const hasKnownPercent = op.progress && typeof op.progress.percent === 'number';
  card.querySelector('.job-progress-bar').hidden = !hasKnownPercent;
  // An indeterminate bar shows whenever the operation is active but has no
  // measurable percentage — this is the ONLY path a repair task's card ever
  // takes (its progress is always null), and it's also what a spawned job
  // shows before its first [semidex:progress] line arrives.
  card.querySelector('.job-progress-indeterminate').hidden = !isRunning || hasKnownPercent;
  if (hasKnownPercent) {
    card.querySelector('.job-progress-fill').style.width = `${Math.min(100, Math.max(0, op.progress.percent))}%`;
  }

  const cancelBtn = card.querySelector('.job-cancel');
  // Trusts the backend's own cancellable flag (api/operations.js) rather
  // than re-deriving "is this cancellable" from state here — a repair task
  // is never cancellable even while running, which state alone can't tell
  // apart from a cancellable running indexing job.
  if (op.cancellable) {
    cancelBtn.dataset.id = op.id;
    cancelBtn.hidden = false;
  }

  const statusLine = card.querySelector('.job-status-line');
  if (op.state === 'cancelling') {
    statusLine.textContent = 'Cancelling…';
  } else if (op.state === 'succeeded') {
    statusLine.textContent = op.finishedAt && op.startedAt
      ? `Completed in ${formatDuration(new Date(op.finishedAt) - new Date(op.startedAt))}`
      : 'Completed';
  } else if (op.state === 'failed') {
    statusLine.textContent = op.finishedAt && op.startedAt
      ? `Failed after ${formatDuration(new Date(op.finishedAt) - new Date(op.startedAt))}`
      : 'Failed';
  } else if (op.state === 'cancelled') {
    statusLine.textContent = op.finishedAt && op.startedAt
      ? `Cancelled after ${formatDuration(new Date(op.finishedAt) - new Date(op.startedAt))}`
      : 'Cancelled';
  }
  // 'running'/'queued' elapsed text is filled in by the caller's own ticker
  // (operation-modal.js's tickElapsed()), same split of responsibility
  // jobs-view.js used to have between render and a once-a-second updater.

  if (op.state === 'failed' && op.error) {
    const errorEl = card.querySelector('.job-error-summary');
    errorEl.textContent = op.error;
    errorEl.hidden = false;
  }

  const detailsEl = card.querySelector('.job-details');
  if (detailsOpen) detailsEl.setAttribute('open', '');
  else detailsEl.removeAttribute('open');
  detailsEl.addEventListener('toggle', () => {
    onToggleDetails?.(detailsEl.hasAttribute('open'));
  });

  card.querySelector('.job-path').textContent = op.sourcePath ?? op.path ?? '';
  const startedLabel = formatStartedLabel(op.startedAt);
  const endedLabel = op.finishedAt ? `ended ${new Date(op.finishedAt).toLocaleString()}` : null;
  card.querySelector('.job-times').textContent =
    [startedLabel, endedLabel].filter(Boolean).join(' · ');

  if (Array.isArray(op.log)) {
    card.querySelector('.job-log').textContent = op.log.slice(-30).join('\n') || '(no output yet)';
  }

  return card;
}

// Recomputes "Running · Xs elapsed" text in place for every currently-
// rendered running/queued operation card under `root`, without a re-render
// — same split jobs-view.js's tickRunningJobRows() used (elapsed time
// doesn't need a network round trip to update, just wall-clock math).
export function tickElapsedRows(root) {
  for (const card of root.querySelectorAll('.job-card')) {
    const badge = card.querySelector('.job-status-badge');
    const state = badge?.textContent;
    if (state !== 'running' && state !== 'queued') continue;
    const startedAt = card.dataset.startedAt;
    if (!startedAt) continue;
    const elapsed = formatDuration(Date.now() - new Date(startedAt).getTime());
    const statusLine = $('.job-status-line', card);
    if (statusLine) statusLine.textContent = state === 'queued' ? `Queued · ${elapsed} elapsed` : `Running · ${elapsed} elapsed`;
  }
}
