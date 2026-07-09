// Cross-cutting accessibility checks for the Admin UI (Phase 3B). Most of
// these are source-string guards over app.css/dom.js rather than rendered-
// DOM assertions — there's no headless browser in this test toolchain, and
// CSS custom-property contrast/focus-visible/reduced-motion are simplest to
// pin as "the rule exists in the stylesheet" regression guards.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readUiSource } from './ui-test-helpers.js';

const CSS_PATH = fileURLToPath(new URL('../../../src/admin/ui-src/app.css', import.meta.url));
const css = () => readFileSync(CSS_PATH, 'utf-8');

function relativeLuminance(hex) {
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [lr, lg, lb] = [r, g, b].map(lin);
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}
function contrast(hex1, hex2) {
  const [l1, l2] = [relativeLuminance(hex1), relativeLuminance(hex2)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

describe('text contrast (WCAG AA, 4.5:1 for normal text)', () => {
  it('--ink-faint clears 4.5:1 against both --bg and --bg-raise', () => {
    const src = css();
    const faint = src.match(/--ink-faint:\s*#([0-9a-f]{6})/i)?.[1];
    const bg = src.match(/--bg:\s*#([0-9a-f]{6})/i)?.[1];
    const bgRaise = src.match(/--bg-raise:\s*#([0-9a-f]{6})/i)?.[1];
    assert.ok(faint && bg && bgRaise, 'expected to find --ink-faint/--bg/--bg-raise declarations');
    assert.ok(contrast(faint, bg) >= 4.5, `--ink-faint vs --bg must be >=4.5:1, got ${contrast(faint, bg).toFixed(2)}`);
    assert.ok(contrast(faint, bgRaise) >= 4.5, `--ink-faint vs --bg-raise must be >=4.5:1, got ${contrast(faint, bgRaise).toFixed(2)}`);
  });

  it('--ink-dim still clears 4.5:1 (regression guard — was already correct)', () => {
    const src = css();
    const dim = src.match(/--ink-dim:\s*#([0-9a-f]{6})/i)?.[1];
    const bg = src.match(/--bg:\s*#([0-9a-f]{6})/i)?.[1];
    assert.ok(contrast(dim, bg) >= 4.5);
  });
});

describe('keyboard focus states', () => {
  it('a global :focus-visible rule covers buttons, links, inputs, selects, and sidebar tree rows', () => {
    const src = css();
    assert.match(src, /button:focus-visible,[\s\S]{0,200}\.tree-row:focus-visible,?[\s\S]{0,80}\{/,
      'expected one shared :focus-visible rule spanning the common interactive elements');
  });

  it('the sidebar resize handle keeps its own dedicated focus-visible indicator (regression guard)', () => {
    assert.match(css(), /\.sidebar-resize-handle:focus-visible/);
  });

  it('the sidebar caret (independently clickable for a directory/file-with-sections — Phase 3D) shares the same focus-visible rule', () => {
    // The caret split into its own click target so a file-with-sections row
    // can be opened directly instead of only expanding — that made the
    // caret an independently focusable/actionable element, needing its own
    // visible focus indicator alongside .tree-row's.
    assert.match(css(), /\.tree-caret\[data-caret\]:focus-visible/);
  });
});

describe('active sidebar row is visible beyond color alone', () => {
  it('.tree-collection-row.active sets both background and a border, not color alone', () => {
    const rule = css().match(/\.tree-collection-row\.active\s*\{([^}]*)\}/)?.[1] ?? '';
    assert.match(rule, /background/);
    assert.match(rule, /border-left-color/);
  });

  it('.tree-file.active and .tree-node.active now have styling (were previously undefined in CSS)', () => {
    const src = css();
    assert.match(src, /\.tree-file\.active,\s*\n\.tree-node\.active\s*\{[^}]*background[^}]*border-left-color/);
  });
});

describe('prefers-reduced-motion', () => {
  it('app.css has a reduced-motion media block disabling panel/progress animations', () => {
    const src = css();
    assert.match(src, /@media \(prefers-reduced-motion: reduce\)/);
    const block = src.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
    assert.match(block, /\.main \.panel \{ animation: none; \}/);
    assert.match(block, /\.job-progress-indeterminate-fill \{[^}]*animation: none/);
  });

  it('dom.js exports a prefersReducedMotion() helper', () => {
    assert.match(readUiSource('dom.js'), /export function prefersReducedMotion\(\)/);
  });

  it('every scrollIntoView({behavior:"smooth"}) call site is guarded by prefersReducedMotion()', () => {
    for (const file of ['file-view.js', 'search.js']) {
      const src = readUiSource(file);
      const calls = src.match(/scrollIntoView\(\{[^}]*\}\)/g) ?? [];
      assert.ok(calls.length > 0, `expected at least one scrollIntoView call in ${file}`);
      for (const call of calls) {
        assert.match(call, /behavior:\s*prefersReducedMotion\(\)/, `${file}: ${call} must branch on prefersReducedMotion()`);
      }
    }
  });
});

describe('accessible names', () => {
  it('the file-filter clear button has an aria-label, not just a title', () => {
    const js = readUiSource('search.js');
    const tag = js.slice(js.indexOf('id="q-file-clear"') - 20, js.indexOf('id="q-file-clear"') + 100);
    assert.match(tag, /aria-label="Clear file filter"/);
  });
});
