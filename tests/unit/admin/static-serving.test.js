// Static UI shell serving — offline tests over a real node:http server with
// a stub StorageAdapter. Verifies content types, 404s, traversal guard, and
// that /api routes keep working with static serving enabled. Unaffected by
// the ui-src module split — these test src/admin/static.js/vite.config.js,
// not any specific ui-src module.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveStaticPath, UI_DIR, handleStatic } from '../../../src/admin/static.js';
import { readUiSource, getBuiltAssetPaths, withServer } from './ui-test-helpers.js';

describe('static UI serving', () => {
  it('GET / returns the HTML shell', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /^text\/html/);
      const html = await res.text();
      assert.match(html, /semidex/);
      assert.match(html, /<script[^>]+type="module"[^>]+src="\/assets\/[^"]+\.js"/, 'entry script must point at a built, hashed asset');
    });
  });

  it('GET / contains the real static layout directly in the body — not an empty shell relying on runtime injection', async () => {
    // Regression guard for the app-shell.html indirection this project
    // deliberately removed: the layout must be baked into index.html by
    // Vite (via src/admin/ui-src/index.html directly, not a document.body.
    // innerHTML = ... call at runtime). An empty <body> that only gets
    // filled in by JS would still pass every other test in this file (most
    // now read ui-src source, not a rendered DOM) but would defeat the whole
    // point of moving the shell out of JS.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
      assert.ok(bodyMatch, 'index.html must have a <body> tag');
      const body = bodyMatch[1];
      assert.match(body, /<header class="topbar">/, 'topbar must be present in the raw served HTML');
      assert.match(body, /<nav class="sidebar">/, 'sidebar must be present in the raw served HTML');
      assert.match(body, /<main class="main" id="main">/, 'main content root must be present in the raw served HTML');
      assert.match(body, /id="health-lamp"/);
      assert.match(body, /id="collection-list"/);
      // The templates (delete modal, search result, chunk card, job row,
      // empty/error state) are also inlined here by vite-plugin-html-inject
      // — confirms <load> tags resolved, not left as literal <load> elements.
      assert.match(body, /<template id="tpl-delete-modal">/);
      assert.match(body, /<template id="tpl-search-result">/);
      assert.match(body, /<template id="tpl-chunk-card">/);
      assert.match(body, /<template id="tpl-job-row">/);
      assert.match(body, /<template id="tpl-empty-state">/);
      assert.match(body, /<template id="tpl-error-state">/);
      assert.ok(!/<load\s/.test(body), 'the <load> include tags must be resolved at build time, not shipped literally');
    });
  });

  it('main.js/app.js never assign document.body.innerHTML (the layout lives in index.html, not injected at runtime)', () => {
    const js = readUiSource('app.js');
    assert.ok(!/document\.body\.innerHTML/.test(js), 'no full-body innerHTML injection should remain in the source');
  });

  it('GET <built JS asset> returns JavaScript with the right content type', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { js: jsPath } = getBuiltAssetPaths(html);
      const res = await fetch(base + jsPath);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /^text\/javascript/);
      assert.match(await res.text(), /api\/health/);
    });
  });

  it('GET <built CSS asset> returns CSS with the right content type', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { css: cssPath } = getBuiltAssetPaths(html);
      assert.ok(cssPath, 'a built stylesheet link must be present in served index.html');
      const res = await fetch(base + cssPath);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /^text\/css/);
    });
  });

  it('unknown static path returns 404 with the JSON error envelope', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/no-such-file.js');
      assert.equal(res.status, 404);
      assert.equal((await res.json()).error.code, 'not_found');
    });
  });

  it('paths without a known extension return 404 (no directory listing)', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/ui');
      assert.equal(res.status, 404);
    });
  });

  it('non-GET methods on static paths return 405', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/main.js', { method: 'POST' });
      assert.equal(res.status, 405);
      assert.equal((await res.json()).error.code, 'method_not_allowed');
    });
  });

  it('API routes still work with static serving enabled', async () => {
    await withServer(async (base) => {
      const health = await fetch(base + '/api/health');
      assert.equal(health.status, 200);
      assert.equal((await health.json()).storage.backend, 'stub');

      const missing = await fetch(base + '/api/no-such-route');
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).error.code, 'not_found');
    });
  });
});

describe('resolveStaticPath — traversal guard', () => {
  it('/ resolves to index.html inside the UI dir', () => {
    const p = resolveStaticPath('/');
    assert.ok(p !== null && p.endsWith('index.html'));
  });

  it('rejects .. traversal out of the UI dir', () => {
    assert.equal(resolveStaticPath('/../server.js'), null);
    assert.equal(resolveStaticPath('/../../core/qdrant.js'), null);
    assert.equal(resolveStaticPath('/..%2F..%2Fserver.js'.replaceAll('%2F', '/')), null);
  });

  it('rejects unknown extensions', () => {
    assert.equal(resolveStaticPath('/app.wasm'), null);
    assert.equal(resolveStaticPath('/data.json5'), null);
  });
});

// ── Vite build restoration: static server targets dist/admin-ui, not the
// old tracked-in-git src/admin/ui, and the build config carries no
// fixed-filename/minify-disabling hacks ────────────────────────────────────
describe('static server target (guard against regressing to src/admin/ui)', () => {
  it('UI_DIR resolves under dist/admin-ui, not src/admin/ui', () => {
    const normalized = UI_DIR.replace(/\\/g, '/');
    assert.ok(normalized.includes('/dist/admin-ui/'), `UI_DIR must point at dist/admin-ui, got: ${UI_DIR}`);
    assert.ok(!normalized.includes('/src/admin/ui/'), `UI_DIR must not point at src/admin/ui, got: ${UI_DIR}`);
  });
});

describe('vite.config.js guard (no fixed-filename/minify-disabling hacks)', () => {
  it('build config has no fixed asset filenames and does not disable minification/code-splitting', () => {
    const src = readFileSync(fileURLToPath(new URL('../../../vite.config.js', import.meta.url)), 'utf-8');
    assert.ok(!/entryFileNames|chunkFileNames|assetFileNames/.test(src),
      'vite.config.js must not pin fixed output filenames — let Vite hash assets normally');
    assert.ok(!/minify:\s*false/.test(src), 'vite.config.js must not disable minification');
    assert.ok(!/cssCodeSplit:\s*false/.test(src), 'vite.config.js must not disable CSS code splitting');
  });
});

describe('missing build error', () => {
  it('handleStatic returns 503 with an actionable message when dist/admin-ui has no build', async () => {
    const fakeReq = { method: 'GET' };
    const chunks = [];
    let statusCode;
    const fakeRes = {
      writeHead(code) { statusCode = code; },
      end(body) { if (body) chunks.push(Buffer.from(body)); },
    };
    const missingDir = fileURLToPath(new URL('../../../dist/definitely-not-built/', import.meta.url));
    await handleStatic(fakeReq, fakeRes, '/', missingDir);
    assert.equal(statusCode, 503);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    assert.equal(body.error.code, 'ui_not_built');
    assert.match(body.error.message, /npm run admin:build/);
  });
});
