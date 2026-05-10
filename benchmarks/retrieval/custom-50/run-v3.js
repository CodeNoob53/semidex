// Quality retrieval benchmark — v3 schema with graded chunk-level relevance.
//
// Uses bench-retrieval-custom-50 collection (separate from stable 21q regression).
// Supports hybrid (RRF) and dense-mmr search modes.
//
// Usage:
//   node benchmarks/retrieval/custom-50/run-v3.js
//   npm run bench:custom50
//   BENCH_PROVIDER=onnx npm run bench:custom50
//   BENCH_SKIP_INDEX=1 npm run bench:custom50
//   BENCH_TOP_K=10 npm run bench:custom50
//   BENCH_SEARCH_MODE=dense-mmr npm run bench:custom50
//   BENCH_WINDOW=1 npm run bench:custom50   # windowRecall adjacency window (default: 1)

if (process.argv.includes('--help')) {
  process.stdout.write(`semidex custom-50 quality benchmark (v3 schema)

Usage:
  node benchmarks/retrieval/custom-50/run-v3.js [options]
  npm run bench:custom50

Options (env vars):
  BENCH_PROVIDER=onnx          Force bge-m3-onnx regardless of .env
  BENCH_SKIP_INDEX=1           Skip re-indexing; reuse existing collection
  BENCH_TOP_K=<n>              Search depth (default: 10)
  BENCH_SEARCH_MODE=<mode>     hybrid (default) or dense-mmr
  MMR_DIVERSITY=<0..1>         Dense MMR diversity balance (default: 0.5)
  MMR_CANDIDATES_LIMIT=<n>     Dense MMR preselect candidate count (default: 100)
  BENCH_JSON=1                 Emit JSON summary on stdout (human output to stderr)
  BENCH_WINDOW=<n>             Adjacency window for windowRecall (default: 1)

Query schema (queries.json): v3
  { schemaVersion: 3, queries: [{
      id, type, query, expectedFiles, relevantChunks, expectedTokens,
      shouldHaveNoStrongHit, note
  }] }

  relevantChunks: [{ chunkId: "file.md#N", relevance: 1|2|3 }]
  relevance 3 = exact answer, 2 = supporting, 1 = same-topic
  chunkRecall@K counts relevance >= 3; supportRecall@K counts >= 2

Metrics:
  chunkRecall@3/5/10   Exact answer chunk in top-3/5/10
  windowRecall@5/10    Exact chunk or ±window neighbor in top-5/10
  supportRecall@K      Supporting or exact chunk in top-K
  nDCG@K (graded)      Gain = 2^relevance - 1, normalised
  MRR@10               Reciprocal rank of first rel>=3 chunk in top-10
  fileRecall@1/K       Expected file-level recall (secondary)
  negativePassRate     Fraction of negative queries with no strong hit in top-1

Prerequisites: QDRANT_URL and QDRANT_KEY in .env or environment.
`);
  process.exit(0);
}

import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { chunkFile } from '../../../src/indexer/phases/chunk.js';
import {
  listCollections, createCollection, deleteBySourceFile,
  upsertPoints, hybridSearch, mmrSearch, scroll,
} from '../../../src/core/qdrant.js';
import { embedForIndex, embedForSearch, SCHEMA_VERSION } from '../../../src/core/embeddings.js';
import { loadConfig, saveConfig, resolveEnvProviders } from '../../../src/core/config.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
// Existing 4 fixture docs live in the parent benchmark's fixtures directory.
// New 6 docs live in this benchmark's own fixtures directory.
const FIXTURES_SHARED = resolve(__dirname, '../fixtures/docs');
const FIXTURES_OWN    = resolve(__dirname, 'fixtures/docs');
const QUERIES_PATH    = resolve(__dirname, 'queries.json');

const COLLECTION           = 'bench-retrieval-custom-50';
const TOP_K                = envInt('BENCH_TOP_K', 10, 1, 1000);
const SEARCH_MODE          = process.env.BENCH_SEARCH_MODE ?? 'hybrid';
const SKIP_INDEX           = process.env.BENCH_SKIP_INDEX === '1';
const BENCH_PROVIDER       = process.env.BENCH_PROVIDER ?? 'env';
const JSON_MODE            = process.env.BENCH_JSON === '1';
const MMR_DIVERSITY        = envFloat('MMR_DIVERSITY', 0.5, 0, 1);
const MMR_CANDIDATES_LIMIT = envInt('MMR_CANDIDATES_LIMIT', 100, 1, 10000);
const BENCH_WINDOW         = envInt('BENCH_WINDOW', 1, 0, 10);

// Fixture files with their source directories.
// Shared: taken from benchmarks/retrieval/fixtures/docs/ (stable regression corpus).
// Own: taken from this directory's fixtures/docs/ (new coverage docs).
const FIXTURE_FILES = [
  { name: 'providers.md',       dir: FIXTURES_SHARED },
  { name: 'qdrant.md',          dir: FIXTURES_SHARED },
  { name: 'chunking.md',        dir: FIXTURES_SHARED },
  { name: 'sync.md',            dir: FIXTURES_SHARED },
  { name: 'mcp-workflow.md',    dir: FIXTURES_OWN },
  { name: 'obsidian.md',        dir: FIXTURES_OWN },
  { name: 'project-structure.md', dir: FIXTURES_OWN },
  { name: 'benchmarking.md',    dir: FIXTURES_OWN },
  { name: 'config-env.md',      dir: FIXTURES_OWN },
  { name: 'multilingual.md',    dir: FIXTURES_OWN },
];

const log  = (...a) => JSON_MODE ? process.stderr.write(a.join(' ') + '\n') : console.log(...a);
const logw = (s)    => JSON_MODE ? process.stderr.write(s) : process.stdout.write(s);

function envInt(name, def, min, max) {
  const v = parseInt(process.env[name] ?? '');
  if (!Number.isFinite(v) || v < min || v > max) {
    if (process.env[name] !== undefined)
      console.warn(`[bench-v3] ${name}="${process.env[name]}" is invalid — using default ${def}`);
    return def;
  }
  return v;
}

function envFloat(name, def, min, max) {
  const v = Number.parseFloat(process.env[name] ?? '');
  if (!Number.isFinite(v) || v < min || v > max) {
    if (process.env[name] !== undefined)
      console.warn(`[bench-v3] ${name}="${process.env[name]}" is invalid — using default ${def}`);
    return def;
  }
  return v;
}

if (!['hybrid', 'dense-mmr'].includes(SEARCH_MODE)) {
  process.stderr.write(`Error: BENCH_SEARCH_MODE="${SEARCH_MODE}" is invalid. Use "hybrid" or "dense-mmr".\n`);
  process.exit(1);
}

if (BENCH_PROVIDER === 'onnx') {
  process.env.ONNX_EMBED = '1';
  delete process.env.DENSE_PROVIDER;
  delete process.env.SPARSE_PROVIDER;
}

// ── v3 schema helpers ─────────────────────────────────────────────────────────

// Build a relevance lookup: "file.md#3" → relevance score (1–3).
function buildQrels(relevantChunks) {
  const map = new Map();
  for (const rc of (relevantChunks ?? [])) {
    map.set(rc.chunkId, rc.relevance ?? 3);
  }
  return map;
}

// Normalise a v3 query to internal shape.
function normaliseQuery(q) {
  return {
    id:                   q.id,
    type:                 q.type ?? 'file-level',
    query:                q.query,
    expectedFiles:        q.expectedFiles ?? [],
    relevantChunks:       q.relevantChunks ?? [],
    qrels:                buildQrels(q.relevantChunks),
    expectedTokens:       q.expectedTokens ? q.expectedTokens.flatMap(t => tokenise(t)).filter(Boolean) : null,
    shouldHaveNoStrongHit: q.shouldHaveNoStrongHit ?? false,
    note:                 q.note ?? '',
  };
}

function tokenise(str) {
  return (str ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

// ── Indexing ──────────────────────────────────────────────────────────────────

async function ensureCollection() {
  const cols = await listCollections();
  if (!cols.includes(COLLECTION)) {
    await createCollection(COLLECTION, 1024);
  }
  const { denseProvider, denseModel, sparseProvider } = resolveEnvProviders();
  const cfg = loadConfig();
  cfg.collections ??= {};
  cfg.collections[COLLECTION] = {
    denseProvider, denseModel, sparseProvider,
    embeddingSchemaVersion: SCHEMA_VERSION,
    vectorSize: 1024,
    description: 'custom-50 quality benchmark — auto-managed',
  };
  saveConfig(cfg);
  return { denseProvider, sparseProvider };
}

async function fetchStoredProvider() {
  const points = await scroll(COLLECTION, undefined, 1, ['dense_provider', 'sparse_provider']);
  const p = points[0]?.payload;
  if (!p) return null;
  return { denseProvider: p.dense_provider ?? null, sparseProvider: p.sparse_provider ?? null };
}

// Returns { indexedIds, emptyChunkIds } after indexing.
// emptyChunkIds: chunk IDs whose text is empty or a heading-only placeholder
// (e.g. "(empty section: …)"). Used by emptyExpectedChunkCount guardrail.
function isEmptyChunkText(text) {
  if (!text || !text.trim()) return true;
  return /^\(empty section:/i.test(text.trim());
}

async function indexFixtures() {
  const indexedIds  = new Set();
  const emptyChunkIds = new Set();
  for (const { name, dir } of FIXTURE_FILES) {
    const filePath   = resolve(dir, name);
    const text       = readFileSync(filePath, 'utf8');
    const sourceFile = name;

    await deleteBySourceFile(COLLECTION, sourceFile);

    const chunks = chunkFile(filePath, text, sourceFile);
    const points = [];
    for (const chunk of chunks) {
      const cid = `${sourceFile}#${chunk.chunkIndex}`;
      indexedIds.add(cid);
      if (isEmptyChunkText(chunk.text)) emptyChunkIds.add(cid);
      const { dense, sparse, meta } = await embedForIndex(COLLECTION, chunk.text);
      points.push({
        id: randomUUID(),
        vector: { dense, sparse },
        payload: {
          text:         chunk.text,
          section:      chunk.section,
          source_file:  sourceFile,
          chunk_index:  chunk.chunkIndex,
          total_chunks: chunk.totalChunks,
          file_hash:    'bench-v3',
          vector_size:  1024,
          ...meta,
        },
      });
    }
    await upsertPoints(COLLECTION, points);
    logw(`  indexed ${name} (${points.length} chunks)\n`);
  }
  return { indexedIds, emptyChunkIds };
}

// Collect chunk IDs from Qdrant (used when BENCH_SKIP_INDEX=1).
// Scrolls up to 2000 points; sufficient for bench-scale fixture sets.
// Returns { indexedIds, emptyChunkIds } matching the shape of indexFixtures().
async function fetchIndexedChunkIds() {
  const points = await scroll(COLLECTION, undefined, 2000, ['source_file', 'chunk_index', 'text']);
  const indexedIds   = new Set();
  const emptyChunkIds = new Set();
  for (const p of points) {
    const sf = p.payload?.source_file;
    const ci = p.payload?.chunk_index;
    if (sf != null && ci != null) {
      const cid = `${sf}#${ci}`;
      indexedIds.add(cid);
      if (isEmptyChunkText(p.payload?.text)) emptyChunkIds.add(cid);
    }
  }
  return { indexedIds, emptyChunkIds };
}

// Fail-fast validation: check every chunkId in relevantChunks exists in the index.
// Prints all bad IDs grouped by query before exiting.
function validateQrels(queries, indexedIds) {
  const errors = [];
  for (const q of queries) {
    if (q.shouldHaveNoStrongHit) continue;
    for (const rc of q.relevantChunks) {
      if (!indexedIds.has(rc.chunkId)) {
        errors.push(`  [${q.id}] "${rc.chunkId}" not found (relevance=${rc.relevance})`);
      }
    }
  }
  if (errors.length) {
    process.stderr.write(
      `\nError: ${errors.length} qrel chunkId(s) not found in index "${COLLECTION}":\n` +
      errors.join('\n') + '\n' +
      `\nFix the chunkIds in queries.json or re-run without BENCH_SKIP_INDEX=1.\n` +
      `Valid chunkIds: ${[...indexedIds].sort().slice(0, 10).join(', ')}${indexedIds.size > 10 ? ` ... (+${indexedIds.size - 10} more)` : ''}\n`
    );
    process.exit(1);
  }
}

// ── Search ────────────────────────────────────────────────────────────────────

async function runQuery(queryText) {
  const t0 = Date.now();
  const { dense, sparse } = await embedForSearch(COLLECTION, queryText);

  let results;
  if (SEARCH_MODE === 'dense-mmr') {
    results = await mmrSearch(COLLECTION, dense, TOP_K, null, {
      diversity: MMR_DIVERSITY,
      candidatesLimit: MMR_CANDIDATES_LIMIT,
    });
  } else {
    results = await hybridSearch(COLLECTION, dense, sparse, TOP_K);
  }

  const latency = Date.now() - t0;
  return { results, latency };
}

// ── Chunk-level metric helpers ────────────────────────────────────────────────

// Extract chunkId from a Qdrant result point.
function resultChunkId(r) {
  const sf = r.payload?.source_file;
  const ci = r.payload?.chunk_index;
  if (!sf || ci == null) return null;
  return `${sf}#${ci}`;
}

// Ideal DCG for a set of qrels at depth k.
function idealDCG(qrels, k) {
  const gains = [...qrels.values()].map(rel => Math.pow(2, rel) - 1).sort((a, b) => b - a);
  let idcg = 0;
  for (let i = 0; i < Math.min(gains.length, k); i++) {
    idcg += gains[i] / Math.log2(i + 2);
  }
  return idcg;
}

// Compute graded nDCG@k for a ranked list of results against qrels.
function gradedNDCG(results, qrels, k) {
  if (!qrels.size) return null;
  const topK = results.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    const cid = resultChunkId(topK[i]);
    const rel = cid ? (qrels.get(cid) ?? 0) : 0;
    dcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }
  const idcg = idealDCG(qrels, k);
  return idcg === 0 ? 0 : dcg / idcg;
}

// chunkRecall@k: fraction where at least one rel>=minRel chunk appears in top-k.
function chunkRecallHit(results, qrels, k, minRel = 3) {
  if (!qrels.size) return null;
  const relevantIds = new Set([...qrels.entries()].filter(([, r]) => r >= minRel).map(([id]) => id));
  if (!relevantIds.size) return null;
  return results.slice(0, k).some(r => relevantIds.has(resultChunkId(r)));
}

// MRR@k: reciprocal rank of first rel>=minRel chunk.
function mrr(results, qrels, k, minRel = 3) {
  if (!qrels.size) return null;
  const relevantIds = new Set([...qrels.entries()].filter(([, r]) => r >= minRel).map(([id]) => id));
  if (!relevantIds.size) return null;
  for (let i = 0; i < Math.min(results.length, k); i++) {
    if (relevantIds.has(resultChunkId(results[i]))) return 1 / (i + 1);
  }
  return 0;
}

// Parse "source_file#chunk_index" → { sourceFile, chunkIndex } or null.
function parseChunkId(chunkId) {
  if (!chunkId) return null;
  const hash = chunkId.lastIndexOf('#');
  if (hash < 0) return null;
  const sourceFile  = chunkId.slice(0, hash);
  const chunkIndex  = parseInt(chunkId.slice(hash + 1), 10);
  if (!sourceFile || !Number.isFinite(chunkIndex)) return null;
  return { sourceFile, chunkIndex };
}

// windowRecall@k: fraction where a rel>=3 chunk OR an adjacent chunk (within ±BENCH_WINDOW)
// appears in top-k. This captures near-misses where the retriever found a neighbor chunk
// that an MCP agent could expand via qdrant_get_chunk(window=N).
function windowRecallHit(results, qrels, k, window) {
  if (!qrels.size) return null;
  const exactIds = [...qrels.entries()].filter(([, r]) => r >= 3).map(([id]) => id);
  if (!exactIds.length) return null;
  const topK = results.slice(0, k);
  // Direct hit.
  const directHit = topK.some(r => {
    const cid = resultChunkId(r);
    return cid && qrels.get(cid) >= 3;
  });
  if (directHit) return true;
  // Window hit: returned chunk is a sibling (same file, index within ±window).
  for (const exactId of exactIds) {
    const ep = parseChunkId(exactId);
    if (!ep) continue;
    const windowHit = topK.some(r => {
      const rp = parseChunkId(resultChunkId(r));
      if (!rp) return false;
      return rp.sourceFile === ep.sourceFile && Math.abs(rp.chunkIndex - ep.chunkIndex) <= window;
    });
    if (windowHit) return true;
  }
  return false;
}

// File-level: build ranked file list (dedup, preserve order).
function rankedFileList(results) {
  const seen = new Set();
  const out  = [];
  for (const r of results) {
    const sf = r.payload?.source_file;
    if (sf && !seen.has(sf)) { seen.add(sf); out.push(sf); }
  }
  return out;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Aggregate metrics ─────────────────────────────────────────────────────────

function computeMetrics(queryResults, emptyChunkIds = new Set()) {
  const positives = queryResults.filter(r => !r.query.shouldHaveNoStrongHit);
  const negatives = queryResults.filter(r =>  r.query.shouldHaveNoStrongHit);

  let cr3 = 0, cr5 = 0, cr10 = 0, wr5 = 0, wr10 = 0, supp = 0, ndcgSum = 0, mrrSum = 0;
  let mrrCount = 0;
  let fRecall1 = 0, fRecallK = 0;
  let negPass = 0;
  const latencies = queryResults.map(r => r.latency).sort((a, b) => a - b);

  for (const r of positives) {
    const { results, query } = r;

    const cr3Hit  = chunkRecallHit(results, query.qrels, 3,      3);
    const cr5Hit  = chunkRecallHit(results, query.qrels, 5,      3);
    const cr10Hit = chunkRecallHit(results, query.qrels, TOP_K,  3);
    const wr5Hit  = windowRecallHit(results, query.qrels, 5,  BENCH_WINDOW);
    const wr10Hit = windowRecallHit(results, query.qrels, TOP_K, BENCH_WINDOW);
    const suppHit = chunkRecallHit(results, query.qrels, TOP_K,  2);
    const ndcgVal = gradedNDCG(results, query.qrels, TOP_K);
    const mrrVal  = mrr(results, query.qrels, 10, 3);

    if (cr3Hit  !== null) cr3  += cr3Hit  ? 1 : 0;
    if (cr5Hit  !== null) cr5  += cr5Hit  ? 1 : 0;
    if (cr10Hit !== null) cr10 += cr10Hit ? 1 : 0;
    if (wr5Hit  !== null) wr5  += wr5Hit  ? 1 : 0;
    if (wr10Hit !== null) wr10 += wr10Hit ? 1 : 0;
    if (suppHit !== null) supp += suppHit ? 1 : 0;
    if (ndcgVal !== null) ndcgSum += ndcgVal;
    if (mrrVal  !== null) { mrrSum += mrrVal; mrrCount++; }

    const rf = rankedFileList(results);
    const ef = query.expectedFiles;
    if (ef.length) {
      if (rf.slice(0, 1).some(f => ef.includes(f)))   fRecall1++;
      if (rf.slice(0, TOP_K).some(f => ef.includes(f))) fRecallK++;
    }
  }

  for (const r of negatives) {
    const { results, query } = r;
    if (!results.length) { negPass++; continue; }
    const top1Words = new Set([
      ...tokenise(results[0].payload?.text    ?? ''),
      ...tokenise(results[0].payload?.section ?? ''),
    ]);
    const strongHit = (query.expectedTokens ?? []).some(t => top1Words.has(t));
    if (!strongHit) negPass++;
  }

  const n = positives.length;
  // Queries that have qrels with rel>=3 (some queries may only have rel<=2 supporting chunks)
  const hasExact = positives.filter(r => [...r.query.qrels.values()].some(v => v >= 3)).length;
  // Queries that have any qrels
  const hasAnyQrels = positives.filter(r => r.query.qrels.size > 0).length;

  // Guardrail: queries where every rel>=3 qrel points to an empty/heading-only chunk.
  // A non-zero value means qrels need review — the benchmark is measuring against
  // chunks with no retrievable content.
  const emptyExpectedChunkCount = positives.filter(r => {
    const exactIds = [...r.query.qrels.entries()].filter(([, v]) => v >= 3).map(([id]) => id);
    return exactIds.length > 0 && exactIds.every(id => emptyChunkIds.has(id));
  }).length;

  return {
    chunkRecall3:     hasExact > 0    ? cr3  / hasExact : null,
    chunkRecall5:     hasExact > 0    ? cr5  / hasExact : null,
    chunkRecall10:    hasExact > 0    ? cr10 / hasExact : null,
    windowRecall5:    hasExact > 0    ? wr5  / hasExact : null,
    windowRecall10:   hasExact > 0    ? wr10 / hasExact : null,
    supportRecallK:  hasAnyQrels > 0  ? supp / hasAnyQrels : null,
    ndcgK:           hasAnyQrels > 0  ? ndcgSum / hasAnyQrels : null,
    mrr10:           mrrCount > 0     ? mrrSum / mrrCount : null,
    fileRecall1:     n > 0            ? fRecall1 / positives.filter(r => r.query.expectedFiles.length).length : null,
    fileRecallK:     n > 0            ? fRecallK / positives.filter(r => r.query.expectedFiles.length).length : null,
    negativePassRate: negatives.length > 0 ? negPass / negatives.length : null,
    avgLatency: latencies.length > 0  ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
    p50Latency: percentile(latencies, 50),
    p95Latency: percentile(latencies, 95),
    nPositive: n,
    nNegative: negatives.length,
    topK: TOP_K,
    window: BENCH_WINDOW,
    emptyExpectedChunkCount,
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function pct(v, decimals = 1) { return v === null ? 'n/a' : `${(v * 100).toFixed(decimals)}%`; }
function pad(s, n)  { return String(s).padEnd(n); }
function lpad(s, n) { return String(s).padStart(n); }

function printResults(queryResults) {
  const W = { id: 4, query: 44, cr3: 4, cr5: 4, sup: 4, ndcg: 7, mrr: 6, ms: 6 };
  const header = [
    pad('ID',   W.id),
    pad('Query', W.query),
    lpad('cr3', W.cr3),
    lpad('cr5', W.cr5),
    lpad('sup', W.sup),
    lpad('nDCG', W.ndcg),
    lpad('MRR', W.mrr),
    lpad('ms', W.ms),
  ].join('  ');

  log('\n' + '─'.repeat(header.length));
  log(header);
  log('─'.repeat(header.length));

  for (const r of queryResults) {
    const { query, results } = r;
    if (query.shouldHaveNoStrongHit) {
      const top1Words = new Set([
        ...tokenise(results[0]?.payload?.text    ?? ''),
        ...tokenise(results[0]?.payload?.section ?? ''),
      ]);
      const strongHit = (query.expectedTokens ?? []).some(t => top1Words.has(t));
      log([
        pad(query.id,                    W.id),
        pad(query.query.slice(0, W.query - 1), W.query),
        lpad('neg', W.cr3),
        lpad('neg', W.cr5),
        lpad('neg', W.sup),
        lpad(strongHit ? '✗' : '✓', W.ndcg),
        lpad('–', W.mrr),
        lpad(r.latency, W.ms),
      ].join('  '));
      continue;
    }

    const cr3s = chunkRecallHit(results, query.qrels, 3, 3);
    const cr5s = chunkRecallHit(results, query.qrels, 5, 3);
    const sups = chunkRecallHit(results, query.qrels, TOP_K, 2);
    const ndcgV = gradedNDCG(results, query.qrels, TOP_K);
    const mrrV  = mrr(results, query.qrels, 10, 3);

    log([
      pad(query.id,                         W.id),
      pad(query.query.slice(0, W.query - 1), W.query),
      lpad(cr3s === null ? '–' : (cr3s ? '✓' : '✗'), W.cr3),
      lpad(cr5s === null ? '–' : (cr5s ? '✓' : '✗'), W.cr5),
      lpad(sups === null ? '–' : (sups ? '✓' : '✗'), W.sup),
      lpad(ndcgV !== null ? ndcgV.toFixed(3) : 'n/a', W.ndcg),
      lpad(mrrV  !== null ? mrrV.toFixed(3)  : 'n/a', W.mrr),
      lpad(r.latency, W.ms),
    ].join('  '));
  }

  log('─'.repeat(header.length));
}

function printSummary(metrics, provider) {
  log(`\nProvider          : ${provider}`);
  log(`Queries           : ${metrics.nPositive} positive, ${metrics.nNegative} negative`);
  log(`chunkRecall@3     : ${pct(metrics.chunkRecall3)}`);
  log(`chunkRecall@5     : ${pct(metrics.chunkRecall5)}`);
  log(`chunkRecall@${TOP_K}    : ${pct(metrics.chunkRecall10)}`);
  log(`windowRecall@5    : ${pct(metrics.windowRecall5)}  (±${BENCH_WINDOW} window)`);
  log(`windowRecall@${TOP_K}   : ${pct(metrics.windowRecall10)}  (±${BENCH_WINDOW} window)`);
  log(`supportRecall@${TOP_K}  : ${pct(metrics.supportRecallK)}`);
  log(`nDCG@${TOP_K} (graded)  : ${metrics.ndcgK?.toFixed(3) ?? 'n/a'}`);
  log(`MRR@10            : ${metrics.mrr10?.toFixed(3) ?? 'n/a'}`);
  log(`fileRecall@1      : ${pct(metrics.fileRecall1)}`);
  log(`fileRecall@${TOP_K}     : ${pct(metrics.fileRecallK)}`);
  if (metrics.negativePassRate !== null)
    log(`negativePass      : ${pct(metrics.negativePassRate)}`);
  if (metrics.emptyExpectedChunkCount > 0)
    log(`⚠ emptyExpected   : ${metrics.emptyExpectedChunkCount} queries point to empty/heading-only qrel chunks — review qrels`);
  log(`Latency p50/p95   : ${metrics.p50Latency}ms / ${metrics.p95Latency}ms`);
  log(`Avg ms            : ${Math.round(metrics.avgLatency)}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const raw     = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  const queries = raw.queries.map(normaliseQuery);
  const { denseProvider, sparseProvider } = resolveEnvProviders();

  log(`\n=== semidex custom-50 quality benchmark ===`);
  log(`Provider  : ${BENCH_PROVIDER}  (${denseProvider}/${sparseProvider})`);
  log(`Search    : ${SEARCH_MODE}${SEARCH_MODE === 'dense-mmr' ? `  (diversity=${MMR_DIVERSITY}, candidates=${MMR_CANDIDATES_LIMIT})` : ''}`);
  log(`Top-K     : ${TOP_K}`);
  log(`Queries   : ${queries.length} (${queries.filter(q => !q.shouldHaveNoStrongHit).length} positive, ${queries.filter(q => q.shouldHaveNoStrongHit).length} negative)`);

  log('\n[1/2] Setup collection...');
  await ensureCollection();

  let indexedIds, emptyChunkIds;
  if (SKIP_INDEX) {
    const stored = await fetchStoredProvider();
    if (!stored) {
      process.stderr.write(
        `\nError: BENCH_SKIP_INDEX=1 but no indexed points found in "${COLLECTION}".\n` +
        `Re-run without BENCH_SKIP_INDEX=1 to index fixtures first.\n`
      );
      process.exit(1);
    }
    if (stored.denseProvider !== denseProvider || stored.sparseProvider !== sparseProvider) {
      process.stderr.write(
        `\nError: BENCH_SKIP_INDEX=1 but stored provider (${stored.denseProvider}/${stored.sparseProvider}) ` +
        `differs from current (${denseProvider}/${sparseProvider}).\n` +
        `Re-run without BENCH_SKIP_INDEX=1 to reindex fixtures with the new provider.\n`
      );
      process.exit(1);
    }
    log('[2/2] Skipping index (BENCH_SKIP_INDEX=1) — fetching chunk IDs for qrel validation...');
    ({ indexedIds, emptyChunkIds } = await fetchIndexedChunkIds());
  } else {
    log(`[2/2] Indexing ${FIXTURE_FILES.length} fixture docs...`);
    ({ indexedIds, emptyChunkIds } = await indexFixtures());
  }

  log('Validating qrels...');
  validateQrels(queries, indexedIds);

  log('\nRunning queries...');
  const queryResults = [];
  for (const q of queries) {
    logw(`  ${q.id}: ${q.query.slice(0, 42)}... `);
    const { results, latency } = await runQuery(q.query);

    queryResults.push({ query: q, results, latency });

    if (q.shouldHaveNoStrongHit) {
      log(`(neg) (${latency}ms)`);
    } else {
      const hit = chunkRecallHit(results, q.qrels, 5, 3);
      log(hit ? `✓ (${latency}ms)` : `✗ (${latency}ms)`);
    }
  }

  const metrics = computeMetrics(queryResults, emptyChunkIds);
  printResults(queryResults);
  printSummary(metrics, BENCH_PROVIDER);
  log('');

  if (JSON_MODE) {
    process.stdout.write(JSON.stringify({
      provider:      BENCH_PROVIDER,
      denseProvider,
      sparseProvider,
      searchMode:    SEARCH_MODE,
      mmr: SEARCH_MODE === 'dense-mmr' ? { diversity: MMR_DIVERSITY, candidatesLimit: MMR_CANDIDATES_LIMIT } : null,
      topK:          TOP_K,
      metrics,
      queryResults: queryResults.map(r => ({
        id:           r.query.id,
        type:         r.query.type,
        isNegative:   r.query.shouldHaveNoStrongHit,
        chunkRecall3:  chunkRecallHit(r.results, r.query.qrels, 3,      3),
        chunkRecall5:  chunkRecallHit(r.results, r.query.qrels, 5,      3),
        chunkRecall10: chunkRecallHit(r.results, r.query.qrels, TOP_K,  3),
        windowRecall5: windowRecallHit(r.results, r.query.qrels, 5,     BENCH_WINDOW),
        windowRecall10: windowRecallHit(r.results, r.query.qrels, TOP_K, BENCH_WINDOW),
        supportRecall: chunkRecallHit(r.results, r.query.qrels, TOP_K,  2),
        ndcg:          gradedNDCG(r.results, r.query.qrels, TOP_K),
        mrr10:         mrr(r.results, r.query.qrels, 10, 3),
        latency:       r.latency,
        topChunks:     r.results.slice(0, TOP_K).map(x => ({
          chunkId:   resultChunkId(x),
          relevance: r.query.qrels.get(resultChunkId(x)) ?? 0,
          score:     x.score,
        })),
      })),
    }) + '\n');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
