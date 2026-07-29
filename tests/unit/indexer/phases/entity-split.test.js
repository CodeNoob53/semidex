// src/indexer/phases/entity-split.js — token-aware splitting of oversized
// table/code_block/checklist entities into bounded fragments.
//
// Full token-aware split (code review, P1): there is no remaining
// "oversized unit, reported but not split further" case — every single
// unit (a table row, a checklist item, a code line) that alone doesn't
// fit the budget is itself split further (by cell for a table row,
// character-boundary for a checklist item / code line) until every
// fragment fits. This file was also written after a real infinite-loop
// bug caught by manual testing: an early table-row splitter rendered a
// split cell back to markdown text ("xxx (Value continued 1/2)") and fed
// it through the GFM row parser again on the next call, which mistook its
// own label for cell content and appended a NEW label on top each time,
// never converging. The fix carries split state as a structured
// { cells, labeled } object end to end, rendered to markdown only once,
// at final fragment assembly — several tests below exist specifically to
// pin that fix (bounded iteration via a real, low timeout).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitStructuralEntity } from '../../../../src/indexer/phases/entity-split.js';

// Deterministic, cheap stand-in for a real tokenizer — char/4 is not what
// production uses (production uses a real per-model tokenizer), but for
// exercising the greedy bin-packing boundary logic itself, any monotonic,
// deterministic counter is sufficient and keeps these tests fast/offline.
function makeBudget(maxInputTokens) {
  return { maxInputTokens, countTokens: (text) => Math.ceil(text.length / 4) };
}

async function assertEveryFragmentFits(fragments, budget) {
  for (const fragment of fragments) {
    const count = await budget.countTokens(fragment);
    assert.ok(count <= budget.maxInputTokens, `fragment exceeds budget (${count} > ${budget.maxInputTokens}): ${JSON.stringify(fragment.slice(0, 120))}`);
  }
}

describe('splitStructuralEntity — table', () => {
  test('splits a large table into fragments, each repeating the header+separator', async () => {
    const header = ['| Name | Value |', '|---|---|'];
    const rows = [];
    for (let i = 1; i <= 50; i++) rows.push(`| item${i} | value${i} |`);
    const rawContent = [...header, ...rows].join('\n');

    const result = await splitStructuralEntity({ nodeType: 'table', rawContent }, makeBudget(40));

    assert.equal(result.split, true);
    assert.ok(result.fragments.length > 1, 'expected more than one fragment for a 50-row table under a tiny budget');
    for (const fragment of result.fragments) {
      assert.ok(fragment.startsWith('| Name | Value |\n|---|---|'), 'every fragment must repeat the header + separator');
    }
    // Every original row must appear in exactly the union of fragments, never dropped.
    const combined = result.fragments.join('\n');
    for (const row of rows) {
      assert.ok(combined.includes(row), `row missing from any fragment: ${row}`);
    }
    await assertEveryFragmentFits(result.fragments, makeBudget(40));
  });

  test('does not split when no header/separator is detected — malformed table treated as unsplittable', async () => {
    const rawContent = 'just some text\nwithout a real table structure\nrow one\nrow two';
    const result = await splitStructuralEntity({ nodeType: 'table', rawContent }, makeBudget(10));
    assert.deepEqual(result, { split: false });
  });

  test('a single row with one oversized cell is split further by cell content — never left whole, never dropped', async () => {
    const header = ['| Name | Value |', '|---|---|'];
    const hugeRow = `| big | ${'x'.repeat(500)} |`;
    const rawContent = [...header, hugeRow, '| small | row |'].join('\n');
    const budget = makeBudget(20);
    const result = await splitStructuralEntity({ nodeType: 'table', rawContent }, budget);

    assert.equal(result.split, true);
    // All 500 'x' characters from the oversized cell must survive somewhere
    // in the fragment set — split into pieces, never truncated or dropped.
    const combined = result.fragments.join('');
    assert.equal((combined.match(/x/g) || []).length, 500, 'every character of the oversized cell value must be preserved across fragments');
    await assertEveryFragmentFits(result.fragments, budget);
  }, { timeout: 10000 });

  test('cell-splitting completes in bounded time and iterations — regression test for the infinite-loop bug (re-parsing an already-labeled cell as new content)', async () => {
    const header = ['| Name | Value |', '|---|---|'];
    const hugeRow = `| big | ${'x'.repeat(50)} |`;
    const rawContent = [...header, hugeRow].join('\n');
    const start = Date.now();
    const result = await splitStructuralEntity({ nodeType: 'table', rawContent }, makeBudget(20));
    const elapsedMs = Date.now() - start;
    assert.equal(result.split, true);
    assert.ok(elapsedMs < 2000, `expected fast convergence, took ${elapsedMs}ms`);
  }, { timeout: 5000 });

  test('a split cell is labeled "(column continued)" so a reader never mistakes a partial value for the complete one', async () => {
    const header = ['| Name | Value |', '|---|---|'];
    const hugeRow = `| big | ${'x'.repeat(60)} |`;
    const rawContent = [...header, hugeRow].join('\n');
    const result = await splitStructuralEntity({ nodeType: 'table', rawContent }, makeBudget(20));
    assert.equal(result.split, true);
    assert.ok(result.fragments.some((f) => f.includes('(Value continued)')), 'expected at least one fragment to label the split Value cell');
  });

  test('splitting a row with an oversized cell never touches the OTHER cells\' content', async () => {
    const header = ['| Name | Value |', '|---|---|'];
    const hugeRow = `| identifiable-name | ${'x'.repeat(200)} |`;
    const rawContent = [...header, hugeRow].join('\n');
    const result = await splitStructuralEntity({ nodeType: 'table', rawContent }, makeBudget(20));
    assert.equal(result.split, true);
    const fragmentsWithName = result.fragments.filter((f) => f.includes('identifiable-name'));
    assert.ok(fragmentsWithName.length >= 1, 'the small, untouched cell value must survive in at least one fragment');
  });

  test('an escaped pipe ("\\|") inside a cell survives a split round-trip as a literal pipe, never a phantom extra column — code review, P1 regression', async () => {
    const header = ['| Name | Value |', '|---|---|'];
    const hugeRow = `| a\\|b | ${'z'.repeat(200)} |`;
    const rawContent = [...header, hugeRow, '| c | d |'].join('\n');
    const budget = makeBudget(40);
    const result = await splitStructuralEntity({ nodeType: 'table', rawContent }, budget);

    assert.equal(result.split, true);
    // The escaped pipe must round-trip as "a\|b" (still escaped) in every
    // fragment that carries it — never unescaped to a bare "a|b", which
    // would parse back as an extra, phantom column in a real GFM renderer.
    const fragmentsWithCell = result.fragments.filter((f) => f.includes('a\\|b'));
    assert.ok(fragmentsWithCell.length >= 1, 'the escaped-pipe cell value must survive, still escaped, in at least one fragment');
    assert.ok(!result.fragments.some((f) => /[^\\]a\|b|^a\|b/.test(f)), 'no fragment may contain an UNescaped "a|b" — that would read as a phantom extra column');
    assert.equal((result.fragments.join('').match(/z/g) || []).length, 200, 'every character of the oversized sibling cell must be preserved across fragments');
    await assertEveryFragmentFits(result.fragments, budget);
  }, { timeout: 10000 });

  test('a row with TWO independently oversized columns splits both, in sequence, with no duplication and no infinite loop — code review, P1 regression found while verifying the escaped-pipe fix', async () => {
    // Digit fillers that never collide with any header/separator/label text
    // ("First"/"Second"/"continued" contain no digits), so a raw character
    // count directly proves preservation with no duplication.
    const header = ['| First | Second |', '|---|---|'];
    const rawContent = [...header, `| ${'3'.repeat(100)} | ${'7'.repeat(100)} |`].join('\n');
    const budget = makeBudget(45);
    const start = Date.now();
    const result = await splitStructuralEntity({ nodeType: 'table', rawContent }, budget);
    const elapsedMs = Date.now() - start;

    assert.equal(result.split, true);
    assert.ok(elapsedMs < 2000, `expected fast, bounded convergence, took ${elapsedMs}ms`);
    assert.equal((result.fragments.join('').match(/3/g) || []).length, 100, 'every "3" character from the first oversized column must be preserved exactly once (no duplication)');
    assert.equal((result.fragments.join('').match(/7/g) || []).length, 100, 'every "7" character from the second oversized column must be preserved exactly once (no duplication)');
    await assertEveryFragmentFits(result.fragments, budget);
  }, { timeout: 10000 });

  test('a table row too small to ever fit — even with every cell emptied — is reported as a typed, hard-stop error rather than looping forever', async () => {
    const header = ['| Name | Value |', '|---|---|'];
    const rawContent = [...header, `| ${'a'.repeat(50)} | ${'z'.repeat(50)} |`].join('\n');
    // A pathologically tiny budget: even the header + separator + one
    // continuation label alone cannot fit.
    const budget = makeBudget(2);
    await assert.rejects(
      () => splitStructuralEntity({ nodeType: 'table', rawContent }, budget),
      (err) => err.code === 'TABLE_ROW_UNSPLITTABLE',
      'expected a typed TABLE_ROW_UNSPLITTABLE error, not an infinite loop or a silent wrong answer',
    );
  }, { timeout: 5000 });
});

describe('splitStructuralEntity — checklist', () => {
  test('splits a large checklist into fragments without ever splitting an item mid-way', async () => {
    const items = [];
    for (let i = 1; i <= 10; i++) items.push(`- [ ] Task number ${i}: do something moderately descriptive here`);
    const rawContent = items.join('\n');

    const result = await splitStructuralEntity({ nodeType: 'checklist', rawContent }, makeBudget(40));

    assert.equal(result.split, true);
    assert.ok(result.fragments.length > 1);
    const combined = result.fragments.join('\n');
    for (const item of items) {
      assert.ok(combined.includes(item), `checklist item missing or split: ${item}`);
    }
    // No fragment should contain a partial/truncated item line.
    for (const fragment of result.fragments) {
      for (const line of fragment.split('\n')) {
        assert.ok(items.includes(line), `fragment contains a line that is not a complete original item: ${JSON.stringify(line)}`);
      }
    }
  });

  test('preserves an item\'s own continuation lines attached to that item, across a real multi-fragment split', async () => {
    const rawContent = [
      '- [ ] First item',
      '  continuation of first item',
      '- [x] Second item',
      '- [ ] Third item',
      '  continuation of third item',
    ].join('\n');
    // A small budget forces a real split (more than one fragment) so this
    // test actually exercises fragment boundaries, not just parsing.
    const result = await splitStructuralEntity({ nodeType: 'checklist', rawContent }, makeBudget(20));

    assert.equal(result.split, true);
    assert.ok(result.fragments.length > 1, 'expected a real multi-fragment split under a small budget');
    const combined = result.fragments.join('\n');
    assert.ok(combined.includes('- [ ] First item\n  continuation of first item'), 'first item + continuation must stay together');
    assert.ok(combined.includes('- [ ] Third item\n  continuation of third item'), 'third item + continuation must stay together');
  });

  test('does not split a single checklist item that already fits the budget whole', async () => {
    const result = await splitStructuralEntity({ nodeType: 'checklist', rawContent: '- [ ] only one item' }, makeBudget(100));
    assert.deepEqual(result, { split: false });
  });

  test('a genuinely single, oversized checklist item (no siblings) is still split — code review, P1 regression: an earlier "items.length < 2" guard bailed out before checking whether the lone item itself needed splitting', async () => {
    const rawContent = `- [ ] ${'y'.repeat(300)}`;
    const budget = makeBudget(15);
    const result = await splitStructuralEntity({ nodeType: 'checklist', rawContent }, budget);

    assert.equal(result.split, true);
    assert.ok(result.fragments.length > 1, 'a lone oversized item with no siblings must still be split into more than one fragment');
    assert.equal((result.fragments.join('').match(/y/g) || []).length, 300, 'every character of the oversized item must be preserved across fragments');
    await assertEveryFragmentFits(result.fragments, budget);
  }, { timeout: 10000 });

  test('an oversized item among sibling items is split further at character boundaries — never left whole, never dropped', async () => {
    const items = ['- [ ] short item', `- [ ] ${'y'.repeat(300)}`, '- [ ] another short item'];
    const rawContent = items.join('\n');
    const budget = makeBudget(15);
    const result = await splitStructuralEntity({ nodeType: 'checklist', rawContent }, budget);

    assert.equal(result.split, true);
    assert.equal((result.fragments.join('').match(/y/g) || []).length, 300, 'every character of the oversized item must be preserved across fragments');
    await assertEveryFragmentFits(result.fragments, budget);
  }, { timeout: 10000 });

  const CHECKLIST_START_RE = /^([-*+]\s+\[[ xX]\]\s|[-*+]\s+)/;
  const CONTINUATION_RE = /^ {2}\(continued\) /;

  test('every continuation piece of a split item carries an explicit "(continued)" marker — code review, P2: a bare non-first piece has no marker and is not valid standalone checklist markdown', async () => {
    const rawContent = `- [ ] ${'y'.repeat(300)}`;
    const budget = makeBudget(15);
    const result = await splitStructuralEntity({ nodeType: 'checklist', rawContent }, budget);

    assert.equal(result.split, true);
    assert.ok(result.fragments.length > 2, 'expected several continuation fragments under this tiny budget');
    // The first fragment keeps the real "- [ ] " marker; every later
    // fragment must start with the continuation marker instead.
    assert.ok(CHECKLIST_START_RE.test(result.fragments[0]), 'the first fragment must keep the real checklist item marker');
    for (const fragment of result.fragments.slice(1)) {
      assert.ok(CONTINUATION_RE.test(fragment), `continuation fragment missing the "(continued)" marker: ${JSON.stringify(fragment.slice(0, 40))}`);
    }
  }, { timeout: 10000 });

  test('a split item\'s continuation pieces are never merged into the same fragment as a different sibling item — code review, P2', async () => {
    const items = ['- [ ] short item before', `- [ ] ${'y'.repeat(200)}`, '- [ ] short item after'];
    const rawContent = items.join('\n');
    const budget = makeBudget(15);
    const result = await splitStructuralEntity({ nodeType: 'checklist', rawContent }, budget);

    assert.equal(result.split, true);
    // No fragment may contain BOTH a continuation marker (tail of the
    // oversized item) AND a different sibling item's own text.
    for (const fragment of result.fragments) {
      const hasContinuation = CONTINUATION_RE.test(fragment);
      const hasSiblingItem = fragment.includes('short item before') || fragment.includes('short item after');
      assert.ok(!(hasContinuation && hasSiblingItem), `fragment merges a continuation with an unrelated sibling item: ${JSON.stringify(fragment)}`);
    }
    // Every fragment line must be either a real checklist item start or a
    // continuation — never a bare, unmarked fragment of text.
    for (const fragment of result.fragments) {
      for (const line of fragment.split('\n')) {
        if (!line) continue;
        assert.ok(CHECKLIST_START_RE.test(line) || CONTINUATION_RE.test(line), `fragment line has neither a checklist marker nor a continuation marker: ${JSON.stringify(line)}`);
      }
    }
    assert.equal((result.fragments.join('').match(/y/g) || []).length, 200, 'every character of the oversized item must be preserved across fragments');
    await assertEveryFragmentFits(result.fragments, budget);
  }, { timeout: 10000 });
});

describe('splitStructuralEntity — code_block', () => {
  test('splits a large code block into line-based fragments — regression test for the double-render bug', async () => {
    const lines = [];
    for (let i = 1; i <= 12; i++) lines.push(`const variable${i} = computeSomething(${i}); // line ${i}`);
    const rawContent = '```javascript\n' + lines.join('\n') + '\n```';

    const result = await splitStructuralEntity({ nodeType: 'code_block', rawContent }, makeBudget(40));

    assert.equal(result.split, true);
    assert.ok(result.fragments.length > 1, 'expected more than one fragment for 12 lines under a tiny budget');

    for (const fragment of result.fragments) {
      const fragLines = fragment.split('\n');
      // Every fragment must open and close with its own fence.
      assert.equal(fragLines[0], '```javascript');
      assert.equal(fragLines[fragLines.length - 1], '```');
      // The regression check: body lines must be full original source
      // lines, never single characters (the exact symptom of the bug where
      // a string was spread via `...group`).
      const bodyLines = fragLines.slice(1, -1);
      assert.ok(bodyLines.length > 0, 'fragment must have at least one body line');
      for (const bodyLine of bodyLines) {
        assert.ok(lines.includes(bodyLine), `body line is not one of the original full source lines: ${JSON.stringify(bodyLine)}`);
      }
    }

    // Every original line must appear in the union of fragments exactly once.
    const allBodyLines = result.fragments.flatMap((f) => f.split('\n').slice(1, -1));
    assert.deepEqual(allBodyLines, lines);
  });

  test('does not duplicate the opening/closing fence across every fragment beyond one each', async () => {
    const lines = [];
    for (let i = 1; i <= 8; i++) lines.push(`line ${i}`);
    const rawContent = '```\n' + lines.join('\n') + '\n```';
    const result = await splitStructuralEntity({ nodeType: 'code_block', rawContent }, makeBudget(15));

    assert.equal(result.split, true);
    assert.ok(result.fragments.length > 1, 'expected a real multi-fragment split under this budget');
    for (const fragment of result.fragments) {
      const fenceCount = (fragment.match(/```/g) || []).length;
      assert.equal(fenceCount, 2, 'each fragment must carry exactly its own opening and closing fence');
    }
  });

  test('does not split a single-body-line code block that already fits the budget whole', async () => {
    const result = await splitStructuralEntity({ nodeType: 'code_block', rawContent: '```\nonly one line\n```' }, makeBudget(100));
    assert.deepEqual(result, { split: false });
  });

  test('handles a code block with no closing fence gracefully (malformed input) — never loses the last line as a fence', async () => {
    const rawContent = '```js\nline one\nline two\nline three';
    // A tiny budget forces a real split so this test actually exercises
    // fragment boundaries around the missing closing fence, not just
    // parsing behavior on an entity that ends up unsplit.
    const result = await splitStructuralEntity({ nodeType: 'code_block', rawContent }, makeBudget(8));
    // No closing fence detected → the last line ("line three") is body, not
    // a fence, and must survive intact in the output rather than being
    // swallowed as a phantom close fence.
    assert.equal(result.split, true);
    assert.ok(result.fragments.length > 1, 'expected a real multi-fragment split under this budget');
    const combined = result.fragments.join('\n');
    assert.ok(combined.includes('line three'), 'last body line must be preserved when no closing fence is present');
  });

  test('a genuinely single, oversized code-block body line (no sibling lines, e.g. minified code) is still split — code review, P1 regression: an earlier "bodyLines.length < 2" guard bailed out before checking whether the lone line itself needed splitting', async () => {
    const rawContent = '```js\n' + 'x'.repeat(300) + '\n```';
    const budget = makeBudget(15);
    const result = await splitStructuralEntity({ nodeType: 'code_block', rawContent }, budget);

    assert.equal(result.split, true);
    assert.ok(result.fragments.length > 1, 'a lone oversized line with no sibling lines must still be split into more than one fragment');
    assert.equal((result.fragments.join('').match(/x/g) || []).length, 300, 'every character of the oversized line must be preserved across fragments');
    await assertEveryFragmentFits(result.fragments, budget);
  }, { timeout: 10000 });

  test('an oversized line among sibling lines (e.g. minified code) is split further at character boundaries — never left whole, never dropped', async () => {
    const longLine = 'x'.repeat(300);
    const rawContent = '```js\nshort line\n' + longLine + '\nanother short line\n```';
    const budget = makeBudget(15);
    const result = await splitStructuralEntity({ nodeType: 'code_block', rawContent }, budget);

    assert.equal(result.split, true);
    assert.equal((result.fragments.join('').match(/x/g) || []).length, 300, 'every character of the oversized line must be preserved across fragments');
    await assertEveryFragmentFits(result.fragments, budget);
  }, { timeout: 10000 });
});

describe('splitStructuralEntity — unknown node type', () => {
  test('returns { split: false } for a node type with no defined split boundary', async () => {
    const result = await splitStructuralEntity({ nodeType: 'paragraph', rawContent: 'some text' }, makeBudget(10));
    assert.deepEqual(result, { split: false });
  });
});

describe('splitStructuralEntity — entity already fits whole under the budget', () => {
  // Regression test: greedyGroup can legitimately produce exactly ONE
  // fragment when everything fits together (that's not a bug in grouping
  // itself), but the caller (skeleton-chunk.js) treats split:true as "emit
  // a canonical entity_raw point plus fragments" — so a single-fragment
  // "split" would create a redundant entity_raw + 1-fragment pair for an
  // entity that never needed splitting at all.
  test('table: generous budget → split: false, not a single redundant fragment', async () => {
    const rawContent = '| Name | Value |\n|---|---|\n| a | 1 |\n| b | 2 |';
    const result = await splitStructuralEntity({ nodeType: 'table', rawContent }, makeBudget(100000));
    assert.deepEqual(result, { split: false });
  });

  test('checklist: generous budget → split: false, not a single redundant fragment', async () => {
    const rawContent = '- [ ] one\n- [ ] two\n- [ ] three';
    const result = await splitStructuralEntity({ nodeType: 'checklist', rawContent }, makeBudget(100000));
    assert.deepEqual(result, { split: false });
  });

  test('code_block: generous budget → split: false, not a single redundant fragment', async () => {
    const rawContent = '```js\nline one\nline two\nline three\n```';
    const result = await splitStructuralEntity({ nodeType: 'code_block', rawContent }, makeBudget(100000));
    assert.deepEqual(result, { split: false });
  });
});

describe('splitStructuralEntity — budget respected end to end', () => {
  test('every fragment individually fits the declared budget', async () => {
    const items = [];
    for (let i = 1; i <= 20; i++) items.push(`- [ ] item ${i}`);
    const rawContent = items.join('\n');
    const budget = makeBudget(30);
    const result = await splitStructuralEntity({ nodeType: 'checklist', rawContent }, budget);

    assert.equal(result.split, true);
    await assertEveryFragmentFits(result.fragments, budget);
  });
});
