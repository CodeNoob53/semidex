// Tests for src/admin/ui-src/structural-renderer.js — the shared
// table/code renderer used by search.js's renderResult() and file-view.js's
// renderFileChunks(). Loaded as a real ES module (not inlined via the vm-
// context stripExports() convention the other ui-src modules use) because it
// has real npm dependencies (unified/remark-parse/remark-gfm/highlight.js)
// that a bare vm.runInContext script can't resolve. `document` is provided
// via linkedom before the import, since the module's highlight.js grammar
// registration and DOM-building helpers both run at module scope / call
// time respectively.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML, Event } from 'linkedom';
import { renderChunkContent, STRUCTURAL_RENDER_TYPES } from '../../../src/admin/ui-src/structural-renderer.js';

const { document } = parseHTML('<div></div>');

// Renders `chunk` into a fresh detached <pre class="chunk-text"> (matching
// the real call sites' container shape) and returns the element that ends
// up in its place (renderChunkContent replaces the container via
// replaceWith), so tests can assert on the resulting subtree directly.
function renderInto(chunk) {
  const host = document.createElement('div');
  const container = document.createElement('pre');
  container.className = 'chunk-text';
  host.appendChild(container);
  renderChunkContent(container, chunk);
  return host.firstElementChild;
}

describe('structural-renderer.js — type detection', () => {
  it('STRUCTURAL_RENDER_TYPES is exactly table and code_block (not checklist — unchanged this phase)', () => {
    assert.deepEqual([...STRUCTURAL_RENDER_TYPES].sort(), ['code_block', 'table']);
  });

  it('a checklist chunk is treated as plain text (no toggle, no table/code parsing)', () => {
    const root = renderInto({ nodeType: 'checklist', rawContent: '- [x] done\n- [ ] todo' });
    assert.equal(root.tagName.toLowerCase(), 'pre');
    assert.equal(root.textContent, '- [x] done\n- [ ] todo');
    assert.equal(Boolean(root.querySelector?.('.structural-toggle')), false);
  });

  it('a plain prose (paragraph) chunk renders via textContent only, no toggle', () => {
    const root = renderInto({ nodeType: 'paragraph', text: 'plain <b>prose</b> text' });
    assert.equal(root.textContent, 'plain <b>prose</b> text');
    assert.equal(Boolean(root.querySelector('b')), false, 'must never parse prose as markup');
  });

  it('a chunk with no nodeType at all renders via textContent only', () => {
    const root = renderInto({ text: 'no node type here' });
    assert.equal(root.textContent, 'no node type here');
  });
});

describe('structural-renderer.js — content source contract', () => {
  it('prefers rawContent over text when both are present', () => {
    const root = renderInto({ nodeType: 'paragraph', rawContent: 'raw wins', text: 'text loses' });
    assert.equal(root.textContent, 'raw wins');
  });

  it('falls back to text when rawContent is absent', () => {
    const root = renderInto({ nodeType: 'paragraph', text: 'only text' });
    assert.equal(root.textContent, 'only text');
  });

  it('renders empty string, not "null"/"undefined", when both rawContent and text are absent', () => {
    const root = renderInto({ nodeType: 'paragraph' });
    assert.equal(root.textContent, '');
  });

  it('a structural chunk with only text and no rawContent still renders (table)', () => {
    const root = renderInto({ nodeType: 'table', text: '| a | b |\n| --- | --- |\n| 1 | 2 |' });
    assert.ok(root.querySelector('table'), 'renders from text when rawContent is absent');
  });
});

describe('structural-renderer.js — table rendering', () => {
  const md = '| Name | Qty | Price |\n| :-- | :-: | --: |\n| Widget | 3 | 9.99 |\n| Gadget | 1 | 19.5 |';

  it('renders a real <table>/<thead>/<tbody>/<tr>/<th>/<td> structure', () => {
    const root = renderInto({ nodeType: 'table', rawContent: md });
    const table = root.querySelector('table');
    assert.ok(table);
    assert.ok(table.querySelector('thead tr'));
    assert.equal(table.querySelectorAll('tbody tr').length, 2, 'two body rows');
    assert.equal(table.querySelectorAll('thead th').length, 3, 'three header cells');
  });

  it('header row text matches the source header cells', () => {
    const root = renderInto({ nodeType: 'table', rawContent: md });
    const headers = [...root.querySelectorAll('thead th')].map(th => th.textContent);
    assert.deepEqual(headers, ['Name', 'Qty', 'Price']);
  });

  it('body cell text matches the source body cells, in order', () => {
    const root = renderInto({ nodeType: 'table', rawContent: md });
    const firstRow = [...root.querySelectorAll('tbody tr')[0].children].map(td => td.textContent);
    assert.deepEqual(firstRow, ['Widget', '3', '9.99']);
  });

  it('preserves column alignment metadata as inline text-align styles', () => {
    const root = renderInto({ nodeType: 'table', rawContent: md });
    const headers = [...root.querySelectorAll('thead th')];
    assert.equal(headers[0].style.textAlign, 'left');
    assert.equal(headers[1].style.textAlign, 'center');
    assert.equal(headers[2].style.textAlign, 'right');
  });

  it('wraps the table in a horizontal-scroll wrapper', () => {
    const root = renderInto({ nodeType: 'table', rawContent: md });
    assert.ok(root.querySelector('.structural-table-wrapper table'));
  });

  it('a single-column table renders correctly (edge case: minimal valid GFM table)', () => {
    const root = renderInto({ nodeType: 'table', rawContent: '| Only |\n| --- |\n| one |' });
    const table = root.querySelector('table');
    assert.ok(table);
    assert.equal(table.querySelectorAll('tbody tr').length, 1);
  });

  it('a header-only table (no body rows) renders without throwing', () => {
    const root = renderInto({ nodeType: 'table', rawContent: '| A | B |\n| --- | --- |' });
    const table = root.querySelector('table');
    assert.ok(table);
    assert.equal(table.querySelectorAll('tbody tr').length, 0);
  });

  it('table with inline markdown in a cell (bold/code) renders only the plain text, never the markup', () => {
    const root = renderInto({ nodeType: 'table', rawContent: '| A |\n| --- |\n| **bold** and `code` |' });
    const cell = root.querySelector('tbody td');
    assert.equal(cell.textContent, 'bold and code');
    assert.equal(Boolean(cell.querySelector('strong')), false);
    assert.equal(Boolean(cell.querySelector('code')), false);
  });
});

describe('structural-renderer.js — table security', () => {
  it('an <img onerror> in a cell never becomes a live element', () => {
    const root = renderInto({ nodeType: 'table', rawContent: '| A |\n| --- |\n| <img src=x onerror=alert(1)> |' });
    assert.equal(Boolean(root.querySelector('img')), false);
    assert.equal(root.querySelector('td').textContent, '<img src=x onerror=alert(1)>');
  });

  it('a </table><script> injection attempt in a cell never becomes a live script element', () => {
    const root = renderInto({ nodeType: 'table', rawContent: '| A |\n| --- |\n| </table><script>alert(1)</script> |' });
    assert.equal(Boolean(root.querySelector('script')), false);
  });

  it('invalid table markdown (no separator row) falls back safely to raw text, never throws', () => {
    assert.doesNotThrow(() => {
      const root = renderInto({ nodeType: 'table', rawContent: 'just some prose, not a table at all' });
      assert.equal(root.textContent, 'just some prose, not a table at all');
      assert.ok(root.querySelector('.structural-raw'), 'renders through the raw-fallback path, not a live table');
    });
  });

  it('empty rawContent for a table chunk falls back safely, never throws', () => {
    assert.doesNotThrow(() => {
      const root = renderInto({ nodeType: 'table', rawContent: '' });
      assert.equal(root.textContent, '');
    });
  });

  it('a table parse failure renders no toggle control (raw-only, no false "Rendered" affordance)', () => {
    const root = renderInto({ nodeType: 'table', rawContent: 'not a table' });
    assert.equal(Boolean(root.querySelector('.structural-toggle')), false);
  });
});

describe('structural-renderer.js — code rendering', () => {
  it('strips a fenced code block\'s delimiters in rendered mode', () => {
    const root = renderInto({ nodeType: 'code_block', rawContent: '```js\nconst x = 1;\n```', lang: 'js' });
    const code = root.querySelector('code');
    assert.equal(code.textContent, 'const x = 1;');
  });

  it('highlights an explicit "javascript" language', () => {
    const root = renderInto({ nodeType: 'code_block', rawContent: 'const x = 1;', lang: 'javascript' });
    const badge = root.querySelector('.structural-code-lang-badge');
    assert.equal(badge.textContent, 'javascript');
    assert.ok(badge.classList.contains('structural-code-lang-explicit'));
    assert.ok(root.querySelector('code').innerHTML.includes('hljs-'), 'highlight.js token spans are present');
  });

  it('resolves the "py" alias to python', () => {
    const root = renderInto({ nodeType: 'code_block', rawContent: 'def f():\n    pass', lang: 'py' });
    assert.equal(root.querySelector('.structural-code-lang-badge').textContent, 'python');
  });

  it('resolves the "sh" alias to bash', () => {
    const root = renderInto({ nodeType: 'code_block', rawContent: 'echo hello', lang: 'sh' });
    assert.equal(root.querySelector('.structural-code-lang-badge').textContent, 'bash');
  });

  it('resolves the "yml" alias to yaml', () => {
    const root = renderInto({ nodeType: 'code_block', rawContent: 'key: value', lang: 'yml' });
    assert.equal(root.querySelector('.structural-code-lang-badge').textContent, 'yaml');
  });

  it('resolves the "cs" alias to csharp', () => {
    const root = renderInto({ nodeType: 'code_block', rawContent: 'class X {}', lang: 'cs' });
    assert.equal(root.querySelector('.structural-code-lang-badge').textContent, 'csharp');
  });

  it('resolves the "html" alias to xml (highlight.js\'s markup grammar)', () => {
    const root = renderInto({ nodeType: 'code_block', rawContent: '<div>x</div>', lang: 'html' });
    assert.equal(root.querySelector('.structural-code-lang-badge').textContent, 'xml');
  });

  it('unlabeled code (no lang) autodetects and shows a "guessed:" marker', () => {
    const root = renderInto({ nodeType: 'code_block', rawContent: 'def foo(x):\n    return x + 1\n' });
    const badge = root.querySelector('.structural-code-lang-badge');
    assert.match(badge.textContent, /^guessed: /);
    assert.ok(badge.classList.contains('structural-code-lang-guessed'));
  });

  it('an unknown/unsupported explicit language does not throw and still renders code text', () => {
    assert.doesNotThrow(() => {
      const root = renderInto({ nodeType: 'code_block', rawContent: 'some code here', lang: 'brainfuck' });
      assert.ok(root.querySelector('code'));
    });
  });

  it('empty code content renders a "plaintext" badge, not a guessed language', () => {
    const root = renderInto({ nodeType: 'code_block', rawContent: '' });
    assert.equal(root.querySelector('.structural-code-lang-badge').textContent, 'plaintext');
  });

  it('code_block always shows a Rendered/Raw toggle (even on plaintext fallback)', () => {
    const root = renderInto({ nodeType: 'code_block', rawContent: '' });
    assert.ok(root.querySelector('.structural-toggle'));
  });
});

describe('structural-renderer.js — code security', () => {
  it('a lang value that is not a registered/aliased grammar can never reach hljs.highlight() with untrusted input', () => {
    // "__proto__" and similar exotic keys are exactly the kind of untrusted
    // `lang` value the task explicitly worries about (prototype-pollution-
    // shaped keys, attempts to reference something outside the curated set).
    for (const maliciousLang of ['__proto__', 'constructor', '../../etc/passwd', '<script>', '']) {
      assert.doesNotThrow(() => {
        const root = renderInto({ nodeType: 'code_block', rawContent: 'hello world', lang: maliciousLang });
        assert.ok(root.querySelector('code'));
      }, `lang=${JSON.stringify(maliciousLang)} must not throw`);
    }
  });

  it('a </code><script> injection attempt in code content never becomes a live script element', () => {
    const root = renderInto({ nodeType: 'code_block', rawContent: '</code><script>alert(1)</script>', lang: 'js' });
    assert.equal(Boolean(root.querySelector('script')), false);
    assert.equal(root.querySelector('code').textContent, '</code><script>alert(1)</script>');
  });

  it('an <img onerror> inside a code string never becomes a live element', () => {
    const root = renderInto({ nodeType: 'code_block', rawContent: 'const s = "<img src=x onerror=alert(1)>";' });
    assert.equal(Boolean(root.querySelector('img')), false);
  });
});

describe('structural-renderer.js — Rendered/Raw toggle', () => {
  it('table: Raw mode textContent is byte-exact to the original rawContent, including pipes/whitespace/linebreaks', () => {
    const raw = '| A | B |\n| :-- | --: |\n|  1  |  2  |';
    const root = renderInto({ nodeType: 'table', rawContent: raw });
    const rawBtn = root.querySelector('.structural-toggle-btn:last-child');
    rawBtn.dispatchEvent(new Event('click', { bubbles: true }));
    const rawEl = root.querySelector('.structural-raw');
    assert.equal(rawEl.textContent, raw);
  });

  it('code: Raw mode textContent is byte-exact to the original rawContent, including fences', () => {
    const raw = '```js\nconst x = 1;\n```';
    const root = renderInto({ nodeType: 'code_block', rawContent: raw, lang: 'js' });
    const rawBtn = root.querySelector('.structural-toggle-btn:last-child');
    rawBtn.dispatchEvent(new Event('click', { bubbles: true }));
    const rawEl = root.querySelector('.structural-raw');
    assert.equal(rawEl.textContent, raw);
  });

  it('switching back to Rendered restores the parsed/highlighted view (no re-fetch, pure DOM swap)', () => {
    const raw = '| A |\n| --- |\n| 1 |';
    const root = renderInto({ nodeType: 'table', rawContent: raw });
    const [renderedBtn, rawBtn] = root.querySelectorAll('.structural-toggle-btn');
    rawBtn.dispatchEvent(new Event('click', { bubbles: true }));
    assert.equal(Boolean(root.querySelector('table')), false, 'table is swapped out while in raw mode');
    renderedBtn.dispatchEvent(new Event('click', { bubbles: true }));
    assert.ok(root.querySelector('table'), 'table is restored on switching back to rendered');
  });

  it('Rendered is the default/active state on successful parse', () => {
    const root = renderInto({ nodeType: 'table', rawContent: '| A |\n| --- |\n| 1 |' });
    const [renderedBtn] = root.querySelectorAll('.structural-toggle-btn');
    assert.ok(renderedBtn.classList.contains('active'));
    assert.ok(root.querySelector('table'), 'renders the table immediately, no click needed');
  });

  it('no network/fetch call happens on render or on Rendered/Raw toggle (pure DOM operation)', () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = () => { fetchCalled = true; throw new Error('fetch must not be called'); };
    try {
      const root = renderInto({ nodeType: 'table', rawContent: '| A |\n| --- |\n| 1 |' });
      root.querySelector('.structural-toggle-btn:last-child')
        .dispatchEvent(new Event('click', { bubbles: true }));
      root.querySelector('.structural-toggle-btn:first-child')
        .dispatchEvent(new Event('click', { bubbles: true }));
      assert.equal(fetchCalled, false, 'rendering/toggling must never call fetch');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
