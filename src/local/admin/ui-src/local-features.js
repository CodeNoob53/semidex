// Full-only local-runtime settings features — ONNX hardware probe panel and
// Ollama model discovery for the global settings view (#/settings/:category).
// Split out of global-settings-view.js (Phase 6 of
// docs/design/full-lite-shared-architecture-audit-2026-08-01.md) so Semidex
// Lite's entry point (entries/lite.js) can simply never import this file —
// true physical bundle isolation, not Rollup dead-code elimination of an
// IS_LITE-guarded branch. Only entries/full.js imports this module and wires
// it into global-settings-view.js via setLocalSettingsCapabilities(); Lite's
// entry never does, so this file (and everything it imports — none of it
// imports anything beyond dom.js/api.js) never becomes reachable from Lite's
// module graph at all.
//
// Every export here is a pure function taking whatever state it needs as
// parameters (currentPendingValue, templateRoot) — this module holds no
// module-level state of its own, unlike global-settings-view.js's
// pendingByCategory/invalidByCategory/lastOllamaModels, which stay private
// to that file since they're shared with genuinely provider-neutral fields
// too (e.g. currentPendingValue is used for every setting, not just
// ONNX/Ollama ones).
import { api, apiPost } from '../../../shared/admin/ui-src/api.js';

const ONNX_PROBE_PROVIDERS = new Set(['cuda', 'dml']);

// Shown only alongside a visible ONNX_EXECUTION_PROVIDER field currently
// staged to 'cuda' or 'dml' — CPU never shows this panel since there is
// nothing to verify. "Last verified" starts empty and is populated only by
// a real click of the test button (see wireOnnxProbePanel) — never
// auto-run, never inferred from the setting alone.
export function onnxProbePanel(category, entries, { templateRoot, currentPendingValue }) {
  const providerEntry = entries.find((e) => e.key === 'ONNX_EXECUTION_PROVIDER');
  if (!providerEntry) return null;
  const provider = currentPendingValue(category, providerEntry);
  if (!ONNX_PROBE_PROVIDERS.has(provider)) return null;

  const panel = templateRoot('tpl-gs-onnx-probe-panel');
  panel.querySelector('.gs-onnx-requested').textContent = provider;
  panel.querySelector('.gs-onnx-active').textContent = providerEntry.activeValue;
  const pendingNote = panel.querySelector('.gs-onnx-pending-restart');
  if (providerEntry.pendingRestart) {
    pendingNote.hidden = false;
    pendingNote.textContent = `Saved — still using "${providerEntry.activeValue}" until semidex restarts.`;
  } else {
    pendingNote.hidden = true;
  }
  // DML never uses the managed CUDA runtime (see
  // onnx-runtime-source-resolution.js's provider-gating) — the managed
  // runtime dropdown is already hidden for DML via ONNX_MANAGED_RUNTIME's
  // own visibleWhen (provider=cuda), but this note explains WHY, in the one
  // other place a DML user would otherwise wonder where their managed
  // runtime went.
  panel.querySelector('.gs-onnx-dml-runtime-note').hidden = provider !== 'dml';
  const testButton = panel.querySelector('.gs-onnx-test-button');
  testButton.dataset.provider = provider;
  // "Test CUDA configuration"/"Test DML configuration" — never the generic
  // template default when a specific provider is what's actually being
  // tested, so a DML-only user is never told they're testing "CUDA".
  testButton.textContent = `Test ${provider.toUpperCase()} configuration`;
  // ONNXRUNTIME_NODE_PATH's CURRENT value (may be an unsaved, staged edit)
  // is read live from its input at click time by runOnnxProbe() itself,
  // not snapshotted here — see that function's own comment for why a
  // render-time snapshot would go stale.
  return panel;
}

export function wireOnnxProbePanel(container, category) {
  const btn = container.querySelector('.gs-onnx-test-button');
  if (!btn) return;
  btn.addEventListener('click', () => runOnnxProbe(container, category, btn));
}

// Renders a { reason, details, nextSteps } CUDA diagnosis (from the probe
// response's `diagnosis` field — real nvidia-smi/CUDA_PATH/cuDNN system
// checks, run server-side) into the panel's .gs-onnx-diagnosis block.
// diagnosis is null/undefined for every non-CUDA probe, every successful
// CUDA probe, and any older cached response shape — hides the block for
// all of those identically via truthiness, no shape-detection needed.
// nextSteps items are appended as real <li> elements, never innerHTML'd —
// matching this codebase's DOM-construction convention throughout.
function renderCudaDiagnosis(panel, diagnosis) {
  const block = panel.querySelector('.gs-onnx-diagnosis');
  if (!diagnosis) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  block.querySelector('.gs-onnx-diagnosis-details').textContent = diagnosis.details ?? '';
  const stepsList = block.querySelector('.gs-onnx-diagnosis-steps');
  stepsList.replaceChildren();
  for (const step of diagnosis.nextSteps ?? []) {
    const li = document.createElement('li');
    li.textContent = step;
    stepsList.appendChild(li);
  }
}

async function runOnnxProbe(container, category, btn) {
  const panel = btn.closest('.gs-onnx-probe-panel');
  const verified = panel.querySelector('.gs-onnx-verified');
  const fallbackWarning = panel.querySelector('.gs-onnx-fallback-warning');
  const stagedPathNotice = panel.querySelector('.gs-onnx-staged-path-notice');
  const resultBlock = panel.querySelector('.gs-onnx-result');
  const provider = btn.dataset.provider;
  // Read the LIVE current value from the path input itself, not a
  // render-time snapshot — editing ONNXRUNTIME_NODE_PATH deliberately never
  // triggers a full category re-render (wireCategoryEvents()'s "don't
  // rebuild the field being edited" contract), so a value captured when
  // this panel was last rendered would go stale the instant the user types
  // into the field without the panel ever refreshing. This is what lets
  // "Test" send a staged-but-unsaved runtime path together with a
  // staged-but-unsaved provider, rather than silently falling back to
  // whatever path was last actually saved.
  const pathInput = container.querySelector('.gs-path-input[data-key="ONNXRUNTIME_NODE_PATH"]');
  // Same live-read rationale as pathInput above: the managed-runtime
  // <select>'s own current value (staged or saved) is read fresh at click
  // time, so "Test" exercises whatever combination is actually on screen,
  // never a stale render-time snapshot.
  const managedRuntimeSelect = container.querySelector('.gs-field-control[data-key="ONNX_MANAGED_RUNTIME"]');
  const requestBody = { provider };
  if (pathInput) requestBody.runtimePath = pathInput.value;
  if (managedRuntimeSelect) requestBody.managedRuntimeId = managedRuntimeSelect.value;

  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Testing…';
  fallbackWarning.hidden = true;
  stagedPathNotice.hidden = true;
  resultBlock.hidden = true;

  try {
    const result = await apiPost('/api/system/onnx-probe', requestBody);
    const timestamp = new Date().toLocaleTimeString();
    verified.textContent = `${result.effectiveProvider ?? 'none'} (${timestamp})`;

    // Server-confirmed (not just the UI's own belief) — surfaced so a
    // result is never mistaken for testing the saved configuration when it
    // actually tested an in-progress, unsaved edit.
    if (result.testedStagedRuntimePath) {
      stagedPathNotice.hidden = false;
      stagedPathNotice.textContent = 'This test used an unsaved custom runtime path — Save to make it permanent.';
    }

    // The one required, exact wording for a CUDA-requested/CPU-effective
    // result — driven only by the probe's own dedicated fellBackToCpu flag,
    // never inferred, so a plain probe failure (e.g. model_not_cached) is
    // never mislabeled as a silent CPU fallback.
    if (result.fellBackToCpu) {
      fallbackWarning.hidden = false;
      fallbackWarning.textContent = 'CUDA was requested, but the effective provider is CPU.';
    }

    resultBlock.hidden = false;
    panel.querySelector('.gs-onnx-runtime-source').textContent = result.runtimeSource ?? 'unknown';
    panel.querySelector('.gs-onnx-runtime-version').textContent = result.runtimeVersion ?? 'unknown';
    panel.querySelector('.gs-onnx-model-cached').textContent = result.modelCached ? 'yes' : 'no';
    panel.querySelector('.gs-onnx-managed-runtime').textContent = result.managedRuntimeManifest
      ? `ORT ${result.managedRuntimeManifest.ortVersion} / CUDA ${result.managedRuntimeManifest.cudaMajor} (${result.managedRuntimeManifest.verification.status})`
      : '—';
    panel.querySelector('.gs-onnx-message').textContent = result.message ?? '';
    renderCudaDiagnosis(panel, result.diagnosis);
  } catch (err) {
    verified.textContent = 'Test failed';
    resultBlock.hidden = false;
    panel.querySelector('.gs-onnx-runtime-source').textContent = 'unknown';
    panel.querySelector('.gs-onnx-runtime-version').textContent = 'unknown';
    panel.querySelector('.gs-onnx-model-cached').textContent = 'unknown';
    panel.querySelector('.gs-onnx-managed-runtime').textContent = '—';
    panel.querySelector('.gs-onnx-message').textContent = err?.message ?? 'The probe request failed.';
    // A network/route failure never has a diagnosis — explicitly hide the
    // block so a stale diagnosis from a previous successful-then-failed
    // click sequence never lingers visibly across an unrelated error.
    renderCudaDiagnosis(panel, null);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

export function categoryNeedsOllamaModels(category, lastFetchedPayload) {
  return lastFetchedPayload.settings.some(
    (s) => s.category === category && s.dynamicOptions?.source === 'ollama_models'
  );
}

// Fetches /api/ollama-models fresh and re-renders — reused directly by
// both the initial category render and the "Refresh models" button, so
// there is exactly one fetch/render path for this data, never two drifting
// implementations. `onModelsFetched(models)` lets the caller store the
// result into its own private lastOllamaModels state and re-render; this
// module holds no state of its own (see this file's own header comment).
export async function refreshOllamaModels(forceRefresh, onModelsFetched) {
  let models;
  try {
    models = await api(forceRefresh ? '/api/ollama-models?refresh=1' : '/api/ollama-models');
  } catch (err) {
    models = { available: false, reason: err.message, models: [] };
  }
  onModelsFetched(models);
}

export function categoryNeedsManagedRuntimes(category, lastFetchedPayload) {
  return lastFetchedPayload.settings.some(
    (s) => s.category === category && s.dynamicOptions?.source === 'managed_onnx_runtimes'
  );
}

// Fetches GET /api/system/onnx-managed-runtimes — the DISPLAY-ONLY listing
// (see managed-runtime-listing.js's own header) for the ONNX_MANAGED_RUNTIME
// dropdown. Same shape/lifecycle contract as refreshOllamaModels() above:
// `onRuntimesFetched(listing)` lets the caller store the result into its
// own private lastManagedRuntimes state and re-render; this module holds
// no state of its own.
export async function refreshManagedRuntimes(onRuntimesFetched) {
  let listing;
  try {
    listing = await api('/api/system/onnx-managed-runtimes');
  } catch {
    listing = { runtimes: [] };
  }
  onRuntimesFetched(listing);
}

// ── collection-creation/reindex forms (jobs-view.js, settings-view.js) ─────
// The functions below back the ONNX embeddings/LLM summaries/tag-gen
// checkboxes on the two indexing forms — genuinely local-only (Ollama
// readiness) or local-model-specific (onnxEmbed/tagGen job options) code
// that must be physically absent from Lite's bundle, not merely
// dead-code-eliminated. Critically, EVERY '#opt-onnx'/'#opt-llm-summaries'/
// '#opt-tags'/'#idx-ollama-status' SELECTOR STRING lives only in this
// file's own querySelector() calls below — jobs-view.js/settings-view.js
// never reference those id strings at all (a real regression caught by
// this phase's own DCE test: an earlier version had jobs-view.js call
// $('#opt-onnx') itself just to feature-detect whether it exists, and that
// SELECTOR STRING LITERAL alone was enough to leak into the Lite JS bundle
// even though the code path calling it was gated — Rollup has no way to
// know a string constant is "local-only," only real import-graph
// reachability decides what ships). jobs-view.js/settings-view.js instead
// call these functions unconditionally through the capability seam
// (localCapabilities?.wireLocalIndexOptions(form) etc.) — each function
// does its OWN internal null-safe querySelector, so a Lite form (which
// genuinely lacks these elements) just finds nothing and no-ops, and Lite
// never imports this file at all so none of these strings ship there.
const OLLAMA_STATUS_BADGE = {
  available: 'badge badge-ok',
  missing: 'badge badge-fail',
  model_missing: 'badge badge-warn',
};

// Wires the ONNX embeddings/LLM summaries checkboxes' own behavior
// (LLM-summaries change -> Ollama readiness check) onto a real, already-
// rendered <form> element — called unconditionally by jobs-view.js's
// renderIndexingView() through the capability seam; a no-op if the
// elements aren't present (Lite's form structurally never has them, so
// this querySelector simply finds nothing).
export function wireIndexingFormLocalOptions(form, { esc, errorBox }) {
  const llmSummariesCheckbox = form.querySelector('#opt-llm-summaries');
  if (!llmSummariesCheckbox) return;
  llmSummariesCheckbox.addEventListener('change', (e) => {
    const box = form.querySelector('#idx-ollama-status');
    if (e.target.checked) loadOllamaStatus(box, { esc, errorBox });
    else if (box) box.style.display = 'none';
  });
}

// Ollama readiness check, reused by both the LLM-summaries checkbox
// listener above and jobs-view.js's own 503-retry handler (via
// retryOllamaStatus() below — jobs-view.js never calls this directly,
// since it never holds the '#idx-ollama-status' selector string itself).
async function loadOllamaStatus(box, { esc, errorBox }) {
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

// jobs-view.js's own 503 ("dependency unavailable") retry path — re-runs
// the Ollama readiness check inside the given form without jobs-view.js
// itself ever needing the '#idx-ollama-status' selector string.
export function retryOllamaStatus(form, { esc, errorBox }) {
  loadOllamaStatus(form.querySelector('#idx-ollama-status'), { esc, errorBox });
}

// Reads the ONNX embeddings/LLM summaries/tag-gen checkboxes (if present)
// into the job-options shape the indexing/reindex POST payload expects.
// Returns null when the form has none of these fields (Lite's forms) so
// the caller can fall back to its own prune-only shape without this
// module ever needing to know what that fallback shape is.
export function collectLocalJobOptions(form) {
  const onnxCheckbox = form.querySelector('#opt-onnx');
  if (!onnxCheckbox) return null;
  const llmSummaries = form.querySelector('#opt-llm-summaries');
  const tagGen = form.querySelector('#opt-tags');
  return {
    onnxEmbed: onnxCheckbox.checked,
    llmSummaries: llmSummaries ? llmSummaries.checked : false,
    tagGen: tagGen ? tagGen.checked : false,
  };
}
