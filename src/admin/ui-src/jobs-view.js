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
// This module's own markup (index-view.html?raw, imported below) is
// PHYSICALLY DIFFERENT between the Full and Lite builds (Phase 6 of
// docs/design/full-lite-shared-architecture-audit-2026-08-01.md) — Full's
// partials/full/index-view.html has the ONNX/LLM-summaries/tag-gen
// checkboxes and the Ollama-status placeholder; Lite's
// partials/lite/index-view.html has only the prune-stale checkbox. Which
// file this import resolves to is decided by which Vite config is building
// (see vite.config.js's/vite.config.lite.js's own resolve.alias entry for
// 'edition').
//
// This file NEVER references '#opt-onnx'/'#opt-llm-summaries'/'#opt-tags'/
// '#idx-ollama-status' as selector strings, not even to feature-detect
// whether they exist — every one of those id strings lives only inside
// local-features.js's own querySelector() calls (see that file's own
// header comment: an earlier version of this file DID call
// $('#opt-onnx') itself just to check presence, and that selector STRING
// LITERAL alone leaked into the Lite JS bundle even though the calling
// code path was gated behind a null capability check — caught by this
// phase's own real `vite build --config vite.config.lite.js` DCE test,
// which scans actual build output, not source). Instead,
// wireIndexingFormLocalOptions()/collectLocalJobOptions() are called
// unconditionally through the capability seam (localCapabilities, set by
// setJobsLocalCapabilities() — only entries/full.js calls it); each
// no-ops or returns null when the relevant elements aren't present, which
// is exactly Lite's real, permanent state, not a temporary fallback.
import indexViewShell from 'edition/index-view.html?raw';
import { $, errorBox, esc } from './dom.js';
import { apiPost } from './api.js';
import { openOperationModal } from './operation-modal.js';
import { pollNow } from './operation-store.js';

let localCapabilities = null;

export function setJobsLocalCapabilities(capabilities) {
  localCapabilities = capabilities;
}

export async function renderIndexingView(main) {
  main.innerHTML = indexViewShell;
  const form = $('#index-form');

  $('#opt-prune').addEventListener('change', (e) => {
    e.target.closest('label').classList.toggle('warn', e.target.checked);
  });

  localCapabilities?.wireIndexingFormLocalOptions(form, { esc, errorBox });

  $('#idx-choose-folder').addEventListener('click', chooseIndexFolder);

  form.addEventListener('submit', (e) => {
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

async function startIndexJob() {
  const status = $('#idx-status');
  const submit = $('#idx-submit');
  const form = $('#index-form');

  const collection = $('#idx-collection').value.trim();
  const path = currentIndexPathValue();
  if (!collection || !path) {
    status.className = 'error-box';
    status.textContent = 'Collection name and folder to index are both required.';
    return;
  }

  // pruneStale is the only option Semidex Lite's jobs policy allows
  // (admin/composition/lite.js's LITE_JOB_POLICY) — its checkbox is the
  // one field common to both editions' forms, so it's read directly here
  // (not through the capability seam) regardless of edition.
  const localOptions = localCapabilities?.collectLocalJobOptions(form);
  const payload = {
    collection,
    path,
    options: { ...(localOptions ?? {}), pruneStale: $('#opt-prune').checked },
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
      localCapabilities?.retryOllamaStatus(form, { esc, errorBox });
    } else {
      status.textContent = err.message;
    }
  } finally {
    submit.disabled = false;
  }
}
