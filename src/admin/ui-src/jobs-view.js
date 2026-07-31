// ── collection-creation view (#/index) ─────────────────────────────────────
// Phase 3S: the route-bound "Indexing progress" panel that used to live
// here (job list, per-job Show details, its own 1.5s poller) is gone —
// deleted, not hidden (task requirement 7). Starting an indexing job now
// opens the global operation modal (operation-modal.js), which is driven by
// the shared operation-store.js poller and survives navigation away from
// this route entirely. This module's only remaining job is the
// collection-creation FORM itself: folder picker, options, Ollama
// readiness check, and POSTing to /api/jobs/index.
//
// IS_LITE (see global-settings-view.js's own header comment for the full
// SEMIDEX_LITE/typeof rationale) guards every reference to the ONNX/
// LLM-summaries/tag-gen checkboxes and the Ollama-status check —
// vite.config.lite.js's stripHtmlMarkers plugin removes those elements
// from index-view.html entirely for the Lite build, so `$('#opt-onnx')`
// etc. would return null there; IS_LITE lets Rollup dead-code-eliminate
// the guarded branches so the Lite bundle has no reachable code path that
// assumes those elements exist.
import indexViewShell from './partials/index-view.html?raw';
import { $, esc, errorBox } from './dom.js';
import { api, apiPost } from './api.js';
import { openOperationModal } from './operation-modal.js';
import { pollNow } from './operation-store.js';

const IS_LITE = typeof SEMIDEX_LITE !== 'undefined' && SEMIDEX_LITE;

export async function renderIndexingView(main) {
  main.innerHTML = indexViewShell;

  $('#opt-prune').addEventListener('change', (e) => {
    e.target.closest('label').classList.toggle('warn', e.target.checked);
  });

  if (!IS_LITE) {
    $('#opt-llm-summaries').addEventListener('change', (e) => {
      if (e.target.checked) loadOllamaStatus(); else $('#idx-ollama-status').style.display = 'none';
    });
  }

  $('#idx-choose-folder').addEventListener('click', chooseIndexFolder);

  $('#index-form').addEventListener('submit', (e) => {
    e.preventDefault();
    startIndexJob();
  });
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
  if (IS_LITE) return;
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
    // pruneStale is the only option Semidex Lite's jobs policy allows
    // (server.js's LITE_JOB_POLICY) — its checkbox is the one kept in the
    // Lite build's stripped index-view.html (see vite.config.lite.js), so
    // it's read unconditionally here. The other three only exist in the
    // full build's DOM.
    options: IS_LITE
      ? { pruneStale: $('#opt-prune').checked }
      : {
          onnxEmbed: $('#opt-onnx').checked,
          llmSummaries: $('#opt-llm-summaries').checked,
          pruneStale: $('#opt-prune').checked,
          tagGen: $('#opt-tags').checked,
        },
  };

  submit.disabled = true;
  status.className = 'empty';
  status.textContent = 'starting…';

  try {
    const { job } = await apiPost('/api/jobs/index', payload);
    status.textContent = '';
    // Open the modal immediately, showing the queued/running state straight
    // from this response (task requirement 3) — pollNow() then reconciles
    // the shared store with the server a moment later so the modal isn't
    // stuck on this one-shot snapshot for up to IDLE_POLL_MS.
    pollNow();
    openOperationModal(job.id);
  } catch (err) {
    status.className = 'error-box';
    if (err.status === 409) {
      // The server's 409 message names the already-running job — shown
      // verbatim (task requirement 3: "show the server's 409 message
      // clearly"), plus a pointer to the modal rather than a dead-end.
      status.textContent = `${err.message} Open the operation status to view or cancel it.`;
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
