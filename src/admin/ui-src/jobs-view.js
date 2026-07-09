// ── indexing progress view ─────────────────────────────────────────────────
// Renamed from the earlier raw "Jobs" panel: this is meant to read as user-
// facing indexing progress (collection, files processed, current file,
// elapsed/duration, a real progress bar), not a debug/job console. Logs stay
// available but collapsed behind "Show details".
import indexViewShell from './partials/index-view.html?raw';
import { $, esc, cloneTemplate, errorBox, emptyBox } from './dom.js';
import { api, apiPost } from './api.js';
import { loadSidebar } from './sidebar.js';
import { currentRoute } from './routes.js';

let indexPollTimer = null;

function stopIndexPolling() {
  if (indexPollTimer) { clearTimeout(indexPollTimer); indexPollTimer = null; }
}

export async function renderIndexingView(main) {
  stopIndexPolling();
  stopJobElapsedTicker();
  main.innerHTML = indexViewShell;

  $('#opt-prune').addEventListener('change', (e) => {
    e.target.closest('label').classList.toggle('warn', e.target.checked);
  });

  $('#opt-llm-summaries').addEventListener('change', (e) => {
    if (e.target.checked) loadOllamaStatus(); else $('#idx-ollama-status').style.display = 'none';
  });

  $('#idx-choose-folder').addEventListener('click', chooseIndexFolder);

  $('#index-form').addEventListener('submit', (e) => {
    e.preventDefault();
    startIndexJob();
  });

  await loadJobs();
}

function currentIndexPathValue() {
  const manual = $('#idx-path-manual');
  const main = $('#idx-path');
  if (manual && manual.offsetParent !== null) return manual.value.trim();
  return main.value.trim();
}

async function chooseIndexFolder() {
  const btn = $('#idx-choose-folder');
  const pathInput = $('#idx-path');
  const fallback = $('#idx-path-fallback');
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Choosing…';

  try {
    const { path, cancelled } = await apiPost('/api/system/pick-folder', {});
    if (!cancelled && path) {
      pathInput.style.display = '';
      pathInput.value = path;
      fallback.style.display = 'none';
    }
  } catch (err) {
    // Picker unavailable (non-Windows, powershell.exe missing, timed out,
    // etc.) — fall back to manual entry instead of leaving the user stuck
    // with a broken button and no way to proceed.
    fallback.style.display = '';
    $('#idx-path-manual').focus();
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

const OLLAMA_STATUS_BADGE = {
  available: 'badge badge-ok',
  missing: 'badge badge-fail',
  model_missing: 'badge badge-warn',
};

async function loadOllamaStatus() {
  const box = $('#idx-ollama-status');
  if (!box) return;
  box.style.display = '';
  box.innerHTML = '<span class="mono muted">checking Ollama…</span>';
  try {
    const { status, message } = await api('/api/system/ollama-status');
    const badgeClass = OLLAMA_STATUS_BADGE[status] ?? 'badge';
    box.innerHTML = `LLM summaries require Ollama:
      <span class="${badgeClass}">${esc(status)}</span>
      <span class="skel-note" style="display:inline;margin:0 0 0 6px">${esc(message)}</span>`;
  } catch (err) {
    box.innerHTML = errorBox(err);
  }
}

async function startIndexJob() {
  const status = $('#idx-status');
  const submit = $('#idx-submit');

  const collection = $('#idx-collection').value.trim();
  const path = currentIndexPathValue();
  if (!collection || !path) {
    status.className = 'error-box';
    status.textContent = 'Collection name and folder to index are both required.';
    return;
  }

  const payload = {
    collection,
    path,
    options: {
      onnxEmbed: $('#opt-onnx').checked,
      llmSummaries: $('#opt-llm-summaries').checked,
      skeletonChunking: $('#opt-skel-chunk').checked,
      skeletonNav: $('#opt-skel-nav').checked,
      pruneStale: $('#opt-prune').checked,
      tagGen: $('#opt-tags').checked,
    },
  };

  submit.disabled = true;
  status.className = 'empty';
  status.textContent = 'starting…';

  try {
    await apiPost('/api/jobs/index', payload);
    status.textContent = 'Job started.';
    await loadJobs();
  } catch (err) {
    status.className = 'error-box';
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

const JOB_STATUS_BADGE_CLASS = {
  queued: 'badge', running: 'badge badge-amber', cancelling: 'badge badge-warn',
  succeeded: 'badge badge-ok', failed: 'badge badge-fail', cancelled: 'badge',
};

// "31s", "4m 12s", "1h 03m" — short, human duration. Never shows raw
// timestamps; that's what "Show details" is for.
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// "Started 14:19" for same-day jobs; only falls back to a full date if the
// job actually started on a different calendar day than "now" — per the
// task's explicit rule that a bare time is enough for the common case and
// a full date should not be forced onto every row.
function formatStartedLabel(startedAtIso) {
  if (!startedAtIso) return null;
  const started = new Date(startedAtIso);
  const now = new Date();
  const sameDay = started.getFullYear() === now.getFullYear()
    && started.getMonth() === now.getMonth()
    && started.getDate() === now.getDate();
  const time = started.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `Started ${time}` : `Started ${started.toLocaleDateString()} ${time}`;
}

function jobFilesLabel(progress) {
  if (!progress) return '';
  if (progress.totalFiles === null) {
    return progress.processedFiles !== null ? `${progress.processedFiles} files processed` : '';
  }
  return `${progress.processedFiles ?? 0} / ${progress.totalFiles} files processed`;
}

// Builds a job-card element from the tpl-job-row template. Progress is
// never forecast — "ended"/"Completed in" only ever comes from the job's
// own finishedAt once the process has actually exited; a running job never
// shows an end time, only elapsed-so-far.
function renderJobRow(j) {
  const frag = cloneTemplate('tpl-job-row');
  const card = frag.querySelector('.job-card');
  card.dataset.id = j.id;
  card.dataset.startedAt = j.startedAt ?? '';

  const badge = card.querySelector('.job-status-badge');
  // "job-status-badge" must survive this assignment — tickRunningJobRows()
  // re-selects this element by that class on every tick to check the
  // current state, so overwriting className with just the color classes
  // (as a naive `badge.className = colorClass` would) breaks it after the
  // very first render.
  badge.className = `job-status-badge ${JOB_STATUS_BADGE_CLASS[j.state] ?? 'badge'}`;
  badge.textContent = j.state;

  const isRunning = j.state === 'queued' || j.state === 'running' || j.state === 'cancelling';
  const titlePrefix = j.state === 'succeeded' ? 'Indexed'
    : j.state === 'failed' ? 'Indexing failed'
    : j.state === 'cancelled' ? 'Indexing cancelled'
    : `Indexing`;
  card.querySelector('.job-title').textContent =
    j.state === 'failed' ? titlePrefix : `${titlePrefix} ${j.collection}`;

  card.querySelector('.job-progress-count').textContent = jobFilesLabel(j.progress);
  const currentFileEl = card.querySelector('.job-progress-current');
  if (isRunning && j.progress?.currentFile) {
    currentFileEl.textContent = `Current file: ${j.progress.currentFile}`;
  }

  // currentStep is the human-facing phase label (e.g. "Generating
  // summaries") — omitted entirely (not shown empty) when the backend
  // hasn't reported one, which covers both "not running yet" and old
  // progress payloads from before this field existed (see task's backward-
  // compatibility requirement).
  const stepEl = card.querySelector('.job-progress-step');
  if (isRunning && j.progress?.currentStep) {
    stepEl.textContent = `Step: ${j.progress.currentStep}`;
    stepEl.hidden = false;
  }

  const hasKnownTotal = j.progress && typeof j.progress.percent === 'number';
  card.querySelector('.job-progress-bar').hidden = !hasKnownTotal;
  card.querySelector('.job-progress-indeterminate').hidden = !isRunning || hasKnownTotal;
  if (hasKnownTotal) {
    card.querySelector('.job-progress-fill').style.width = `${Math.min(100, Math.max(0, j.progress.percent))}%`;
  }

  const cancelBtn = card.querySelector('.job-cancel');
  if (j.state === 'queued' || j.state === 'running') {
    cancelBtn.dataset.id = j.id;
    cancelBtn.hidden = false;
  }

  const statusLine = card.querySelector('.job-status-line');
  if (j.state === 'cancelling') {
    statusLine.textContent = 'Cancelling…';
  } else if (j.state === 'succeeded') {
    statusLine.textContent = j.finishedAt && j.startedAt
      ? `Completed in ${formatDuration(new Date(j.finishedAt) - new Date(j.startedAt))}`
      : 'Completed';
  } else if (j.state === 'failed') {
    statusLine.textContent = j.finishedAt && j.startedAt
      ? `Failed after ${formatDuration(new Date(j.finishedAt) - new Date(j.startedAt))}`
      : 'Failed';
  } else if (j.state === 'cancelled') {
    statusLine.textContent = j.finishedAt && j.startedAt
      ? `Cancelled after ${formatDuration(new Date(j.finishedAt) - new Date(j.startedAt))}`
      : 'Cancelled';
  }
  // 'running'/'queued' elapsed text is filled in by tickRunningJobRows()
  // below (needs to update every second without a full re-render).

  // The error summary itself needs job.log, which only the per-job detail
  // endpoint returns (GET /api/jobs, used for the list, is summary-only) —
  // loadJobLog() fills .job-error-summary in once that detail request
  // resolves. Auto-expand details on failure so the error/log is visible
  // without an extra click — but logs still start collapsed for every
  // other state.
  card.querySelector('.job-details').open = j.state === 'failed';

  card.querySelector('.job-path').textContent = j.path;
  const startedLabel = formatStartedLabel(j.startedAt);
  const endedLabel = j.finishedAt ? `ended ${new Date(j.finishedAt).toLocaleString()}` : null;
  card.querySelector('.job-times').textContent =
    [startedLabel, endedLabel].filter(Boolean).join(' · ');

  return card;
}

// Running/queued jobs show a live "Xs elapsed" — recomputed on an interval
// rather than re-fetching /api/jobs, since elapsed time doesn't need a
// network round trip to update.
let jobElapsedTimer = null;
function stopJobElapsedTicker() {
  if (jobElapsedTimer) { clearInterval(jobElapsedTimer); jobElapsedTimer = null; }
}
function tickRunningJobRows() {
  const box = $('#idx-jobs');
  if (!box) return;
  for (const card of box.querySelectorAll('.job-card')) {
    const badge = card.querySelector('.job-status-badge');
    const state = badge?.textContent;
    if (state !== 'running' && state !== 'queued') continue;
    const startedAt = card.dataset.startedAt;
    if (!startedAt) continue;
    const elapsed = formatDuration(Date.now() - new Date(startedAt).getTime());
    card.querySelector('.job-status-line').textContent =
      state === 'queued' ? `Queued · ${elapsed} elapsed` : `Running · ${elapsed} elapsed`;
  }
}

async function loadJobs() {
  const box = $('#idx-jobs');
  let jobs;
  try {
    ({ jobs } = await api('/api/jobs'));
  } catch (err) {
    box.innerHTML = errorBox(err);
    return;
  }

  if (!jobs.length) {
    box.innerHTML = emptyBox('No indexing jobs yet.');
  } else {
    // renderJobRow() always rebuilds a fresh <details>, only auto-opening it
    // for a failed job — every poll tick otherwise silently closes a
    // user-opened details panel on a still-running job. Capture which job
    // IDs were open before the full replaceChildren() below, then reapply.
    const openIds = new Set(
      [...box.querySelectorAll('.job-details[open]')]
        .map(el => el.closest('.job-card')?.dataset.id)
        .filter(Boolean),
    );
    box.replaceChildren(...jobs.map(renderJobRow));
    for (const card of box.querySelectorAll('.job-card')) {
      // setAttribute, not `.open = true` — both work in a real browser, but
      // setAttribute doesn't depend on the <details> IDL-property/attribute
      // reflection some DOM implementations (including this project's test
      // harness, linkedom) don't fully support.
      if (openIds.has(card.dataset.id)) card.querySelector('.job-details').setAttribute('open', '');
    }

    for (const btn of box.querySelectorAll('.job-cancel')) {
      btn.addEventListener('click', () => cancelJob(btn.dataset.id));
    }
    for (const card of box.querySelectorAll('.job-card')) {
      loadJobLog(card);
    }
  }

  const stillActive = jobs.some(j => j.state === 'queued' || j.state === 'running' || j.state === 'cancelling');
  stopIndexPolling();
  stopJobElapsedTicker();
  if (stillActive) {
    tickRunningJobRows();
    jobElapsedTimer = setInterval(tickRunningJobRows, 1000);
    indexPollTimer = setTimeout(async () => {
      if (currentRoute().view !== 'index') return; // navigated away
      await loadJobs();
    }, 1500);
  } else if (jobs.some(j => j.state === 'succeeded')) {
    loadSidebar();
  }
}

async function loadJobLog(card) {
  const pre = card.querySelector('.job-log');
  if (!pre) return;
  const id = card.dataset.id;
  try {
    const { job } = await api(`/api/jobs/${encodeURIComponent(id)}`);
    pre.textContent = job.log.slice(-30).join('\n') || '(no output yet)';

    if (job.state === 'failed') {
      const lastErrorLine = [...job.log].reverse().find(l => l.startsWith('[stderr]'));
      if (lastErrorLine) {
        const errorEl = card.querySelector('.job-error-summary');
        errorEl.textContent = lastErrorLine.replace(/^\[stderr\]\s*/, '');
        errorEl.hidden = false;
      }
    }
  } catch (err) {
    pre.textContent = err.message;
  }
}

async function cancelJob(id) {
  try {
    await apiPost(`/api/jobs/${encodeURIComponent(id)}/cancel`, {});
    await loadJobs();
  } catch (err) {
    $('#idx-status').className = 'error-box';
    $('#idx-status').textContent = err.message;
  }
}
