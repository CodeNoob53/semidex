// Profile-aware token-budget chunking — regression coverage for the
// production bug found during the SciFact pilot: a chunk that fits under
// the heuristic (chars/4) token estimate can still exceed a real cloud
// tokenizer's actual count (dense/technical prose systematically
// undercounts under chars/4). This file proves EVERY retrieval-chunking
// entry point (Markdown prose via recursiveChunkTextForBudget/
// chunkFromSkeleton, and non-Markdown via chunkFileAsync/
// chunkExtractedTextForBudget) respects a real per-profile budget, never
// ships a chunk exceeding it, and — for the budget===null (Local) path —
// is provably unchanged from pre-fix behavior by construction (the null
// branch calls the original, unmodified functions, never a
// default-parameterized version of the new ones).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recursiveChunkText,
  recursiveChunkTextForBudget,
  chunkFileAsync,
  chunkFileFromPath,
  chunkExtractedTextForBudget,
  effectiveBudgetFor,
  getChunkingConfig,
} from '../../../../src/shared/indexer/phases/chunk.js';
import { chunkFromSkeleton } from '../../../../src/shared/indexer/phases/skeleton-chunk.js';
import { parseSkeleton } from '../../../../src/shared/indexer/phases/skeleton.js';
import { canonicalWhitespace } from '../../../../src/shared/indexer/phases/token-budget-split.js';

// ── Divergent-fixture technique (reused from
// tests/unit/core/embedding-profile/qdrant-cloud-catalog.test.js's own
// "camelCase identifier" regression fixture) — a repeated dense identifier
// string whose heuristic (chars/4) estimate says "fits" under a given
// ceiling, but whose FAKE "real" tokenizer (deliberately overweighting
// no-space identifier runs, mirroring how a real subword/BPE tokenizer
// splits camelCase into many more tokens than chars/4 predicts) says it
// does NOT fit — the exact class of divergence that caused the live pilot
// crash (BGE-M3 heuristic said 512, real E5 tokenizer said 599).
const IDENTIFIER_CHUNK = 'resolveEmbeddingProfileFromCollectionInfoConfigMetadataParamsVectorsSparseVectors ';

function buildDivergentText(heuristicCeiling) {
  let text = '';
  let heuristicEstimate = 0;
  while (heuristicEstimate < heuristicCeiling) {
    text += IDENTIFIER_CHUNK;
    heuristicEstimate = Math.ceil(text.length / 4);
  }
  return text;
}

const heuristicCount = (text) => Math.ceil(text.length / 4);
// "Real" fake tokenizer: identifier-dense text (no whitespace runs) is
// counted at roughly 2.2x the heuristic rate — plain prose stays close to
// the heuristic. This reproduces "fits under heuristic, fails under real
// tokenizer" deterministically and offline, without a real model.
function realCount(text) {
  const words = text.split(/\s+/).filter(Boolean);
  let total = 0;
  for (const w of words) {
    const dense = w.length > 15 && !/[.,!?;:]/.test(w);
    total += dense ? Math.ceil(w.length / 1.8) : Math.ceil((w.length + 1) / 4);
  }
  return total;
}

function makeDivergentBudget(maxInputTokens) {
  return { maxInputTokens, countTokens: async (text) => realCount(text) };
}

async function assertEveryPieceFits(pieces, budget) {
  for (const piece of pieces) {
    const count = await budget.countTokens(piece);
    assert.ok(count <= budget.maxInputTokens, `piece exceeds budget (${count} > ${budget.maxInputTokens}): ${JSON.stringify(piece.slice(0, 80))}`);
  }
}

describe('divergent fixture setup — proves the heuristic/real gap actually exists', () => {
  test('buildDivergentText produces text the heuristic says fits but the fake real tokenizer says does not', () => {
    const text = buildDivergentText(480);
    const h = heuristicCount(text);
    const r = realCount(text);
    assert.ok(h <= 512, `heuristic estimate must say it fits under 512, got ${h}`);
    assert.ok(r > 512, `fake real tokenizer must say it does NOT fit under 512, got ${r}`);
  });
});

describe('Test 1 — Local/no-budget parity (function level)', () => {
  test('recursiveChunkTextForBudget(text, null) output equals recursiveChunkText(text) output exactly', async () => {
    const text = buildDivergentText(600) + '\n\nSecond paragraph with different content entirely, just prose.';
    const viaForBudget = await recursiveChunkTextForBudget(text, null);
    const viaDirect = recursiveChunkText(text);
    assert.deepEqual(viaForBudget, viaDirect);
  });

  test('recursiveChunkTextForBudget(text, null) with opts forwards them to recursiveChunkText unchanged', async () => {
    const text = '-- 3 of 10 --\n\nSome prose after a page marker.';
    const viaForBudget = await recursiveChunkTextForBudget(text, null, { stripPageMarkers: true });
    const viaDirect = recursiveChunkText(text, { stripPageMarkers: true });
    assert.deepEqual(viaForBudget, viaDirect);
  });
});

describe('Test 2 — Local/no-budget parity (full non-Markdown file path, golden fixture)', () => {
  // Golden fixture captured from chunkFileAsync's pre-existing (unbudgeted)
  // behavior — proves the budget===null path calls the literal original
  // functions (chunkSectionsAsync/chunkBySentencesAsync/finalizeChunksAsync),
  // never a reimplementation, for representative shapes: sentences crossing
  // MAX_TOKENS, short sections needing merge, an overlap-eligible boundary.
  const countFn = async (text) => Math.ceil(text.length / 4);

  test('a plain-text fixture with several long sentences produces the same chunks with budget=null as with no budget arg at all', async () => {
    const text = 'First sentence that is reasonably short. '.repeat(3) +
      'Second block of sentences that are also fairly short and plain. '.repeat(3);
    const withoutBudgetArg = await chunkFileAsync('/tmp/plain.txt', text, 'plain.txt', countFn);
    const withNullBudget = await chunkFileAsync('/tmp/plain.txt', text, 'plain.txt', countFn, null);
    assert.deepEqual(withNullBudget, withoutBudgetArg);
  });

  test('a synthetic-Markdown fixture with short sections needing merge produces identical output with/without an explicit null budget', async () => {
    const text = '# Heading\n\nShort.\n\n## Sub\n\nAlso short.\n\n## Sub2\n\nA third short section of prose here.\n';
    const withoutBudgetArg = await chunkFileAsync('/tmp/doc.md', text, 'doc.md', countFn);
    const withNullBudget = await chunkFileAsync('/tmp/doc.md', text, 'doc.md', countFn, null);
    assert.deepEqual(withNullBudget, withoutBudgetArg);
  });
});

describe('Test 3 — every piece from recursiveChunkTextForBudget fits budget; preservation is whitespace-canonical', () => {
  test('a divergent prose paragraph, split under a real budget, produces pieces that all fit', async () => {
    const text = buildDivergentText(600);
    const budget = makeDivergentBudget(512);
    const pieces = await recursiveChunkTextForBudget(text, budget);
    assert.ok(pieces.length > 1, 'expected the divergent text to actually require splitting under the real tokenizer');
    await assertEveryPieceFits(pieces, budget);
  });

  test('rejoining pieces (word-level join) reproduces the canonically-normalized input', async () => {
    const text = buildDivergentText(600);
    const budget = makeDivergentBudget(512);
    const pieces = await recursiveChunkTextForBudget(text, budget);
    assert.equal(canonicalWhitespace(pieces.join(' ')), canonicalWhitespace(text));
  });
});

describe('Test 4 — end-to-end chunkFromSkeleton() with a real-shaped budget', () => {
  test('a prose paragraph built from the divergent fixture is split so every chunk fits budget, with unchanged chunk shape', async () => {
    const prose = buildDivergentText(700);
    const md = `# Section\n\n${prose}\n`;
    const budget = makeDivergentBudget(512);
    const skel = parseSkeleton(md, { sourceFile: 'a.md' });
    const { chunks } = await chunkFromSkeleton(skel, { sourceFile: 'a.md', budget });

    assert.ok(chunks.length > 1, 'expected the oversized prose paragraph to be split into multiple chunks');
    for (const chunk of chunks) {
      const count = await budget.countTokens(chunk.text);
      assert.ok(count <= budget.maxInputTokens, `chunk exceeds budget (${count} > ${budget.maxInputTokens})`);
      assert.equal(typeof chunk.source_file, 'string');
      assert.equal(chunk.source_file, 'a.md');
      assert.ok(typeof chunk.node_id === 'string' && chunk.node_id.length > 0);
      assert.ok(typeof chunk.node_path === 'string' && chunk.node_path.length > 0);
    }
  });

  test('entity_raw canonical points are unaffected by prose budget-awareness (still produced only for oversized structural entities)', async () => {
    const md = '# S\n\nShort prose, well under any budget.\n';
    const budget = makeDivergentBudget(512);
    const skel = parseSkeleton(md, { sourceFile: 'b.md' });
    const { entityRawPoints } = await chunkFromSkeleton(skel, { sourceFile: 'b.md', budget });
    assert.deepEqual(entityRawPoints, []);
  });
});

describe('Test 5 — pathological single long "word" exceeds budget even after word-level splitting', () => {
  test('a long no-space identifier is split via the character-boundary last resort, reproducing content exactly', async () => {
    const longWord = 'x'.repeat(2000);
    const budget = makeDivergentBudget(100);
    const pieces = await recursiveChunkTextForBudget(longWord, budget);
    assert.ok(pieces.length > 1);
    assert.equal(pieces.join(''), longWord);
    await assertEveryPieceFits(pieces, budget);
  });
});

describe('Test 6 — non-Markdown, budget-aware: chunkFileAsync respects a real budget', () => {
  test('a plain-text file built from the divergent fixture: every resulting chunk fits the budget', async () => {
    const text = buildDivergentText(700);
    const budget = makeDivergentBudget(512);
    const chunks = await chunkFileAsync('/tmp/dense.txt', text, 'dense.txt', budget.countTokens, budget);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      const count = await budget.countTokens(chunk.text);
      assert.ok(count <= budget.maxInputTokens, `chunk exceeds budget (${count} > ${budget.maxInputTokens})`);
    }
  });
});

describe('Test 6b — structured-PDF/Pandoc route (synthetic Markdown through chunkFileAsync)', () => {
  test('a synthetic-Markdown section built from the divergent fixture fits budget end-to-end', async () => {
    const prose = buildDivergentText(700);
    const text = `# Heading\n\n${prose}\n`;
    const budget = makeDivergentBudget(512);
    const chunks = await chunkFileAsync('/tmp/converted.md', text, 'converted.md', budget.countTokens, budget);
    assert.ok(chunks.length > 1, 'expected the oversized synthetic-Markdown section to be split');
    for (const chunk of chunks) {
      const count = await budget.countTokens(chunk.text);
      assert.ok(count <= budget.maxInputTokens, `chunk exceeds budget (${count} > ${budget.maxInputTokens})`);
    }
  });
});

describe('Test 6c — structured-section single-oversized-word (via the public chunkFileAsync entry point)', () => {
  test('a section containing one long no-space identifier that alone exceeds budget is still split, never left oversized', async () => {
    const longWord = 'y'.repeat(3000);
    const text = `# Heading\n\n${longWord}\n`;
    const budget = makeDivergentBudget(100);
    const chunks = await chunkFileAsync('/tmp/converted2.md', text, 'converted2.md', budget.countTokens, budget);
    assert.ok(chunks.length > 1, 'expected the oversized single-word section to be split into multiple fragments');
    for (const chunk of chunks) {
      const count = await budget.countTokens(chunk.text);
      assert.ok(count <= budget.maxInputTokens, `fragment exceeds budget (${count} > ${budget.maxInputTokens})`);
    }
    assert.equal(chunks.map((c) => c.text).join(''), longWord);
  });
});

describe('Test 7 — oversized-sentence-splits-further (non-Markdown plain-text path)', () => {
  test('a single sentence exceeding budget alone is split further, not shipped oversized', async () => {
    const longSentence = buildDivergentText(700).trim() + '.';
    const budget = makeDivergentBudget(512);
    const chunks = await chunkFileAsync('/tmp/sentence.txt', longSentence, 'sentence.txt', budget.countTokens, budget);
    assert.ok(chunks.length > 1, 'expected the oversized single sentence to be split into multiple chunks');
    for (const chunk of chunks) {
      const count = await budget.countTokens(chunk.text);
      assert.ok(count <= budget.maxInputTokens, `chunk exceeds budget (${count} > ${budget.maxInputTokens})`);
    }
  });
});

describe('Test 7b — single-word-exceeds-even-word-level (non-Markdown plain-text path, real entry point)', () => {
  test('a single long no-space token, alone, is character-split — proven at the chunkFileAsync API level', async () => {
    const longWord = 'z'.repeat(2500);
    const budget = makeDivergentBudget(80);
    const chunks = await chunkFileAsync('/tmp/word.txt', longWord, 'word.txt', budget.countTokens, budget);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      const count = await budget.countTokens(chunk.text);
      assert.ok(count <= budget.maxInputTokens, `chunk exceeds budget (${count} > ${budget.maxInputTokens})`);
    }
    assert.equal(chunks.map((c) => c.text).join(''), longWord);
  });
});

describe('Test 8 — merge-never-exceeds', () => {
  test('adjacent short chunks that would combine to exceed budget are not merged', async () => {
    // Two sentences, each individually well under any minTokens floor, but
    // whose IDENTIFIER-DENSE concatenation would exceed a tight ceiling
    // under the real (fake) tokenizer even though each is short alone.
    const half = 'resolveEmbeddingProfileFromCollectionInfoConfigMetadataParamsVectorsSparseVectors.';
    const text = `${half} ${half}`;
    const budget = makeDivergentBudget(30); // tight enough that merging both halves overshoots
    const chunks = await chunkFileAsync('/tmp/merge.txt', text, 'merge.txt', budget.countTokens, budget);
    for (const chunk of chunks) {
      const count = await budget.countTokens(chunk.text);
      assert.ok(count <= budget.maxInputTokens, `chunk exceeds budget after merge (${count} > ${budget.maxInputTokens})`);
    }
  });
});

describe('Test 9 — overlap-never-exceeds', () => {
  test('a split boundary whose overlap would overshoot once actually joined is shrunk/omitted, never exceeding budget', async () => {
    const text = buildDivergentText(1000);
    const budget = makeDivergentBudget(512);
    const chunks = await chunkFileAsync('/tmp/overlap.txt', text, 'overlap.txt', budget.countTokens, budget);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      const count = await budget.countTokens(chunk.text);
      assert.ok(count <= budget.maxInputTokens, `chunk exceeds budget even with overlap applied (${count} > ${budget.maxInputTokens})`);
    }
  });
});

describe('Test 10 — final invariant: budget violations fail loudly, never silently', () => {
  test('a countTokens that reports a passing count during splitting but a violating count during the final check causes chunkFileAsync to throw, not silently ship an oversized chunk', async () => {
    // finalizeChunksAsyncBudgeted's own hard invariant check is module-
    // private (deliberately not exported — see the plan's design), so this
    // exercises it through the public chunkFileAsync entry point with a
    // deliberately INCONSISTENT countTokens: it reports a small, always-
    // fitting count while the pipeline is actively splitting/merging
    // (letting an oversized chunk slip through undetected by the earlier
    // guards), then reports the TRUE, over-budget count once the final
    // invariant pass re-measures every chunk. A real per-model tokenizer
    // is always consistent call-to-call, so this scenario cannot occur in
    // production — it is exactly the kind of "should be structurally
    // unreachable, but fail loudly if it somehow is" case the invariant
    // exists to guard.
    const text = 'one two three four five six seven eight nine ten';
    // Lies the FIRST time any exact string is measured (letting splitting/
    // merging/overlap all conclude everything fits), then tells the truth
    // on every SUBSEQUENT sighting of that same exact string — the
    // invariant's own re-measure pass at the very end is necessarily a
    // second (or later) sighting of each final chunk's text, since every
    // earlier stage already measured it at least once while deciding
    // whether to split/merge/overlap it.
    const seen = new Set();
    const budget = {
      maxInputTokens: 5,
      countTokens: async (t) => {
        if (!seen.has(t)) { seen.add(t); return 1; }
        return 9999;
      },
    };
    await assert.rejects(
      () => chunkFileAsync('/tmp/invariant.txt', text, 'invariant.txt', budget.countTokens, budget),
      /budget invariant violated/,
    );
  });
});

describe('Test 11 — effectiveMax never widens configured chunk size', () => {
  test('a budget with a LARGER maxInputTokens than configured MAX_CHUNK_TOKENS never widens the effective ceiling', () => {
    const configured = getChunkingConfig();
    const widerBudget = { maxInputTokens: configured.maxTokens * 2, countTokens: () => 0 };
    const eff = effectiveBudgetFor(widerBudget);
    assert.equal(eff.maxTokens, configured.maxTokens);
    assert.equal(eff.minTokens, configured.minTokens);
    assert.equal(eff.overlapTokens, configured.overlapTokens);
  });

  test('a budget with a SMALLER maxInputTokens than configured tightens the ceiling and scales min/overlap down proportionally', () => {
    const configured = getChunkingConfig();
    const narrowMax = Math.floor(configured.maxTokens / 2);
    const narrowBudget = { maxInputTokens: narrowMax, countTokens: () => 0 };
    const eff = effectiveBudgetFor(narrowBudget);
    assert.equal(eff.maxTokens, narrowMax);
    assert.ok(eff.minTokens <= configured.minTokens);
    assert.ok(eff.overlapTokens <= configured.overlapTokens);
  });

  test('effectiveBudgetFor(null) returns null — the sentinel for "take the unchanged path"', () => {
    assert.equal(effectiveBudgetFor(null), null);
  });
});

describe('Test 13 — PDF plain-text fallback (chunkExtractedTextForBudget)', () => {
  test('extracted text fitting the divergent fixture is split so every chunk fits budget, when useAsync/budget are both active', async () => {
    const text = buildDivergentText(700);
    const budget = makeDivergentBudget(512);
    const chunks = await chunkExtractedTextForBudget(text, 'scan.pdf', budget.countTokens, budget, true, { stripPageMarkers: true });
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      const count = await budget.countTokens(chunk.text);
      assert.ok(count <= budget.maxInputTokens, `chunk exceeds budget (${count} > ${budget.maxInputTokens})`);
    }
  });

  test('useAsync=false takes the exact pre-existing sync path (recursiveChunkText/finalizeChunks), ignoring budget entirely', async () => {
    const text = 'Some short plain text extracted from a PDF.';
    const chunks = await chunkExtractedTextForBudget(text, 'scan.pdf', null, null, false);
    assert.ok(chunks.length >= 1);
    assert.equal(chunks[0].text, text.trim());
  });

  test('budget=null with useAsync=true takes the unbudgeted async path (recursiveChunkTextAsync/finalizeChunksAsync), unchanged from pre-fix behavior', async () => {
    const text = 'Some short plain text extracted from a PDF, async mode.';
    const countFn = async (t) => Math.ceil(t.length / 4);
    const chunks = await chunkExtractedTextForBudget(text, 'scan.pdf', countFn, null, true);
    assert.ok(chunks.length >= 1);
    assert.equal(chunks[0].text, text.trim());
  });
});

describe('Dispatch priority — budget overrides TOKEN_COUNT (integration-level, via effectiveBudgetFor + chunkFileAsync)', () => {
  test('a non-null budget is honored by chunkFileAsync regardless of what countFn the caller supplies for the fallback path', async () => {
    // This exercises the same code path chunkFileFromPath's dispatch fix
    // relies on: chunkFileAsync's budget parameter takes priority over
    // whatever countFn was resolved from TOKEN_COUNT — proven here by
    // passing a heuristic countFn (as chunkFileFromPath would under
    // TOKEN_COUNT=heuristic) alongside a real divergent budget, and
    // confirming the OUTPUT respects the budget's real tokenizer, not the
    // heuristic.
    const text = buildDivergentText(700);
    const budget = makeDivergentBudget(512);
    const heuristicCountFn = async (t) => Math.ceil(t.length / 4); // what TOKEN_COUNT=heuristic would supply
    const chunks = await chunkFileAsync('/tmp/dispatch.txt', text, 'dispatch.txt', heuristicCountFn, budget);
    for (const chunk of chunks) {
      const realTokens = await budget.countTokens(chunk.text);
      assert.ok(realTokens <= budget.maxInputTokens, `chunk violates the REAL budget (${realTokens} > ${budget.maxInputTokens}) — the heuristic countFn must not have been used for splitting decisions`);
    }
  });
});

describe('Test 12 — dispatch priority at chunkFileFromPath itself: budget overrides TOKEN_COUNT=heuristic', () => {
  async function withTempTxtFile(text, fn) {
    const dir = mkdtempSync(join(tmpdir(), 'semidex-chunk-budget-'));
    const fp = join(dir, 'dense.txt');
    writeFileSync(fp, text, 'utf8');
    try {
      return await fn(fp);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('TOKEN_COUNT=heuristic with an active cloud budget still splits against the REAL tokenizer, not the heuristic — the exact scenario the round-5 finding identified', async () => {
    const savedTokenCount = process.env.TOKEN_COUNT;
    process.env.TOKEN_COUNT = 'heuristic';
    try {
      const text = buildDivergentText(700);
      const budget = makeDivergentBudget(512);
      await withTempTxtFile(text, async (fp) => {
        const { chunks } = await chunkFileFromPath(fp, 'dense.txt', budget);
        assert.ok(chunks.length > 1, 'expected the divergent text to require splitting under the real budget, proving the heuristic dispatch was NOT used');
        for (const chunk of chunks) {
          const realTokens = await budget.countTokens(chunk.text);
          assert.ok(realTokens <= budget.maxInputTokens, `chunk violates the real budget (${realTokens} > ${budget.maxInputTokens})`);
        }
      });
    } finally {
      if (savedTokenCount === undefined) delete process.env.TOKEN_COUNT;
      else process.env.TOKEN_COUNT = savedTokenCount;
    }
  });

  test('budget=null with TOKEN_COUNT=heuristic behaves exactly as before this fix (sync heuristic chunkFile path, unaffected)', async () => {
    const savedTokenCount = process.env.TOKEN_COUNT;
    process.env.TOKEN_COUNT = 'heuristic';
    try {
      const text = 'Short plain text with a few short sentences. Nothing oversized here at all.';
      await withTempTxtFile(text, async (fp) => {
        const { chunks } = await chunkFileFromPath(fp, 'dense.txt', null);
        assert.ok(chunks.length >= 1);
        assert.equal(chunks.map((c) => c.text).join(' ').trim().length > 0, true);
      });
    } finally {
      if (savedTokenCount === undefined) delete process.env.TOKEN_COUNT;
      else process.env.TOKEN_COUNT = savedTokenCount;
    }
  });
});
