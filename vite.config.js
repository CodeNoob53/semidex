import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import fullReload from 'vite-plugin-full-reload';
import injectHTML from 'vite-plugin-html-inject';

// npm run admin:dev serves the UI from Vite's own dev server (a different
// origin/port than the Local API) but app.js calls relative fetch('/api/...')
// paths — without this proxy those requests would hit the Vite dev server
// itself (404) instead of node src/admin/bootstrap.js. The Local API must be
// started separately (npm run admin) while running admin:dev; target port
// is overridable via ADMIN_PORT to match a non-default `npm run admin`.
const apiProxyTarget = `http://127.0.0.1:${process.env.ADMIN_PORT || 8642}`;

const ROOT = resolve(__dirname, 'src/admin/ui-src');

export default defineConfig({
  root: ROOT,
  base: '/',
  resolve: {
    // Phase 6 (docs/design/full-lite-shared-architecture-audit-2026-08-01.md):
    // jobs-view.js/settings-view.js import 'edition/index-view.html' and
    // 'edition/settings-shell.html' — a stable, edition-neutral bare
    // specifier directory, not a real path on disk. This config (Full)
    // aliases 'edition' to partials/full/; vite.config.lite.js aliases the
    // same 'edition' specifier to partials/lite/ instead, so each build
    // resolves the SAME import statement in jobs-view.js/settings-view.js
    // to its own edition's real, physically separate partial file — never
    // the same file post-processed or stripped.
    alias: [
      // partials/full/ physically relocated to src/local/admin/ui-src/
      // (Phase 8B Step 7C — local-only markup/features must not live
      // under shared UI source).
      { find: 'edition', replacement: resolve(ROOT, '../../local/admin/ui-src/partials/full') },
    ],
  },
  server: {
    proxy: {
      '/api': { target: apiProxyTarget, changeOrigin: true },
    },
  },
  plugins: [
    injectHTML(),
    // index.html itself is already covered by Vite's own dev-server reload
    // (it's the HTML entry point — editing it reloads automatically with no
    // extra plugin, verified by hand). What's NOT covered: the *.html files
    // it <load>s (vite-plugin-html-inject partials) and the ?raw-imported
    // view-shell .html files under partials/ — plain .html files aren't
    // part of Vite's ES-module graph, so editing one doesn't trigger
    // anything on its own without this. Scoped to partials/ only (not
    // '**/*.html') so index.html isn't double-watched by two mechanisms.
    // root is passed explicitly because vite-plugin-full-reload defaults to
    // process.cwd() (the repo root when running `npm run admin:dev`), not
    // Vite's own `root` above — without this the glob silently matches
    // nothing (verified: partials/**/*.html alone, with no root option,
    // never logged a reload when editing a partial). Three glob roots
    // (Phase 8B Step 7C): 'partials/**/*.html' still covers the
    // composition-owned partials/lite/ that stayed under ui-src/; the
    // other two explicitly reach the physically relocated shared
    // (src/shared/admin/ui-src/partials/) and local-only
    // (src/local/admin/ui-src/partials/full/) partial trees — each
    // resolved via plain path.resolve(root, path), which supports '../'
    // traversal outside ui-src/ (confirmed from the plugin's own source).
    fullReload([
      'partials/**/*.html',
      '../../shared/admin/ui-src/partials/**/*.html',
      '../../local/admin/ui-src/partials/**/*.html',
    ], { root: ROOT }),
  ],
  build: {
    rollupOptions: {
      input: resolve(ROOT, 'index.html'),
    },
    // Repo-root dist/, outside Vite's own root (src/admin/ui-src) — three
    // levels up (ui-src -> admin -> src -> repo root), then into dist/admin-ui.
    outDir: '../../../dist/admin-ui',
    // Default would already be true here since outDir is outside root, but
    // kept explicit to document intent regardless of future root/outDir changes.
    emptyOutDir: true,
  },
});
