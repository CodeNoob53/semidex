// ── global runtime settings (#/settings) ────────────────────────────────────
// Distinct from collection settings (#/c/:name/settings, settings-view.js):
// this is a single, instance-wide, READ-ONLY view over the runtime status
// APIs completed in Phase 4A.5a — GET /api/health and
// GET /api/generation/status. No writes, no provider switching, no .env
// editing; those are explicitly out of scope for this phase.
//
// Data sources are exactly these two endpoints — no direct Ollama calls, no
// /api/system/ollama-status (that stays scoped to the indexing form's own
// pre-check role), no env var reads in this file, no second config-
// precedence implementation. Provenance display is a straight label lookup
// over what the backend already resolved and reported.
import globalSettingsShell from './partials/global-settings-shell.html?raw';
import { $, esc } from './dom.js';
import { api } from './api.js';

const PROVENANCE_LABEL = {
  os_env: 'Operating system environment',
  dotenv: '.env file',
  default: 'Semidex default',
};

function provenanceLabel(source) {
  return PROVENANCE_LABEL[source] ?? 'Unknown';
}

// Renders a compact "how was this set" details block — secondary text, not
// a dominant UI element, per the task's explicit "provenance should be
// secondary text or a compact details area" requirement. `fields` is an
// ordered list of [label, sourceKey] pairs read from status.configuration.
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
  $('#gs-storage').innerHTML = `
    <div class="panel-head">Storage</div>
    <div class="panel-body">
      <dl class="kv">
        <dt>status</dt><dd>${badge}</dd>
        <dt>backend</dt><dd>${esc(backend)}</dd>
      </dl>
      ${detail}
    </div>`;
}

function renderStorageError(err) {
  $('#gs-storage').innerHTML = `
    <div class="panel-head">Storage</div>
    <div class="panel-body">
      <dl class="kv"><dt>status</dt><dd><span class="badge badge-fail">Unavailable</span></dd></dl>
      <p class="gs-detail">${esc(err.message)}</p>
    </div>`;
}

// Human-friendly context-size formatting (e.g. 8192 -> "8,192 tokens").
// Never fabricates a value when numCtx is unknown (provider not ready, or
// the field is genuinely absent).
function formatContextSize(numCtx) {
  if (typeof numCtx !== 'number' || !Number.isFinite(numCtx)) return '—';
  return `${numCtx.toLocaleString('en-US')} tokens`;
}

function renderGenerationPanel(status) {
  const ready = Boolean(status?.ready);
  const badge = ready
    ? '<span class="badge badge-ok">Ready</span>'
    : '<span class="badge badge-fail">Unavailable</span>';

  // Context size and device policy are shown whenever the backend actually
  // reports a value, not only when ready:true — the backend resolves and
  // returns devicePolicy.value from configuration regardless of provider
  // readiness (runtime.js's getStatus() only nulls it out for a genuinely
  // invalid configuration, not a merely-unreachable provider), so an
  // unreachable-Ollama diagnosis still benefits from seeing what device
  // policy was actually configured. numCtx is null while not ready (the
  // backend only reports the provider's *effective* numCtx after a
  // successful readiness check, since it depends on the live model's own
  // context ceiling), so formatContextSize()'s existing "—" fallback
  // already handles that correctly without gating on `ready` here (code
  // review finding: gating the whole row pair on `ready` hid a genuinely
  // known device policy exactly when a user most needs to check it — e.g.
  // confirming a GENERATION_DEVICE override actually took effect before
  // troubleshooting further).
  const rows = [
    `<dt>status</dt><dd>${badge}</dd>`,
    `<dt>provider</dt><dd>${esc(status?.backend ?? '—')}</dd>`,
    `<dt>model</dt><dd>${esc(status?.model ?? '—')}</dd>`,
  ];
  if (status?.configuration) {
    rows.push(`<dt>context size</dt><dd>${esc(formatContextSize(status?.numCtx))}</dd>`);
    rows.push(`<dt>device</dt><dd>${esc(status?.devicePolicy?.value ?? '—')}</dd>`);
  }

  // Unavailable reason is the one actionable, user-facing detail this view
  // shows outside the collapsed provenance area — per the task's explicit
  // "why is generation unavailable" requirement. baseUrl.display (already
  // redacted server-side — see runtime.js) is shown alongside it only when
  // it plausibly helps diagnose the failure (an unreachable/misconfigured
  // endpoint), never reconstructed or guessed at client-side.
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

  $('#gs-generation').innerHTML = `
    <div class="panel-head">Answer model</div>
    <div class="panel-body">
      <dl class="kv">${rows.join('')}</dl>
      ${reasonBlock}
      ${provenance}
    </div>`;
}

function renderGenerationError(err) {
  $('#gs-generation').innerHTML = `
    <div class="panel-head">Answer model</div>
    <div class="panel-body">
      <dl class="kv"><dt>status</dt><dd><span class="badge badge-fail">Unavailable</span></dd></dl>
      <p class="gs-detail">${esc(err.message)}</p>
    </div>`;
}

export async function renderGlobalSettingsView(main) {
  main.innerHTML = globalSettingsShell;

  // Fetched independently (Promise.allSettled, not sequential try/catch) so
  // a failure on one endpoint never blocks the other panel from rendering
  // its own real result — the task's explicit requirement.
  const [healthResult, generationResult] = await Promise.allSettled([
    api('/api/health'),
    api('/api/generation/status'),
  ]);

  if (healthResult.status === 'fulfilled') renderStoragePanel(healthResult.value);
  else renderStorageError(healthResult.reason);

  if (generationResult.status === 'fulfilled') renderGenerationPanel(generationResult.value);
  else renderGenerationError(generationResult.reason);
}
