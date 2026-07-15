// Tests for src/admin/ui-src/global-settings-view.js (#/settings, Phase
// 4A.5b) — the global, read-only runtime settings screen. Distinct from
// collection settings (#/c/:name/settings, settings-view.js /
// ui-settings.test.js). Data sources are exactly GET /api/health and
// GET /api/generation/status — no writes, no provider switching.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadGlobalSettingsHelpers, readUiSource, loadRouterHelper, withServer } from './ui-test-helpers.js';

const HEALTH_OK = { ok: true, storage: { backend: 'qdrant', ok: true, detail: 'reachable' } };
const HEALTH_FAIL = { ok: false, storage: { backend: 'qdrant', ok: false, detail: 'connection refused' } };

const GENERATION_READY = {
  backend: 'ollama', model: 'gemma3:4b', ready: true, reason: null, numCtx: 8192,
  capabilities: { streaming: true, cancellation: true },
  devicePolicy: { value: 'auto', supported: ['auto'] },
  configuration: {
    backend: { source: 'default' }, model: { source: 'os_env' },
    baseUrl: { source: 'dotenv', display: 'http://localhost:11434' },
    numCtx: { source: 'default' }, devicePolicy: { source: 'default' },
  },
};

const GENERATION_UNAVAILABLE = {
  backend: 'ollama', model: 'gemma3:4b', ready: false,
  reason: 'Ollama is not reachable at http://localhost:11434. Start it with "ollama serve".',
  numCtx: null, capabilities: { streaming: true, cancellation: true },
  devicePolicy: { value: 'auto', supported: ['auto'] },
  configuration: {
    backend: { source: 'default' }, model: { source: 'dotenv' },
    baseUrl: { source: 'dotenv', display: 'http://localhost:11434' },
    numCtx: { source: 'default' }, devicePolicy: { source: 'default' },
  },
};

const GENERATION_INVALID_CONFIG = {
  backend: 'openai', model: null, ready: false,
  reason: 'Unknown generation backend "openai" (SEMIDEX_GENERATION_BACKEND). Supported: ollama.',
  numCtx: null, capabilities: { streaming: false, cancellation: false },
  devicePolicy: { value: null, supported: ['auto'] },
  configuration: null,
};

describe('#/settings — currentRoute() parsing', () => {
  it('parses #/settings as a distinct global-settings view', () => {
    const { currentRoute } = loadRouterHelper();
    assert.deepEqual(currentRoute('#/settings'), { view: 'global-settings' });
  });

  it('collection settings route (#/c/:name/settings) is unaffected', () => {
    const { currentRoute } = loadRouterHelper();
    assert.deepEqual(currentRoute('#/c/my-docs/settings'), { view: 'settings', name: 'my-docs' });
  });

  it('#/settings and #/c/:name/settings never collide for any collection name', () => {
    const { currentRoute } = loadRouterHelper();
    assert.notDeepEqual(currentRoute('#/settings'), currentRoute('#/c/settings/settings'));
    assert.deepEqual(currentRoute('#/c/settings/settings'), { view: 'settings', name: 'settings' });
  });
});

describe('router.js — dispatches #/settings to renderGlobalSettingsView', () => {
  it('imports and calls renderGlobalSettingsView for the global-settings route', () => {
    const js = readUiSource('router.js');
    assert.match(js, /import\s*\{\s*renderGlobalSettingsView\s*\}\s*from ['"]\.\/global-settings-view\.js['"]/);
    assert.match(js, /renderGlobalSettingsView\(main\)/);
  });

  it('global-settings-view.js does not import router.js (no circular import)', () => {
    const js = readUiSource('global-settings-view.js');
    assert.ok(!/from ['"]\.\/router\.js['"]/.test(js), 'global-settings-view.js must not import router.js');
  });
});

describe('renderGlobalSettingsView — both ready', () => {
  it('renders Connected/Ready badges, backend, provider, model, context size, device policy', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/health': HEALTH_OK, '/api/generation/status': GENERATION_READY },
    });
    await renderGlobalSettingsView(document.getElementById('main'));

    const storage = document.getElementById('gs-storage');
    assert.match(storage.textContent, /Connected/);
    assert.match(storage.textContent, /qdrant/);

    const generation = document.getElementById('gs-generation');
    assert.match(generation.textContent, /Ready/);
    assert.match(generation.textContent, /ollama/);
    assert.match(generation.textContent, /gemma3:4b/);
    assert.match(generation.textContent, /8,192/);
    assert.match(generation.textContent, /auto/);
  });

  it('fetches exactly /api/health and /api/generation/status, nothing else', async () => {
    const { document, renderGlobalSettingsView, __apiCalls } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/health': HEALTH_OK, '/api/generation/status': GENERATION_READY },
    });
    await renderGlobalSettingsView(document.getElementById('main'));
    assert.deepEqual(__apiCalls.sort(), ['/api/generation/status', '/api/health']);
  });
});

describe('renderGlobalSettingsView — storage unavailable', () => {
  it('renders an Unavailable badge and the connection detail, generation panel still renders independently', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/health': HEALTH_FAIL, '/api/generation/status': GENERATION_READY },
    });
    await renderGlobalSettingsView(document.getElementById('main'));

    const storage = document.getElementById('gs-storage');
    assert.match(storage.textContent, /Unavailable/);
    assert.match(storage.textContent, /connection refused/);

    const generation = document.getElementById('gs-generation');
    assert.match(generation.textContent, /Ready/);
  });
});

describe('renderGlobalSettingsView — generation unavailable with a reason', () => {
  it('renders Unavailable, the actionable reason, and the redacted endpoint as diagnostic detail', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/health': HEALTH_OK, '/api/generation/status': GENERATION_UNAVAILABLE },
    });
    await renderGlobalSettingsView(document.getElementById('main'));

    const generation = document.getElementById('gs-generation');
    assert.match(generation.textContent, /Unavailable/);
    assert.match(generation.textContent, /not reachable/);
    assert.match(generation.textContent, /localhost:11434/);
    // numCtx is unknown while unready (the backend only reports the live
    // model's effective context size after a successful readiness check),
    // so no fabricated token count should appear.
    assert.doesNotMatch(generation.textContent, /tokens/);
  });

  it('still shows the configured device policy even though the provider is unavailable (code review finding)', async () => {
    // Regression: device policy used to be gated on ready:true, hiding a
    // genuinely known, backend-reported configuration value exactly when
    // diagnosing an unavailable provider is most useful (e.g. confirming a
    // GENERATION_DEVICE override actually took effect). The backend
    // resolves and returns devicePolicy.value from configuration
    // regardless of provider readiness — only a fully invalid
    // configuration (configuration: null) has no known value to show.
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/health': HEALTH_OK, '/api/generation/status': GENERATION_UNAVAILABLE },
    });
    await renderGlobalSettingsView(document.getElementById('main'));
    const generation = document.getElementById('gs-generation');
    assert.match(generation.textContent, /device/i);
    assert.match(generation.textContent, /auto/);
  });

  it('shows "—" for context size (not a fabricated number) while the provider is unavailable', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/health': HEALTH_OK, '/api/generation/status': GENERATION_UNAVAILABLE },
    });
    await renderGlobalSettingsView(document.getElementById('main'));
    const generation = document.getElementById('gs-generation');
    assert.match(generation.textContent, /context size/i);
    assert.match(generation.textContent, /—/);
  });
});

describe('renderGlobalSettingsView — invalid generation configuration', () => {
  it('renders Unavailable with the configuration error as the reason, no crash, no provenance block (configuration is null)', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/health': HEALTH_OK, '/api/generation/status': GENERATION_INVALID_CONFIG },
    });
    await renderGlobalSettingsView(document.getElementById('main'));

    const generation = document.getElementById('gs-generation');
    assert.match(generation.textContent, /Unavailable/);
    assert.match(generation.textContent, /Unknown generation backend/);
    assert.equal(generation.querySelector('.gs-provenance'), null);
  });
});

describe('renderGlobalSettingsView — independent request failures', () => {
  it('a failed /api/health request does not prevent the generation panel from rendering', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/health': new Error('network error'),
        '/api/generation/status': GENERATION_READY,
      },
    });
    await renderGlobalSettingsView(document.getElementById('main'));
    assert.match(document.getElementById('gs-storage').textContent, /Unavailable/);
    assert.match(document.getElementById('gs-storage').textContent, /network error/);
    assert.match(document.getElementById('gs-generation').textContent, /Ready/);
  });

  it('a failed /api/generation/status request does not prevent the storage panel from rendering', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/health': HEALTH_OK,
        '/api/generation/status': new Error('status endpoint exploded'),
      },
    });
    await renderGlobalSettingsView(document.getElementById('main'));
    assert.match(document.getElementById('gs-storage').textContent, /Connected/);
    assert.match(document.getElementById('gs-generation').textContent, /Unavailable/);
    assert.match(document.getElementById('gs-generation').textContent, /status endpoint exploded/);
  });

  it('both requests failing renders two independent error states, not a crash', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/health': new Error('health down'),
        '/api/generation/status': new Error('generation down'),
      },
    });
    await renderGlobalSettingsView(document.getElementById('main'));
    assert.match(document.getElementById('gs-storage').textContent, /health down/);
    assert.match(document.getElementById('gs-generation').textContent, /generation down/);
  });

  it('source uses Promise.allSettled, not sequential await/try-catch, for the two fetches', () => {
    const js = readUiSource('global-settings-view.js');
    assert.match(js, /Promise\.allSettled/);
  });
});

describe('renderGlobalSettingsView — provenance labels', () => {
  it('translates os_env/dotenv/default into the documented human-readable labels', async () => {
    const status = {
      ...GENERATION_READY,
      configuration: {
        backend: { source: 'os_env' }, model: { source: 'dotenv' },
        baseUrl: { source: 'default', display: 'http://localhost:11434' },
        numCtx: { source: 'os_env' }, devicePolicy: { source: 'default' },
      },
    };
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/health': HEALTH_OK, '/api/generation/status': status },
    });
    await renderGlobalSettingsView(document.getElementById('main'));
    const provenance = document.querySelector('.gs-provenance');
    assert.match(provenance.textContent, /Operating system environment/);
    assert.match(provenance.textContent, /\.env file/);
    assert.match(provenance.textContent, /Semidex default/);
  });

  it('provenance lives inside a collapsed <details> (secondary, not dominant)', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/health': HEALTH_OK, '/api/generation/status': GENERATION_READY },
    });
    await renderGlobalSettingsView(document.getElementById('main'));
    const details = document.querySelector('.gs-provenance');
    assert.equal(details.tagName.toLowerCase(), 'details');
    assert.equal(details.hasAttribute('open'), false);
  });
});

describe('renderGlobalSettingsView — hostile strings remain inert', () => {
  it('a hostile model name never becomes a live element', async () => {
    const malicious = '<img src=x onerror="window.__pwned=true">';
    const status = { ...GENERATION_READY, model: malicious };
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/health': HEALTH_OK, '/api/generation/status': status },
    });
    await renderGlobalSettingsView(document.getElementById('main'));
    const generation = document.getElementById('gs-generation');
    assert.equal(generation.querySelectorAll('img').length, 0);
    assert.match(generation.textContent, /<img/);
  });

  it('a hostile unavailable reason never becomes a live element', async () => {
    const malicious = '<script>window.__pwned=true</script>Ollama down';
    const status = { ...GENERATION_UNAVAILABLE, reason: malicious };
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/health': HEALTH_OK, '/api/generation/status': status },
    });
    await renderGlobalSettingsView(document.getElementById('main'));
    const generation = document.getElementById('gs-generation');
    assert.equal(generation.querySelectorAll('script').length, 0);
    assert.match(generation.textContent, /Ollama down/);
  });

  it('a hostile storage backend name never becomes a live element', async () => {
    const malicious = { ok: true, storage: { backend: '<b onmouseover="pwn()">qdrant</b>', ok: true, detail: 'ok' } };
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/health': malicious, '/api/generation/status': GENERATION_READY },
    });
    await renderGlobalSettingsView(document.getElementById('main'));
    const storage = document.getElementById('gs-storage');
    assert.equal(storage.querySelectorAll('b[onmouseover]').length, 0);
    assert.match(storage.textContent, /qdrant/);
  });

  it('a hostile storage detail string never becomes a live element', async () => {
    const malicious = { ok: false, storage: { backend: 'qdrant', ok: false, detail: '<img src=x onerror="pwn()">' } };
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/health': malicious, '/api/generation/status': GENERATION_READY },
    });
    await renderGlobalSettingsView(document.getElementById('main'));
    const storage = document.getElementById('gs-storage');
    assert.equal(storage.querySelectorAll('img').length, 0);
  });

  it('a hostile network-error message (from a rejected api() call) never becomes a live element', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: {
        '/api/health': new Error('<img src=x onerror="pwn()">'),
        '/api/generation/status': GENERATION_READY,
      },
    });
    await renderGlobalSettingsView(document.getElementById('main'));
    const storage = document.getElementById('gs-storage');
    assert.equal(storage.querySelectorAll('img').length, 0);
  });
});

describe('renderGlobalSettingsView — no secret/raw configuration fields', () => {
  it('never renders capability booleans (streaming/cancellation)', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/health': HEALTH_OK, '/api/generation/status': GENERATION_READY },
    });
    await renderGlobalSettingsView(document.getElementById('main'));
    const html = document.getElementById('main').innerHTML;
    assert.ok(!/streaming/i.test(html));
    assert.ok(!/cancellation/i.test(html));
  });

  it('never renders raw internal field names (numCtx, devicePolicy, baseUrl as literal keys)', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/health': HEALTH_OK, '/api/generation/status': GENERATION_READY },
    });
    await renderGlobalSettingsView(document.getElementById('main'));
    const html = document.getElementById('main').innerHTML;
    assert.ok(!/numCtx/.test(html));
    assert.ok(!/devicePolicy/.test(html));
    assert.ok(!/\bbaseUrl\b/.test(html));
  });

  it('never renders a raw JSON blob of the API response', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/health': HEALTH_OK, '/api/generation/status': GENERATION_READY },
    });
    await renderGlobalSettingsView(document.getElementById('main'));
    const html = document.getElementById('main').innerHTML;
    assert.ok(!/[{"]capabilities[":]/.test(html), 'must not stringify the raw status object anywhere');
  });

  it('source never reads process/env vars directly (no client-side config resolution)', () => {
    const js = readUiSource('global-settings-view.js');
    assert.ok(!/process\.env/.test(js));
  });

  it('source never fetches /api/system/ollama-status', () => {
    const js = readUiSource('global-settings-view.js');
    // Matches an actual api() call target, not prose (this file's own
    // header comment explains, in passing, why that endpoint is NOT used —
    // a naive /ollama-status/ substring check flags that comment too).
    assert.ok(!/api\(['"]\/api\/system\/ollama-status/.test(js));
  });

  it('source never calls raw fetch() — only the shared api() helper', () => {
    const js = readUiSource('global-settings-view.js');
    assert.ok(!/\bfetch\(/.test(js));
  });
});

describe('renderGlobalSettingsView — no writes from this view', () => {
  it('source contains no apiPost/apiDelete calls or import', () => {
    const js = readUiSource('global-settings-view.js');
    assert.ok(!/apiPost/.test(js));
    assert.ok(!/apiDelete/.test(js));
  });

  it('renders no form, no input, no button anywhere in the view', async () => {
    const { document, renderGlobalSettingsView } = loadGlobalSettingsHelpers({
      apiResponses: { '/api/health': HEALTH_OK, '/api/generation/status': GENERATION_READY },
    });
    await renderGlobalSettingsView(document.getElementById('main'));
    const main = document.getElementById('main');
    assert.equal(main.querySelectorAll('form, input, button').length, 0);
  });
});

describe('topbar gear link — navigation and accessibility', () => {
  it('index.html has a gear link to #/settings with aria-label, title, and a stable id', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      assert.match(html, /id="nav-global-settings"/);
      assert.match(html, /href="#\/settings"/);
      assert.match(html, /aria-label="Semidex settings"/);
      assert.match(html, /title="Semidex settings"/);
    });
  });

  it('topbar.js renders the existing iconGear() SVG into the link, not a duplicate hand-rolled icon', () => {
    const js = readUiSource('topbar.js');
    assert.match(js, /import\s*\{\s*iconGear\s*\}\s*from ['"]\.\/icons\.js['"]/);
    assert.match(js, /iconGear\(\)/);
  });

  it('the gear link participates in markActive() active-route styling', () => {
    const js = readUiSource('sidebar.js');
    assert.match(js, /nav-global-settings/);
    assert.match(js, /global-settings/);
  });

  it('app.css gives the gear link a visible keyboard-focus and active-route state', () => {
    const css = readUiSource('app.css');
    assert.match(css, /\.topbar-gear-link/);
    assert.match(css, /\.topbar-gear-link\.active/);
  });

  it('a link (not a button) is used, so it is reachable and keyboard-activatable like every other nav link', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const match = html.match(/<a[^>]+id="nav-global-settings"[^>]*>/);
      assert.ok(match, 'expected an <a> element for the gear link');
    });
  });
});
