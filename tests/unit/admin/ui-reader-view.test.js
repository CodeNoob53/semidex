import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node, parseHTML } from 'linkedom';
import { mount } from '../../../src/shared/admin/ui-src/features/reader/view.js';
import { setExpandedCollection } from '../../../src/shared/admin/ui-src/state.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.resolve(here, '../../../src/shared/admin/ui-src/partials/shared/templates');
const templateNames = [
  'assembly-segment.html',
  'assembly-warning.html',
  'chunk-card.html',
  'file-view-header.html',
  'reader-mode-toggle.html',
  'search-result.html',
];
const templates = templateNames.map(name => fs.readFileSync(path.join(templatesDir, name), 'utf8')).join('\n');

const original = {
  document: globalThis.document,
  Node: globalThis.Node,
  fetch: globalThis.fetch,
  location: globalThis.location,
  history: globalThis.history,
};

Object.defineProperty(globalThis, 'localStorage', {
  value: { getItem: () => null, setItem() {}, removeItem() {} },
  configurable: true,
  writable: true,
});

function response(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function detail() {
  return {
    name: 'my-docs', pointCount: 2, chunkCount: 2, semidexManaged: true,
    hasSkeleton: true, warnings: [], description: null, overviewSummary: 'Docs',
    vectorSchema: { dense: { size: 1024, distance: 'cosine' }, sparse: true },
    provider: { denseProvider: 'onnx', denseModel: 'bge-m3-onnx', sparseProvider: 'bm25' },
    embeddingProfile: {
      state: 'valid',
      profile: { embedding: { dense: { vectorName: 'dense', execution: 'client' }, sparse: { vectorName: 'sparse' } } },
    },
    versions: { embeddingSchema: 2, chunkingSchema: 4, indexingSchema: 4, tokenCountMode: 'bge-m3' },
    availability: { status: 'available' },
  };
}

function prose(chunkIndex, text, extra = {}) {
  return {
    kind: 'prose', chunkIndex, nodeId: null, nodePath: null, nodeType: 'paragraph',
    text, context: null, section: null, headingPath: null, ...extra,
  };
}

function entity(chunkIndex, nodeType, rawContent, extra = {}) {
  return {
    kind: 'entity', chunkIndex, nodeId: `node-${chunkIndex}`, nodePath: `guide.md#node-${chunkIndex}`,
    nodeType, rawContent, lang: null, context: null, section: null, headingPath: null, ...extra,
  };
}

function assembly(scope, segments, extra = {}) {
  return {
    collection: 'my-docs', scope, sourceFile: 'guide.md',
    nodePath: scope === 'section' ? 'guide.md#intro' : null,
    assemblyMode: 'entity_refs', warnings: [], segments, ...extra,
  };
}

function chunksResponse(chunks, extra = {}) {
  return { collection: 'my-docs', sourceFile: 'guide.md', chunkIndex: null, window: null, chunks, ...extra };
}

function makeHost() {
  const { document, Element } = parseHTML(`<div id="root"></div><ul id="collection-list"></ul>${templates}`);
  Element.prototype.scrollIntoView = () => {};
  globalThis.document = document;
  globalThis.Node = Node;
  return document.getElementById('root');
}

function routedFetch(routes, calls = []) {
  return async (url, init) => {
    calls.push({ url: String(url), signal: init?.signal });
    for (const [part, handler] of routes) {
      if (String(url).includes(part)) return typeof handler === 'function' ? handler(url, init) : handler;
    }
    return new Promise(() => {});
  };
}

async function settle(times = 8) {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setImmediate(resolve));
}

beforeEach(() => {
  setExpandedCollection('my-docs');
  globalThis.location = { hash: '#/c/my-docs/f/guide.md?q=restored' };
  globalThis.history = {
    state: null,
    pushState: (_state, _title, url) => { globalThis.location.hash = url; },
    replaceState: (_state, _title, url) => { globalThis.location.hash = url; },
  };
});

afterEach(() => {
  globalThis.document = original.document;
  globalThis.Node = original.Node;
  globalThis.fetch = original.fetch;
  globalThis.location = original.location;
  globalThis.history = original.history;
  setExpandedCollection(null);
});

describe('lifecycle reader view', () => {
  it('opens a file through validated assembly while restoring ?q= without searching', async () => {
    const host = makeHost();
    const calls = [];
    globalThis.fetch = routedFetch([
      ['/assembly?', response(200, {
        ...assembly('file', [prose(0, '<b>inert</b>')], { assemblyMode: 'plain_chunks' }),
      })],
      ['/api/collections/my-docs', response(200, { collection: detail() })],
    ], calls);

    const view = mount(host, { name: 'my-docs', sourceFile: 'guide.md' });
    await settle();

    assert.equal(host.querySelector('#q-input').value, 'restored');
    assert.ok(!calls.some(call => call.url.includes('/api/search')));
    assert.ok(calls.some(call => call.url.includes('scope=file&sourceFile=guide.md')));
    assert.equal(host.querySelector('#content-title').textContent, 'guide.md');
    assert.match(host.querySelector('.assembly-doc').textContent, /<b>inert<\/b>/);
    assert.equal(host.querySelectorAll('.assembly-doc b').length, 0);
    view.dispose();
  });

  it('resolves a section node, then requests the exact section assembly', async () => {
    const host = makeHost();
    const calls = [];
    globalThis.location.hash = '#/c/my-docs/n/guide.md%23intro';
    globalThis.fetch = routedFetch([
      ['/skeleton/node?', response(200, { collection: 'my-docs', node: {
        nodePath: 'guide.md#intro', nodeType: 'section', sourceFile: 'guide.md', headingPath: ['Вступ'],
      } })],
      ['/assembly?', response(200, assembly('section', [prose(1, 'Текст розділу')]))],
      ['/api/collections/my-docs', response(200, { collection: detail() })],
    ], calls);

    const view = mount(host, { name: 'my-docs', nodePath: 'guide.md#intro' });
    await settle();

    assert.equal(host.querySelector('#content-title').textContent, 'Вступ');
    assert.ok(calls.some(call => call.url.includes('scope=section&nodePath=guide.md%23intro')));
    assert.match(host.querySelector('.assembly-doc').textContent, /Текст розділу/);
    view.dispose();
  });

  it('lazily fetches chunks once and paginates locally through delegated events', async () => {
    const host = makeHost();
    let chunkCalls = 0;
    const chunks = Array.from({ length: 7 }, (_, chunkIndex) => ({ chunkIndex, text: `chunk-${chunkIndex}` }));
    globalThis.fetch = routedFetch([
      ['/chunks?', () => { chunkCalls += 1; return response(200, chunksResponse(chunks)); }],
      ['/assembly?', response(200, assembly('file', [prose(0, 'document')], { assemblyMode: 'plain_chunks' }))],
      ['/api/collections/my-docs', response(200, { collection: detail() })],
    ]);

    const view = mount(host, { name: 'my-docs', sourceFile: 'guide.md' });
    await settle();
    host.querySelector('[data-mode="chunks"]').click();
    await settle();
    assert.equal(chunkCalls, 1);
    assert.equal(host.querySelectorAll('.chunk').length, 5);
    host.querySelector('#file-load-more').click();
    assert.equal(host.querySelectorAll('.chunk').length, 7);
    host.querySelector('[data-mode="document"]').click();
    host.querySelector('[data-mode="chunks"]').click();
    await settle();
    assert.equal(chunkCalls, 1, 'cached chunks must survive mode toggles');
    view.dispose();
  });

  it('dispose aborts the owned reader request and prevents late commits', async () => {
    const host = makeHost();
    let assemblySignal;
    globalThis.fetch = routedFetch([
      ['/assembly?', (_url, init) => {
        assemblySignal = init.signal;
        return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }));
      }],
      ['/api/collections/my-docs', response(200, { collection: detail() })],
    ]);

    const view = mount(host, { name: 'my-docs', sourceFile: 'guide.md' });
    await settle(2);
    view.dispose();
    assert.equal(assemblySignal.aborted, true);
    await settle();
    assert.ok(host.querySelector('#collection-content .state-loading'));
  });

  it('rejects a malformed assembly contract with an actionable Retry state', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch([
      ['/assembly?', response(200, { scope: 'file', segments: 'not-an-array' })],
      ['/api/collections/my-docs', response(200, { collection: detail() })],
    ]);
    const view = mount(host, { name: 'my-docs', sourceFile: 'guide.md' });
    await settle();
    assert.ok(host.querySelector('#collection-content .state-error'));
    assert.ok(host.querySelector('#collection-content .state-retry'));
    view.dispose();
  });

  it('shows loading immediately, clean empty states for file and section, and an Open file link for an empty section', async () => {
    const host = makeHost();
    let resolveAssembly;
    globalThis.fetch = routedFetch([
      ['/assembly?', () => new Promise(resolve => { resolveAssembly = resolve; })],
      ['/api/collections/my-docs', response(200, { collection: detail() })],
    ]);
    const loading = mount(host, { name: 'my-docs', sourceFile: 'guide.md' });
    assert.ok(host.querySelector('#collection-content .state-loading'));
    resolveAssembly(response(200, assembly('file', [])));
    await settle();
    assert.match(host.querySelector('#collection-content').textContent, /No searchable chunks/);
    loading.dispose();

    globalThis.fetch = routedFetch([
      ['/skeleton/node?', response(200, { collection: 'my-docs', node: {
        nodePath: 'guide.md#intro', nodeType: 'section', sourceFile: 'guide.md', headingPath: ['Intro'],
      } })],
      ['/assembly?', response(200, assembly('section', []))],
      ['/api/collections/my-docs', response(200, { collection: detail() })],
    ]);
    const emptySection = mount(host, { name: 'my-docs', nodePath: 'guide.md#intro' });
    await settle();
    assert.match(host.querySelector('#collection-content').textContent, /section has no indexed content/i);
    assert.equal(host.querySelector('#section-open-file-start').getAttribute('href'), '#/c/my-docs/f/guide.md');
    emptySection.dispose();
  });

  it('normalizes network failures, offers Retry, and succeeds on retry', async () => {
    const host = makeHost();
    let attempts = 0;
    globalThis.fetch = routedFetch([
      ['/assembly?', () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('connection reset');
        return response(200, assembly('file', [prose(0, 'recovered')]));
      }],
      ['/api/collections/my-docs', response(200, { collection: detail() })],
    ]);
    const view = mount(host, { name: 'my-docs', sourceFile: 'guide.md' });
    await settle();
    assert.ok(host.querySelector('.state-error .state-retry'));
    host.querySelector('.state-retry').click();
    await settle();
    assert.equal(attempts, 2);
    assert.match(host.querySelector('.assembly-doc').textContent, /recovered/);
    view.dispose();
  });

  it('renders fallback and integrity warnings without exposing warning details', async () => {
    const host = makeHost();
    globalThis.fetch = routedFetch([
      ['/assembly?', response(200, assembly('file', [prose(0, 'legacy')], {
        assemblyMode: 'placeholder_fallback',
        warnings: [
          { code: 'placeholder_fallback', message: '<img src=x onerror=alert(1)>' },
          { code: 'orphan_placeholder', message: 'internal node secret' },
        ],
      }))],
      ['/api/collections/my-docs', response(200, { collection: detail() })],
    ]);
    const view = mount(host, { name: 'my-docs', sourceFile: 'guide.md' });
    await settle();
    assert.equal(host.querySelectorAll('.assembly-warning').length, 2);
    assert.doesNotMatch(host.textContent, /internal node secret|onerror/);
    assert.equal(host.querySelectorAll('img').length, 0);
    view.dispose();
  });

  it('aborts a pending section-node request and a pending lazy chunks request', async () => {
    const host = makeHost();
    let nodeSignal;
    globalThis.fetch = routedFetch([
      ['/skeleton/node?', (_url, init) => {
        nodeSignal = init.signal;
        return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      }],
      ['/api/collections/my-docs', response(200, { collection: detail() })],
    ]);
    const section = mount(host, { name: 'my-docs', nodePath: 'guide.md#intro' });
    await settle(2);
    section.dispose();
    assert.equal(nodeSignal.aborted, true);

    let chunksSignal;
    globalThis.fetch = routedFetch([
      ['/chunks?', (_url, init) => {
        chunksSignal = init.signal;
        return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      }],
      ['/assembly?', response(200, assembly('file', [prose(0, 'document')]))],
      ['/api/collections/my-docs', response(200, { collection: detail() })],
    ]);
    const file = mount(host, { name: 'my-docs', sourceFile: 'guide.md' });
    await settle();
    host.querySelector('[data-mode="chunks"]').click();
    await settle(2);
    file.dispose();
    assert.equal(chunksSignal.aborted, true);
  });

  it('prevents slow A from overwriting fast B and resets reader/search/pagination state', async () => {
    const host = makeHost();
    let resolveSlow;
    globalThis.fetch = routedFetch([
      ['sourceFile=slow.md', () => new Promise(resolve => { resolveSlow = resolve; })],
      ['/api/collections/my-docs', response(200, { collection: detail() })],
    ]);
    const slow = mount(host, { name: 'my-docs', sourceFile: 'slow.md' });
    await settle(2);
    slow.dispose();

    globalThis.fetch = routedFetch([
      ['/assembly?', response(200, assembly('file', [prose(0, 'fast result')], { sourceFile: 'fast.md' }))],
      ['/api/collections/my-docs', response(200, { collection: detail() })],
    ]);
    const fast = mount(host, { name: 'my-docs', sourceFile: 'fast.md' });
    await settle();
    assert.match(host.querySelector('.assembly-doc').textContent, /fast result/);
    assert.equal(host.querySelector('[data-mode="document"]').getAttribute('aria-pressed'), 'true');
    assert.equal(host.querySelector('#search-results').textContent, '');
    resolveSlow(response(200, assembly('file', [prose(0, 'stale result')], { sourceFile: 'slow.md' })));
    await settle();
    assert.doesNotMatch(host.textContent, /stale result/);
    fast.dispose();
  });

  it('restores ?q= for a node route without running search', async () => {
    const host = makeHost();
    const calls = [];
    globalThis.location.hash = '#/c/my-docs/n/guide.md%23intro?q=%D0%BF%D0%BE%D1%88%D1%83%D0%BA';
    globalThis.fetch = routedFetch([
      ['/skeleton/node?', response(200, { collection: 'my-docs', node: {
        nodePath: 'guide.md#intro', nodeType: 'section', sourceFile: 'guide.md', headingPath: ['Intro'],
      } })],
      ['/assembly?', response(200, assembly('section', [prose(1, 'section')]))],
      ['/api/collections/my-docs', response(200, { collection: detail() })],
    ], calls);
    const view = mount(host, { name: 'my-docs', nodePath: 'guide.md#intro' });
    await settle();
    assert.equal(host.querySelector('#q-input').value, 'пошук');
    assert.ok(!calls.some(call => call.url.includes('/api/search')));
    view.dispose();
  });

  it('preserves matched-chunk anchoring and structural Rendered/Raw controls', async () => {
    const host = makeHost();
    globalThis.history.state = { semidexReader: { chunkIndex: 2 } };
    globalThis.fetch = routedFetch([
      ['/assembly?', response(200, assembly('file', [
        prose(0, 'before'),
        entity(2, 'table', '| Name | Value |\n| --- | --- |\n| safe | <img src=x> |'),
      ]))],
      ['/api/collections/my-docs', response(200, { collection: detail() })],
    ]);
    const view = mount(host, { name: 'my-docs', sourceFile: 'guide.md' });
    await settle();
    assert.equal(host.querySelectorAll('.assembly-target').length, 1);
    assert.equal(host.querySelector('.assembly-target').dataset.chunkIndex, '2');
    assert.ok(host.querySelector('.structural-table'));
    assert.equal(host.querySelectorAll('img').length, 0);
    host.querySelectorAll('.structural-toggle-btn')[1].click();
    assert.match(host.querySelector('.structural-raw').textContent, /<img src=x>/);
    assert.equal(host.querySelectorAll('img').length, 0);
    view.dispose();
  });

  it('renders hostile long Cyrillic paths and headings as inert complete text', async () => {
    const host = makeHost();
    const sourceFile = 'дуже-довгий-шлях/'.repeat(8) + '<img src=x onerror=alert(1)>.md';
    const heading = 'Розділ <script>alert(1)</script>';
    globalThis.fetch = routedFetch([
      ['/skeleton/node?', response(200, { collection: 'my-docs', node: {
        nodePath: `${sourceFile}#intro`, nodeType: 'section', sourceFile, headingPath: [heading],
      } })],
      ['/assembly?', response(200, assembly('section', [prose(1, '<b>текст</b>')], { sourceFile, nodePath: `${sourceFile}#intro` }))],
      ['/api/collections/my-docs', response(200, { collection: detail() })],
    ]);
    const view = mount(host, { name: 'my-docs', nodePath: `${sourceFile}#intro` });
    await settle();
    assert.equal(host.querySelector('#content-title').textContent, heading);
    assert.match(host.querySelector('.file-view-meta').textContent, /дуже-довгий-шлях/);
    assert.equal(host.querySelectorAll('img,script,b').length, 0);
    view.dispose();
  });

  it('does not accumulate active delegated listeners across repeated mount/dispose', async () => {
    const host = makeHost();
    let chunkCalls = 0;
    globalThis.fetch = routedFetch([
      ['/chunks?', () => { chunkCalls += 1; return response(200, chunksResponse([{ chunkIndex: 0, text: 'one' }])); }],
      ['/assembly?', () => response(200, assembly('file', [prose(0, 'document')]))],
      ['/api/collections/my-docs', () => response(200, { collection: detail() })],
    ]);
    for (let i = 0; i < 8; i += 1) {
      const view = mount(host, { name: 'my-docs', sourceFile: 'guide.md' });
      await settle();
      host.querySelector('[data-mode="chunks"]').click();
      await settle();
      view.dispose();
    }
    assert.equal(chunkCalls, 8, 'one lazy request per mounted reader, never multiplied by stale listeners');
  });
});
