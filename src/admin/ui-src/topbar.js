// ── top bar: health + capabilities + active-job chip ─────────────────────
import { $, esc } from './dom.js';
import { api } from './api.js';
import { currentRoute } from './routes.js';

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

const JOB_CHIP_ACTIVE_STATES = new Set(['queued', 'running', 'cancelling']);
const JOB_CHIP_ACTIVE_POLL_MS = 1500;
const JOB_CHIP_IDLE_POLL_MS = 5000;

let jobChipTimer = null;

/**
 * Small always-visible-when-relevant indicator that an indexing job is in
 * flight, reachable from any route — not a full job center (the jobs list
 * itself lives at #/index). Hidden with zero active jobs; shows the
 * collection name of the first active job otherwise. Click navigates to
 * #/index. Deliberately skips its own poll tick while already on #/index,
 * since jobs-view.js runs its own faster (1.5s) poller there — polling from
 * both places at once would double the request rate for no benefit.
 */
export function initJobChip() {
  pollJobChip();
}

async function pollJobChip() {
  clearTimeout(jobChipTimer);
  const chip = $('#job-chip');
  if (!chip) return;

  if (currentRoute().view === 'index') {
    // jobs-view.js already polls faster and renders the full list while
    // this route is active — but the chip itself must not just go stale:
    // without this, clicking the chip to reach #/index and then having that
    // job finish would leave "Indexing ..." showing indefinitely until the
    // user navigates away. Hide it here (the jobs list itself is the
    // source of truth while on this route) and just recheck on our own
    // slower cadence so the chip catches up once the user navigates away.
    chip.hidden = true;
    chip.textContent = '';
    jobChipTimer = setTimeout(pollJobChip, JOB_CHIP_IDLE_POLL_MS);
    return;
  }

  let activeJobs = [];
  try {
    const { jobs } = await api('/api/jobs');
    activeJobs = jobs.filter(j => JOB_CHIP_ACTIVE_STATES.has(j.state));
  } catch {
    // Transient API errors shouldn't flip a visible chip on/off; keep
    // whatever state was last shown and just try again next tick.
    jobChipTimer = setTimeout(pollJobChip, JOB_CHIP_IDLE_POLL_MS);
    return;
  }

  renderJobChip(chip, activeJobs);
  jobChipTimer = setTimeout(pollJobChip, activeJobs.length ? JOB_CHIP_ACTIVE_POLL_MS : JOB_CHIP_IDLE_POLL_MS);
}

export function renderJobChip(chip, activeJobs) {
  if (!activeJobs.length) {
    chip.hidden = true;
    chip.textContent = '';
    return;
  }
  const job = activeJobs[0];
  const extra = activeJobs.length > 1 ? ` +${activeJobs.length - 1}` : '';
  chip.hidden = false;
  // job.collection is a user-controlled collection name (the API only
  // rejects "/" and "\", not HTML) — esc() it, same as every other place
  // in this codebase that interpolates a collection/file name into HTML.
  chip.innerHTML = `<span class="job-chip-dot"></span>Indexing ${esc(job.collection)}${esc(extra)}`;
  chip.onclick = () => { location.hash = '#/index'; };
}
