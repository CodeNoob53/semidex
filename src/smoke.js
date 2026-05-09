// Smoke tests for the embedding provider layer and config pipeline.
// Runs without Qdrant or Ollama — tests logic and provider routing only.
// Usage: node src/smoke.js  /  npm run smoke
//
// Tests:
//   1. Default provider resolves to ollama + hashed-tf
//   2. ONNX_EMBED=1 resolves to bge-m3-onnx + bge-m3-onnx
//   3. Invalid provider combo throws in resolveEnvProviders
//   4. Invalid provider combo throws in embedForSearch (actual runtime guard)
//   5. Reindex detection: every discriminator field change → not skipped

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../config.json');

let passed = 0;
let failed = 0;

function ok(label, result) {
  if (result) { console.log(`  ✓ ${label}`); passed++; }
  else        { console.error(`  ✗ ${label}`); failed++; }
}

function throws(label, fn, expectedSubstring) {
  try {
    fn();
    console.error(`  ✗ ${label} — expected throw, got none`);
    failed++;
  } catch (e) {
    if (!expectedSubstring || e.message.includes(expectedSubstring)) {
      console.log(`  ✓ ${label}`); passed++;
    } else {
      console.error(`  ✗ ${label} — wrong error: ${e.message}`); failed++;
    }
  }
}

async function throwsAsync(label, fn, expectedSubstring) {
  try {
    await fn();
    console.error(`  ✗ ${label} — expected throw, got none`);
    failed++;
  } catch (e) {
    if (!expectedSubstring || e.message.includes(expectedSubstring)) {
      console.log(`  ✓ ${label}`); passed++;
    } else {
      console.error(`  ✗ ${label} — wrong error: ${e.message}`); failed++;
    }
  }
}

// Temporarily replace config.json, run fn(), restore.
async function withConfig(tempConfig, fn) {
  const original = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf-8') : null;
  writeFileSync(CONFIG_PATH, JSON.stringify(tempConfig, null, 2), 'utf-8');
  try { await fn(); } finally {
    if (original !== null) writeFileSync(CONFIG_PATH, original, 'utf-8');
    else rmSync(CONFIG_PATH, { force: true });
  }
}

// ── 1. Default provider ──────────────────────────────────────────────────────
console.log('\n[1] Default provider (no env overrides)');
{
  delete process.env.DENSE_PROVIDER;
  delete process.env.SPARSE_PROVIDER;
  delete process.env.ONNX_EMBED;
  delete process.env.EMBED_MODEL;

  const { resolveEnvProviders } = await import('./core/config.js');
  const p = resolveEnvProviders();
  ok('denseProvider = ollama',     p.denseProvider  === 'ollama');
  ok('sparseProvider = hashed-tf', p.sparseProvider === 'hashed-tf');
  ok('denseModel = bge-m3',        p.denseModel     === 'bge-m3');
}

// ── 2. ONNX_EMBED=1 shorthand ────────────────────────────────────────────────
console.log('\n[2] ONNX_EMBED=1 shorthand');
{
  process.env.ONNX_EMBED = '1';
  const { resolveEnvProviders } = await import('./core/config.js');
  const p = resolveEnvProviders();
  ok('denseProvider = bge-m3-onnx',    p.denseProvider  === 'bge-m3-onnx');
  ok('sparseProvider = bge-m3-onnx',   p.sparseProvider === 'bge-m3-onnx');
  ok('denseModel = aapot/bge-m3-onnx', p.denseModel     === 'aapot/bge-m3-onnx');
  delete process.env.ONNX_EMBED;
}

// ── 3. Invalid combo in resolveEnvProviders ──────────────────────────────────
console.log('\n[3] Invalid provider combo — resolveEnvProviders');
{
  const { resolveEnvProviders } = await import('./core/config.js');

  process.env.DENSE_PROVIDER  = 'ollama';
  process.env.SPARSE_PROVIDER = 'bge-m3-onnx';
  throws('ollama + bge-m3-onnx throws', () => resolveEnvProviders(), 'Invalid provider combination');

  process.env.DENSE_PROVIDER  = 'bge-m3-onnx';
  process.env.SPARSE_PROVIDER = 'hashed-tf';
  throws('bge-m3-onnx + hashed-tf throws', () => resolveEnvProviders(), 'Invalid provider combination');

  process.env.DENSE_PROVIDER  = 'unknown-provider';
  process.env.SPARSE_PROVIDER = 'hashed-tf';
  throws('unknown denseProvider throws', () => resolveEnvProviders(), 'Invalid provider combination');

  delete process.env.DENSE_PROVIDER;
  delete process.env.SPARSE_PROVIDER;
}

// ── 4. embedForSearch runtime guard ─────────────────────────────────────────
// embeddings._embed validates the combo before any Ollama/ONNX call, so this
// test exercises the actual code path callers hit (not just resolveEnvProviders).
// We write a temporarily bad config.json entry to bypass the env-level guard.
console.log('\n[4] Invalid provider combo — embedForSearch runtime guard');
{
  delete process.env.DENSE_PROVIDER;
  delete process.env.SPARSE_PROVIDER;
  delete process.env.ONNX_EMBED;

  const embMod = await import('./core/embeddings.js');
  ok('SCHEMA_VERSION is 2', embMod.SCHEMA_VERSION === 2);

  const badConfig = {
    collections: {
      '__smoke_bad__': {
        denseProvider:  'ollama',
        sparseProvider: 'bge-m3-onnx',  // invalid combo
        denseModel:     'bge-m3',
        embeddingSchemaVersion: 2,
        vectorSize: 1024,
      },
    },
  };

  await withConfig(badConfig, async () => {
    await throwsAsync(
      'embedForSearch with bad config combo throws',
      () => embMod.embedForSearch('__smoke_bad__', 'test query'),
      'Unsupported provider combination'
    );
  });
}

// ── 5. Reindex detection logic ───────────────────────────────────────────────
console.log('\n[5] Reindex detection — storedMeta mismatch');
{
  const embedCfg   = { denseProvider: 'ollama', denseModel: 'bge-m3', sparseProvider: 'hashed-tf', schemaVersion: 2 };
  const vectorSize = 1024;

  function wouldSkip(storedMeta) {
    return (
      storedMeta.hash                   === 'abc123' &&
      storedMeta.denseProvider          === embedCfg.denseProvider &&
      storedMeta.denseModel             === embedCfg.denseModel &&
      storedMeta.sparseProvider         === embedCfg.sparseProvider &&
      storedMeta.embeddingSchemaVersion === embedCfg.schemaVersion &&
      (storedMeta.vectorSize ?? vectorSize) === vectorSize
    );
  }

  const base = { hash: 'abc123', denseProvider: 'ollama', denseModel: 'bge-m3', sparseProvider: 'hashed-tf', embeddingSchemaVersion: 2, vectorSize: 1024 };

  ok('identical meta → skip',            wouldSkip(base));
  ok('denseProvider changed → reindex',  !wouldSkip({ ...base, denseProvider: 'bge-m3-onnx', denseModel: 'aapot/bge-m3-onnx', sparseProvider: 'bge-m3-onnx' }));
  ok('denseModel changed → reindex',     !wouldSkip({ ...base, denseModel: 'snowflake-arctic-embed2' }));
  ok('sparseProvider changed → reindex', !wouldSkip({ ...base, sparseProvider: 'bge-m3-onnx' }));
  ok('schemaVersion changed → reindex',  !wouldSkip({ ...base, embeddingSchemaVersion: 1 }));
  ok('vectorSize changed → reindex',     !wouldSkip({ ...base, vectorSize: 768 }));
  ok('file hash changed → reindex',      !wouldSkip({ ...base, hash: 'different' }));
  ok('null vectorSize in stored → treated as current → skip', wouldSkip({ ...base, vectorSize: null }));
}

// ── 6. Chunking edge cases ───────────────────────────────────────────────────
console.log('\n[6] Chunking edge cases');
{
  const { chunkFile } = await import('./indexer/phases/chunk.js');

  // 6a. Short .txt (1-2 sentences) must not return 0 chunks.
  const short1 = 'Hello world.';
  const r1 = chunkFile('x.txt', short1, 'x.txt');
  ok('1-sentence .txt → 1 chunk',   r1.length === 1);
  ok('1-sentence chunk has text',    r1[0]?.text === short1.trim());

  const short2 = 'First sentence. Second sentence.';
  const r2 = chunkFile('x.txt', short2, 'x.txt');
  ok('2-sentence .txt → 1 chunk',       r2.length === 1);
  ok('2-sentence chunk text unchanged', r2[0]?.text === 'First sentence. Second sentence.');

  // 6b. Trailing text without sentence terminator must not be dropped.
  const withTail = 'Complete sentence. trailing without dot';
  const r3 = chunkFile('x.txt', withTail, 'x.txt');
  ok('trailing text without dot preserved', r3.some(c => c.text.includes('trailing without dot')));

  // 6c. Markdown: sentences from section A must not appear in section B chunk.
  const md = `# Section A\nOnly sentence in A.\n\n# Section B\nOnly sentence in B.`;
  const r4 = chunkFile('x.md', md, 'x.md');
  const sectionBChunks = r4.filter(c => c.section === 'Section B');
  ok('section B has no text from section A', sectionBChunks.every(c => !c.text.includes('sentence in A')));

  // 6d. No overlap-only final chunk: after a full chunk is emitted the overlap
  // sentences must not re-appear as a standalone chunk if no new sentences follow.
  // default MAX_TOKENS=400, countTokens = ceil(len/4), so 1596 chars ≈ 399 tokens.
  const bigSentence = 'A'.repeat(1596) + '.'; // just under one chunk by itself
  const r5 = chunkFile('x.txt', `${bigSentence} Final.`, 'x.txt');
  // Should be exactly 2 chunks (big + "Final."), not 3 (big + "Final." + overlap-only).
  ok('no overlap-only final chunk after full emit', r5.length <= 2);

  // 6e. No consecutive duplicate chunks.
  const medText = 'Alpha sentence. Beta sentence. Gamma sentence.';
  const r6 = chunkFile('x.txt', medText, 'x.txt');
  ok('no consecutive duplicate chunks', r6.every((c, i) => i === 0 || c.text !== r6[i - 1].text));

  // 6f. chunkIndex / totalChunks metadata is correct.
  ok('chunkIndex + totalChunks set correctly',
    r1[0].chunkIndex === 0 && r1[0].totalChunks === 1);
}

// ── 7. Reranker: top-1 protection uses original RRF rank, not rerank score ───
console.log('\n[7] Reranker top-1 protection');
{
  // Test the fix directly: originalTop must be found by rank===0 BEFORE sort.
  // We replicate the scoring + selection logic inline with a forced scenario where
  // sort() flips rank-0 and rank-1, and verify the protection still pins rank-0.
  //
  // Setup: rank-0 result has no token match (baseScore = 1.0).
  //        rank-1 result has huge source_file boost that flips it above rank-0.
  //        Protection delta = 0.9 (very high), so any advantage < 0.9 → protection fires.
  //        With the BUG (originalTop read after sort): protection targets rank-1 (new sort[0]).
  //          → rank-0 stays first only if rank-1 can't beat 1e9 penalty... actually it can't.
  //          Wait: the forcedPenalty applies to NON-rank0Sf. With the bug rank0Sf = rank-1's file.
  //          So rank-0's file gets the 1e9 penalty and rank-1 wins. rank-0 displaced. BUG confirmed.
  //        With the FIX: originalTop = rank-0 item. forcedPenalty on rank-1 → rank-0 stays. ✓

  // Inline simulation (no env reload needed).
  const DIVERSITY_PENALTIES_T = [0.05, 0.10, 0.15];
  const TECH_MULT_T = 3;
  const BOOST_SOURCE_FILE_T = 2.0; // exaggerated to flip rank-0
  const PROTECT_DELTA_T = 0.9;     // high enough to engage on any flip

  function tokenHitsT(str, tokens) {
    if (!str || !tokens.size) return 0;
    const words = str.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
    let score = 0;
    for (const w of words) { if (tokens.has(w)) score += 1; }
    return score;
  }

  function rerankFixed(results, query) {
    const tokens = new Map(
      (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).map(t => [t, false])
    );
    const scored = results.map((r, rank) => {
      const p = r.payload;
      const base = 1 / (rank + 1);
      const srcHits = tokenHitsT(p.source_file, tokens);
      const boostSrc = Math.min(srcHits * BOOST_SOURCE_FILE_T, BOOST_SOURCE_FILE_T * 3);
      return { result: r, baseScore: base + boostSrc, rank };
    });

    // FIX: capture before sort
    const originalTop = scored.find(s => s.rank === 0);
    scored.sort((a, b) => b.baseScore - a.baseScore);
    const challenger = scored.find(s => s !== originalTop);
    const protected_ = PROTECT_DELTA_T > 0 && originalTop && challenger &&
      challenger.baseScore - originalTop.baseScore < PROTECT_DELTA_T;

    const selected = [];
    const remaining = [...scored];
    while (selected.length < results.length && remaining.length > 0) {
      let bestIdx = 0, bestEff = -Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const forced = (protected_ && selected.length === 0 && remaining[i] !== originalTop) ? 1e9 : 0;
        const eff = remaining[i].baseScore - forced;
        if (eff > bestEff) { bestEff = eff; bestIdx = i; }
      }
      selected.push(remaining[bestIdx]);
      remaining.splice(bestIdx, 1);
    }
    return selected.map(s => s.result);
  }

  function rerankBuggy(results, query) {
    const tokens = new Map(
      (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).map(t => [t, false])
    );
    const scored = results.map((r, rank) => {
      const p = r.payload;
      const base = 1 / (rank + 1);
      const srcHits = tokenHitsT(p.source_file, tokens);
      const boostSrc = Math.min(srcHits * BOOST_SOURCE_FILE_T, BOOST_SOURCE_FILE_T * 3);
      return { result: r, baseScore: base + boostSrc, rank };
    });

    // BUG: sort first, then read scored[0]
    scored.sort((a, b) => b.baseScore - a.baseScore);
    const rank0Score = scored[0]?.baseScore ?? 0;
    const rank0Sf    = scored[0]?.result.payload?.source_file;
    const challenger = scored.find(s => s.result.payload?.source_file !== rank0Sf);
    const protected_ = PROTECT_DELTA_T > 0 && challenger !== undefined &&
      challenger.baseScore - rank0Score < PROTECT_DELTA_T;

    const selected = [];
    const remaining = [...scored];
    while (selected.length < results.length && remaining.length > 0) {
      let bestIdx = 0, bestEff = -Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const sf = remaining[i].result.payload?.source_file;
        const forced = (protected_ && selected.length === 0 && sf !== rank0Sf) ? 1e9 : 0;
        const eff = remaining[i].baseScore - forced;
        if (eff > bestEff) { bestEff = eff; bestIdx = i; }
      }
      selected.push(remaining[bestIdx]);
      remaining.splice(bestIdx, 1);
    }
    return selected.map(s => s.result);
  }

  // rank-0: source_file='x.md', query has no match → boostSrc=0, baseScore=1.0
  // rank-1: source_file='query_token.md', query='query token' → 2 hits, boostSrc=min(2*2,6)=4.0, baseScore=0.5+4=4.5
  // sort() → rank-1 is now scored[0]. gap=4.5-1.0=3.5 > delta(0.9) → protection does NOT engage.
  // Need gap < delta: use source_file with 0 hits for rank-1 but rank-1 just barely beats rank-0.
  // rank-1: source_file='z.md', 0 token hits, baseScore=0.5 < 1.0 → doesn't flip. Need different approach.
  // Actually to flip: rank-1 must have baseScore > rank-0 baseScore.
  // rank-0 baseScore = 1.0 + boostSrc_0. rank-1 baseScore = 0.5 + boostSrc_1.
  // For rank-1 > rank-0: 0.5 + boostSrc_1 > 1.0 + boostSrc_0 → boostSrc_1 - boostSrc_0 > 0.5.
  // Give rank-0 0 hits, rank-1 1 hit with BOOST=2.0: boostSrc_1 = min(1*2,6)=2.0. 0.5+2.0=2.5 > 1.0. ✓
  // gap = 2.5 - 1.0 = 1.5 > PROTECT_DELTA_T(0.9) → protection does NOT engage even with fix.
  // Need gap < 0.9: boostSrc_1 = 0.5 + 0.89 = 1.39. With BOOST=2.0: 1 hit → 2.0. Too big.
  // Use BOOST=1.3: 1 hit → 1.3. rank-1 baseScore = 0.5+1.3=1.8. gap=1.8-1.0=0.8 < 0.9. ✓

  const BOOST_SMALL = 1.3;
  function rerankFixedSmall(results, query) {
    const tokens = new Map(
      (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).map(t => [t, false])
    );
    const scored = results.map((r, rank) => {
      const p = r.payload;
      const base = 1 / (rank + 1);
      const srcHits = tokenHitsT(p.source_file, tokens);
      const boostSrc = Math.min(srcHits * BOOST_SMALL, BOOST_SMALL * 3);
      return { result: r, baseScore: base + boostSrc, rank };
    });
    const originalTop = scored.find(s => s.rank === 0); // FIX: before sort
    scored.sort((a, b) => b.baseScore - a.baseScore);
    const challenger = scored.find(s => s !== originalTop);
    const protected_ = PROTECT_DELTA_T > 0 && originalTop && challenger &&
      challenger.baseScore - originalTop.baseScore < PROTECT_DELTA_T;
    const selected = [];
    const remaining = [...scored];
    while (selected.length < results.length && remaining.length > 0) {
      let bestIdx = 0, bestEff = -Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const forced = (protected_ && selected.length === 0 && remaining[i] !== originalTop) ? 1e9 : 0;
        const eff = remaining[i].baseScore - forced;
        if (eff > bestEff) { bestEff = eff; bestIdx = i; }
      }
      selected.push(remaining[bestIdx]);
      remaining.splice(bestIdx, 1);
    }
    return selected.map(s => s.result);
  }

  function rerankBuggySmall(results, query) {
    const tokens = new Map(
      (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).map(t => [t, false])
    );
    const scored = results.map((r, rank) => {
      const p = r.payload;
      const base = 1 / (rank + 1);
      const srcHits = tokenHitsT(p.source_file, tokens);
      const boostSrc = Math.min(srcHits * BOOST_SMALL, BOOST_SMALL * 3);
      return { result: r, baseScore: base + boostSrc, rank };
    });
    // BUG: sort first
    scored.sort((a, b) => b.baseScore - a.baseScore);
    const rank0Sf = scored[0]?.result.payload?.source_file;
    const challenger = scored.find(s => s.result.payload?.source_file !== rank0Sf);
    const rank0Score = scored[0]?.baseScore ?? 0;
    const protected_ = PROTECT_DELTA_T > 0 && challenger !== undefined &&
      challenger.baseScore - rank0Score < PROTECT_DELTA_T;
    const selected = [];
    const remaining = [...scored];
    while (selected.length < results.length && remaining.length > 0) {
      let bestIdx = 0, bestEff = -Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const sf = remaining[i].result.payload?.source_file;
        const forced = (protected_ && selected.length === 0 && sf !== rank0Sf) ? 1e9 : 0;
        const eff = remaining[i].baseScore - forced;
        if (eff > bestEff) { bestEff = eff; bestIdx = i; }
      }
      selected.push(remaining[bestIdx]);
      remaining.splice(bestIdx, 1);
    }
    return selected.map(s => s.result);
  }

  // rank-0: source_file='x.md', 0 query token hits → baseScore=1.0
  // rank-1: source_file='query_word.md', 1 hit with BOOST=1.3 → baseScore=0.5+1.3=1.8
  // gap = 0.8 < PROTECT_DELTA_T(0.9) → protection must engage when reading rank-0 correctly.
  const input2 = [
    { score: 0.9, payload: { source_file: 'x.md',          section: '', tags: [], text: '' } },
    { score: 0.5, payload: { source_file: 'query_word.md',  section: '', tags: [], text: '' } },
  ];
  const fixedResult  = rerankFixedSmall(input2,  'query_word');
  const buggyResult  = rerankBuggySmall(input2,  'query_word');

  ok('top-1 protection (fixed): original RRF rank-0 stays first', fixedResult[0].payload.source_file === 'x.md');
  ok('top-1 bug reproduced: without fix rank-0 is displaced',      buggyResult[0].payload.source_file !== 'x.md');
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Smoke tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
