import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import injectHTML from 'vite-plugin-html-inject';

// npm run admin:build:lite — produces dist/admin-ui-lite/, the UI Semidex
// Lite's packages/lite/build.mjs stages into packages/lite/dist/admin-ui/.
// Reuses the shared admin UI source tree (src/shared/admin/ui-src/,
// physically relocated from src/admin/ui-src/ in Phase 8B Step 7C)
// unchanged for every genuinely shared module/partial — no separate
// ui-src-lite/ source duplication.
//
// Phase 6 (docs/design/full-lite-shared-architecture-audit-2026-08-01.md):
// this config now builds a real, separate Lite HTML entry document
// (lite-entry/index.html) from a real, separate JS entry point
// (entries/lite.js), composed from Lite's own physical partial files
// (partials/lite/*.html) — the ONNX probe panel template and the ONNX/
// LLM-summaries/tag-gen checkboxes are never included in the first place,
// because lite-entry/index.html never <load>s the local-only
// onnx-probe-panel.html (physically relocated to
// src/local/admin/ui-src/partials/full/, Phase 8B Step 7C), and
// jobs-view.js's/settings-view.js's ?raw partial imports resolve (via
// resolve.alias below) to partials/lite/index-view.html and
// partials/lite/settings-shell.html, not the Full edition's files at all.
// There is no post-build HTML/JS string-stripping step here any more (the
// old stripHtmlMarkers()/HTML_STRIPS mechanism, and every
// semidex-lite-strip:* marker it looked for, are gone) — Lite's local-only
// markup is never composed into the page or bundle to begin with, so
// there is nothing to strip.
// entries/lite.js also never imports local-features.js (see that file's
// own header comment), so onnxProbePanel()/wireOnnxProbePanel()/
// categoryNeedsOllamaModels()/refreshOllamaModels() all stay unreachable
// no-ops in global-settings-view.js's own bundle too —
// packages/lite/build.mjs's own forbidden-marker content scan over this
// build's real output (Part F) is what independently confirms none of
// this leaked through either path.
//
// `root` is src/admin/ui-src/lite-entry/ (NOT src/admin/ui-src/ itself,
// unlike vite.config.js) — this is what makes Vite emit
// dist/admin-ui-lite/index.html rather than
// dist/admin-ui-lite/lite-entry/index.html (Vite preserves the HTML
// entry's own path relative to `root` in its output). This has two real
// consequences, both handled below: (1) lite-entry/index.html's <load>
// partial paths are one directory level below src/admin/ui-src/, so they
// use "../partials/..." — vite-plugin-html-inject resolves a
// "."-prefixed src relative to the INCLUDING file's own directory, not
// Vite's root (confirmed by reading its source), so this is the correct,
// necessary form here, unlike vite.config.js's root-relative
// "partials/..." form; (2) module resolution (JS imports, the
// "edition/..." alias below) is governed by Node/Rollup module resolution
// from each importing FILE's own location, entirely independent of
// Vite's HTML `root` — entries/lite.js's own `import '../app.css'`/
// `import { startAdminApp } from '../app.js'` (one directory up from
// entries/) are unaffected by this config's `root` choice.
const apiProxyTarget = `http://127.0.0.1:${process.env.ADMIN_PORT || 8642}`;

const UI_SRC = resolve(__dirname, 'src/admin/ui-src');
const ROOT = resolve(UI_SRC, 'lite-entry');

export default defineConfig({
  root: ROOT,
  base: '/',
  resolve: {
    // See vite.config.js's own comment on this same alias — Lite's config
    // aliases the 'edition' specifier directory to its OWN physical
    // partials/lite/ files instead of Full's partials/full/.
    alias: [
      { find: 'edition', replacement: resolve(UI_SRC, 'partials/lite') },
    ],
  },
  server: {
    // A Lite dev command exists for real manual verification of the Lite
    // build specifically (npm run admin:dev:lite) — same proxy target
    // convention as vite.config.js's own dev server.
    proxy: {
      '/api': { target: apiProxyTarget, changeOrigin: true },
    },
  },
  plugins: [
    injectHTML(),
  ],
  build: {
    // Repo-root dist/, outside this config's own root
    // (src/admin/ui-src/lite-entry) — four levels up (lite-entry -> ui-src
    // -> admin -> src -> repo root), then into dist/admin-ui-lite.
    outDir: '../../../../dist/admin-ui-lite',
    emptyOutDir: true,
  },
});
