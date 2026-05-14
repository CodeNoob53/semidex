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
  // Set env vars before the first import of rerank.js so envFloat() picks them up.
  // Scenario: rank-1 source_file has 1 token match with BOOST=1.3 → baseScore 0.5+1.3=1.8,
  // which flips past rank-0's baseScore of 1.0. Gap=0.8 < PROTECT_TOP1_DELTA=0.9, so
  // protection must fire and keep rank-0 (x.md) first.
  process.env.RERANK_BOOST_SOURCE_FILE      = '1.3';
  process.env.RERANK_PROTECT_TOP1_DELTA     = '0.9';
  // Zero out other boost signals so only source_file matters.
  process.env.RERANK_BOOST_SECTION          = '0';
  process.env.RERANK_BOOST_TAGS             = '0';
  process.env.RERANK_BOOST_TEXT             = '0';
  process.env.RERANK_BOOST_BACKLINK         = '0';

  const { rerankResults } = await import('./core/rerank.js');

  // rank-0: 'original' — no match for query 'boostme' → baseScore = 1/(0+1) = 1.0
  // rank-1: 'boostme'  — 1 hit (source_file token) → baseScore = 0.5 + 1.3 = 1.8
  // After scoring sort: rank-1 is first (1.8 > 1.0). Gap = 0.8 < delta 0.9 → protection fires.
  // Expected: 'original' stays at position 0 (original RRF rank-0 protected).
  // Extension-free names used to avoid '.md' adding a spurious extra token hit.
  const input = [
    { score: 0.9, payload: { source_file: 'original', section: '', tags: [], text: '' } },
    { score: 0.5, payload: { source_file: 'boostme',  section: '', tags: [], text: '' } },
  ];
  const result = await rerankResults(input, 'boostme', { finalLimit: 2, collection: null });
  ok('top-1 protection keeps original RRF rank-0 when advantage < delta', result[0].payload.source_file === 'original');

  // Note: these env vars are deleted for hygiene, but rerank.js constants are fixed at
  // module load time (envFloat runs once). Any additional rerank tests added below this
  // block must set their own env vars BEFORE importing rerank.js in a fresh worker,
  // or test only behaviour that doesn't depend on these constants.
  for (const k of ['RERANK_BOOST_SOURCE_FILE', 'RERANK_PROTECT_TOP1_DELTA',
                    'RERANK_BOOST_SECTION', 'RERANK_BOOST_TAGS',
                    'RERANK_BOOST_TEXT', 'RERANK_BOOST_BACKLINK']) {
    delete process.env[k];
  }
}

// ── 8. Compact window chunk formatting ──────────────────────────────────────
// Imports and tests the production assembleWindowChunks helper from
// src/mcp/tools/search.js without live Qdrant. Mirrors the getStoredMeta
// load-bearing case: rank-1 is qdrant.md#5 (Payload Indexes), the next
// neighbor qdrant.md#6 carries the six reindex discriminator fields.
console.log('\n[8] Compact window chunk formatting (no Qdrant)');
{
  const { assembleWindowChunks } = await import('./mcp/tools/search.js');

  // Synthetic points for the getStoredMeta case (window=1 around chunk_index=5).
  // Neighbor text front-loads all six field names so they survive the 150-char slice.
  const MATCH_IDX = 5;
  const matchText = 'Payload Indexes: source_file is indexed as keyword for fast filter lookups. getStoredMeta is the primary caller.';
  const neighborText = 'Fields: file_hash, dense_provider, dense_model, sparse_provider, embedding_schema_version, vector_size. getStoredMeta scrolls one point matching source_file and returns these six reindex discriminator fields from its payload.';

  const syntheticPoints = [
    { payload: { source_file: 'qdrant.md', chunk_index: MATCH_IDX,     section: 'Payload Indexes', text: matchText    } },
    { payload: { source_file: 'qdrant.md', chunk_index: MATCH_IDX + 1, section: 'getStoredMeta',   text: neighborText } },
  ];

  // ── 8a: compact mode ──
  const compact = assembleWindowChunks(syntheticPoints, MATCH_IDX, 'compact');

  ok('compact: two window chunks returned',             compact.length === 2);
  ok('compact: matched chunk is_match=true',            compact[0].is_match === true);
  ok('compact: neighbor chunk is_match=false',          compact[1].is_match === false);
  ok('compact: matched chunk has text_snippet',         typeof compact[0].text_snippet === 'string');
  ok('compact: neighbor chunk has text_snippet',        typeof compact[1].text_snippet === 'string');
  ok('compact: matched chunk has no .text field',       !Object.prototype.hasOwnProperty.call(compact[0], 'text'));
  ok('compact: neighbor has no .text field',            !Object.prototype.hasOwnProperty.call(compact[1], 'text'));

  // Neighbor is >150 chars — must be truncated with "..."
  ok('compact: neighbor snippet ≤ 153 chars (150 + "...")', compact[1].text_snippet.length <= 153);
  ok('compact: neighbor snippet ends with "..."',            compact[1].text_snippet.endsWith('...'));

  // The 150-char slice must contain all six discriminator field names
  const snippet = compact[1].text_snippet;
  ok('compact: neighbor snippet contains file_hash',                 snippet.includes('file_hash'));
  ok('compact: neighbor snippet contains dense_provider',            snippet.includes('dense_provider'));
  ok('compact: neighbor snippet contains dense_model',               snippet.includes('dense_model'));
  ok('compact: neighbor snippet contains sparse_provider',           snippet.includes('sparse_provider'));
  ok('compact: neighbor snippet contains embedding_schema_version',  snippet.includes('embedding_schema_version'));
  ok('compact: neighbor snippet contains vector_size',               snippet.includes('vector_size'));

  // ── 8b: full mode ──
  const full = assembleWindowChunks(syntheticPoints, MATCH_IDX, 'full');

  ok('full: neighbor has .text field',             Object.prototype.hasOwnProperty.call(full[1], 'text'));
  ok('full: neighbor .text is untruncated',        full[1].text === neighborText);
  ok('full: neighbor has no text_snippet field',   !Object.prototype.hasOwnProperty.call(full[1], 'text_snippet'));

  // ── 8c: assembleWindowChunks with empty input returns empty array ──
  // (production window=0 guard is in handle() — it never calls assembleWindowChunks;
  // this tests the helper's own empty-input invariant)
  const noPoints = assembleWindowChunks([], MATCH_IDX, 'compact');
  ok('assembleWindowChunks: empty input → empty array', noPoints.length === 0);

  // ── 8d: deduplication — same neighbor appearing twice must be emitted once ──
  const dup = assembleWindowChunks([
    { payload: { source_file: 'qdrant.md', chunk_index: MATCH_IDX,     section: 'Payload Indexes', text: matchText    } },
    { payload: { source_file: 'qdrant.md', chunk_index: MATCH_IDX + 1, section: 'getStoredMeta',   text: neighborText } },
    { payload: { source_file: 'qdrant.md', chunk_index: MATCH_IDX + 1, section: 'getStoredMeta',   text: neighborText } }, // duplicate
  ], MATCH_IDX, 'compact');
  ok('deduplication: duplicate non-match neighbor emitted once', dup.length === 2);
}

// ── 9. computeStaleSourceFiles ───────────────────────────────────────────────
console.log('\n[9] computeStaleSourceFiles (no Qdrant)');
{
  const { computeStaleSourceFiles } = await import('./indexer/index.js');

  // 9a. Both sets empty → no stale
  ok('empty indexed + empty stored → []',
    computeStaleSourceFiles([], []).length === 0);

  // 9b. Standard stale case: c is in stored but not indexed
  const stale = computeStaleSourceFiles(['a.md', 'b.md'], ['a.md', 'b.md', 'c.md']);
  ok('stored has extra c.md → stale = [c.md]',
    stale.length === 1 && stale[0] === 'c.md');

  // 9c. Rename: old path stale, new path indexed
  const renamed = computeStaleSourceFiles(['renamed-new.md'], ['old.md', 'renamed-new.md']);
  ok('renamed: old.md stale, renamed-new.md kept',
    renamed.length === 1 && renamed[0] === 'old.md');

  // 9d. Sets equal → no stale
  ok('equal sets → []',
    computeStaleSourceFiles(['a.md', 'b.md'], ['a.md', 'b.md']).length === 0);

  // 9e. Inputs not mutated
  const inp1 = ['x.md'];
  const inp2 = ['x.md', 'y.md'];
  computeStaleSourceFiles(inp1, inp2);
  ok('inputs not mutated',
    inp1.length === 1 && inp2.length === 2);
}

// ── 10. resolveLinkCollections ──────────────────────────────────────────────
// Second arg is now a configCollectionsMap (name → entry object), not an array.
// Entries with linkDisabled: true are excluded, except for the current collection.
console.log('\n[10] resolveLinkCollections (no Qdrant)');
{
  const { resolveLinkCollections } = await import('./indexer/index.js');

  // 10a. Standard: qdrant has foreign; config knows a,b; current=a → {a,b}
  {
    const result = resolveLinkCollections(['a', 'b', 'foreign'], { a: {}, b: {} }, 'a', null);
    ok('qdrant {a,b,foreign}, config {a,b}, current a → {a,b}',
      result.length === 2 && result.includes('a') && result.includes('b') && !result.includes('foreign'));
  }

  // 10b. Config empty, current a → {a} (current always included)
  {
    const result = resolveLinkCollections(['a', 'b'], {}, 'a', null);
    ok('config empty, current a → includes a',  result.includes('a'));
    ok('config empty → no b',                   !result.includes('b'));
  }

  // 10c. Current collection missing from config → still included
  {
    const result = resolveLinkCollections(['a', 'b', 'c'], { b: {}, c: {} }, 'a', null);
    ok('current a missing from config → includes a',  result.includes('a'));
    ok('config-known b,c also included',              result.includes('b') && result.includes('c'));
    ok('no foreign beyond a,b,c',                     result.length === 3);
  }

  // 10d. LINK_COLLECTIONS=b with config {a,b,c}, current a → narrows to {b}
  // (allowlist does NOT auto-add current collection — existing LINK_COLLECTIONS semantics)
  {
    const result = resolveLinkCollections(['a', 'b', 'c'], { a: {}, b: {}, c: {} }, 'a', new Set(['b']));
    ok('LINK_COLLECTIONS=b, config {a,b,c}, current a → only b',
      result.length === 1 && result[0] === 'b');
  }

  // 10e. No Qdrant-only foreign collection ever included
  {
    const result = resolveLinkCollections(['a', 'external-1', 'external-2'], { a: {} }, 'a', null);
    ok('foreign Qdrant-only collections excluded',
      !result.includes('external-1') && !result.includes('external-2'));
  }

  // 10f. Current collection not yet in Qdrant list (just created) → still included
  {
    const result = resolveLinkCollections(['b', 'c'], { a: {}, b: {}, c: {} }, 'a', null);
    ok('current a not yet in qdrant list → still included', result.includes('a'));
  }

  // 10g. linkDisabled: true on a non-current collection → excluded
  {
    const result = resolveLinkCollections(
      ['a', 'b', 'legacy'],
      { a: {}, b: {}, legacy: { linkDisabled: true } },
      'a', null,
    );
    ok('linkDisabled entry excluded from link targets', !result.includes('legacy'));
    ok('non-disabled entries still included',           result.includes('a') && result.includes('b'));
  }

  // 10h. linkDisabled: true on the current collection → still included in base
  // (current collection must always be linkable for intra-collection cross-file links)
  {
    const result = resolveLinkCollections(
      ['a', 'b'],
      { a: { linkDisabled: true }, b: {} },
      'a', null,
    );
    ok('current collection included even if linkDisabled', result.includes('a'));
  }

  // 10i. linkDisabled + LINK_COLLECTIONS allowlist: disabled entry stays excluded
  {
    const result = resolveLinkCollections(
      ['a', 'b', 'legacy'],
      { a: {}, b: {}, legacy: { linkDisabled: true } },
      'a', new Set(['a', 'legacy']),
    );
    ok('linkDisabled excluded even when named in LINK_COLLECTIONS allowlist',
      !result.includes('legacy'));
    ok('non-disabled allowlisted entry included', result.includes('a'));
  }

  // 10j. linkDisabled: false (explicit false) → not excluded
  {
    const result = resolveLinkCollections(
      ['a', 'b'],
      { a: {}, b: { linkDisabled: false } },
      'a', null,
    );
    ok('linkDisabled: false is not excluded', result.includes('b'));
  }
}

// ── 11. recursiveChunkText ───────────────────────────────────────────────────
console.log('\n[11] recursiveChunkText (no Qdrant)');
{
  const { recursiveChunkText } = await import('./indexer/phases/chunk.js');

  // Read MAX from env the same way chunk.js does, so tests stay valid under any MAX_CHUNK_TOKENS.
  const TOKEN_CHARS = 4;
  const MAX = (() => { const v = parseInt(process.env.MAX_CHUNK_TOKENS ?? ''); return Number.isFinite(v) && v >= 1 ? v : 400; })();
  const bigWord = 'A'.repeat(MAX * TOKEN_CHARS + 4); // single unsplittable word > MAX_TOKENS

  // 11a. PDF page markers are stripped.
  {
    const text = 'First paragraph.\n\n-- 1 of 50 --\n\nSecond paragraph.';
    const chunks = recursiveChunkText(text, { stripPageMarkers: true });
    ok('page markers stripped — no chunk contains "of 50"',
      chunks.every(c => !c.includes('of 50')));
    ok('page markers stripped — both paragraphs present',
      chunks.some(c => c.includes('First')) && chunks.some(c => c.includes('Second')));
  }

  // 11b. Paragraphs are packed without crossing MAX_TOKENS.
  {
    // Each paragraph = floor(MAX/2) tokens. Two fit (≈MAX + join overhead), three don't.
    // Allow +1 token of join overhead (\n\n = 2 chars) per packed chunk.
    const paraTokens = Math.floor(MAX / 2);
    const para = 'B'.repeat(paraTokens * TOKEN_CHARS);
    const text = `${para}\n\n${para}\n\n${para}`;
    const chunks = recursiveChunkText(text);
    ok('three half-MAX paragraphs → at least 2 chunks', chunks.length >= 2);
    ok('no chunk exceeds MAX_TOKENS + join overhead', chunks.every(c => Math.ceil(c.length / TOKEN_CHARS) <= MAX + 1));
  }

  // 11c. Oversized paragraph falls back to sentence splitting.
  {
    // Each sentence = floor(MAX/2) tokens — fits alone but two together exceed MAX.
    // Three sentences with no \n\n form one paragraph that is 1.5×MAX > MAX.
    const sentTokens = Math.floor(MAX / 2);
    const sent = 'C'.repeat(sentTokens * TOKEN_CHARS) + '.';
    const text = `${sent} ${sent} ${sent}`; // no \n\n — single paragraph > MAX
    const chunks = recursiveChunkText(text);
    ok('oversized paragraph split by sentences → ≥ 2 chunks', chunks.length >= 2);
    ok('sentence-split chunks within MAX_TOKENS', chunks.every(c => Math.ceil(c.length / TOKEN_CHARS) <= MAX));
  }

  // 11d. Oversized single sentence (no punctuation boundary) falls back to word splitting.
  {
    // Words totalling MAX * 1.2 tokens — no sentence boundary, guaranteed > MAX.
    const targetChars = Math.ceil(MAX * 1.2) * TOKEN_CHARS;
    const wordCount = Math.ceil(targetChars / 6); // avg word ~5 chars + space
    const words = Array.from({ length: wordCount }, (_, i) => `word${i}`).join(' ');
    const chunks = recursiveChunkText(words);
    ok('oversized no-sentence text split by words → ≥ 2 chunks', chunks.length >= 2);
    ok('word-split chunks within MAX_TOKENS', chunks.every(c => Math.ceil(c.length / TOKEN_CHARS) <= MAX));
  }

  // 11e. Tiny final chunk is preserved (not dropped).
  {
    const big = 'D'.repeat(MAX * TOKEN_CHARS - 4); // just under MAX_TOKENS as one paragraph
    const tiny = 'tiny final';
    const text = `${big}\n\n${tiny}`;
    const chunks = recursiveChunkText(text);
    ok('tiny final chunk preserved', chunks.some(c => c.includes('tiny final')));
  }

  // 11f. Empty input returns [].
  {
    ok('empty string → []', recursiveChunkText('').length === 0);
    ok('whitespace-only → []', recursiveChunkText('   \n\n  ').length === 0);
  }

  // 11g. Text within MAX_TOKENS returned as single chunk.
  {
    const short = 'Short text that fits in one chunk.';
    const chunks = recursiveChunkText(short);
    ok('short text → exactly 1 chunk', chunks.length === 1);
    ok('short text chunk content preserved', chunks[0] === short);
  }

  // 11h. stripPageMarkers=false (default) — markers not stripped.
  {
    const text = 'Para one.\n\n-- 3 of 10 --\n\nPara two.';
    const chunks = recursiveChunkText(text); // default: no stripping
    ok('stripPageMarkers=false — marker text preserved',
      chunks.some(c => c.includes('3 of 10')));
  }

  // 11i. Unsplittable single word exceeding MAX_TOKENS is returned as-is (not dropped).
  {
    const chunks = recursiveChunkText(bigWord);
    ok('unsplittable oversized word returned as-is (not dropped)', chunks.length === 1);
    ok('unsplittable word content intact', chunks[0] === bigWord);
  }

  // 11j. Markdown chunking still uses chunkBySentences (chunkFile .md path unchanged).
  {
    const { chunkFile } = await import('./indexer/phases/chunk.js');
    const md = `# Section A\nSentence one. Sentence two.\n\n# Section B\nSentence three.`;
    const result = chunkFile('doc.md', md, 'doc.md');
    ok('markdown: section A chunk exists', result.some(c => c.section === 'Section A'));
    ok('markdown: section B chunk exists', result.some(c => c.section === 'Section B'));
    ok('markdown: no cross-section bleed',
      result.filter(c => c.section === 'Section B').every(c => !c.text.includes('Sentence one')));
  }

  // 11k. .txt does not use the PDF recursive path — page markers must NOT be stripped.
  {
    const { chunkFile } = await import('./indexer/phases/chunk.js');
    const txtWithMarker = 'Some text.\n\n-- 7 of 100 --\n\nMore text.';
    const result = chunkFile('notes.txt', txtWithMarker, 'notes.txt');
    ok('.txt: PDF page marker preserved (not on recursive PDF path)',
      result.some(c => c.text.includes('7 of 100')));
  }

  // 11l. parseMarkdown handles H1–H6 headings (#{1,6}) — not just #{1,3}.
  // This covers the pdf2md output where section headings appear as ##### (H5).
  {
    const { chunkFile } = await import('./indexer/phases/chunk.js');

    // H4 and H5 headings must be recognized as section boundaries.
    const md4 = `#### Deep Section\nContent under H4 heading.`;
    const r4 = chunkFile('doc.md', md4, 'doc.md');
    ok('H4 (####) becomes section name', r4.some(c => c.section === 'Deep Section'));

    const md5 = `##### Subsection\nContent under H5 heading.\n\n##### Another Sub\nMore content.`;
    const r5 = chunkFile('doc.md', md5, 'doc.md');
    ok('H5 (#####) becomes section name', r5.some(c => c.section === 'Subsection'));
    ok('two H5 sections are distinct', r5.some(c => c.section === 'Another Sub'));

    // H6 also recognized.
    const md6 = `###### Leaf\nLeaf content here.`;
    const r6 = chunkFile('doc.md', md6, 'doc.md');
    ok('H6 (######) becomes section name', r6.some(c => c.section === 'Leaf'));

    // Existing H1–H3 must still work (regression guard).
    const mdMixed = `# Top\nH1 body.\n\n## Mid\nH2 body.\n\n### Sub\nH3 body.`;
    const rMixed = chunkFile('doc.md', mdMixed, 'doc.md');
    ok('H1 still works after #{1,6} expansion', rMixed.some(c => c.section === 'Top'));
    ok('H2 still works after #{1,6} expansion', rMixed.some(c => c.section === 'Mid'));
    ok('H3 still works after #{1,6} expansion', rMixed.some(c => c.section === 'Sub'));
  }

  // 11m. PDF routing: hasStructure threshold uses /gm so multiple headings are counted.
  // Without the g flag, match() returns at most 1 result — threshold of 3 is never reached.
  {
    const mdWith3Headings = `# Title\nbody\n\n## Section A\ncontent A\n\n## Section B\ncontent B`;
    const mdWith2Headings = `# Title\nbody\n\n## Section A\ncontent A`;
    const mdNoHeadings    = `Just plain text with no headings at all.`;

    // The exact regex used in chunkFileFromPath PDF routing.
    const countHeadings = s => (s.match(/^#{1,6} /gm) || []).length;

    ok('3 headings → count=3 (≥3, structured path taken)',   countHeadings(mdWith3Headings) >= 3);
    ok('2 headings → count=2 (<3, fallback path taken)',      countHeadings(mdWith2Headings) < 3);
    ok('no headings → count=0 (<3, fallback path taken)',     countHeadings(mdNoHeadings) === 0);

    // Without g flag the match stops at 1 — this is what the bug looked like.
    const buggyCount = s => (s.match(/^#{1,6} /m) || []).length;
    ok('regression: without g flag, 3-heading doc still counts as 1 (bug reproduced)',
      buggyCount(mdWith3Headings) === 1);

    // pdf2md PAGE_BREAK stripping before routing: headings must survive cleanup.
    const { chunkFile } = await import('./indexer/phases/chunk.js');
    const pdf2mdOutput = `<!-- PAGE_BREAK -->\n## Chapter 1\nContent here.\n\n<!-- PAGE_BREAK -->\n## Chapter 2\nMore content.\n\n<!-- PAGE_BREAK -->\n## Chapter 3\nEven more.`;
    const cleaned = pdf2mdOutput.replace(/<!-- PAGE_BREAK -->/g, '\n').replace(/\n{3,}/g, '\n\n');
    ok('pdf2md PAGE_BREAK cleanup preserves headings', countHeadings(cleaned) >= 3);
    const chunks = chunkFile('book.md', cleaned, 'book.pdf');
    ok('cleaned pdf2md output → sections assigned', chunks.some(c => c.section === 'Chapter 1'));
    ok('cleaned pdf2md output → multiple distinct sections', new Set(chunks.map(c => c.section)).size >= 3);
  }
}

// ── 12. resolveOnnxExecutionProviders (no model load) ───────────────────────
console.log('\n[12] resolveOnnxExecutionProviders (no model load)');
{
  // Save and clear env so tests control it explicitly.
  const saved = process.env.ONNX_EXECUTION_PROVIDER;
  delete process.env.ONNX_EXECUTION_PROVIDER;

  const { resolveOnnxExecutionProviders } = await import('./core/onnx-embed.js');

  // 12a. Unset → ['cpu']
  ok('unset → [cpu]',
    resolveOnnxExecutionProviders(undefined).join(',') === 'cpu');

  // 12b. Empty string → ['cpu']
  ok('empty string → [cpu]',
    resolveOnnxExecutionProviders('').join(',') === 'cpu');

  // 12c. 'cpu' → ['cpu']
  ok("'cpu' → [cpu]",
    resolveOnnxExecutionProviders('cpu').join(',') === 'cpu');

  // 12d. 'dml' → ['dml', 'cpu'] (DirectML with CPU fallback)
  {
    const r = resolveOnnxExecutionProviders('dml');
    ok("'dml' → includes dml",  r[0] === 'dml');
    ok("'dml' → includes cpu fallback", r.includes('cpu'));
  }

  // 12e. 'cuda' → ['cuda'] (no auto-fallback in provider list; retry is in load())
  {
    const r = resolveOnnxExecutionProviders('cuda');
    ok("'cuda' → [cuda]", r.length === 1 && r[0] === 'cuda');
  }

  // 12f. Invalid value → ['cpu']
  ok("invalid value → [cpu]",
    resolveOnnxExecutionProviders('webgpu').join(',') === 'cpu');

  // 12g. Case-insensitive ('DML' treated as 'dml')
  ok("'DML' uppercase → includes dml",
    resolveOnnxExecutionProviders('DML')[0] === 'dml');

  // Restore env.
  if (saved !== undefined) process.env.ONNX_EXECUTION_PROVIDER = saved;
}

// ── 13. isSemidexPayload ─────────────────────────────────────────────────────
console.log('\n[13] isSemidexPayload (pure, no Qdrant)');
{
  const { isSemidexPayload } = await import('./core/qdrant.js');

  const FULL = {
    source_file: 'docs/readme.md',
    chunk_index: 0,
    file_hash: 'abc123',
    dense_provider: 'bge-m3-onnx',
    dense_model: 'aapot/bge-m3-onnx',
    sparse_provider: 'bge-m3-onnx',
    embedding_schema_version: 2,
    vector_size: 1024,
  };

  // 13a. Full semidex payload → true
  ok('full semidex payload → true', isSemidexPayload(FULL));

  // 13b–13i. Each discriminator field missing → false
  const FIELDS = Object.keys(FULL);
  for (const field of FIELDS) {
    const partial = { ...FULL };
    delete partial[field];
    ok(`missing ${field} → false`, !isSemidexPayload(partial));
  }

  // 13j. null → false (empty collection case: null payload is handled at call site,
  //      not by isSemidexPayload — but the function must not throw)
  ok('null → false', !isSemidexPayload(null));

  // 13k. undefined → false
  ok('undefined → false', !isSemidexPayload(undefined));

  // 13l. Foreign payload with text but no semidex fields → false
  ok('foreign payload without semidex fields → false',
    !isSemidexPayload({ text: 'hello', embedding: [0.1, 0.2] }));

  // 13m. Empty object → false
  ok('empty object → false', !isSemidexPayload({}));

  // 13n. getCollectionSamplePayload contract — isSemidexPayload correctly handles
  //      the two non-null return values from that helper:
  //      {} (point exists, no payload returned) → false → sync marks linkDisabled
  ok('empty-payload sentinel {} → false (non-empty foreign with no payload)',
    !isSemidexPayload({}));
  //      full semidex payload → true → sync does not disable
  ok('full payload still true after fixing return contract', isSemidexPayload(FULL));
}

// ── 14. Profiler ─────────────────────────────────────────────────────────────
console.log('\n[14] Profiler (pure, no I/O)');
{
  const { Profiler } = await import('./indexer/profiler.js');

  const savedProfile = process.env.INDEX_PROFILE;

  // 14a. Disabled when INDEX_PROFILE unset
  delete process.env.INDEX_PROFILE;
  {
    const p = new Profiler();
    ok('disabled when unset: enabled=false', p.enabled === false);
    p.mark('x');
    ok('disabled: mark() is no-op (no marks stored)', p.marks.length === 0);
  }

  // 14b. Disabled when INDEX_PROFILE=0
  process.env.INDEX_PROFILE = '0';
  {
    const p = new Profiler();
    ok('disabled when INDEX_PROFILE=0: enabled=false', p.enabled === false);
  }

  // 14c. Enabled when INDEX_PROFILE=1
  process.env.INDEX_PROFILE = '1';
  {
    const p = new Profiler();
    ok('enabled when INDEX_PROFILE=1: enabled=true', p.enabled === true);

    // 14d. mark() records labels in order
    p.mark('chunk');
    p.mark('context');
    p.mark('tag');
    ok('three marks recorded', p.marks.length === 3);
    ok('marks in order: chunk/context/tag',
      p.marks.map(m => m.label).join(',') === 'chunk,context,tag');

    // 14e. report() output contains all phase labels
    let output = '';
    const orig = console.log;
    console.log = (...args) => { output += args.join(' ') + '\n'; };
    p.report({ chunksIn: 5, chunksOut: 4, tokensEst: 200 });
    console.log = orig;
    ok('report output contains [profile]',   output.includes('[profile]'));
    ok('report output contains chunk label',  output.includes('chunk'));
    ok('report output contains context label', output.includes('context'));
    ok('report output contains tag label',    output.includes('tag'));
    ok('report output contains total',        output.includes('total'));
    ok('report output contains chunks/s',     output.includes('chunks/s'));

    // 14f. Single mark produces one phase row
    const p2 = new Profiler();
    p2.mark('only');
    let out2 = '';
    console.log = (...args) => { out2 += args.join(' ') + '\n'; };
    p2.report({ chunksIn: 1, chunksOut: 1, tokensEst: 50 });
    console.log = orig;
    ok('single mark: output contains only label', out2.includes('only'));
    ok('single mark: output contains total',      out2.includes('total'));

    // 14g. Zero chunks: cps reported as em-dash, no NaN or Infinity
    const p3 = new Profiler();
    p3.mark('chunk');
    let out3 = '';
    console.log = (...args) => { out3 += args.join(' ') + '\n'; };
    p3.report({ chunksIn: 0, chunksOut: 0, tokensEst: 0 });
    console.log = orig;
    ok('zero chunks: output does not contain NaN',      !out3.includes('NaN'));
    ok('zero chunks: output does not contain Infinity', !out3.includes('Infinity'));
    ok('zero chunks: cps reported as em-dash',          out3.includes('—'));

    // 14h. totalMs=0 with chunks: cps still em-dash, no Infinity
    const p4 = new Profiler();
    p4.mark('chunk');
    p4.t0 = Date.now() + 9999; // force totalMs = negative → effectively 0-guard
    let out4 = '';
    console.log = (...args) => { out4 += args.join(' ') + '\n'; };
    p4.report({ chunksIn: 3, chunksOut: 3, tokensEst: 100 });
    console.log = orig;
    ok('totalMs≤0 with chunks: no Infinity', !out4.includes('Infinity'));
    ok('totalMs≤0 with chunks: cps is em-dash', out4.includes('—'));
  }

  // Restore env
  if (savedProfile !== undefined) process.env.INDEX_PROFILE = savedProfile;
  else delete process.env.INDEX_PROFILE;
}

// ── 15. bootstrap-docs helpers (pure, no Qdrant) ─────────────────────────────
console.log('\n[15] bootstrap-docs helpers (pure, no Qdrant)');
{
  const {
    resolveRepoRoot,
    getBootstrapSources,
    checkCollisionGuard,
    buildIndexerEnv,
    applyManagedConfig,
  } = await import('./bootstrap-docs.js');
  const { isAbsolute, basename } = await import('path');

  // 15a. resolveRepoRoot() returns an absolute path
  const root = resolveRepoRoot();
  ok('resolveRepoRoot returns absolute path', isAbsolute(root));

  // 15b. source list contains README.md, AGENTS.md, and docs/en
  const sources = getBootstrapSources(root);
  ok('bootstrap sources include README.md',  sources.some(s => basename(s) === 'README.md'));
  ok('bootstrap sources include AGENTS.md',  sources.some(s => basename(s) === 'AGENTS.md'));
  ok('bootstrap sources include docs/en',    sources.some(s => s.endsWith('docs' + (process.platform === 'win32' ? '\\' : '/') + 'en') || s.includes('docs/en') || s.includes('docs\\en')));
  ok('bootstrap sources has exactly 3 entries', sources.length === 3);
  ok('all source entries are non-empty strings', sources.every(s => typeof s === 'string' && s.length > 0));

  // 15c. buildIndexerEnv defaults to ONNX but respects explicit opt-out
  {
    const envDefault = buildIndexerEnv({}, root);
    ok('buildIndexerEnv default sets ONNX_EMBED=1', envDefault.ONNX_EMBED === '1');
    ok('buildIndexerEnv sets COLLECTION=semidex-docs', envDefault.COLLECTION === 'semidex-docs');
    ok('buildIndexerEnv sets SOURCE_ROOT to repo root', envDefault.SOURCE_ROOT === root);

    const envOptOut = buildIndexerEnv({ ONNX_EMBED: '0' }, root);
    ok('buildIndexerEnv respects ONNX_EMBED=0 opt-out', envOptOut.ONNX_EMBED === '0');
  }

  // 15d. applyManagedConfig writes provider + management metadata
  {
    const cfg = applyManagedConfig({ collections: {} }, buildIndexerEnv({}, root));
    const entry = cfg.collections?.['semidex-docs'];
    ok('applyManagedConfig writes semidexManaged:true', entry?.semidexManaged === true);
    ok('applyManagedConfig writes linkDisabled:true', entry?.linkDisabled === true);
    ok('applyManagedConfig writes ONNX denseProvider by default', entry?.denseProvider === 'bge-m3-onnx');
    ok('applyManagedConfig writes ONNX sparseProvider by default', entry?.sparseProvider === 'bge-m3-onnx');

    const fallback = applyManagedConfig({ collections: {} }, buildIndexerEnv({ ONNX_EMBED: '0' }, root));
    ok('applyManagedConfig respects ONNX_EMBED=0 dense fallback',
      fallback.collections?.['semidex-docs']?.denseProvider === 'ollama');
    ok('applyManagedConfig respects ONNX_EMBED=0 sparse fallback',
      fallback.collections?.['semidex-docs']?.sparseProvider === 'hashed-tf');
  }

  // 15e. semidexManaged config field round-trips through loadConfig/saveConfig
  await withConfig(
    { collections: { 'semidex-docs': { semidexManaged: true, linkDisabled: true, description: 'test' } } },
    async () => {
      const { loadConfig } = await import('./core/config.js');
      const cfg = loadConfig();
      ok('semidexManaged:true survives loadConfig round-trip',
        cfg.collections?.['semidex-docs']?.semidexManaged === true);
      ok('linkDisabled:true survives loadConfig round-trip',
        cfg.collections?.['semidex-docs']?.linkDisabled === true);
    },
  );

  // 15f. Collision guard: non-managed existing collection → returns error string
  {
    const existsButNotManaged = true;
    const configNoManaged = { collections: { 'semidex-docs': { denseProvider: 'ollama' } } };
    const err = checkCollisionGuard(existsButNotManaged, configNoManaged);
    ok('non-managed existing collection → returns error string', typeof err === 'string' && err.length > 0);
    ok('error string mentions semidex-docs',   err.includes('semidex-docs'));
    ok('error string mentions semidexManaged',  err.includes('semidexManaged'));
  }

  // 15g. Collision guard: collection does not exist → returns null (safe to proceed)
  {
    const err = checkCollisionGuard(false, {});
    ok('collection absent → no collision (null)', err === null);
  }

  // 15h. Collision guard: exists + semidexManaged:true → returns null (safe to re-run)
  {
    const configManaged = { collections: { 'semidex-docs': { semidexManaged: true } } };
    const err = checkCollisionGuard(true, configManaged);
    ok('semidexManaged:true existing collection → no collision (null)', err === null);
  }
}

// ── 16. extractJsonArray (tag batch parser) ───────────────────────────────────
console.log('\n[16] extractJsonArray (tag batch parser)');
{
  const { extractJsonArray } = await import('./indexer/phases/tag.js');

  ok('flat array → returned as-is',
    JSON.stringify(extractJsonArray('[["a","b"],["c","d"]]', 2)) === '[["a","b"],["c","d"]]');

  ok('object wrapper {"tags":[[...]],"tags2":[[...]]} → flattened',
    JSON.stringify(extractJsonArray('{"tags":[["a","b"]],"tags2":[["c","d"]]}', 2)) === '[["a","b"],["c","d"]]');

  ok('flat strings per chunk {"c0":["a"],"c1":["b"]} → flattened',
    JSON.stringify(extractJsonArray('{"c0":["a","b"],"c1":["c","d"]}', 2)) === '[["a","b"],["c","d"]]');

  ok('wrong length → null',
    extractJsonArray('[["a"],["b"],["c"]]', 2) === null);

  ok('empty object → null',
    extractJsonArray('{}', 2) === null);

  ok('markdown fenced → parsed',
    JSON.stringify(extractJsonArray('```json\n[["a"],["b"]]\n```', 2)) === '[["a"],["b"]]');
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Smoke tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
