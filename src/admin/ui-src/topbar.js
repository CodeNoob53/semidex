// ── top bar: health + capabilities + active-operation chip ────────────────
import { $, esc } from './dom.js';
import { api } from './api.js';
import { subscribe, getActiveOperation } from './operation-store.js';
import { openOperationModal } from './operation-modal.js';

export async function loadTopbar() {
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

const KIND_CHIP_LABEL = { index: 'Indexing', reindex: 'Reindexing', repair: 'Repairing' };

/**
 * Reachable-from-any-route indicator that an operation (indexing,
 * reindexing, or repair) is in flight. Phase 3S: subscribes to the shared
 * operation-store.js instead of polling /api/jobs on its own timer — the
 * store already polls continuously (started once at app boot, see app.js),
 * so this is a pure render-on-event subscriber, never a second poller.
 * Clicking it opens the global operation modal in place — it no longer
 * navigates to #/index, since #/index is collection-creation only now (the
 * jobs list that used to live there is gone; see jobs-view.js).
 */
export function initJobChip() {
  const chip = $('#job-chip');
  if (!chip) return;
  chip.addEventListener('click', () => openOperationModal(getActiveOperation()?.id));
  subscribe((event) => {
    if (event.type === 'update') renderJobChip(chip, getActiveOperation());
  });
}

export function renderJobChip(chip, activeOp) {
  if (!activeOp) {
    chip.hidden = true;
    chip.textContent = '';
    return;
  }
  chip.hidden = false;
  const label = KIND_CHIP_LABEL[activeOp.kind] ?? 'Working on';
  const percent = typeof activeOp.progress?.percent === 'number'
    ? ` ${Math.round(activeOp.progress.percent)}%`
    : ''; // no known percentage -> the CSS dot's indeterminate pulse is the only progress signal, no fabricated number
  // activeOp.collection is a user-controlled collection name (the API only
  // rejects "/" and "\", not HTML) — esc() it, same as every other place in
  // this codebase that interpolates a collection/file name into HTML.
  chip.innerHTML = `<span class="job-chip-dot"></span>${esc(label)} ${esc(activeOp.collection)}${esc(percent)}`;
}
