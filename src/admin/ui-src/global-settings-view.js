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
import globalSettingsShell from './partials/global-settings-shell.html?raw';
import { $, esc } from './dom.js';
import { api, apiPatch } from './api.js';
import { showToast } from './toasts.js';
import { renderSettingsNav, syncSidebarMode, markActive } from './sidebar.js';

const PROVENANCE_LABEL = {
  os_env: 'Operating system environment',
  dotenv: '.env file',
  config_json: 'Local semidex setting',
  default: 'Semidex default',
};

function provenanceLabel(source) {
  return PROVENANCE_LABEL[source] ?? esc(source ?? 'Unknown');
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

function renderProvenance(configuration, fields) {
  if (!configuration) return '';
  const rows = fields
    .map(([label, key]) => {
      const entry = configuration[key];
      if (!entry) return '';
      return `<dt>${esc(label)}</dt><dd>${esc(provenanceLabel(entry.source))}</dd>`;
    })
    .join('');
  if (!rows) return '';
  return `
    <details class="gs-provenance">
      <summary>Where these values came from</summary>
      <dl class="kv">${rows}</dl>
    </details>`;
}

function renderStoragePanel(health) {
  const ok = Boolean(health?.ok);
  const badge = ok
    ? '<span class="badge badge-ok">Connected</span>'
    : '<span class="badge badge-fail">Unavailable</span>';
  const backend = health?.storage?.backend ?? 'storage';
  const detail = !ok && health?.storage?.detail
    ? `<p class="gs-detail">${esc(health.storage.detail)}</p>`
    : '';
  return `
    <div class="panel" id="gs-storage">
      <div class="panel-head">Storage</div>
      <div class="panel-body">
        <dl class="kv">
          <dt>status</dt><dd>${badge}</dd>
          <dt>backend</dt><dd>${esc(backend)}</dd>
        </dl>
        ${detail}
      </div>
    </div>`;
}

function renderStorageError(err) {
  return `
    <div class="panel" id="gs-storage">
      <div class="panel-head">Storage</div>
      <div class="panel-body">
        <dl class="kv"><dt>status</dt><dd><span class="badge badge-fail">Unavailable</span></dd></dl>
        <p class="gs-detail">${esc(err.message)}</p>
      </div>
    </div>`;
}

function formatContextSize(numCtx) {
  if (typeof numCtx !== 'number' || !Number.isFinite(numCtx)) return '—';
  return `${numCtx.toLocaleString('en-US')} tokens`;
}

function renderGenerationPanel(status) {
  const ready = Boolean(status?.ready);
  const badge = ready
    ? '<span class="badge badge-ok">Ready</span>'
    : '<span class="badge badge-fail">Unavailable</span>';

  const rows = [
    `<dt>status</dt><dd>${badge}</dd>`,
    `<dt>provider</dt><dd>${esc(status?.backend ?? '—')}</dd>`,
    `<dt>model</dt><dd>${esc(status?.model ?? '—')}</dd>`,
  ];
  if (status?.configuration) {
    rows.push(`<dt>context size</dt><dd>${esc(formatContextSize(status?.numCtx))}</dd>`);
    rows.push(`<dt>device</dt><dd>${esc(status?.devicePolicy?.value ?? '—')}</dd>`);
  }

  let reasonBlock = '';
  if (!ready && status?.reason) {
    const baseUrlLine = status?.configuration?.baseUrl?.display
      ? `<p class="gs-detail-sub">Configured endpoint: ${esc(status.configuration.baseUrl.display)}</p>`
      : '';
    reasonBlock = `<p class="gs-detail">${esc(status.reason)}</p>${baseUrlLine}`;
  }

  const provenance = renderProvenance(status?.configuration, [
    ['Provider', 'backend'],
    ['Model', 'model'],
    ['Endpoint', 'baseUrl'],
    ['Context size', 'numCtx'],
    ['Device policy', 'devicePolicy'],
  ]);

  return `
    <div class="panel" id="gs-generation">
      <div class="panel-head">Answer model</div>
      <div class="panel-body">
        <dl class="kv">${rows.join('')}</dl>
        ${reasonBlock}
        ${provenance}
      </div>
    </div>`;
}

function renderGenerationError(err) {
  return `
    <div class="panel" id="gs-generation">
      <div class="panel-head">Answer model</div>
      <div class="panel-body">
        <dl class="kv"><dt>status</dt><dd><span class="badge badge-fail">Unavailable</span></dd></dl>
        <p class="gs-detail">${esc(err.message)}</p>
      </div>
    </div>`;
}

async function renderStatusCategory(container, myGeneration) {
  container.innerHTML = '<div class="panel" id="gs-storage">…</div><div class="panel" id="gs-generation">…</div>';
  const [healthResult, generationResult] = await Promise.allSettled([
    api('/api/health'),
    api('/api/generation/status'),
  ]);
  if (myGeneration !== renderGeneration) return; // superseded by a newer navigation

  const storageHtml = healthResult.status === 'fulfilled'
    ? renderStoragePanel(healthResult.value) : renderStorageError(healthResult.reason);
  const generationHtml = generationResult.status === 'fulfilled'
    ? renderGenerationPanel(generationResult.value) : renderGenerationError(generationResult.reason);
  container.innerHTML = storageHtml + generationHtml;
}

// ── Future provider placeholders (static, inert) ────────────────────────────

function providerPlaceholder(category) {
  if (category === 'ai') {
    return `
      <div class="gs-placeholder">
        <p><strong>Ollama</strong> — currently implemented.</p>
        <p class="gs-field-desc">Cloud providers are planned.</p>
      </div>`;
  }
  if (category === 'storage') {
    return `
      <div class="gs-placeholder">
        <p><strong>Qdrant</strong> — currently implemented.</p>
        <p class="gs-field-desc">Additional vector databases are planned.</p>
      </div>`;
  }
  return '';
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

function fieldControlHtml(category, entry) {
  const value = currentPendingValue(category, entry);
  const disabled = entry.configuredSource === 'os_env' || entry.configuredSource === 'dotenv';
  if (entry.type === 'boolean') {
    return `<input type="checkbox" class="gs-field-control" data-key="${esc(entry.key)}" ${value ? 'checked' : ''} ${disabled ? 'disabled' : ''}>`;
  }
  if (entry.type === 'enum') {
    const options = (entry.options ?? []).map((o) =>
      `<option value="${esc(o.value)}" ${o.value === value ? 'selected' : ''}>${esc(o.label)}</option>`
    ).join('');
    return `<select class="gs-field-control q-input" data-key="${esc(entry.key)}" ${disabled ? 'disabled' : ''}>${options}</select>`;
  }
  if (entry.type === 'number') {
    const minAttr = entry.min !== undefined ? ` min="${entry.min}"` : '';
    const maxAttr = entry.max !== undefined ? ` max="${entry.max}"` : '';
    return `<input type="number" class="gs-field-control q-input" data-key="${esc(entry.key)}" value="${esc(value)}"${minAttr}${maxAttr} ${disabled ? 'disabled' : ''}>`;
  }
  // string
  return `<input type="text" class="gs-field-control q-input" data-key="${esc(entry.key)}" value="${esc(value)}" ${disabled ? 'disabled' : ''}>`;
}

function fieldRowHtml(category, entry) {
  if (entry.secret) {
    const badge = entry.configured
      ? '<span class="badge badge-ok">Configured</span>'
      : '<span class="badge badge-fail">Not configured</span>';
    return `
      <div class="gs-field">
        <label class="gs-field-label">${esc(entry.label)}</label>
        ${badge}
        <p class="gs-field-desc">${esc(entry.description ?? '')}</p>
      </div>`;
  }

  if (!entry.writable) {
    return `
      <div class="gs-field">
        <label class="gs-field-label">${esc(entry.label)}</label>
        <p class="gs-field-value mono">${esc(entry.configuredValue)}</p>
        <p class="gs-field-desc">${esc(entry.description ?? '')}</p>
        <p class="gs-field-source">${esc(entry.readOnlyReason ?? '')}</p>
      </div>`;
  }

  const control = fieldControlHtml(category, entry);
  const disabled = entry.configuredSource === 'os_env' || entry.configuredSource === 'dotenv';
  const sourceLine = disabled
    ? `<span class="badge badge-warn">locked</span> Set by ${provenanceLabel(entry.configuredSource)}; semidex cannot change this.`
    : provenanceLabel(entry.configuredSource);
  const resetButton = entry.hasLocalOverride
    ? `<button type="button" class="btn-ghost gs-field-reset" data-key="${esc(entry.key)}" title="This clears your saved override and falls back to ${esc(provenanceLabel(entry.activeSource))}.">Use inherited value</button>`
    : '';
  const pendingRestartLine = entry.pendingRestart
    ? `<p class="gs-field-pending-restart">Saved — still using the previous value (${esc(entry.activeValue)}) until semidex restarts.</p>`
    : '';
  const impactParts = [appliesAtLabel(entry.appliesAt)];
  if (entry.requiresReindex) impactParts.push('Requires reindex');
  if (entry.requiresBackfill) impactParts.push('Requires backfill');
  const impact = impactParts.filter(Boolean).join(' · ');

  return `
    <div class="gs-field" data-field="${esc(entry.key)}">
      <label class="gs-field-label">${esc(entry.label)}</label>
      ${control}
      <p class="gs-field-desc">${esc(entry.description ?? '')}</p>
      <p class="gs-field-source">${sourceLine} ${resetButton}</p>
      ${pendingRestartLine}
      <span class="gs-field-impact">${esc(impact)}</span>
    </div>`;
}

function saveBarHtml(category) {
  const pending = pendingByCategory.get(category);
  const invalid = invalidByCategory.get(category);
  const dirty = Boolean(pending?.size || invalid?.size);
  if (!dirty) return '';
  const hasInvalid = Boolean(invalid?.size);
  return `
    <div class="gs-save-bar">
      ${hasInvalid ? '<span class="gs-field-source">Fix invalid fields before saving.</span>' : ''}
      <button type="button" class="btn-amber" id="gs-save" ${hasInvalid ? 'disabled' : ''}>Save</button>
      <button type="button" class="btn-ghost" id="gs-cancel">Cancel</button>
    </div>`;
}

function renderEditableCategory(container, category) {
  const entries = categoryEntries(category);
  const primary = entries.filter((e) => !e.advanced);
  const advanced = entries.filter((e) => e.advanced);

  const placeholder = providerPlaceholder(category);
  const primaryHtml = primary.map((e) => fieldRowHtml(category, e)).join('');
  const advancedHtml = advanced.length
    ? `<details class="gs-advanced"><summary>Advanced settings</summary>${advanced.map((e) => fieldRowHtml(category, e)).join('')}</details>`
    : '';

  container.innerHTML = placeholder + primaryHtml + advancedHtml + saveBarHtml(category);
  wireCategoryEvents(container, category);
}

function syncSaveBar(container, category) {
  container.querySelector('.gs-save-bar')?.remove();
  const html = saveBarHtml(category);
  if (!html) return;
  container.insertAdjacentHTML('beforeend', html);
  wireSaveBarEvents(container, category);
}

function wireCategoryEvents(container, category) {
  for (const el of container.querySelectorAll('.gs-field-control')) {
    const key = el.dataset.key;
    const entry = lastFetchedPayload.settings.find((s) => s.key === key);
    const handler = () => {
      if (entry.type === 'boolean') {
        stagePending(category, key, el.checked, entry);
        markInvalid(category, key, false);
      } else if (entry.type === 'enum') {
        stagePending(category, key, el.value, entry);
        markInvalid(category, key, false);
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
      syncSaveBar(container, category);
    };
    el.addEventListener('change', handler);
    if (entry.type === 'string' || entry.type === 'number') {
      el.addEventListener('input', handler);
    }
  }

  for (const btn of container.querySelectorAll('.gs-field-reset')) {
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

  wireSaveBarEvents(container, category);
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
  mount.innerHTML = `
    <select class="q-input gs-inline-category-select" aria-label="Settings category">
      ${categories.map((c) => `<option value="${esc(c.id)}" ${c.id === category ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
    </select>`;
  mount.querySelector('select').addEventListener('change', (e) => {
    location.hash = `#/settings/${encodeURIComponent(e.target.value)}`;
  });
}

// ── Top-level render ─────────────────────────────────────────────────────────

async function renderCategoryContent(main, category, payload, myGeneration) {
  const content = main.querySelector('#gs-content');
  if (category === 'status') {
    await renderStatusCategory(content, myGeneration);
    return;
  }
  if (myGeneration !== renderGeneration) return;
  renderEditableCategory(content, category);
}

export async function renderGlobalSettingsView(main, requestedCategory) {
  const myGeneration = ++renderGeneration;
  main.innerHTML = globalSettingsShell;
  let payload;
  try {
    payload = await api('/api/settings');
  } catch (err) {
    if (myGeneration !== renderGeneration) return;
    main.querySelector('#gs-content').innerHTML = `<p class="gs-detail">${esc(err.message)}</p>`;
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
