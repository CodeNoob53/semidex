// ── collection settings (was "Maintenance") ────────────────────────────────
// User-facing settings (health, reindex) are separated from "Advanced
// diagnostics" (dense/sparse vector details, provider strings, schema
// versions, semidex-managed flag, raw warnings) — the latter collapsed by
// default so the default view is not filled with developer-only labels.
import settingsShell from './partials/settings-shell.html?raw';
import { $, esc, cloneTemplate, errorBox } from './dom.js';
import { api, apiPost, apiDelete } from './api.js';
import { getExpandedCollection, setExpandedCollection } from './state.js';
import { loadSidebar } from './sidebar.js';

const RECENT_SOURCE_PATHS_KEY = 'semidex-admin-recent-source-paths';

function getRecentSourcePaths() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_SOURCE_PATHS_KEY) ?? '[]');
  } catch { return []; }
}

function rememberSourcePath(path) {
  const recent = [path, ...getRecentSourcePaths().filter(p => p !== path)].slice(0, 8);
  try { localStorage.setItem(RECENT_SOURCE_PATHS_KEY, JSON.stringify(recent)); } catch { /* storage unavailable — non-fatal */ }
}

export async function renderSettingsView(main, name) {
  main.innerHTML = settingsShell;
  $('#settings-title').textContent = `${name} · settings`;
  $('#settings-back-link').setAttribute('href', `#/c/${encodeURIComponent(name)}`);
  $('#settings-source-path-field').innerHTML = renderSourcePathField();

  const modal = cloneTemplate('tpl-delete-modal');
  modal.querySelector('#delete-modal-name').textContent = name;
  $('#delete-modal-slot').replaceChildren(modal);

  $('#opt-prune').addEventListener('change', (e) => {
    e.target.closest('label').classList.toggle('warn', e.target.checked);
  });
  $('#settings-reindex-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runSettingsReindex(name);
  });
  $('#settings-repair').addEventListener('click', () => runSettingsRepair(name));
  $('#settings-delete-btn').addEventListener('click', () => openDeleteModal());
  $('#delete-modal-cancel').addEventListener('click', () => closeDeleteModal());
  $('#delete-modal-confirm').addEventListener('click', () => runDeleteCollection(name));

  let detail;
  try {
    detail = (await api(`/api/collections/${encodeURIComponent(name)}`)).collection;
  } catch (err) {
    $('#settings-health').innerHTML = errorBox(err);
    $('#settings-diagnostics').innerHTML = errorBox(err);
    return;
  }

  renderSettingsHealth(detail);
  renderAdvancedDiagnostics(detail);
}

function renderSourcePathField() {
  const recent = getRecentSourcePaths();
  const options = recent.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  return `
    <label class="form-row">
      <span>source path ${recent.length ? '' : '(no recent paths yet — choose a folder below)'}</span>
      ${recent.length ? `
        <select id="settings-path-recent" class="q-input">
          <option value="">— choose a recent source root —</option>
          ${options}
          <option value="__manual__">Choose a different folder…</option>
        </select>` : ''}
      <div class="path-picker-row" style="${recent.length ? 'display:none;margin-top:6px' : ''}" id="settings-path-manual-row">
        <input type="text" id="settings-path-manual" class="q-input" placeholder="Choose a folder, or type a path">
        <button type="button" class="btn-ghost" id="settings-choose-folder">Choose folder…</button>
      </div>
    </label>`;
}

function wireSourcePathField() {
  const select = $('#settings-path-recent');
  const manual = $('#settings-path-manual');
  const manualRow = $('#settings-path-manual-row');
  if (select) {
    select.addEventListener('change', () => {
      if (select.value === '__manual__' || select.value === '') {
        manualRow.style.display = '';
        manualRow.style.marginTop = '6px';
        if (select.value === '__manual__') manual.focus();
      } else {
        manualRow.style.display = 'none';
        manual.value = select.value;
      }
    });
  }
  $('#settings-choose-folder')?.addEventListener('click', async () => {
    const btn = $('#settings-choose-folder');
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Choosing…';
    try {
      const { path, cancelled } = await apiPost('/api/system/pick-folder', {});
      if (!cancelled && path) manual.value = path;
    } catch { /* picker unavailable — manual input stays available as-is */ }
    finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });
}

function currentSourcePathValue() {
  const select = $('#settings-path-recent');
  const manual = $('#settings-path-manual');
  if (select && select.value && select.value !== '__manual__') return select.value;
  return manual?.value.trim() ?? '';
}

function renderSettingsHealth(detail) {
  const warnings = detail.warnings ?? [];
  const healthBadge = warnings.length
    ? `<span class="badge badge-warn">${warnings.length} warning${warnings.length > 1 ? 's' : ''}</span>`
    : '<span class="badge badge-ok">healthy</span>';

  $('#settings-health').innerHTML = `
    <div class="panel-head">Collection health</div>
    <div class="panel-body">
      <dl class="kv">
        <dt>status</dt><dd>${healthBadge}</dd>
        <dt>points</dt><dd>${Number(detail.pointCount ?? 0).toLocaleString('en-US')}</dd>
        <dt>skeleton nav</dt><dd>${detail.hasSkeleton ? 'available' : 'not enabled'}</dd>
      </dl>
      ${warnings.map(w => `<div class="error-box" style="margin-top:12px">${esc(w)}</div>`).join('')}
    </div>`;

  wireSourcePathField();
}

function renderAdvancedDiagnostics(detail) {
  const v = detail.vectorSchema ?? {};
  const p = detail.provider ?? {};
  const ver = detail.versions ?? {};
  $('#settings-diagnostics').innerHTML = `
    <dl class="kv">
      <dt>dense vector</dt><dd>${v.dense?.size ?? '—'} · ${esc(v.dense?.distance ?? '—')}</dd>
      <dt>sparse vector</dt><dd>${v.sparse ? 'yes' : 'no'}</dd>
      <dt>dense provider</dt><dd>${esc(p.denseProvider ?? '—')}${p.denseModel ? ` / ${esc(p.denseModel)}` : ''}</dd>
      <dt>sparse provider</dt><dd>${esc(p.sparseProvider ?? '—')}</dd>
      <dt>versions</dt><dd>embed v${ver.embeddingSchema ?? '?'} · chunk v${ver.chunkingSchema ?? '?'} · tokens ${esc(ver.tokenCountMode ?? '?')}</dd>
      <dt>semidex-managed</dt><dd>${detail.semidexManaged ? 'yes' : 'no'}</dd>
    </dl>`;
}

async function runSettingsReindex(name) {
  const submit = $('#settings-reindex-submit');
  const result = $('#settings-reindex-result');

  const path = currentSourcePathValue();
  if (!path) {
    result.className = 'error-box';
    result.textContent = 'Source path is required.';
    return;
  }

  const payload = {
    collection: name,
    path,
    options: {
      onnxEmbed: $('#opt-onnx').checked,
      llmSummaries: $('#opt-llm-summaries').checked,
      skeletonChunking: $('#opt-skel-chunk').checked,
      skeletonNav: $('#opt-skel-nav').checked,
      tagGen: $('#opt-tags').checked,
      pruneStale: $('#opt-prune').checked,
    },
  };

  submit.disabled = true;
  result.className = 'empty';
  result.textContent = 'starting…';

  try {
    const body = await apiPost('/api/jobs/index', payload);
    rememberSourcePath(path);
    result.className = 'empty';
    result.innerHTML = `Job started (<span class="mono">${esc(body.job.id)}</span>).
      <a href="#/index">Watch it on the indexing jobs view</a>.`;
  } catch (err) {
    result.className = 'error-box';
    result.textContent = err.status === 409
      ? `${err.message} Wait for it to finish, or cancel it from the indexing jobs view.`
      : err.message;
  } finally {
    submit.disabled = false;
  }
}

async function runSettingsRepair(name) {
  const btn = $('#settings-repair');
  const result = $('#settings-repair-result');
  btn.disabled = true;
  result.className = 'empty';
  result.textContent = 'checking…';

  try {
    const body = await apiPost(`/api/collections/${encodeURIComponent(name)}/sync-schema`, {});
    const parts = [];
    if (body.repaired?.length) parts.push(`repaired: ${body.repaired.join(', ')}`);
    if (body.warnings?.length) parts.push(`warnings: ${body.warnings.join(' · ')}`);
    result.className = body.warnings?.length ? 'error-box' : 'empty';
    result.textContent = parts.length ? parts.join(' — ') : 'Already compatible — nothing to repair.';
    const detail = (await api(`/api/collections/${encodeURIComponent(name)}`)).collection;
    renderSettingsHealth(detail);
    renderAdvancedDiagnostics(detail);
  } catch (err) {
    result.className = 'error-box';
    result.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

function openDeleteModal() {
  $('#delete-modal-backdrop').style.display = '';
}

function closeDeleteModal() {
  $('#delete-modal-backdrop').style.display = 'none';
}

async function runDeleteCollection(name) {
  const btn = $('#delete-modal-confirm');
  const result = $('#settings-delete-result');
  btn.disabled = true;
  result.className = 'empty';
  result.textContent = 'deleting…';

  try {
    await apiDelete(`/api/collections/${encodeURIComponent(name)}`);
    if (getExpandedCollection() === name) setExpandedCollection(null);
    location.hash = '#/';
    loadSidebar();
  } catch (err) {
    result.className = 'error-box';
    result.textContent = err.message;
    btn.disabled = false;
  }
}
