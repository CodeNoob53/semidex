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

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Smoke tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
