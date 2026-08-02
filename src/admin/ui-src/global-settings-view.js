// ── global runtime settings (#/settings/:category) ──────────────────────────
// Phase 4A.5c: a real, category-based editor driven entirely by
// GET /api/settings, with PATCH support for writable fields. The registry
// (src/core/settings/definitions.js, via SettingsService) is the single
// source of truth for every setting's label/type/description/min/max/
// options/appliesAt/reindex-or-backfill impact — this file never hardcodes
// a second list of settings, defaults, validation rules, or enum options.
//
// "Runtime status" is one category among several (moved here verbatim from
// the old Phase 4A.5b read-only screen); every other category renders
// editable rows built purely from registry metadata.
//
// Local-only (ONNX/Ollama-specific) settings features — onnxProbePanel()/
// wireOnnxProbePanel()/categoryNeedsOllamaModels()/refreshOllamaModels()
// below — are NOT implemented in this file (Phase 6 of
// docs/design/full-lite-shared-architecture-audit-2026-08-01.md). Their
// real implementation lives in local-features.js, which THIS file never
// imports — only entries/full.js does, calling setLocalSettingsCapabilities()
// once at startup to inject it. Semidex Lite's entry point (entries/lite.js)
// never imports local-features.js and never calls that setter, so
// localCapabilities stays null there and this file's own capability-seam
// functions no-op — true physical bundle isolation (Lite's module graph
// never statically reaches local-features.js at all), not Rollup dead-code
// elimination of a build-time boolean branch. Shared, generic rendering
// infrastructure (fieldRow(), visibleWhen/dynamicOptions resolution,
// categoryNeedsGenerationModels()/refreshGenerationModels() — the
// provider-neutral counterpart both Ollama and Gemini use) is deliberately
// NEVER routed through this seam: it is not local-only code, and gating it
// would risk changing full-Semidex's own behavior for no reason.
import { $, cloneTemplate } from './dom.js';
import { api, apiPatch, apiPost } from './api.js';
import { showToast } from './toasts.js';
import { renderSettingsNav, syncSidebarMode, markActive } from './sidebar.js';
// Pure-data module only (zero deps: no fs/fetch/tokenizer) — safe to bundle
// into the browser. Never import qdrant-cloud-catalog.js itself here — it
// pulls in qdrant-cloud-tokenizer.js's Node-only fs/fetch code.
import { findDenseModel as findQdrantCloudDenseModel, isCatalogCompatibleWithChunking } from '../../core/embedding-profile/qdrant-cloud-models.js';

// null by default (Lite's real, shipped state — entries/lite.js never
// calls the setter below). entries/full.js calls
// setLocalSettingsCapabilities(localFeatures) once at startup, passing the
// whole local-features.js module namespace object (its exports match the
// shape every call site below expects: onnxProbePanel, wireOnnxProbePanel,
// categoryNeedsOllamaModels, refreshOllamaModels).
let localCapabilities = null;

export function setLocalSettingsCapabilities(capabilities) {
  localCapabilities = capabilities;
}

const PROVENANCE_LABEL = {
  os_env: 'Operating system environment',
  dotenv: '.env file',
  config_json: 'Local semidex setting',
  default: 'Semidex default',
};

function provenanceLabel(source) {
  return PROVENANCE_LABEL[source] ?? String(source ?? 'Unknown');
}

const APPLIES_AT_LABEL = {
  next_search: 'Applies to the next search',
  next_index_job: 'Applies to the next indexing job',
  new_collection: 'Applies to newly created collections',
  next_restart: 'Requires a restart to take effect',
  immediate: 'Applies immediately',
};

function appliesAtLabel(appliesAt) {
  return APPLIES_AT_LABEL[appliesAt] ?? '';
}

// ── Runtime Status category (moved verbatim from Phase 4A.5b) ───────────────

function templateRoot(id) {
  return cloneTemplate(id).firstElementChild;
}

function appendKeyValueRow(list, label, value) {
  const fragment = cloneTemplate('tpl-gs-kv-row');
  fragment.querySelector('dt').textContent = label;
  const valueElement = fragment.querySelector('dd');
  if (value?.nodeType) valueElement.append(value);
  else valueElement.textContent = String(value ?? '');
  list.append(fragment);
}

function statusBadge(text, ok) {
  const badge = templateRoot('tpl-gs-badge');
  badge.textContent = text;
  badge.classList.add(ok ? 'badge-ok' : 'badge-fail');
  return badge;
}

function statusPanel(id, title) {
  const panel = templateRoot('tpl-gs-status-panel');
  panel.id = id;
  panel.querySelector('.gs-status-title').textContent = title;
  return panel;
}

function renderProvenance(configuration, fields) {
  if (!configuration) return null;
  const details = templateRoot('tpl-gs-provenance');
  const list = details.querySelector('.kv');
  for (const [label, key] of fields) {
    const entry = configuration[key];
    if (entry) appendKeyValueRow(list, label, provenanceLabel(entry.source));
  }
  return list.children.length ? details : null;
}

function renderStoragePanel(health) {
  const ok = Boolean(health?.ok);
  const panel = statusPanel('gs-storage', 'Storage');
  const rows = panel.querySelector('.gs-status-rows');
  appendKeyValueRow(rows, 'status', statusBadge(ok ? 'Connected' : 'Unavailable', ok));
  const backend = health?.storage?.backend ?? 'storage';
  appendKeyValueRow(rows, 'backend', backend);
  if (!ok && health?.storage?.detail) {
    const message = panel.querySelector('.gs-status-message');
    message.hidden = false;
    message.querySelector('.gs-detail').textContent = health.storage.detail;
  }
  return panel;
}

function renderStorageError(err) {
  return renderStoragePanel({ ok: false, storage: { detail: err.message } });
}

function formatContextSize(numCtx) {
  if (typeof numCtx !== 'number' || !Number.isFinite(numCtx)) return '—';
  return `${numCtx.toLocaleString('en-US')} tokens`;
}

function renderGenerationPanel(status) {
  const ready = Boolean(status?.ready);
  const panel = statusPanel('gs-generation', 'Answer model');
  const rows = panel.querySelector('.gs-status-rows');
  appendKeyValueRow(rows, 'status', statusBadge(ready ? 'Ready' : 'Unavailable', ready));
  appendKeyValueRow(rows, 'provider', status?.backend ?? '—');
  appendKeyValueRow(rows, 'model', status?.model ?? '—');
  if (status?.configuration) {
    appendKeyValueRow(rows, 'context size', formatContextSize(status?.numCtx));
    appendKeyValueRow(rows, 'device', status?.devicePolicy?.value ?? '—');
  }

  if (!ready && status?.reason) {
    const message = panel.querySelector('.gs-status-message');
    message.hidden = false;
    message.querySelector('.gs-detail').textContent = status.reason;
    if (status?.configuration?.baseUrl?.display) {
      const endpoint = message.querySelector('.gs-detail-sub');
      endpoint.hidden = false;
      endpoint.textContent = `Configured endpoint: ${status.configuration.baseUrl.display}`;
    }
  }

  const provenance = renderProvenance(status?.configuration, [
    ['Provider', 'backend'],
    ['Model', 'model'],
    ['Endpoint', 'baseUrl'],
    ['Context size', 'numCtx'],
    ['Device policy', 'devicePolicy'],
  ]);
  if (provenance) panel.querySelector('.gs-provenance-mount').append(provenance);
  return panel;
}

function renderGenerationError(err) {
  return renderGenerationPanel({ ready: false, reason: err.message });
}

async function renderStatusCategory(container, myGeneration) {
  const storageLoading = statusPanel('gs-storage', 'Storage');
  storageLoading.querySelector('.panel-body').textContent = '…';
  const generationLoading = statusPanel('gs-generation', 'Answer model');
  generationLoading.querySelector('.panel-body').textContent = '…';
  container.replaceChildren(storageLoading, generationLoading);
  const [healthResult, generationResult] = await Promise.allSettled([
    api('/api/health'),
    api('/api/generation/status'),
  ]);
  if (myGeneration !== renderGeneration) return; // superseded by a newer navigation

  const storageHtml = healthResult.status === 'fulfilled'
    ? renderStoragePanel(healthResult.value) : renderStorageError(healthResult.reason);
  const generationHtml = generationResult.status === 'fulfilled'
    ? renderGenerationPanel(generationResult.value) : renderGenerationError(generationResult.reason);
  container.replaceChildren(storageHtml, generationHtml);
}

// ── Future provider placeholders (static, inert) ────────────────────────────

// The 'ai' category no longer gets a static placeholder (Stage B1) — it
// had claimed "Ollama · Cloud providers are planned", which became false
// the moment Gemini shipped as a real, selectable backend
// (SEMIDEX_GENERATION_BACKEND now offers both). Generation backend choice
// is fully expressed by the real writable controls in this category now,
// so no placeholder is needed there at all.
function providerPlaceholder(category) {
  if (category === 'storage') {
    const placeholder = templateRoot('tpl-gs-provider-placeholder');
    placeholder.querySelector('strong').textContent = 'Qdrant';
    placeholder.querySelector('.gs-field-desc').textContent = 'Additional vector databases are planned.';
    return placeholder;
  }
  return null;
}

// ── Editable category rendering ──────────────────────────────────────────────

// pendingByCategory/invalidByCategory are module-level, session-scoped state
// — NOT reset on every render. A user editing "Indexing", switching to "AI",
// and switching back must still see the unsaved edit and the Save/Cancel
// bar. Only that category's own Save or Cancel clears its entry. Navigating
// away from Settings entirely (in-app) does not clear this state either —
// see invalidateGlobalSettingsRender()/the beforeunload guard below.
const pendingByCategory = new Map(); // categoryId -> Map<key, value|null>
const invalidByCategory = new Map(); // categoryId -> Map<key, rawValue>
let lastFetchedPayload = null; // full GET /api/settings response

// Populated only when the resolved category actually contains a field with
// dynamicOptions (avoids fetching /api/ollama-models for categories that
// never need it, e.g. retrieval/system). null before the first fetch for a
// category that needs it; { available, reason, models } afterward — see
// core/ollama-models.js for the shape.
let lastOllamaModels = null;

// Same shape/lifecycle as lastOllamaModels, but for the provider-neutral
// GET /api/generation/models?backend=<...> endpoint (ASK_MODEL only,
// Stage B1). Tracks which backend it was fetched for (lastGenerationModelsBackend)
// so a stale Ollama-backend fetch is never rendered as if it were Gemini's
// list or vice versa — re-fetched whenever the STAGED
// SEMIDEX_GENERATION_BACKEND value changes, not just on category entry.
let lastGenerationModels = null;
let lastGenerationModelsBackend = null;

// Monotonic request token guarding against async races: fast category
// switching (or navigating away from Settings entirely while a fetch/save
// is in flight) must never let a stale response repaint over whatever is
// now on screen. Every await boundary in this module re-checks
// `myGeneration === renderGeneration` before touching the DOM.
let renderGeneration = 0;

export function invalidateGlobalSettingsRender() {
  renderGeneration += 1;
}

let beforeunloadRegistered = false;
function onBeforeUnload(e) {
  e.preventDefault();
  e.returnValue = '';
}
function syncBeforeUnloadGuard() {
  const anyPending = [...pendingByCategory.values()].some((m) => m.size > 0);
  const anyInvalid = [...invalidByCategory.values()].some((m) => m.size > 0);
  if ((anyPending || anyInvalid) && !beforeunloadRegistered) {
    window.addEventListener('beforeunload', onBeforeUnload);
    beforeunloadRegistered = true;
  } else if (!anyPending && beforeunloadRegistered) {
    window.removeEventListener('beforeunload', onBeforeUnload);
    beforeunloadRegistered = false;
  }
}

function categoryEntries(category) {
  return lastFetchedPayload.settings.filter((s) => s.category === category);
}

// isFieldVisible reads each driver's STAGED (currentPendingValue), not its
// last-fetched configuredValue — so switching TAG_PROVIDER/EMBEDDING_BACKEND/
// ONNX_EXECUTION_PROVIDER in an unsaved edit immediately updates dependent
// visibility before Save. Fails open (visible) for any condition whose
// driver isn't in this payload — never hides a field it can't evaluate a
// condition for.
//
// visibleWhen accepts EITHER a single { key, equals } condition (the
// original shape — every pre-existing field keeps working unchanged) OR an
// array of such conditions, AND-composed: ALL conditions must hold for the
// field to be visible. This is what lets e.g. ONNXRUNTIME_NODE_PATH be
// scoped to "BGE-M3 ONNX selected AND CUDA selected" declaratively, rather
// than hardcoding a field-name check here.
//
// uiHidden (DENSE_PROVIDER/SPARSE_PROVIDER only): unconditionally hidden
// from this view — they remain independently PATCHable via the raw API
// for power users/scripts (SettingsService.setMany() still cross-validates
// the resulting pair via assertProviderCombo(), see service.js), but the
// UI never renders them as controls, since EMBEDDING_BACKEND is now the
// one canonical selector and exposing the two underlying keys alongside
// it would let a user reconstruct an invalid combination through this UI.
function isFieldVisible(category, entry) {
  if (entry.uiHidden) return false;
  // hiddenWhen is the inverse of visibleWhen — a single { key, equals }
  // condition (no array/AND-composition support, unlike visibleWhen; add
  // that generalization only if a second real use case needs it) that
  // hides a field whose SETTING VALUE is still perfectly valid but has
  // become inert/inapplicable given another field's current staged value
  // (e.g. TOKEN_COUNT is a real, writable setting, but it is never
  // consulted once EMBEDDING_BACKEND=qdrant-cloud — see
  // core/token-count.js's resolveTokenCountMode()). Distinct from
  // visibleWhen: that mechanism scopes a field to WHEN it's relevant at
  // all (e.g. a Qdrant-Cloud-only field never shown for other backends);
  // this one scopes a field OUT for a specific driver value while staying
  // visible for every other value, which visibleWhen's single-equals
  // shape cannot express against a 3+ value enum without listing every
  // other value explicitly.
  if (entry.hiddenWhen) {
    const driver = lastFetchedPayload.settings.find((s) => s.key === entry.hiddenWhen.key);
    if (driver && currentPendingValue(category, driver) === entry.hiddenWhen.equals) return false;
  }
  if (!entry.visibleWhen) return true;
  const conditions = Array.isArray(entry.visibleWhen) ? entry.visibleWhen : [entry.visibleWhen];
  return conditions.every((condition) => {
    const driver = lastFetchedPayload.settings.find((s) => s.key === condition.key);
    if (!driver) return true;
    return currentPendingValue(category, driver) === condition.equals;
  });
}

function visibleKeySet(category) {
  return new Set(
    categoryEntries(category).filter((e) => isFieldVisible(category, e)).map((e) => e.key)
  );
}

// displayValue: unset fields (configuredValue undefined — no default, no
// override, e.g. QDRANT_URL) must never render the literal text
// "undefined". Booleans fall back to false, everything else to ''. This is
// purely a display default, not a staged edit.
function displayValue(entry) {
  if (entry.type === 'boolean') return entry.configuredValue ?? false;
  return entry.configuredValue ?? '';
}

function currentPendingValue(category, entry) {
  const invalid = invalidByCategory.get(category);
  if (invalid?.has(entry.key)) return invalid.get(entry.key);
  const pending = pendingByCategory.get(category);
  if (pending && pending.has(entry.key)) {
    const value = pending.get(entry.key);
    if (value !== null) return value;

    // `null` deletes the local override; it is not an input value. Preview
    // whichever value will win after deletion.
    if (entry.configuredSource === 'os_env' || entry.configuredSource === 'dotenv') {
      return displayValue(entry);
    }
    if (entry.type === 'boolean') return entry.default ?? false;
    return entry.default ?? '';
  }
  return displayValue(entry);
}

function markInvalid(category, key, invalid, rawValue) {
  let values = invalidByCategory.get(category);
  if (!values) { values = new Map(); invalidByCategory.set(category, values); }
  if (invalid) values.set(key, rawValue); else values.delete(key);
  syncBeforeUnloadGuard();
}

function stagePending(category, key, value, entry) {
  let pending = pendingByCategory.get(category);
  if (!pending) { pending = new Map(); pendingByCategory.set(category, pending); }
  // Deletes the key (rather than storing a no-op change) if the new value
  // matches the last-fetched configuredValue exactly — keeps "unchanged
  // fields never sent" true even after an edit-then-revert round trip.
  if (value === (entry.configuredValue ?? (entry.type === 'boolean' ? false : ''))) {
    pending.delete(key);
  } else {
    pending.set(key, value);
  }
  syncBeforeUnloadGuard();
}

function requiredOllamaCapability(capability) {
  return capability === 'generation' ? 'completion' : capability;
}

// Gemini's models.list() reports supportedActions as Pascal-case action
// names (e.g. 'generateContent'), not Ollama's lowercase capability
// vocabulary — this maps semidex's own capability id ('generation') to
// each backend's real field name/value, never guessing from a model name.
function requiredCapability(backend, capability) {
  if (backend === 'gemini') return capability === 'generation' ? 'generateContent' : capability;
  return requiredOllamaCapability(capability);
}

function modelSupportsCapability(model, capability, backend = 'ollama') {
  return Array.isArray(model?.capabilities)
    && model.capabilities.includes(requiredCapability(backend, capability));
}

// The STAGED SEMIDEX_GENERATION_BACKEND value, wherever it lives (the "ai"
// category, always — generation settings are not split across categories).
// Falls back to the last-fetched configuredValue when the field isn't
// staged/edited, and to 'ollama' if the field is entirely absent from this
// payload (should not happen in production, but keeps this helper total).
function currentGenerationBackend() {
  const entry = lastFetchedPayload?.settings.find((s) => s.key === 'SEMIDEX_GENERATION_BACKEND');
  if (!entry) return 'ollama';
  return currentPendingValue(entry.category, entry);
}

function selectedOllamaModel(category, modelKey) {
  const modelEntry = lastFetchedPayload.settings.find((entry) => entry.key === modelKey);
  if (!modelEntry) return null;
  const modelName = currentPendingValue(category, modelEntry);
  return lastOllamaModels?.models?.find((model) => model.name === modelName) ?? null;
}

function selectOption(value, label, { selected = false, disabled = false } = {}) {
  const option = templateRoot('tpl-gs-option');
  option.setAttribute('value', value);
  option.textContent = label;
  option.toggleAttribute('selected', selected);
  option.toggleAttribute('disabled', disabled);
  return option;
}

// Builds a <select> for a dynamicOptions-backed string field. Never empty:
// configured-but-not-installed values are preserved; unreachable or empty
// discovery states get an explicit disabled option. Generic over the
// discovery source (Ollama's 'ollama_models' or the provider-neutral
// 'generation_models') — the caller supplies the resolved model list,
// backend id, and unreachable-state copy, so this function contains no
// backend-specific branching itself.
function dynamicOptionsControl(entry, value, disabled, { discovery, backend, unavailableLabel, unavailableReason }) {
  const capability = entry.dynamicOptions.capability;
  const select = templateRoot('tpl-gs-control-select');
  select.dataset.key = entry.key;
  const extras = [];

  if (!discovery || !discovery.available) {
    if (value) select.append(selectOption(value, value, { selected: true }));
    select.append(selectOption('', unavailableLabel, { selected: !value, disabled: true }));
    select.disabled = true;
    const note = templateRoot('tpl-gs-control-note');
    note.textContent = discovery?.reason ?? unavailableReason;
    extras.push(note);
    return { control: select, extras };
  }

  const confirmed = discovery.models.filter((model) => modelSupportsCapability(model, capability, backend));
  const unverified = discovery.models.filter((model) => model.capabilities === null);
  const installedNames = new Set([...confirmed, ...unverified].map((m) => m.name));
  if (value && !installedNames.has(value)) {
    select.append(selectOption(value, `${value} (not installed)`, { selected: true }));
  }
  for (const model of confirmed) {
    select.append(selectOption(model.name, model.name, { selected: model.name === value }));
  }
  for (const model of unverified) {
    // Shown informationally (never silently hidden), but never selectable
    // as a NEW choice — an unverified capability is not a confirmed
    // generateContent-capable model, and offering it as an equal-weight
    // option next to confirmed models risks the user picking one that
    // then fails at actual generation time (code review finding). The
    // one exception: if this unverified model is the value ALREADY
    // configured, it stays selected and enabled so an unrelated Save
    // (one that doesn't touch this field) doesn't get blocked by a
    // pre-existing configuration this control had no part in choosing.
    const isCurrentValue = model.name === value;
    select.append(selectOption(
      model.name,
      `${model.name} (capability unverified)`,
      { selected: isCurrentValue, disabled: !isCurrentValue }
    ));
  }
  if (!select.querySelectorAll('option').length) {
    select.append(selectOption('', 'No installed models found', { selected: true, disabled: true }));
  }
  select.disabled = disabled;

  const installedElsewhere = value && !installedNames.has(value)
    && discovery.models.some((m) => m.name === value);
  if (installedElsewhere) {
    const note = templateRoot('tpl-gs-control-note');
    note.textContent = 'Configured but inactive: this model may not support the required capability.';
    extras.push(note);
  }
  return { control: select, extras };
}

function fieldControl(category, entry) {
  const value = currentPendingValue(category, entry);
  const disabled = entry.configuredSource === 'os_env' || entry.configuredSource === 'dotenv';
  let control;
  if (entry.type === 'boolean') {
    control = templateRoot('tpl-gs-control-checkbox');
    control.checked = Boolean(value);
  } else if (entry.type === 'enum') {
    control = templateRoot('tpl-gs-control-select');
    const configuredOptionExists = (entry.options ?? []).some((option) => option.value === value);
    if (value !== '' && !configuredOptionExists) {
      control.append(selectOption(value, `${value} (invalid configuration)`, { selected: true }));
    }
    for (const option of entry.options ?? []) {
      control.append(selectOption(option.value, option.label, { selected: option.value === value }));
    }
  } else if (entry.dynamicOptions?.source === 'ollama_models') {
    return dynamicOptionsControl(entry, value, disabled, {
      discovery: lastOllamaModels,
      backend: 'ollama',
      unavailableLabel: 'Ollama unreachable — models unknown',
      unavailableReason: 'Ollama models are unknown.',
    });
  } else if (entry.dynamicOptions?.source === 'generation_models') {
    const backend = currentGenerationBackend();
    return dynamicOptionsControl(entry, value, disabled, {
      discovery: lastGenerationModelsBackend === backend ? lastGenerationModels : null,
      backend,
      unavailableLabel: backend === 'gemini' ? 'Gemini unavailable — models unknown' : 'Ollama unreachable — models unknown',
      unavailableReason: backend === 'gemini' ? 'Gemini models are unknown.' : 'Ollama models are unknown.',
    });
  } else if (entry.pathPicker) {
    // A filesystem-path field with a Browse button wired to the existing
    // POST /api/system/pick-folder endpoint (see wireCategoryEvents()'s
    // browse-button handler below) — the text input itself is always the
    // real .gs-field-control (same generic event wiring every other text
    // field uses), so Browse is purely an assist, never the only way to
    // set the value: if the picker is unavailable (non-Windows, no
    // powershell.exe, timed out), the input remains fully usable.
    const wrapper = templateRoot('tpl-gs-control-path');
    const input = wrapper.querySelector('.gs-path-input');
    input.value = value;
    input.dataset.key = entry.key;
    input.disabled = disabled;
    wrapper.querySelector('.gs-path-browse').disabled = disabled;
    return { control: wrapper, extras: [] };
  } else {
    control = templateRoot('tpl-gs-control-input');
    control.type = entry.type === 'number' ? 'number' : 'text';
    control.value = value;
    if (entry.min !== undefined) control.setAttribute('min', String(entry.min));
    if (entry.max !== undefined) control.setAttribute('max', String(entry.max));
  }
  control.dataset.key = entry.key;
  control.disabled = disabled;
  return { control, extras: [] };
}

function readonlyField(entry, value, { source = '', warning = '' } = {}) {
  const row = templateRoot('tpl-gs-field-readonly');
  row.dataset.field = entry.key;
  row.querySelector('.gs-field-label').textContent = entry.label;
  row.querySelector('.gs-field-value').textContent = String(value ?? '');
  row.querySelector('.gs-field-desc').textContent = entry.description ?? '';
  if (source) {
    const sourceElement = row.querySelector('.gs-field-source');
    sourceElement.hidden = false;
    sourceElement.textContent = source;
  }
  if (warning) {
    const warningElement = row.querySelector('.gs-field-pending-restart');
    warningElement.hidden = false;
    warningElement.textContent = warning;
  }
  return row;
}

function fieldRow(category, entry) {
  if (entry.secret) {
    const row = templateRoot('tpl-gs-field-secret');
    row.dataset.field = entry.key;
    row.querySelector('.gs-field-label').textContent = entry.label;
    row.querySelector('.gs-field-desc').textContent = entry.description ?? '';
    const badge = row.querySelector('.gs-secret-status');
    badge.textContent = entry.configured ? 'Configured' : 'Not configured';
    badge.classList.add(entry.configured ? 'badge-ok' : 'badge-fail');
    return row;
  }

  if (entry.derivedWhen) {
    const driver = lastFetchedPayload.settings.find((s) => s.key === entry.derivedWhen.key);
    const driverMatches = driver && currentPendingValue(category, driver) === entry.derivedWhen.equals;
    if (driverMatches) return readonlyField(entry, entry.derivedWhen.value);
  }

  if (entry.dynamicDerived) {
    const driver = lastFetchedPayload.settings.find((item) => item.key === entry.dynamicDerived.key);
    const driverMatches = driver
      && currentPendingValue(category, driver) === entry.dynamicDerived.equals;
    if (driverMatches) {
      const model = selectedOllamaModel(category, entry.dynamicDerived.modelKey);
      const value = model?.[entry.dynamicDerived.property];
      const known = Number.isInteger(value) && value > 0;
      return readonlyField(entry, known ? value : 'Unknown', {
        warning: known
          ? ''
          : 'The selected model does not expose a verified embedding dimension. Semidex will not create a collection until it can detect the real vector size.',
      });
    }
  }

  // catalogDerived: a property looked up from the STATIC Qdrant Cloud
  // model catalog by the staged model key — never probed live, since every
  // property here (dimensions, contextWindow, costTier, the model id
  // itself...) is fixed per model ID (no network call needed). Same
  // rendering path as dynamicDerived above, different data source. The
  // server sends only the JSON-safe {key, equals, modelKey, property?}
  // quad (a real `lookup` function cannot survive JSON serialization) —
  // findQdrantCloudDenseModel is resolved against this file's own bundled
  // qdrant-cloud-models.js copy. `property` defaults to 'dimensions' for
  // backward compatibility with VECTOR_SIZE's original single-purpose
  // entry; any other catalog field name (e.g. 'contextWindow', 'id' for a
  // tokenizer-identity row) works identically.
  if (entry.catalogDerived) {
    const driver = lastFetchedPayload.settings.find((item) => item.key === entry.catalogDerived.key);
    const driverMatches = driver
      && currentPendingValue(category, driver) === entry.catalogDerived.equals;
    if (driverMatches) {
      const modelEntry = lastFetchedPayload.settings.find((item) => item.key === entry.catalogDerived.modelKey);
      const modelId = modelEntry ? currentPendingValue(category, modelEntry) : null;
      const property = entry.catalogDerived.property ?? 'dimensions';
      const value = modelId ? findQdrantCloudDenseModel(modelId)?.[property] ?? null : null;
      // Numeric properties (dimensions, contextWindow) are "known" only
      // when a positive integer; any other property (e.g. the model id
      // itself, a string label) is "known" whenever it's a non-empty
      // value — a numeric-only check would wrongly report a real string
      // value like a model id as "Unknown".
      const known = typeof value === 'number' ? (Number.isInteger(value) && value > 0) : (value != null && value !== '');
      return readonlyField(entry, known ? value : 'Unknown', {
        warning: known ? '' : (entry.catalogDerived.unknownWarning ?? 'Select a dense model to detect this value.'),
      });
    }
  }

  if (!entry.writable) {
    return readonlyField(entry, entry.configuredValue, { source: entry.readOnlyReason ?? '' });
  }

  const row = templateRoot('tpl-gs-field');
  row.dataset.field = entry.key;
  row.querySelector('.gs-field-label').textContent = entry.label;
  row.querySelector('.gs-field-desc').textContent = entry.description ?? '';
  const { control, extras } = fieldControl(category, entry);
  row.querySelector('.gs-field-control-mount').append(control, ...extras);

  const disabled = entry.configuredSource === 'os_env' || entry.configuredSource === 'dotenv';
  row.querySelector('.gs-field-lock').hidden = !disabled;
  row.querySelector('.gs-field-source-text').textContent = disabled
    ? `Set by ${provenanceLabel(entry.configuredSource)}; semidex cannot change this.`
    : provenanceLabel(entry.configuredSource);
  const resetButton = row.querySelector('.gs-field-reset');
  resetButton.hidden = !entry.hasLocalOverride;
  if (entry.hasLocalOverride) {
    resetButton.dataset.key = entry.key;
    resetButton.title = `This clears your saved override and falls back to ${provenanceLabel(entry.activeSource)}.`;
  }
  const messages = [
    ['pending-restart', entry.pendingRestart
      ? `Saved — still using the previous value (${entry.activeValue}) until semidex restarts.`
      : ''],
    ['shadowed', entry.shadowedBy
      ? `Currently overridden by the legacy "Dense model" setting (${entry.shadowedBy.value}, set via ${provenanceLabel(entry.shadowedBy.source)}) — set a value here to take precedence.`
      : ''],
    ['invalid-configuration', entry.invalidConfiguration ?? ''],
  ];
  for (const [name, text] of messages) {
    const element = row.querySelector(`[data-message="${name}"]`);
    element.hidden = !text;
    element.textContent = text;
  }
  const impactParts = [appliesAtLabel(entry.appliesAt)];
  if (entry.requiresReindex) impactParts.push('Requires reindex');
  if (entry.requiresBackfill) impactParts.push('Requires backfill');
  row.querySelector('.gs-field-impact').textContent = impactParts.filter(Boolean).join(' · ');
  return row;
}

function saveBar(category) {
  const pending = pendingByCategory.get(category);
  const invalid = invalidByCategory.get(category);
  const dirty = Boolean(pending?.size || invalid?.size);
  if (!dirty) return null;
  const hasInvalid = Boolean(invalid?.size);
  const bar = templateRoot('tpl-gs-save-bar');
  bar.querySelector('.gs-save-invalid').hidden = !hasInvalid;
  bar.querySelector('#gs-save').disabled = hasInvalid;
  return bar;
}

// Full-only — real implementation in local-features.js, injected via
// setLocalSettingsCapabilities() (see this file's own header comment).
// null in Lite (no-op) since entries/lite.js never calls that setter.
function onnxProbePanel(category, entries) {
  if (!localCapabilities) return null;
  return localCapabilities.onnxProbePanel(category, entries, { templateRoot, currentPendingValue });
}

function wireOnnxProbePanel(container, category) {
  if (!localCapabilities) return;
  localCapabilities.wireOnnxProbePanel(container, category);
}

// Label/CSS-class lookup for the settings-time 4-status availability
// classification (admin/system/qdrant-cloud.js's classifyInferenceProbeError()
// — available/unavailable_for_cluster/unsupported_by_semidex/unverified).
// Mirrors collection-view.js's own availabilityChip() lookup-object
// pattern, applied to a DIFFERENT status vocabulary: that one describes an
// EXISTING collection's resolved-profile search availability
// (core/embedding-profile/availability.js's COLLECTION_STATUS); this one
// describes a CANDIDATE model's settings-time probe outcome, before any
// collection exists — deliberately two separate lookups, not a shared
// one, since the status vocabularies themselves are unrelated.
const QC_AVAILABILITY_BADGE = {
  available: { label: 'Available', cls: 'badge-ok' },
  unavailable_for_cluster: { label: 'Unavailable for this cluster', cls: 'badge-warn' },
  unsupported_by_semidex: { label: 'Unsupported', cls: 'badge-fail' },
  unverified: { label: 'Unverified', cls: 'badge-warn' },
};

function renderAvailabilityBadge(badgeEl, availability) {
  const entry = QC_AVAILABILITY_BADGE[availability?.status];
  badgeEl.classList.remove('badge-ok', 'badge-warn', 'badge-fail');
  if (!entry) {
    badgeEl.textContent = 'Not yet tested';
    return;
  }
  badgeEl.textContent = entry.label;
  badgeEl.classList.add(entry.cls);
}

// Shown only alongside a visible EMBEDDING_BACKEND field currently staged
// to 'qdrant-cloud' — this is the ONLY code path that ever calls Tier 2
// (probeQdrantCloudInference()); routine Settings rendering and collection
// browsing both stay on Tier 1 (INFERENCE_UNVERIFIED) until this button is
// explicitly clicked. "Last verified" starts empty and is populated only
// by a real click — never auto-run, never inferred from the setting alone
// (same discipline as onnxProbePanel()/runOnnxProbe() above).
function qdrantCloudProbePanel(category, entries) {
  const backendEntry = entries.find((e) => e.key === 'EMBEDDING_BACKEND');
  if (!backendEntry) return null;
  if (currentPendingValue(category, backendEntry) !== 'qdrant-cloud') return null;

  const denseModelEntry = entries.find((e) => e.key === 'QDRANT_CLOUD_DENSE_MODEL');
  const denseModel = denseModelEntry ? currentPendingValue(category, denseModelEntry) : null;

  const panel = templateRoot('tpl-gs-qdrant-cloud-probe-panel');
  panel.querySelector('.gs-qc-dense-model').textContent = denseModel ?? 'Unknown';
  const testButton = panel.querySelector('.gs-qc-test-button');
  testButton.dataset.denseModel = denseModel ?? '';
  return panel;
}

function wireQdrantCloudProbePanel(container, category) {
  const btn = container.querySelector('.gs-qc-test-button');
  if (!btn) return;
  btn.addEventListener('click', () => runQdrantCloudProbe(container, btn));
}

async function runQdrantCloudProbe(container, btn) {
  const panel = btn.closest('.gs-qdrant-cloud-probe-panel');
  const verified = panel.querySelector('.gs-qc-verified');
  const badge = panel.querySelector('.gs-qc-availability-badge');
  const resultBlock = panel.querySelector('.gs-qc-result');
  const denseModel = btn.dataset.denseModel;

  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Testing…';
  resultBlock.hidden = true;

  try {
    const result = await apiPost('/api/system/qdrant-cloud-probe', { denseModel });
    const timestamp = new Date().toLocaleTimeString();
    verified.textContent = `${result.status} (${timestamp})`;
    // availability (added alongside the original status/message fields —
    // see admin/api/qdrant-cloud.js's own comment) is what drives the
    // badge; the original status/message pair still drives the existing
    // verified-timestamp line and message text unchanged.
    renderAvailabilityBadge(badge, result.availability);
    resultBlock.hidden = false;
    panel.querySelector('.gs-qc-message').textContent = result.message ?? (
      result.status === 'inference_available'
        ? 'Cloud Inference is working for this model.'
        : ''
    );
  } catch (err) {
    verified.textContent = 'Test failed';
    renderAvailabilityBadge(badge, null);
    resultBlock.hidden = false;
    panel.querySelector('.gs-qc-message').textContent = err?.message ?? 'The probe request failed.';
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

function renderEditableCategory(container, category) {
  const entries = categoryEntries(category).filter((e) => isFieldVisible(category, e));
  const primary = entries.filter((e) => !e.advanced);
  const advanced = entries.filter((e) => e.advanced);

  const content = document.createDocumentFragment();
  const needsOllamaModels = categoryNeedsOllamaModels(category);
  const needsGenerationModels = categoryNeedsGenerationModels(category);
  if (needsOllamaModels || needsGenerationModels) content.append(templateRoot('tpl-gs-refresh-models'));
  const placeholder = providerPlaceholder(category);
  if (placeholder) content.append(placeholder);
  for (const entry of primary) content.append(fieldRow(category, entry));
  if (advanced.length) {
    const advancedBlock = templateRoot('tpl-gs-advanced');
    const advancedFields = advancedBlock.querySelector('.gs-advanced-fields');
    for (const entry of advanced) advancedFields.append(fieldRow(category, entry));
    content.append(advancedBlock);
  }
  const probePanel = onnxProbePanel(category, entries);
  if (probePanel) content.append(probePanel);
  const qdrantCloudPanel = qdrantCloudProbePanel(category, entries);
  if (qdrantCloudPanel) content.append(qdrantCloudPanel);
  const currentSaveBar = saveBar(category);
  if (currentSaveBar) content.append(currentSaveBar);
  container.replaceChildren(content);
  wireCategoryEvents(container, category);
  wireOnnxProbePanel(container, category);
  wireQdrantCloudProbePanel(container, category);

  const refreshBtn = container.querySelector('#gs-refresh-models');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      const main = container.closest('#main');
      if (!main) return;
      // needsOllamaModels/needsGenerationModels are mutually exclusive in
      // practice today (no category mixes both discovery sources), but the
      // button always refreshes whichever one this category actually
      // needs rather than assuming Ollama.
      if (needsGenerationModels) refreshGenerationModels(main, category, renderGeneration, { forceRefresh: true });
      else refreshOllamaModels(main, category, renderGeneration, { forceRefresh: true });
    });
  }
}

function syncSaveBar(container, category) {
  container.querySelector('.gs-save-bar')?.remove();
  const bar = saveBar(category);
  if (!bar) return;
  container.append(bar);
  wireSaveBarEvents(container, category);
}

function wireCategoryEvents(container, category) {
  for (const el of container.querySelectorAll('.gs-field-control')) {
    const key = el.dataset.key;
    const entry = lastFetchedPayload.settings.find((s) => s.key === key);
    // A dynamicOptions string field renders as a <select> (see
    // dynamicOptionsControl) — its value is always one of the
    // rendered options (a structural guarantee, same reasoning as a plain
    // enum <select>), so it follows the enum branch below, not the
    // free-text string branch's allowEmpty validation.
    const isDynamicSelect = entry.type === 'string'
      && (entry.dynamicOptions?.source === 'ollama_models' || entry.dynamicOptions?.source === 'generation_models');
    const handler = () => {
      const beforeVisible = visibleKeySet(category);
      if (entry.type === 'boolean') {
        stagePending(category, key, el.checked, entry);
        markInvalid(category, key, false);
      } else if (entry.type === 'enum' || isDynamicSelect) {
        stagePending(category, key, el.value, entry);
        if (key === 'EMBED_MODEL') {
          const selected = lastOllamaModels?.models?.find((model) => model.name === el.value);
          markInvalid(
            category,
            key,
            !Number.isInteger(selected?.embeddingDimension) || selected.embeddingDimension <= 0,
            el.value
          );
        } else if (key === 'QDRANT_CLOUD_DENSE_MODEL') {
          // Coarse, settings-time-only compatibility warning
          // (isCatalogCompatibleWithChunking() — Part B's Tier 1 check): a
          // model whose contextWindow is smaller than the staged
          // MAX_CHUNK_TOKENS alone (the most optimistic possible case,
          // ignoring heading-path/skeleton-summary context) is blocked
          // from Save here. This is advisory/early — it cannot and does
          // not guarantee every future chunk's assembled embed text will
          // fit; the real, exact, embed-time gate is
          // checkEmbedInputFits(), which can still reject an individual
          // over-long input even for a model marked compatible here.
          const model = findQdrantCloudDenseModel(el.value);
          const maxChunkTokensEntry = lastFetchedPayload.settings.find((s) => s.key === 'MAX_CHUNK_TOKENS');
          const maxChunkTokens = maxChunkTokensEntry ? Number(currentPendingValue('indexing', maxChunkTokensEntry)) : 512;
          const compatible = model ? isCatalogCompatibleWithChunking(model, { maxChunkTokens }) : false;
          markInvalid(category, key, !compatible, el.value);
        } else if (key === 'SEMIDEX_GENERATION_BACKEND') {
          // Switching backends invalidates ASK_MODEL's current value
          // outright — an Ollama model name is never a valid Gemini model
          // and vice versa, so this is marked invalid immediately (Save
          // stays blocked) rather than waiting for the async model-list
          // refetch below to resolve and discover the mismatch itself.
          // The user must explicitly choose a real model for the new
          // backend before Save re-enables — silently carrying the old
          // value forward is exactly what this task forbids.
          const askModelEntry = lastFetchedPayload.settings.find((s) => s.key === 'ASK_MODEL');
          if (askModelEntry) {
            const askModelValue = currentPendingValue(category, askModelEntry);
            markInvalid(category, 'ASK_MODEL', true, askModelValue);
          }
          markInvalid(category, key, false);
        } else {
          markInvalid(category, key, false);
        }
      } else if (entry.type === 'number') {
        const raw = el.value;
        // Validated directly against the registry's own min/max — not
        // el.checkValidity(), which real browsers support but is not a
        // dependency this view can rely on (and which would only ever
        // re-derive bounds this file already has from the API response).
        const value = raw === '' ? NaN : Number(raw);
        const outOfRange = entry.min !== undefined && value < entry.min
          || entry.max !== undefined && value > entry.max;
        if (raw === '' || !Number.isFinite(value) || outOfRange) {
          markInvalid(category, key, true, raw);
        } else {
          markInvalid(category, key, false);
          stagePending(category, key, value, entry);
        }
      } else {
        // string
        const raw = el.value;
        if (raw === '' && entry.allowEmpty === false) {
          markInvalid(category, key, true, raw);
        } else {
          markInvalid(category, key, false);
          stagePending(category, key, raw, entry);
        }
      }
      el.toggleAttribute('aria-invalid', Boolean(invalidByCategory.get(category)?.has(key)));

      // Only a full rebuild (which re-wires everything, including the
      // control just changed, from the now-current pendingByCategory
      // state) if this change actually altered which fields are visible —
      // never for an ordinary field, so a keystroke in a non-driving text
      // field still only repaints the save bar (established Phase 4A.5c
      // constraint: input events must not rebuild/replace the field being
      // edited).
      const drivesDynamicDerived = categoryEntries(category).some(
        (candidate) => candidate.dynamicDerived?.modelKey === key
      );
      // SEMIDEX_GENERATION_BACKEND always forces a rebuild + generation-model
      // re-fetch on its own — never conditioned on whether OLLAMA_URL/
      // GENERATION_DEVICE/GEMINI_API_KEY's visibility actually flipped in
      // THIS payload (a category missing one of those fields, e.g. in a
      // narrow test fixture, must not silently skip the re-fetch that a
      // full production payload would trigger only as a side effect of its
      // own visibleWhen diff).
      const isBackendSwitch = key === 'SEMIDEX_GENERATION_BACKEND';
      if (drivesDynamicDerived
        || isBackendSwitch
        || visibleKeySet(category).size !== beforeVisible.size
        || ![...visibleKeySet(category)].every((k) => beforeVisible.has(k))) {
        renderEditableCategory(container, category);
        // The backend changed — lastGenerationModels/lastGenerationModelsBackend
        // are now stale (they belong to the PREVIOUS backend, if fetched at
        // all). Re-fetch for the new backend so ASK_MODEL's <select>
        // eventually reflects real options instead of staying on the
        // "unavailable" fallback until the user happens to trigger another
        // re-render some other way.
        if (isBackendSwitch) {
          const main = container.closest('#main');
          if (main) refreshGenerationModels(main, category, renderGeneration);
        }
      } else {
        syncSaveBar(container, category);
      }
    };
    el.addEventListener('change', handler);
    if (entry.type === 'string' && !isDynamicSelect || entry.type === 'number') {
      el.addEventListener('input', handler);
    }
  }

  for (const btn of container.querySelectorAll('.gs-field-reset')) {
    if (btn.hidden) continue;
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      const entry = lastFetchedPayload.settings.find((s) => s.key === key);
      let pending = pendingByCategory.get(category);
      if (!pending) { pending = new Map(); pendingByCategory.set(category, pending); }
      pending.set(key, null);
      markInvalid(category, key, false);
      syncBeforeUnloadGuard();
      renderEditableCategory(container, category);
    });
  }

  for (const btn of container.querySelectorAll('.gs-path-browse')) {
    if (btn.disabled) continue;
    btn.addEventListener('click', () => wirePathBrowseClick(btn));
  }

  wireSaveBarEvents(container, category);
}

async function wirePathBrowseClick(btn) {
  const wrapper = btn.closest('.gs-path-control');
  const input = wrapper.querySelector('.gs-path-input');
  const fallback = wrapper.querySelector('.gs-path-fallback');
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Choosing…';
  try {
    const { path, cancelled } = await apiPost('/api/system/pick-folder', {});
    if (!cancelled && path) {
      input.value = path;
      fallback.hidden = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } catch {
    // Picker unavailable (non-Windows, powershell.exe missing, timed out,
    // etc.) — fall back to manual entry instead of leaving the user stuck
    // with a broken button and no way to proceed.
    fallback.hidden = false;
    input.focus();
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

function wireSaveBarEvents(container, category) {
  const saveBtn = container.querySelector('#gs-save');
  if (saveBtn) saveBtn.addEventListener('click', () => onSave(container, category));

  const cancelBtn = container.querySelector('#gs-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    pendingByCategory.delete(category);
    invalidByCategory.delete(category);
    syncBeforeUnloadGuard();
    renderEditableCategory(container, category);
  });
}

const ERROR_MESSAGES = {
  setting_overridden: 'That value changed outside semidex — reload this category and try again.',
  not_writable: "Couldn't save — please reload.",
  unknown_key: "Couldn't save — please reload.",
};

async function onSave(container, category) {
  const myGeneration = renderGeneration;
  const pending = pendingByCategory.get(category);
  if (!pending || pending.size === 0) return;
  const submitted = new Map(pending);
  const saveBtn = container.querySelector('#gs-save');
  const cancelBtn = container.querySelector('#gs-cancel');
  if (saveBtn) saveBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;
  for (const control of container.querySelectorAll('.gs-field-control, .gs-field-reset')) {
    control.disabled = true;
  }

  const changedKeys = [...submitted.keys()];
  try {
    const patchResult = await apiPatch('/api/settings', { changes: Object.fromEntries(submitted) });

    // PATCH returns complete entries for the changed keys. Merge them into
    // the cache before the follow-up GET so the UI still has an honest
    // post-save state if that refresh request alone fails.
    if (lastFetchedPayload && Array.isArray(patchResult?.settings)) {
      const updated = new Map(patchResult.settings.map((entry) => [entry.key, entry]));
      lastFetchedPayload = {
        ...lastFetchedPayload,
        settings: lastFetchedPayload.settings.map((entry) => updated.get(entry.key) ?? entry),
      };
    }

    // PATCH success is authoritative. Clear dirty state immediately: a
    // subsequent refresh failure must not make a persisted change look
    // unsaved and invite the user to submit it again.
    const currentPending = pendingByCategory.get(category);
    for (const [key, value] of submitted) {
      if (currentPending?.has(key) && Object.is(currentPending.get(key), value)) {
        currentPending.delete(key);
      }
    }
    if (currentPending?.size === 0) pendingByCategory.delete(category);
    syncBeforeUnloadGuard();

    let freshPayload = lastFetchedPayload;
    let refreshFailed = false;
    try {
      freshPayload = await api('/api/settings');
      lastFetchedPayload = freshPayload;
    } catch {
      refreshFailed = true;
    }

    if (myGeneration !== renderGeneration) return; // a newer render/navigation has since taken over

    const changedEntries = freshPayload.settings.filter((s) => changedKeys.includes(s.key));
    const impactParts = new Set();
    for (const e of changedEntries) {
      const label = appliesAtLabel(e.appliesAt);
      if (label) impactParts.add(label);
      if (e.requiresReindex) impactParts.add('existing collections require reindexing');
      if (e.requiresBackfill) impactParts.add('existing collections require a tag backfill');
    }
    const impactText = [...impactParts].join('; ');
    if (refreshFailed) {
      showToast('Saved, but the refreshed settings could not be loaded. Reopen this category to refresh it.', { variant: 'warn' });
    } else {
      showToast(`Saved ${changedKeys.length} setting${changedKeys.length === 1 ? '' : 's'}${impactText ? ` — ${impactText}.` : '.'}`, { variant: 'success' });
    }

    renderEditableCategory(container, category);
  } catch (err) {
    if (myGeneration !== renderGeneration) return;
    const message = ERROR_MESSAGES[err.code] ?? err.message;
    showToast(message, { variant: 'error' });
    renderEditableCategory(container, category);
  }
}

// ── Inline narrow-width category selector ───────────────────────────────────

function renderInlineCategorySelect(main, categories, category) {
  const mount = main.querySelector('#gs-inline-category-mount');
  if (!mount) return;
  const select = templateRoot('tpl-gs-inline-category');
  for (const item of categories) {
    select.append(selectOption(item.id, item.label, { selected: item.id === category }));
  }
  mount.replaceChildren(select);
  select.addEventListener('change', (e) => {
    location.hash = `#/settings/${encodeURIComponent(e.target.value)}`;
  });
}

// ── Ollama model discovery (dynamicOptions) ─────────────────────────────────

// Full-only — real implementation in local-features.js. null in Lite (see
// this file's own header comment on the capability seam).
function categoryNeedsOllamaModels(category) {
  if (!localCapabilities) return false;
  return localCapabilities.categoryNeedsOllamaModels(category, lastFetchedPayload);
}

function categoryNeedsGenerationModels(category) {
  return lastFetchedPayload.settings.some(
    (s) => s.category === category && s.dynamicOptions?.source === 'generation_models'
  );
}

// Fetches /api/ollama-models fresh and re-renders — reused directly by
// both the initial category render (below) and the "Refresh models"
// button, so there is exactly one fetch/render path for this data, never
// two drifting implementations. Full-only — real implementation in
// local-features.js; null in Lite (see this file's own header comment).
async function refreshOllamaModels(main, category, myGeneration, { forceRefresh = false } = {}) {
  if (!localCapabilities) return;
  await localCapabilities.refreshOllamaModels(forceRefresh, (models) => { lastOllamaModels = models; });
  if (myGeneration !== renderGeneration) return;
  const content = main.querySelector('#gs-content');
  if (content) renderEditableCategory(content, category);
}

// Provider-neutral counterpart to refreshOllamaModels() — fetches
// GET /api/generation/models?backend=<the CURRENTLY STAGED backend>, not a
// fixed backend, so switching SEMIDEX_GENERATION_BACKEND in an unsaved
// edit and re-triggering this (see wireCategoryEvents' backend-change
// handler) always fetches the NEW backend's models, never the one the
// page originally loaded with. Tracks lastGenerationModelsBackend so a
// slow in-flight fetch for a since-abandoned backend selection can never
// be rendered as if it belonged to the current one (an async race the
// myGeneration check alone would not catch, since both fetches share the
// same render generation).
async function refreshGenerationModels(main, category, myGeneration, { forceRefresh = false } = {}) {
  const backend = currentGenerationBackend();
  const query = forceRefresh ? `backend=${backend}&refresh=1` : `backend=${backend}`;
  let result;
  try {
    result = await api(`/api/generation/models?${query}`);
  } catch (err) {
    result = { available: false, reason: err.message, models: [] };
  }
  if (myGeneration !== renderGeneration) return;
  if (currentGenerationBackend() !== backend) return; // stale: backend changed again while this fetch was in flight
  lastGenerationModels = result;
  lastGenerationModelsBackend = backend;
  const content = main.querySelector('#gs-content');
  if (content) renderEditableCategory(content, category);
}

// ── Top-level render ─────────────────────────────────────────────────────────

async function renderCategoryContent(main, category, payload, myGeneration) {
  const content = main.querySelector('#gs-content');
  if (category === 'status') {
    await renderStatusCategory(content, myGeneration);
    return;
  }
  if (myGeneration !== renderGeneration) return;

  if (categoryNeedsOllamaModels(category)) {
    // Render once immediately with whatever's cached (or nothing, on a
    // fresh page load) so the category isn't blocked on this fetch, then
    // refresh in the background and re-render when it resolves — mirrors
    // the status category's own "render skeleton, fill in async" shape.
    renderEditableCategory(content, category);
    await refreshOllamaModels(main, category, myGeneration);
    return;
  }
  if (categoryNeedsGenerationModels(category)) {
    renderEditableCategory(content, category);
    await refreshGenerationModels(main, category, myGeneration);
    return;
  }
  renderEditableCategory(content, category);
}

export async function renderGlobalSettingsView(main, requestedCategory) {
  const myGeneration = ++renderGeneration;
  main.replaceChildren(cloneTemplate('tpl-global-settings-shell'));
  let payload;
  try {
    payload = await api('/api/settings');
  } catch (err) {
    if (myGeneration !== renderGeneration) return;
    const message = document.createElement('p');
    message.className = 'gs-detail';
    message.textContent = err.message;
    main.querySelector('#gs-content').replaceChildren(message);
    return;
  }
  if (myGeneration !== renderGeneration) return;

  lastFetchedPayload = payload;
  const categories = payload.categories;
  const category = categories.find((c) => c.id === requestedCategory)?.id ?? categories[0].id;
  if (!requestedCategory || category !== requestedCategory) {
    history.replaceState(null, '', `#/settings/${category}`);
  }
  renderSettingsNav(categories, category);
  syncSidebarMode({ view: 'global-settings', category });
  markActive({ view: 'global-settings', category });
  renderInlineCategorySelect(main, categories, category);
  await renderCategoryContent(main, category, payload, myGeneration);
}
