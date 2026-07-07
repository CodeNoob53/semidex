import { defineConfig } from 'vite';
import fullReload from 'vite-plugin-full-reload';
import injectHTML from 'vite-plugin-html-inject';

// npm run admin:dev serves the UI from Vite's own dev server (a different
// origin/port than the Local API) but app.js calls relative fetch('/api/...')
// paths — without this proxy those requests would hit the Vite dev server
// itself (404) instead of node src/admin/server.js. The Local API must be
// started separately (npm run admin) while running admin:dev; target port
// is overridable via ADMIN_PORT to match a non-default `npm run admin`.
const apiProxyTarget = `http://127.0.0.1:${process.env.ADMIN_PORT || 8642}`;

export default defineConfig({
  root: 'src/admin/ui-src',
  base: '/',
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
    // never logged a reload when editing a partial).
    fullReload(['partials/**/*.html'], { root: 'src/admin/ui-src' }),
  ],
  build: {
    // Repo-root dist/, outside Vite's own root (src/admin/ui-src) — three
    // levels up (ui-src -> admin -> src -> repo root), then into dist/admin-ui.
    outDir: '../../../dist/admin-ui',
    // Default would already be true here since outDir is outside root, but
    // kept explicit to document intent regardless of future root/outDir changes.
    emptyOutDir: true,
  },
});
