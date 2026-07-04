// Static UI shell serving — offline tests over a real node:http server with
// a stub StorageAdapter. Verifies content types, 404s, traversal guard, and
// that /api routes keep working with static serving enabled.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { createApp } from '../../../src/admin/server.js';
import { resolveStaticPath } from '../../../src/admin/static.js';
import { createJobRegistry } from '../../../src/admin/jobs/registry.js';

// Pulls the small, pure rendering helpers directly out of the served app.js
// source (by name, between two known adjacent function declarations — same
// slicing technique already used elsewhere in this file) and evaluates just
// those snippets in an isolated vm context. This lets tests assert on actual
// rendering behavior for given inputs, not just regex-match the source text
// — without needing a DOM/browser runner, and without risking the module-
// level side effects (loadTopbar()/loadSidebar()/route()) that running the
// whole file would trigger.
function extractBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error(`end marker not found after start: ${endMarker}`);
  return src.slice(start, end);
}

function loadSidebarLabelHelpers(js) {
  const src = extractBetween(js, 'function esc(value)', 'function errorBox(err)')
    + extractBetween(js, 'function sidebarNodeRow(', 'async function onSidebarNodeClick');
  const context = {};
  vm.createContext(context);
  vm.runInContext(src, context);
  return context;
}

function loadChunkRenderHelpers(js) {
  const src = extractBetween(js, 'function esc(value)', 'function errorBox(err)')
    + extractBetween(js, 'const STRUCTURAL_NODE_TYPES', 'function fileViewLoadMoreButton');
  const context = {};
  vm.createContext(context);
  vm.runInContext(src, context);
  return context;
}

function makeFakeChildForSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { setTimeout(() => child.emit('exit', null, 'SIGTERM'), 1); };
  return child;
}

function makeStubAdapter() {
  return {
    name: () => 'stub',
    capabilities: () => ({
      namedVectors: true, sparseVectors: true, hybridSearch: true, payloadIndexes: true,
      aliases: false, snapshots: false, collectionExists: true,
    }),
    ping: async () => ({ ok: true, detail: 'stub reachable' }),
    listCollections: async () => [],
    getCollection: async () => null,
    createCollection: async () => {},
    deleteCollection: async () => {},
    ensureCollectionSchema: async () => ({ repaired: [], warnings: [] }),
    listSourceDocuments: async () => [],
    getChunk: async () => [],
    searchHybrid: async () => [],
    getSkeletonRoot: async () => null,
    getSkeletonNode: async () => null,
    getSkeletonChildren: async () => [],
    getStructuralNode: async () => null,
    getSectionAnchor: async () => null,
  };
}

async function withServer(fn) {
  const app = createApp({ adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }) });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

describe('static UI serving', () => {
  it('GET / returns the HTML shell', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /^text\/html/);
      const html = await res.text();
      assert.match(html, /semidex/);
      assert.match(html, /app\.js/);
    });
  });

  it('GET /app.js returns JavaScript with the right content type', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/app.js');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /^text\/javascript/);
      assert.match(await res.text(), /api\/health/);
    });
  });

  it('GET /app.css returns CSS with the right content type', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/app.css');
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
      const res = await fetch(base + '/app.js', { method: 'POST' });
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

// ── Phase 2E: "Search this collection" (renamed from Search playground) ─────
// Browser-level tests are out of scope (no DOM runner in the toolchain);
// these assert the served app.js wires search to the right endpoint, keeps
// the evidence-vs-navigation copy, and defaults to the human-readable "full"
// window format with advanced controls collapsed. Behavior of /api/search
// itself is covered in search.test.js.
describe('search this collection (served app.js)', () => {
  it('app.js posts to /api/search and renders a search panel', async () => {
    await withServer(async (base) => {
      const res = await fetch(base + '/app.js');
      assert.equal(res.status, 200);
      const js = await res.text();
      assert.match(js, /apiPost\('\/api\/search'/, 'search must call POST /api/search');
      assert.match(js, /search-panel/, 'collection view must render the search panel container');
      assert.match(js, /windowFormat/, 'search must send windowFormat');
      assert.match(js, /sourceFile/, 'search must support the file filter');
    });
  });

  it('is labeled "Search this collection", not "Search playground"', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /Search this collection/);
      assert.ok(!/Search playground/.test(js), 'old "Search playground" label must not remain');
    });
  });

  it('defaults the window format to full, not compact', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /data-v="full" class="on"/, 'full must be the default-selected segmented option');
      assert.ok(!/data-v="compact" class="on"/.test(js), 'compact must not be the default');
    });
  });

  it('defaults the score display to off (an advanced/debug opt-in, not shown by default)', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const checkboxTag = js.slice(js.indexOf('id="q-show-score"') - 40, js.indexOf('id="q-show-score"') + 30);
      assert.ok(!/\bchecked\b/.test(checkboxTag), `score checkbox must not be checked by default: ${checkboxTag}`);
    });
  });

  it('hides advanced controls (window, format, score, file filter) behind a collapsible disclosure', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /<details class="advanced-box">/);
      assert.match(js, /<summary>Advanced<\/summary>/);
    });
  });

  it('the default visible controls are just query, top-k, and submit', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /search-main-row/);
      assert.match(js, /id="q-top"/);
    });
  });

  it('app.js keeps evidence-vs-navigation copy', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /retrieval evidence/i, 'results must be framed as evidence');
      assert.match(js, /navigation only/i, 'sidebar tree must be framed as navigation');
    });
  });

  it('app.js escapes rendered strings (esc used on result fields)', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /esc\(r\.sourceFile/, 'result sourceFile must go through esc()');
      assert.match(js, /esc\(r\.text/, 'result text must go through esc()');
      assert.match(js, /esc\(w\.textSnippet/, 'window snippets must go through esc()');
    });
  });
});

// ── Phase 2C: indexing jobs UI presence ──────────────────────────────────────
// Same served-file-level approach as Phase 2B: no DOM runner in this
// toolchain, so these assert the served app.js/index.html wire the indexing
// view to the right endpoints and keep the required safety copy. Job
// manager/API behavior itself is covered in jobs.test.js.
describe('indexing jobs view (served app.js / index.html)', () => {
  it('index.html links to the indexing view', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      assert.match(html, /#\/index/, 'sidebar must link to the indexing view');
    });
  });

  it('app.js posts to /api/jobs/index with the six typed options', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /apiPost\('\/api\/jobs\/index'/, 'must POST to /api/jobs/index');
      assert.match(js, /onnxEmbed/);
      assert.match(js, /llmSummaries/);
      assert.match(js, /skeletonChunking/);
      assert.match(js, /skeletonNav/);
      assert.match(js, /pruneStale/);
      assert.match(js, /tagGen/);
    });
  });

  it('app.js fetches the job list and a single job\'s detail/log', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /api\('\/api\/jobs'\)/, 'must GET the job list');
      assert.match(js, /\/api\/jobs\/\$\{/, 'must GET a single job by id');
    });
  });

  it('app.js supports cancelling a job via POST /api/jobs/:id/cancel', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /\/cancel/);
    });
  });

  it('app.js keeps the required safety copy', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /Indexing writes to the selected collection/);
      assert.match(js, /Prune stale should be used only with the full source root/);
    });
  });

  it('app.js refreshes the sidebar after a job succeeds', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /loadSidebar\(\)/);
    });
  });
});

// ── folder picker + human collection naming (developer-form redesign) ───────
describe('folder picker (served app.js)', () => {
  it('has a primary "Choose folder" button wired to POST /api/system/pick-folder', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /idx-choose-folder/);
      assert.match(js, /apiPost\('\/api\/system\/pick-folder'/);
    });
  });

  it('has a manual-path fallback state that is shown when the picker fails', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /idx-path-fallback/);
      assert.match(js, /idx-path-manual/);
      // The fallback must actually be revealed on picker failure, not just present in markup.
      const fnStart = js.indexOf('async function chooseIndexFolder');
      assert.ok(fnStart !== -1, 'chooseIndexFolder should be defined');
      const fn = js.slice(fnStart, fnStart + 800);
      assert.match(fn, /catch/);
      assert.match(fn, /fallback\.style\.display\s*=\s*''/);
    });
  });

  it('the settings reindex form also offers a folder-picker button, not manual-only', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /settings-choose-folder/);
    });
  });
});

describe('POST /api/system/pick-folder — response shape', () => {
  it('returns a domain-shaped { path, cancelled } response, not a raw dialog/OS object', async () => {
    const pickFolderFn = async () => ({ path: 'C:\\Users\\demo\\Docs', cancelled: false });
    const app = createApp({ adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }), pickFolderFn });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.address().port}`;
    try {
      const res = await fetch(base + '/api/system/pick-folder', { method: 'POST' });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(Object.keys(body).sort(), ['cancelled', 'path']);
    } finally {
      await new Promise((resolve) => app.close(resolve));
    }
  });
});

describe('LLM summaries — Ollama dependency status (served app.js)', () => {
  it('shows "LLM summaries require Ollama" copy with a status badge, not a silent checkbox', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /LLM summaries require Ollama/);
      assert.match(js, /idx-ollama-status/);
      assert.match(js, /\/api\/system\/ollama-status/);
    });
  });

  it('checking the LLM summaries checkbox triggers an Ollama status check', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /opt-llm-summaries['"]\)\s*\n?\s*\.addEventListener\('change'|opt-llm-summaries.*addEventListener\('change'/s);
      assert.match(js, /loadOllamaStatus/);
    });
  });

  it('maps each Ollama status (available/missing/model_missing) to a distinct badge class', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /available:\s*'badge badge-ok'/);
      assert.match(js, /missing:\s*'badge badge-fail'/);
      assert.match(js, /model_missing:\s*'badge badge-warn'/);
    });
  });

  it('surfaces a 503 dependency error from job start back through the Ollama status check, not a generic failure', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const start = js.indexOf('async function startIndexJob');
      const fn = js.slice(start, start + 1500);
      assert.match(fn, /err\.status === 503/);
      assert.match(fn, /loadOllamaStatus/);
    });
  });
});

describe('collection naming (served app.js)', () => {
  it('does not suggest lowercase-hyphen slug names anywhere in the served UI', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const html = await (await fetch(base + '/')).text();
      assert.ok(!/my-docs/.test(js), 'app.js must not use the old slug placeholder "my-docs"');
      assert.ok(!/lowercase-hyphen|lowercase and hyphens|use lowercase/i.test(js + html), 'no lowercase-hyphen guidance should remain');
    });
  });

  it('uses a human-readable example as the collection-name placeholder', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /idx-collection/);
      const start = js.indexOf('id="idx-collection"');
      const tag = js.slice(start - 20, start + 120);
      assert.match(tag, /placeholder="[^"]*[А-ЯҐЄІЇа-яґєії ][^"]*"/, 'placeholder should look like a human name, not a slug');
    });
  });
});

describe('POST /api/collections/:name — names with spaces (served API)', () => {
  it('starts an indexing job for a collection name containing spaces', async () => {
    const calls = [];
    const spawnFn = (command, args, opts) => { calls.push({ command, args, opts }); return makeFakeChildForSpawn(); };
    const jobRegistry = createJobRegistry({ spawnFn });
    const app = createApp({ adapter: makeStubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }), jobRegistry });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.address().port}`;
    try {
      const res = await fetch(base + '/api/jobs/index', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'Company Knowledge Base', path: './docs' }),
      });
      assert.equal(res.status, 202);
      const body = await res.json();
      assert.equal(body.job.collection, 'Company Knowledge Base');
      assert.equal(calls[0].opts.env.COLLECTION, 'Company Knowledge Base');
    } finally {
      await new Promise((resolve) => app.close(resolve));
    }
  });

  it('GET /api/collections/:name round-trips a name with spaces through URL encoding', async () => {
    const name = 'Основи Node.js';
    const adapter = makeStubAdapter();
    let seenName = null;
    adapter.getCollection = async (n) => { seenName = n; return { name: n, pointCount: 0 }; };
    const app = createApp({ adapter, embedQuery: async () => ({ dense: [], sparse: {} }) });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.address().port}`;
    try {
      const res = await fetch(base + `/api/collections/${encodeURIComponent(name)}`);
      assert.equal(res.status, 200);
      assert.equal(seenName, name);
      const body = await res.json();
      assert.equal(body.collection.name, name);
    } finally {
      await new Promise((resolve) => app.close(resolve));
    }
  });
});

// ── Phase 2E: navigation-first dashboard redesign ────────────────────────────
// Same served-file-level approach: no DOM runner, so these assert the served
// app.js wires the sidebar tree, collection header, file/section view, and
// collection settings correctly, and that the old flat panels/type-to-confirm
// UI are gone. API behavior is covered in server.test.js/jobs.test.js.
describe('sidebar navigation tree (served app.js)', () => {
  it('renders collections as an expandable tree, not a flat link list', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /function renderSidebarList/);
      assert.match(js, /tree-collection-row/);
      assert.match(js, /tree-children/);
    });
  });

  it('loads the skeleton tree for a selected collection, falling back to a flat file list', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /async function loadSidebarTree/);
      assert.match(js, /hasSkeleton/);
      assert.match(js, /async function loadSidebarFileList/);
      assert.match(js, /\/documents\?limit=/);
    });
  });

  it('drills into skeleton children via /api/collections/:name/skeleton/children', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /\/skeleton\/children\?/);
    });
  });

  it('clicking a file/section opens the file view, not a separate route', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /openFileView/);
    });
  });

  it('an empty section (404 from skeleton/anchor) does not auto-open chunk 0 — it requires an explicit click', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const start = js.indexOf('async function openSectionView');
      assert.ok(start !== -1, 'openSectionView should be defined');
      const end = js.indexOf('\nasync function openFileView');
      assert.ok(end !== -1 && end > start, 'openFileView should follow openSectionView');
      const fn = js.slice(start, end);
      assert.match(fn, /section-open-file-start/);
      assert.match(fn, /addEventListener\('click', \(\) => openFileView/);
      assert.ok(!/return openFileView\(name, node\.sourceFile, node\.nodePath, 0\);/.test(fn),
        'a 404 from skeleton/anchor must not automatically open chunk 0 of the file');
    });
  });
});

// ── skeleton node labels and chunk display clarity ───────────────────────────
describe('sidebar node labels (served app.js, evaluated behavior)', () => {
  it('a file node with nodePath "pitch-en.md#file" renders as "pitch-en.md", not "file"', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { nodeDisplayLabel } = loadSidebarLabelHelpers(js);
      const label = nodeDisplayLabel({ nodeType: 'file', nodePath: 'pitch-en.md#file', sourceFile: 'pitch-en.md' });
      assert.equal(label, 'pitch-en.md');
      assert.notEqual(label, 'file');
    });
  });

  it('a file node under a subfolder renders only the basename, not the folder path', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { nodeDisplayLabel } = loadSidebarLabelHelpers(js);
      const label = nodeDisplayLabel({
        nodeType: 'file',
        nodePath: 'Тема 10. Процеси в Linux/1. Вступ.md#file',
        sourceFile: 'Тема 10. Процеси в Linux/1. Вступ.md',
      });
      assert.equal(label, '1. Вступ.md');
    });
  });

  it('a section node uses the last heading_path entry, not the raw nodePath', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { nodeDisplayLabel } = loadSidebarLabelHelpers(js);
      const label = nodeDisplayLabel({
        nodeType: 'section',
        nodePath: 'pitch-en.md#intro/details',
        headingPath: ['Introduction', 'Details'],
        summary: 'Details — 3 paragraphs',
      });
      assert.equal(label, 'Details');
    });
  });

  it('a section node with no heading_path falls back to summary, not the raw nodePath', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { nodeDisplayLabel } = loadSidebarLabelHelpers(js);
      const label = nodeDisplayLabel({
        nodeType: 'section', nodePath: 'pitch-en.md#вступ', headingPath: [], summary: 'Вступ',
      });
      assert.equal(label, 'Вступ');
    });
  });

  it('a directory node renders its own directory name, not the full nested path', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { nodeDisplayLabel } = loadSidebarLabelHelpers(js);
      const label = nodeDisplayLabel({
        nodeType: 'directory',
        nodePath: 'demo#dir/Тема 10. Процеси в Linux (ps, top, kill, htop)',
      });
      assert.equal(label, 'Тема 10. Процеси в Linux (ps, top, kill, htop)');
    });
  });

  it('a nested directory node renders only its own segment, not the parent path', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { nodeDisplayLabel } = loadSidebarLabelHelpers(js);
      const label = nodeDisplayLabel({ nodeType: 'directory', nodePath: 'demo#dir/parent/child' });
      assert.equal(label, 'child');
    });
  });

  it('sidebarNodeRow keeps node_path and summary in the tooltip only, not the visible label', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { sidebarNodeRow } = loadSidebarLabelHelpers(js);
      const html = sidebarNodeRow({
        nodeType: 'file', nodePath: 'pitch-en.md#file', sourceFile: 'pitch-en.md', summary: 'Pitch deck', childCount: 0,
      }, 0, 0);
      assert.match(html, /title="Pitch deck — pitch-en\.md#file"/);
      assert.match(html, />pitch-en\.md</);
      assert.ok(!html.includes('>pitch-en.md#file<'), 'raw node_path must not be the visible label text');
    });
  });
});

describe('chunk view rendering (served app.js, evaluated behavior)', () => {
  it('renderFileChunks includes a node_type badge for every chunk', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { renderFileChunks } = loadChunkRenderHelpers(js);
      const html = renderFileChunks([
        { chunkIndex: 0, section: 'Intro', nodeType: 'paragraph', text: 'hello', context: 'Intro' },
      ]);
      assert.match(html, /badge badge-amber/);
      assert.match(html, />paragraph</);
    });
  });

  it('labels structural node types (table/code/checklist) distinctly', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { renderFileChunks } = loadChunkRenderHelpers(js);
      const table = renderFileChunks([{ chunkIndex: 1, nodeType: 'table', text: '| a | b |', context: 'Intro — table' }]);
      const code = renderFileChunks([{ chunkIndex: 2, nodeType: 'code_block', text: 'console.log(1)', context: 'Intro — code block' }]);
      const checklist = renderFileChunks([{ chunkIndex: 3, nodeType: 'checklist', text: '- [ ] todo', context: 'Intro — checklist' }]);
      assert.match(table, />table</);
      assert.match(code, />code</);
      assert.match(checklist, />checklist</);
    });
  });

  it('labels context as "retrieval context" for structural chunks and "section path" for plain prose', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { renderFileChunks } = loadChunkRenderHelpers(js);
      const prose = renderFileChunks([{ chunkIndex: 0, nodeType: 'paragraph', text: 'hello', context: 'Intro › Details' }]);
      const table = renderFileChunks([{ chunkIndex: 1, nodeType: 'table', text: '| a |', context: 'Intro — table' }]);
      assert.match(prose, /section path/i);
      assert.ok(!/retrieval context/i.test(prose), 'a plain prose chunk must not be labeled as retrieval context');
      assert.match(table, /retrieval context/i);
      assert.ok(!/section path/i.test(table), 'a structural chunk must not be labeled as a plain section path');
    });
  });

  it('the context annotation is visually secondary (a distinct label class), not ordinary chunk content', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const { renderFileChunks } = loadChunkRenderHelpers(js);
      const html = renderFileChunks([{ chunkIndex: 0, nodeType: 'paragraph', text: 'hello', context: 'Intro' }]);
      assert.match(html, /class="chunk-context-label"/);
      assert.match(html, /class="chunk-context"/);
    });
  });
});

describe('collection header (served app.js)', () => {
  it('renders name, summary, health badge, and point count — no dense/sparse/provider strings', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /function renderCollectionHeader/);
      const fn = js.slice(js.indexOf('function renderCollectionHeader'), js.indexOf('function renderCollectionHeader') + 1200);
      assert.ok(!/dense vector|sparse vector|denseProvider|chunkingSchema/.test(fn),
        'collection header must not render technical vector/provider/schema details');
    });
  });

  it('has a settings button that navigates to the settings route', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /col-settings-btn/);
      assert.match(js, /\/settings`/);
    });
  });
});

describe('old flat technical panels are removed (served app.js)', () => {
  it('no longer renders a separate Documents card', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.ok(!/col-docs/.test(js), 'old standalone Documents panel container must be gone');
      assert.ok(!/async function loadDocuments/.test(js), 'old loadDocuments() must be removed');
    });
  });

  it('no longer renders skeleton navigation as its own main-panel card', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.ok(!/col-skel/.test(js), 'old standalone skeleton-nav panel container must be gone');
    });
  });

  it('the Metadata panel is not duplicated as a separate technical card in the collection view', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.ok(!/col-meta/.test(js), 'old standalone Metadata panel container must be gone');
    });
  });
});

describe('collection settings (served app.js)', () => {
  it('renders a settings view with reindex, repair, diagnostics, and delete', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /async function renderSettingsView/);
      assert.match(js, /Advanced diagnostics/);
    });
  });

  it('starts a reindex job with the current collection name, no separate retyped field', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /runSettingsReindex/);
      assert.match(js, /collection:\s*name,[\s\S]{0,80}path,/);
    });
  });

  it('reindex options are grouped and include LLM summaries', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /opt-group-label">Quality/);
      assert.match(js, /opt-group-label">Structure/);
      assert.match(js, /opt-llm-summaries/);
    });
  });

  it('offers a recent-source-path selector with a manual fallback, not only a plain path input', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /function renderSourcePathField/);
      assert.match(js, /settings-path-recent/);
      assert.match(js, /settings-path-manual/);
    });
  });

  it('the manual source-path input has no HTML "required" attribute (JS-level validation only)', async () => {
    // A `required` attribute on an input that can be hidden via display:none
    // (when a recent-path <select> is shown instead) risks blocking form
    // submission on native constraint validation before the JS handler ever
    // runs. Validation is done entirely by runSettingsReindex's own
    // "Source path is required" check instead.
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      const inputTag = js.slice(js.indexOf('id="settings-path-manual"') - 60, js.indexOf('id="settings-path-manual"') + 150);
      assert.ok(!/\brequired\b/.test(inputTag), `manual path input must not have "required": ${inputTag}`);
    });
  });

  it('requires a source path before starting a reindex', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /Source path is required/);
    });
  });

  it('renames sync-schema to "Repair collection compatibility" with an explanatory tooltip', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /Repair collection compatibility/);
      assert.match(js, /Checks and repairs semidex metadata, vector names, and payload indexes/);
      assert.ok(!/>sync schema</i.test(js), 'old unexplained "sync schema" label must not remain verbatim');
    });
  });

  it('keeps the reindex/prune-stale safety copy', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /Reindex starts a background job and writes to this collection/);
      assert.match(js, /Use prune stale only with the full source root/);
    });
  });

  it('delete uses a modal confirmation, not a typed-name text input', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /delete-modal-backdrop/);
      assert.match(js, /openDeleteModal/);
      assert.ok(!/maint-delete-confirm/.test(js), 'old type-to-confirm text input must be gone');
      assert.ok(!/confirmInput/.test(js), 'old type-to-confirm input reference must be gone');
    });
  });

  it('the delete modal calls DELETE with no request body', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /async function apiDelete\(path\)/, 'apiDelete must take no payload parameter');
      assert.match(js, /apiDelete\(`\/api\/collections\/\$\{encodeURIComponent\(name\)\}`\)/);
    });
  });

  it('navigates away from the deleted collection after a successful delete', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /runDeleteCollection[\s\S]{0,600}location\.hash = '#\/'/);
    });
  });

  it('advanced diagnostics (dense/sparse vector, provider, schema versions) are collapsed by default', async () => {
    await withServer(async (base) => {
      const js = await (await fetch(base + '/app.js')).text();
      assert.match(js, /<details class="panel advanced-panel">/);
      assert.match(js, /function renderAdvancedDiagnostics/);
    });
  });
});
