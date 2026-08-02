import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import injectHTML from 'vite-plugin-html-inject';

// npm run admin:build:lite — produces dist/admin-ui-lite/, the UI Semidex
// Lite's packages/lite/build.mjs stages into packages/lite/dist/admin-ui/.
// Reuses the FULL admin UI source tree (src/admin/ui-src/) unchanged — no
// separate ui-src-lite/ source duplication. Most of the Settings view is
// already rendered generically from the GET /api/settings response
// (fieldRow(category, entry) — see global-settings-view.js), so a Lite
// backend (whose response only ever contains the Lite settings allow-list,
// see core/settings/lite-policy.js) already renders zero ONNX/Ollama field
// rows at runtime with the SAME JS. Two places still have STATIC local-only
// markup that plain data-gating can't remove: the ONNX probe panel
// <template> in global-settings.html, and the ONNX/LLM-summaries/tag-gen
// checkboxes in index-view.html's indexing form (Lite's jobs policy
// rejects those options server-side, but the checkboxes themselves are
// unconditional HTML, not API-response-driven). stripHtmlMarkers() below
// removes both at build time — compiled OUT, not hidden, not left
// present-but-unreachable. build.mjs's own check #5 (Part F) content-scans
// the built output (HTML *and* JS) for local-only markers and fails the
// Lite package build if any leak through either the HTML or the bundle.
const HTML_STRIPS = [
  {
    label: 'onnx-probe-template',
    // The <template id="tpl-gs-onnx-probe-panel"> block in
    // global-settings.html — no Lite replacement needed, it's simply
    // absent (onnxProbePanel() never runs in Lite anyway; see
    // global-settings-view.js's IS_LITE guard).
    start: '<template id="tpl-gs-onnx-probe-panel">',
    end: '</template>',
    endIncluded: true,
    replacement: '',
  },
  {
    label: 'local-only-index-options',
    // index-view.html's ONNX/LLM-summaries/tag-gen checkboxes (Lite's jobs
    // policy — admin/composition/lite.js's LITE_JOB_POLICY — rejects onnxEmbed/
    // llmSummaries/tagGen; only pruneStale is Lite-allowed). Replaced, not
    // just removed, with a Lite-scoped equivalent that keeps the
    // prune-stale checkbox (same #opt-prune id, so jobs-view.js's existing
    // $('#opt-prune').checked read needs no change) inside the same
    // <details class="advanced-box"> shell, dropping only the three
    // local-only rows and the Ollama-status placeholder div.
    startMarker: '<!-- semidex-lite-strip:local-only-index-options',
    endMarker: '<!-- semidex-lite-strip:end local-only-index-options -->',
    endIncluded: true,
    replacement: `<div class="idx-options">
        <details class="advanced-box">
          <summary>Advanced options</summary>
          <label class="idx-check"><input type="checkbox" id="opt-prune"> Prune stale</label>
          <p class="skel-note">Prune stale should be used only with the full source root.</p>
        </details>
      </div>`,
  },
  {
    label: 'local-only-reindex-options',
    // settings-shell.html's ONNX/LLM-summaries/tag-gen checkboxes on the
    // per-collection Reindex form — same Lite jobs policy reasoning as
    // local-only-index-options above, but this is a SEPARATE form/DOM
    // (settings-view.js's runSettingsReindex(), not jobs-view.js's
    // startIndexJob()). Removed with no replacement — Lite's reindex form
    // simply has no "Quality"/"Optional enrichment" groups; the Maintenance
    // group (#opt-prune) that follows is untouched.
    startMarker: '<!-- semidex-lite-strip:local-only-reindex-options',
    endMarker: '<!-- semidex-lite-strip:end local-only-reindex-options -->',
    endIncluded: true,
    replacement: '',
  },
];

function stripMarkers(source, filenameForErrors) {
  let out = source;
  for (const spec of HTML_STRIPS) {
    const startNeedle = spec.start ?? spec.startMarker;
    const start = out.indexOf(startNeedle);
    if (start === -1) continue; // this marker doesn't live in this particular source
    const endNeedle = spec.end ?? spec.endMarker;
    const endIdx = out.indexOf(endNeedle, start);
    if (endIdx === -1) {
      throw new Error(`semidex-lite-strip: marker "${spec.label}" in ${filenameForErrors} found its start but no matching end ("${endNeedle}").`);
    }
    const cutEnd = spec.endIncluded ? endIdx + endNeedle.length : endIdx;
    out = out.slice(0, start) + spec.replacement + out.slice(cutEnd);
  }
  return out;
}

// Two distinct places local-only markup can live in this codebase, needing
// two distinct Vite hooks:
//  1. global-settings.html is included into index.html via
//     vite-plugin-html-inject's <load> tag — only visible to the
//     transformIndexHtml hook, AFTER that inlining has already happened
//     (hence the DEFAULT hook order, not `pre`).
//  2. index-view.html is imported as a raw JS string
//     (`import x from './index-view.html?raw'`, jobs-view.js) — it is
//     never part of the HTML document Vite builds; it only ever exists as
//     module source text, visible to the transform() hook instead.
// Each spec in HTML_STRIPS is checked against both hooks; a spec with no
// matching start marker in a given source is a silent no-op there (that is
// how the SAME spec list correctly finds the onnx-probe-panel marker only
// in index.html's post-inline HTML, and the local-only-index-options
// marker only in index-view.html's raw module source).
function stripHtmlMarkers() {
  return {
    name: 'semidex-lite-strip-html-markers',
    transformIndexHtml(html) {
      return stripMarkers(html, 'index.html (post vite-plugin-html-inject)');
    },
    // enforce: 'pre' + a load() hook (not transform()) — Vite's own
    // built-in `?raw` handling turns file content into a JS
    // `export default "..."` string during its OWN load phase; a
    // transform() hook would run on that ALREADY-JS-STRING-ESCAPED output,
    // so inserting raw HTML (with real quotes/newlines) there corrupts the
    // JS string literal (a real failure hit once while wiring this up — a
    // build error, not a silent corruption, but still the wrong hook).
    // enforce: 'pre' runs this load() BEFORE Vite's own, so it sees and
    // returns plain raw HTML text; Vite's built-in `?raw` handling then
    // does the JS-string serialization itself, on the ALREADY-stripped text.
    enforce: 'pre',
    load(id) {
      if (!id.endsWith('.html?raw')) return null;
      const filePath = id.slice(0, id.lastIndexOf('?'));
      const raw = readFileSync(filePath, 'utf-8');
      const stripped = stripMarkers(raw, id);
      // Matches Vite's own built-in ?raw module shape (a plain
      // `export default "<json-string>"`) — returning bare stripped HTML
      // text here would make Vite try to parse it as ESM source instead.
      return `export default ${JSON.stringify(stripped)}`;
    },
  };
}

const apiProxyTarget = `http://127.0.0.1:${process.env.ADMIN_PORT || 8642}`;

export default defineConfig({
  root: 'src/admin/ui-src',
  base: '/',
  define: {
    // A hardcoded boolean literal (see vite.config.js's own comment on the
    // false side of this define) — global-settings-view.js's
    // onnxProbePanel()/wireOnnxProbePanel()/runOnnxProbe()/
    // categoryNeedsOllamaModels()/refreshOllamaModels() are each guarded by
    // `if (IS_LITE) return ...;` so Rollup's dead-code elimination removes
    // their real bodies (and every ONNX/Ollama-specific string literal and
    // /api/ollama-models, /api/system/onnx-probe route reference inside
    // them) from THIS build's output entirely — not just hidden or
    // unreachable at runtime, physically absent from the bundle.
    SEMIDEX_LITE: JSON.stringify(true),
  },
  server: {
    proxy: {
      '/api': { target: apiProxyTarget, changeOrigin: true },
    },
  },
  plugins: [
    injectHTML(),
    stripHtmlMarkers(),
  ],
  build: {
    outDir: '../../../dist/admin-ui-lite',
    emptyOutDir: true,
  },
});
