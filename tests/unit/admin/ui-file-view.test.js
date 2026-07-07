// Tests for src/admin/ui-src/file-view.js's rendering (renderFileChunks).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadFileViewRenderHelpers, withServer } from './ui-test-helpers.js';

describe('chunk view rendering (ui-src source + built index.html, evaluated behavior)', () => {
  it('renderFileChunks includes a node_type badge for every chunk', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadFileViewRenderHelpers(html);
      const frag = renderFileChunks([
        { chunkIndex: 0, section: 'Intro', nodeType: 'paragraph', text: 'hello', context: 'Intro' },
      ]);
      const badge = frag.querySelector('.chunk-node-type');
      assert.equal(badge.hidden, false);
      assert.equal(badge.textContent, 'paragraph');
      assert.match(badge.className, /badge-amber/);
    });
  });

  it('labels structural node types (table/code/checklist) distinctly', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadFileViewRenderHelpers(html);
      const table = renderFileChunks([{ chunkIndex: 1, nodeType: 'table', text: '| a | b |', context: 'Intro — table' }]);
      const code = renderFileChunks([{ chunkIndex: 2, nodeType: 'code_block', text: 'console.log(1)', context: 'Intro — code block' }]);
      const checklist = renderFileChunks([{ chunkIndex: 3, nodeType: 'checklist', text: '- [ ] todo', context: 'Intro — checklist' }]);
      assert.equal(table.querySelector('.chunk-node-type').textContent, 'table');
      assert.equal(code.querySelector('.chunk-node-type').textContent, 'code');
      assert.equal(checklist.querySelector('.chunk-node-type').textContent, 'checklist');
    });
  });

  it('labels context as "retrieval context" for structural chunks and "section path" for plain prose', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadFileViewRenderHelpers(html);
      const prose = renderFileChunks([{ chunkIndex: 0, nodeType: 'paragraph', text: 'hello', context: 'Intro › Details' }]);
      const table = renderFileChunks([{ chunkIndex: 1, nodeType: 'table', text: '| a |', context: 'Intro — table' }]);
      assert.match(prose.querySelector('.chunk-context-label').textContent, /section path/i);
      assert.doesNotMatch(prose.querySelector('.chunk-context-label').textContent, /retrieval context/i);
      assert.match(table.querySelector('.chunk-context-label').textContent, /retrieval context/i);
      assert.doesNotMatch(table.querySelector('.chunk-context-label').textContent, /^section path/i);
    });
  });

  it('the context annotation is visually secondary (a distinct label class), not ordinary chunk content', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderFileChunks } = loadFileViewRenderHelpers(html);
      const frag = renderFileChunks([{ chunkIndex: 0, nodeType: 'paragraph', text: 'hello', context: 'Intro' }]);
      const contextEl = frag.querySelector('.chunk-context');
      assert.equal(contextEl.hidden, false);
      assert.ok(contextEl.querySelector('.chunk-context-label'), 'context must carry a distinct label element, not just plain text');
    });
  });
});
