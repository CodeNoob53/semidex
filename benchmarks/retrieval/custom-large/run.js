// Large-document chunking and retrieval benchmark.
//
// Fixture docs contain [[BENCH_ANCHOR: NAME]] markers. After indexing,
// this script scans chunk text to build an anchor→chunkId map, then uses
// that map to resolve qrels at runtime from queries.json's expectedAnchors.
// No chunk indices are hardcoded in queries.json.
//
// Collection: bench-retrieval-custom-large
//
// Usage:
//   node benchmarks/retrieval/custom-large/run.js
//   npm run bench:custom-large
//   BENCH_SKIP_INDEX=1 npm run bench:custom-large
//   BENCH_TOP_K=10 npm run bench:custom-large
//   BENCH_WINDOW=1 npm run bench:custom-large

if (process.argv.includes('--help')) {
  process.stdout.write(`semidex custom-large benchmark

Usage:
  node benchmarks/retrieval/custom-large/run.js [options]
  npm run bench:custom-large

Options (env vars):
  BENCH_SKIP_INDEX=1     Skip re-indexing; reuse existing collection
  BENCH_TOP_K=<n>        Search depth (default: 10)
  BENCH_WINDOW=<n>       Adjacency window for windowRecall (default: 1)
  ONNX_EMBED=1           Force bge-m3-onnx provider (recommended)

Provider note:
  Always uses the provider from the current environment.
  For consistent results, set ONNX_EMBED=1 before running.
  BENCH_SKIP_INDEX=1 fails if the stored provider differs from the current one.

Query schema (queries.json):
  { schemaVersion: 4, queries: [{
      id, type, query, expectedAnchors, expectedTokens,
      shouldHaveNoStrongHit, note
  }] }

  expectedAnchors: [{ anchor: "ANCHOR_NAME", relevance: 1|2|3 }]
  relevance 3 = exact answer, 2 = supporting, 1 = same-topic

  Anchors are resolved to chunkIds at runtime by scanning indexed chunk text.
  Fail-fast if any anchor is missing from the indexed chunks.

Metrics (retrieval):
  chunkRecall@3/5/10     Exact answer chunk (rel>=3) in top-3/5/10
  windowRecall@5/10      Exact chunk or +-window neighbor in top-5/10
  supportRecall@K        Supporting or exact chunk (rel>=2) in top-K
  nDCG@5/10 (graded)    Gain = 2^relevance - 1, normalised
  MRR@10                 Reciprocal rank of first rel>=3 chunk
  fileRecall@1/K         File-level recall (secondary)
  negativePassRate       Negative queries with no strong hit

Chunking guardrails (reported, do not fail the run):
  zeroChunkFiles         Files that produced 0 chunks
  anchorCoverage         Fraction of expected anchors found in chunks
  missingAnchors         Anchor names not found in any chunk
  duplicateAnchors       Anchors found in more than one chunk
  oversizedChunkCount    Chunks exceeding MAX_CHUNK_TOKENS threshold
  maxChunkTokensObserved Largest chunk size seen (approx word*1.3)
  sectionlessChunkRate   Fraction of chunks with no section heading
  anchorsPerChunk        Distribution of anchor count per chunk (p50/p95)
`);
  process.exit(0);
}

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { chunkFile } from '../../../src/indexer/phases/chunk.js';
import {
  listCollections, createCollection, deleteBySourceFile,
  upsertPoints, hybridSearch, scroll,
} from '../../../src/core/qdrant.js';
import { embedForIndex, embedForSearch, SCHEMA_VERSION } from '../../../src/core/embeddings.js';
import { loadConfig, saveConfig, resolveEnvProviders } from '../../../src/core/config.js';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, 'fixtures/docs');
const QUERIES_PATH = resolve(__dirname, 'queries.json');
const RESULTS_DIR  = resolve(__dirname, '../results');

const COLLECTION  = 'bench-retrieval-custom-large';
const TOP_K       = envInt('BENCH_TOP_K', 10, 1, 1000);
const SKIP_INDEX  = process.env.BENCH_SKIP_INDEX === '1';
const BENCH_WINDOW = envInt('BENCH_WINDOW', 1, 0, 10);
const BENCH_CONTEXT_WINDOW = envInt('BENCH_CONTEXT_WINDOW', 0, 0, 10);

// Approximate token count threshold for oversized-chunk guardrail.
// Default matches production MAX_CHUNK_TOKENS (chunk.js line 22) so the
// guardrail catches chunks that exceeded the splitter's own target.
const MAX_CHUNK_TOKENS_THRESHOLD = envInt('BENCH_OVERSIZED_CHUNK_TOKENS', 400, 1, 100000);

const FIXTURE_FILES = [
  'api-reference-large.md',
  'configuration-manual.md',
  'migration-guide-v1-v2.md',
  'mixed-language-agent-guide.md',
  'troubleshooting-runbook.md',
];

// Pattern that matches [[BENCH_ANCHOR: NAME]] in chunk text.
// Double-bracket syntax avoids HTML comment splitting by sentence tokenizers.
const ANCHOR_RE = /\[\[BENCH_ANCHOR:\s*(\w+)\]\]/g;

function envInt(name, def, min, max) {
  const v = parseInt(process.env[name] ?? '');
  if (!Number.isFinite(v) || v < min || v > max) {
    if (process.env[name] !== undefined)
      console.warn(`[bench-large] ${name}="${process.env[name]}" is invalid — using default ${def}`);
    return def;
  }
  return v;
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
    description: 'custom-large stress benchmark — auto-managed',
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

// Approximate token count: words * 1.3. Fast, no tokenizer needed.
function approxTokens(text) {
  return Math.round((text.match(/\S+/g) ?? []).length * 1.3);
}

// Index all fixture files. Returns { chunkData, guardrails }.
// chunkData: array of { sourceFile, chunkIndex, text, section, approxToks }
// guardrails: { zeroChunkFiles, oversizedChunkCount, maxChunkTokensObserved, sectionlessCount }
async function indexFixtures() {
  const chunkData = [];
  const guardrails = {
    zeroChunkFiles: [],
    oversizedChunkCount: 0,
    maxChunkTokensObserved: 0,
    sectionlessCount: 0,
  };

  for (const name of FIXTURE_FILES) {
    const filePath   = resolve(FIXTURES_DIR, name);
    const text       = readFileSync(filePath, 'utf8');
    const sourceFile = name;

    await deleteBySourceFile(COLLECTION, sourceFile);

    const chunks = chunkFile(filePath, text, sourceFile);

    if (chunks.length === 0) {
      guardrails.zeroChunkFiles.push(name);
      process.stdout.write(`  indexed ${name} (0 chunks — WARNING: zero chunks)\n`);
      continue;
    }

    const points = [];
    for (const chunk of chunks) {
      const toks = approxTokens(chunk.text ?? '');
      if (toks > MAX_CHUNK_TOKENS_THRESHOLD) guardrails.oversizedChunkCount++;
      if (toks > guardrails.maxChunkTokensObserved) guardrails.maxChunkTokensObserved = toks;
      if (!chunk.section || chunk.section.trim() === '') guardrails.sectionlessCount++;

      chunkData.push({
        sourceFile,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text ?? '',
        section: chunk.section ?? '',
        approxToks: toks,
      });

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
          file_hash:    'bench-large',
          vector_size:  1024,
          ...meta,
        },
      });
    }
    await upsertPoints(COLLECTION, points);
    process.stdout.write(`  indexed ${name} (${points.length} chunks)\n`);
  }

  return { chunkData, guardrails };
}

// Collect chunk data from Qdrant when BENCH_SKIP_INDEX=1.
async function fetchChunkData() {
  const points = await scroll(COLLECTION, undefined, 5000,
    ['source_file', 'chunk_index', 'text', 'section']);
  const chunkData = [];
  for (const p of points) {
    const sf = p.payload?.source_file;
    const ci = p.payload?.chunk_index;
    const tx = p.payload?.text ?? '';
    const sc = p.payload?.section ?? '';
    if (sf != null && ci != null) {
      chunkData.push({
        sourceFile: sf,
        chunkIndex: ci,
        text: tx,
        section: sc,
        approxToks: approxTokens(tx),
      });
    }
  }
  return chunkData;
}

// ── Anchor mapping ────────────────────────────────────────────────────────────

// Scan all chunk texts for BENCH_ANCHOR comments.
// Returns { anchorMap, anchorsPerChunk, duplicateAnchors }.
// anchorMap: Map<anchorName, "sourceFile#chunkIndex">
// anchorsPerChunk: array of per-chunk anchor counts (for p50/p95 distribution)
// duplicateAnchors: Map<anchorName, string[]> — anchor names found in >1 chunk
function buildAnchorMap(chunkData) {
  const anchorMap   = new Map();
  const duplicates  = new Map();
  const anchorsPerChunk = chunkData.map(() => 0);

  for (let i = 0; i < chunkData.length; i++) {
    const { sourceFile, chunkIndex, text } = chunkData[i];
    const chunkId = `${sourceFile}#${chunkIndex}`;
    const matches = [...text.matchAll(ANCHOR_RE)];
    anchorsPerChunk[i] = matches.length;

    for (const m of matches) {
      const name = m[1];
      if (anchorMap.has(name)) {
        if (!duplicates.has(name)) duplicates.set(name, [anchorMap.get(name)]);
        duplicates.get(name).push(chunkId);
      } else {
        anchorMap.set(name, chunkId);
      }
    }
  }

  return { anchorMap, anchorsPerChunk, duplicateAnchors: duplicates };
}

// Resolve expectedAnchors to relevantChunks using the anchor map.
// Fail-fast if any anchor is missing from the map.
function resolveAnchors(queries, anchorMap) {
  const errors = [];
  const resolved = [];

  for (const q of queries) {
    if (q.shouldHaveNoStrongHit) {
      resolved.push({ ...q, relevantChunks: [] });
      continue;
    }
    const relevantChunks = [];
    for (const ea of (q.expectedAnchors ?? [])) {
      const chunkId = anchorMap.get(ea.anchor);
      if (!chunkId) {
        errors.push(`  [${q.id}] anchor "${ea.anchor}" not found in any indexed chunk`);
      } else {
        relevantChunks.push({ chunkId, relevance: ea.relevance ?? 3 });
      }
    }
    resolved.push({ ...q, relevantChunks });
  }

  if (errors.length) {
    process.stderr.write(
      `\nError: ${errors.length} anchor(s) not found in indexed chunks:\n` +
      errors.join('\n') + '\n\n' +
      `Available anchors (${anchorMap.size}):\n` +
      [...anchorMap.keys()].sort().map(k => `  ${k} -> ${anchorMap.get(k)}`).join('\n') + '\n'
    );
    process.exit(1);
  }

  return resolved;
}

// ── Chunking guardrail report ─────────────────────────────────────────────────

function computeChunkingGuardrails(chunkData, anchorMap, duplicateAnchors, allAnchors, anchorsPerChunk, guardrails) {
  const totalChunks = chunkData.length;

  // Anchors expected across all queries.
  const missingAnchors = allAnchors.filter(a => !anchorMap.has(a));
  const anchorCoverage = allAnchors.length > 0
    ? (allAnchors.length - missingAnchors.length) / allAnchors.length
    : 1;

  const sectionlessRate = totalChunks > 0
    ? guardrails.sectionlessCount / totalChunks
    : 0;

  // anchorsPerChunk p50/p95.
  const sorted = [...anchorsPerChunk].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;

  return {
    totalChunks,
    zeroChunkFiles:          guardrails.zeroChunkFiles,
    anchorCoverage,
    missingAnchors,
    duplicateAnchors:        [...duplicateAnchors.entries()].map(([a, ids]) => ({ anchor: a, chunkIds: ids })),
    oversizedChunkCount:     guardrails.oversizedChunkCount,
    maxChunkTokensObserved:  guardrails.maxChunkTokensObserved,
    maxChunkTokensThreshold: MAX_CHUNK_TOKENS_THRESHOLD,
    sectionlessRate,
    anchorsPerChunkP50:      p50,
    anchorsPerChunkP95:      p95,
  };
}

// ── Query normalization ───────────────────────────────────────────────────────

function tokenise(str) {
  return (str ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function buildQrels(relevantChunks) {
  const map = new Map();
  for (const rc of (relevantChunks ?? [])) {
    map.set(rc.chunkId, Math.max(map.get(rc.chunkId) ?? 0, rc.relevance ?? 3));
  }
  return map;
}

function normaliseQuery(q) {
  return {
    id:                    q.id,
    type:                  q.type ?? 'exact-token',
    query:                 q.query,
    expectedAnchors:       q.expectedAnchors ?? [],
    relevantChunks:        q.relevantChunks  ?? [],
    qrels:                 buildQrels(q.relevantChunks ?? []),
    expectedTokens:        q.expectedTokens
      ? q.expectedTokens.flatMap(t => tokenise(t)).filter(Boolean)
      : null,
    shouldHaveNoStrongHit: q.shouldHaveNoStrongHit ?? false,
    note:                  q.note ?? '',
  };
}

// ── Search ────────────────────────────────────────────────────────────────────

async function runQuery(queryText) {
  const t0 = Date.now();
  const { dense, sparse } = await embedForSearch(COLLECTION, queryText);
  const results = await hybridSearch(COLLECTION, dense, sparse, TOP_K);
  return { results, latency: Date.now() - t0 };
}

// ── Metric helpers ────────────────────────────────────────────────────────────

function resultChunkId(r) {
  const sf = r.payload?.source_file;
  const ci = r.payload?.chunk_index;
  if (!sf || ci == null) return null;
  return `${sf}#${ci}`;
}

function parseChunkId(chunkId) {
  if (!chunkId) return null;
  const hash = chunkId.lastIndexOf('#');
  if (hash < 0) return null;
  const sourceFile  = chunkId.slice(0, hash);
  const chunkIndex  = parseInt(chunkId.slice(hash + 1), 10);
  if (!sourceFile || !Number.isFinite(chunkIndex)) return null;
  return { sourceFile, chunkIndex };
}

function chunkRecallHit(results, qrels, k, minRel = 3) {
  if (!qrels.size) return null;
  const relevant = new Set([...qrels.entries()].filter(([, r]) => r >= minRel).map(([id]) => id));
  if (!relevant.size) return null;
  return results.slice(0, k).some(r => relevant.has(resultChunkId(r)));
}

function windowRecallHit(results, qrels, k, window) {
  if (!qrels.size) return null;
  const exactIds = [...qrels.entries()].filter(([, r]) => r >= 3).map(([id]) => id);
  if (!exactIds.length) return null;
  const topK = results.slice(0, k);
  if (topK.some(r => exactIds.includes(resultChunkId(r)))) return true;
  for (const exactId of exactIds) {
    const ep = parseChunkId(exactId);
    if (!ep) continue;
    if (topK.some(r => {
      const rp = parseChunkId(resultChunkId(r));
      return rp && rp.sourceFile === ep.sourceFile &&
             Math.abs(rp.chunkIndex - ep.chunkIndex) <= window;
    })) return true;
  }
  return false;
}

function idealDCG(qrels, k) {
  const gains = [...qrels.values()].map(r => Math.pow(2, r) - 1).sort((a, b) => b - a);
  let idcg = 0;
  for (let i = 0; i < Math.min(gains.length, k); i++) idcg += gains[i] / Math.log2(i + 2);
  return idcg;
}

function gradedNDCG(results, qrels, k) {
  if (!qrels.size) return null;
  let dcg = 0;
  for (let i = 0; i < Math.min(results.length, k); i++) {
    const rel = qrels.get(resultChunkId(results[i])) ?? 0;
    dcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }
  const idcg = idealDCG(qrels, k);
  return idcg === 0 ? 0 : dcg / idcg;
}

function mrr(results, qrels, k, minRel = 3) {
  if (!qrels.size) return null;
  const relevant = new Set([...qrels.entries()].filter(([, r]) => r >= minRel).map(([id]) => id));
  if (!relevant.size) return null;
  for (let i = 0; i < Math.min(results.length, k); i++) {
    if (relevant.has(resultChunkId(results[i]))) return 1 / (i + 1);
  }
  return 0;
}

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
  return sorted[Math.max(0, Math.ceil(sorted.length * p / 100) - 1)];
}

// ── Aggregate metrics ─────────────────────────────────────────────────────────

function computeMetrics(queryResults) {
  const positives = queryResults.filter(r => !r.query.shouldHaveNoStrongHit);
  const negatives = queryResults.filter(r =>  r.query.shouldHaveNoStrongHit);

  let cr3 = 0, cr5 = 0, cr10 = 0, wr5 = 0, wr10 = 0;
  let ctx5 = 0, ctx10 = 0;
  let supp = 0, ndcg5Sum = 0, ndcg10Sum = 0, mrrSum = 0, mrrCount = 0;
  let fRecall1 = 0, fRecallK = 0;
  let negPass = 0;
  const latencies = queryResults.map(r => r.latency).sort((a, b) => a - b);

  const hasExact    = positives.filter(r => [...r.query.qrels.values()].some(v => v >= 3)).length;
  const hasAnyQrels = positives.filter(r => r.query.qrels.size > 0).length;
  const hasExpectedFiles = positives.filter(r => (r.query.expectedFiles ?? []).length > 0).length;

  for (const r of positives) {
    const { results, query } = r;

    const cr3Hit  = chunkRecallHit(results, query.qrels, 3, 3);
    const cr5Hit  = chunkRecallHit(results, query.qrels, 5, 3);
    const cr10Hit = chunkRecallHit(results, query.qrels, TOP_K, 3);
    const wr5Hit  = windowRecallHit(results, query.qrels, 5, BENCH_WINDOW);
    const wr10Hit = windowRecallHit(results, query.qrels, TOP_K, BENCH_WINDOW);
    const ctx5Hit  = BENCH_CONTEXT_WINDOW > 0 ? windowRecallHit(results, query.qrels, 5, BENCH_CONTEXT_WINDOW) : null;
    const ctx10Hit = BENCH_CONTEXT_WINDOW > 0 ? windowRecallHit(results, query.qrels, TOP_K, BENCH_CONTEXT_WINDOW) : null;
    const suppHit = chunkRecallHit(results, query.qrels, TOP_K, 2);
    const n5      = gradedNDCG(results, query.qrels, 5);
    const n10     = gradedNDCG(results, query.qrels, TOP_K);
    const mrrVal  = mrr(results, query.qrels, 10, 3);

    if (cr3Hit  !== null) cr3  += cr3Hit  ? 1 : 0;
    if (cr5Hit  !== null) cr5  += cr5Hit  ? 1 : 0;
    if (cr10Hit !== null) cr10 += cr10Hit ? 1 : 0;
    if (wr5Hit  !== null) wr5  += wr5Hit  ? 1 : 0;
    if (wr10Hit !== null) wr10 += wr10Hit ? 1 : 0;
    if (ctx5Hit !== null) ctx5 += ctx5Hit ? 1 : 0;
    if (ctx10Hit !== null) ctx10 += ctx10Hit ? 1 : 0;
    if (suppHit !== null) supp += suppHit ? 1 : 0;
    if (n5      !== null) ndcg5Sum  += n5;
    if (n10     !== null) ndcg10Sum += n10;
    if (mrrVal  !== null) { mrrSum += mrrVal; mrrCount++; }

    const ef = query.expectedFiles ?? [];
    if (ef.length) {
      const rf = rankedFileList(results);
      if (rf.slice(0, 1).some(f => ef.includes(f)))    fRecall1++;
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

  return {
    chunkRecall3:     hasExact > 0     ? cr3  / hasExact : null,
    chunkRecall5:     hasExact > 0     ? cr5  / hasExact : null,
    chunkRecall10:    hasExact > 0     ? cr10 / hasExact : null,
    windowRecall5:    hasExact > 0     ? wr5  / hasExact : null,
    windowRecall10:   hasExact > 0     ? wr10 / hasExact : null,
    contextRecall5:   BENCH_CONTEXT_WINDOW > 0 && hasExact > 0 ? ctx5 / hasExact : null,
    contextRecall10:  BENCH_CONTEXT_WINDOW > 0 && hasExact > 0 ? ctx10 / hasExact : null,
    supportRecallK:   hasAnyQrels > 0  ? supp / hasAnyQrels : null,
    ndcg5:            hasAnyQrels > 0  ? ndcg5Sum  / hasAnyQrels : null,
    ndcg10:           hasAnyQrels > 0  ? ndcg10Sum / hasAnyQrels : null,
    mrr10:            mrrCount > 0     ? mrrSum / mrrCount : null,
    fileRecall1:      hasExpectedFiles > 0 ? fRecall1 / hasExpectedFiles : null,
    fileRecallK:      hasExpectedFiles > 0 ? fRecallK / hasExpectedFiles : null,
    negativePassRate: negatives.length > 0 ? negPass / negatives.length : null,
    avgLatency:  latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1),
    p50Latency:  percentile(latencies, 50),
    p95Latency:  percentile(latencies, 95),
    nPositive:   positives.length,
    nNegative:   negatives.length,
    topK:        TOP_K,
    window:      BENCH_WINDOW,
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function pct(v, d = 1) { return v === null ? 'n/a' : `${(v * 100).toFixed(d)}%`; }
function pad(s, n)  { return String(s).padEnd(n); }
function lpad(s, n) { return String(s).padStart(n); }

function printQueryResults(queryResults) {
  const W = { id: 6, query: 48, cr3: 4, cr5: 4, sup: 4, ndcg: 7, mrr: 6, ms: 6 };
  const header = [
    pad('ID',    W.id),
    pad('Query', W.query),
    lpad('cr3',  W.cr3),
    lpad('cr5',  W.cr5),
    lpad('sup',  W.sup),
    lpad('nDCG', W.ndcg),
    lpad('MRR',  W.mrr),
    lpad('ms',   W.ms),
  ].join('  ');

  console.log('\n' + '-'.repeat(header.length));
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const r of queryResults) {
    const { query, results } = r;
    if (query.shouldHaveNoStrongHit) {
      const top1W = new Set([
        ...tokenise(results[0]?.payload?.text    ?? ''),
        ...tokenise(results[0]?.payload?.section ?? ''),
      ]);
      const hit = (query.expectedTokens ?? []).some(t => top1W.has(t));
      console.log([
        pad(query.id, W.id),
        pad(query.query.slice(0, W.query - 1), W.query),
        lpad('neg', W.cr3), lpad('neg', W.cr5), lpad('neg', W.sup),
        lpad(hit ? 'FAIL' : 'PASS', W.ndcg),
        lpad('-', W.mrr), lpad(r.latency, W.ms),
      ].join('  '));
      continue;
    }
    const cr3 = chunkRecallHit(results, query.qrels, 3, 3);
    const cr5 = chunkRecallHit(results, query.qrels, 5, 3);
    const sup = chunkRecallHit(results, query.qrels, TOP_K, 2);
    const ndg = gradedNDCG(results, query.qrels, 5);
    const mrv = mrr(results, query.qrels, 10, 3);
    console.log([
      pad(query.id, W.id),
      pad(query.query.slice(0, W.query - 1), W.query),
      lpad(cr3 === null ? '-' : (cr3 ? 'Y' : 'N'), W.cr3),
      lpad(cr5 === null ? '-' : (cr5 ? 'Y' : 'N'), W.cr5),
      lpad(sup === null ? '-' : (sup ? 'Y' : 'N'), W.sup),
      lpad(ndg !== null ? ndg.toFixed(3) : 'n/a', W.ndcg),
      lpad(mrv !== null ? mrv.toFixed(3) : 'n/a', W.mrr),
      lpad(r.latency, W.ms),
    ].join('  '));
  }
  console.log('-'.repeat(header.length));
}

function printSummary(metrics, chunkingGuardrails, provider) {
  const g = chunkingGuardrails;
  console.log(`\nProvider          : ${provider}`);
  console.log(`Queries           : ${metrics.nPositive} positive, ${metrics.nNegative} negative`);
  console.log(`chunkRecall@3     : ${pct(metrics.chunkRecall3)}`);
  console.log(`chunkRecall@5     : ${pct(metrics.chunkRecall5)}`);
  console.log(`chunkRecall@${TOP_K}    : ${pct(metrics.chunkRecall10)}`);
  console.log(`windowRecall@5    : ${pct(metrics.windowRecall5)}  (+-${BENCH_WINDOW} window)`);
  console.log(`windowRecall@${TOP_K}   : ${pct(metrics.windowRecall10)}  (+-${BENCH_WINDOW} window)`);
  if (BENCH_CONTEXT_WINDOW > 0) {
    console.log(`contextRecall@5   : ${pct(metrics.contextRecall5)}  (+-${BENCH_CONTEXT_WINDOW} context)`);
    console.log(`contextRecall@${TOP_K}  : ${pct(metrics.contextRecall10)}  (+-${BENCH_CONTEXT_WINDOW} context)`);
  }
  console.log(`supportRecall@${TOP_K}  : ${pct(metrics.supportRecallK)}`);
  console.log(`nDCG@5 (graded)   : ${metrics.ndcg5?.toFixed(3)   ?? 'n/a'}`);
  console.log(`nDCG@${TOP_K} (graded)  : ${metrics.ndcg10?.toFixed(3)  ?? 'n/a'}`);
  console.log(`MRR@10            : ${metrics.mrr10?.toFixed(3)   ?? 'n/a'}`);
  if (metrics.fileRecall1 !== null)
    console.log(`fileRecall@1      : ${pct(metrics.fileRecall1)}`);
  if (metrics.fileRecallK !== null)
    console.log(`fileRecall@${TOP_K}     : ${pct(metrics.fileRecallK)}`);
  if (metrics.negativePassRate !== null)
    console.log(`negativePass      : ${pct(metrics.negativePassRate)}`);
  console.log(`Latency p50/p95   : ${metrics.p50Latency}ms / ${metrics.p95Latency}ms`);
  console.log(`Avg ms            : ${Math.round(metrics.avgLatency)}`);

  console.log('\n--- Chunking Guardrails ---');
  console.log(`totalChunks       : ${g.totalChunks}`);
  console.log(`zeroChunkFiles    : ${g.zeroChunkFiles.length === 0 ? 'none' : g.zeroChunkFiles.join(', ')}`);
  console.log(`anchorCoverage    : ${pct(g.anchorCoverage)}`);
  if (g.missingAnchors.length > 0)
    console.log(`missingAnchors    : ${g.missingAnchors.join(', ')}`);
  if (g.duplicateAnchors.length > 0)
    console.log(`duplicateAnchors  : ${g.duplicateAnchors.map(d => d.anchor).join(', ')}`);
  console.log(`oversizedChunks   : ${g.oversizedChunkCount} (>${g.maxChunkTokensThreshold} approx tokens)`);
  console.log(`maxChunkTokens    : ${g.maxChunkTokensObserved} approx`);
  console.log(`sectionlessRate   : ${pct(g.sectionlessRate)}`);
  console.log(`anchorsPerChunk   : p50=${g.anchorsPerChunkP50}  p95=${g.anchorsPerChunkP95}`);
}

// ── Save result ───────────────────────────────────────────────────────────────

function saveResult(metrics, chunkingGuardrails, provider, anchorMap) {
  const date = new Date().toISOString().slice(0, 10);
  const outPath = resolve(RESULTS_DIR, `${date}-custom-large.txt`);

  const lines = [
    `=== semidex custom-large benchmark — ${date} ===`,
    `Provider: ${provider}`,
    `Top-K: ${TOP_K}  Window: +-${BENCH_WINDOW}`,
    '',
    '--- Retrieval Metrics ---',
    `chunkRecall@3     : ${pct(metrics.chunkRecall3)}`,
    `chunkRecall@5     : ${pct(metrics.chunkRecall5)}`,
    `chunkRecall@${TOP_K}    : ${pct(metrics.chunkRecall10)}`,
    `windowRecall@5    : ${pct(metrics.windowRecall5)}`,
    `windowRecall@${TOP_K}   : ${pct(metrics.windowRecall10)}`,
    ...(BENCH_CONTEXT_WINDOW > 0 ? [
      `contextRecall@5   : ${pct(metrics.contextRecall5)}`,
      `contextRecall@${TOP_K}  : ${pct(metrics.contextRecall10)}`,
    ] : []),
    `supportRecall@${TOP_K}  : ${pct(metrics.supportRecallK)}`,
    `nDCG@5            : ${metrics.ndcg5?.toFixed(3)  ?? 'n/a'}`,
    `nDCG@${TOP_K}           : ${metrics.ndcg10?.toFixed(3) ?? 'n/a'}`,
    `MRR@10            : ${metrics.mrr10?.toFixed(3)  ?? 'n/a'}`,
    `negativePass      : ${pct(metrics.negativePassRate)}`,
    `Latency p50/p95   : ${metrics.p50Latency}ms / ${metrics.p95Latency}ms`,
    '',
    '--- Chunking Guardrails ---',
    `totalChunks       : ${chunkingGuardrails.totalChunks}`,
    `zeroChunkFiles    : ${chunkingGuardrails.zeroChunkFiles.join(', ') || 'none'}`,
    `anchorCoverage    : ${pct(chunkingGuardrails.anchorCoverage)}`,
    `missingAnchors    : ${chunkingGuardrails.missingAnchors.join(', ') || 'none'}`,
    `duplicateAnchors  : ${chunkingGuardrails.duplicateAnchors.map(d => d.anchor).join(', ') || 'none'}`,
    `oversizedChunks   : ${chunkingGuardrails.oversizedChunkCount} (>${chunkingGuardrails.maxChunkTokensThreshold} approx tokens)`,
    `maxChunkTokens    : ${chunkingGuardrails.maxChunkTokensObserved} approx`,
    `sectionlessRate   : ${pct(chunkingGuardrails.sectionlessRate)}`,
    `anchorsPerChunk   : p50=${chunkingGuardrails.anchorsPerChunkP50}  p95=${chunkingGuardrails.anchorsPerChunkP95}`,
    '',
    '--- Anchor Map ---',
    ...[...anchorMap.entries()].sort().map(([a, c]) => `  ${a.padEnd(35)} -> ${c}`),
  ];

  writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  console.log(`\nResult saved to ${outPath}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const raw = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  if (raw.schemaVersion !== 4) {
    process.stderr.write(`Error: queries.json schemaVersion must be 4 (got ${raw.schemaVersion})\n`);
    process.exit(1);
  }

  const { denseProvider, sparseProvider } = resolveEnvProviders();
  const providerLabel = `${denseProvider}/${sparseProvider}`;

  console.log(`\n=== semidex custom-large benchmark ===`);
  console.log(`Provider  : ${providerLabel}`);
  console.log(`Top-K     : ${TOP_K}  Window: +-${BENCH_WINDOW}`);
  console.log(`Queries   : ${raw.queries.length}`);

  console.log('\n[1/4] Setup collection...');
  await ensureCollection();

  let chunkData;
  const guardrailsBase = {
    zeroChunkFiles: [],
    oversizedChunkCount: 0,
    maxChunkTokensObserved: 0,
    sectionlessCount: 0,
  };

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
        `Re-run without BENCH_SKIP_INDEX=1 to reindex with the new provider.\n`
      );
      process.exit(1);
    }
    console.log('[2/4] Skipping index (BENCH_SKIP_INDEX=1) — fetching chunk data...');
    chunkData = await fetchChunkData();
    // Recompute guardrails from fetched data.
    for (const c of chunkData) {
      if (c.approxToks > MAX_CHUNK_TOKENS_THRESHOLD) guardrailsBase.oversizedChunkCount++;
      if (c.approxToks > guardrailsBase.maxChunkTokensObserved)
        guardrailsBase.maxChunkTokensObserved = c.approxToks;
      if (!c.section || c.section.trim() === '') guardrailsBase.sectionlessCount++;
    }
  } else {
    console.log(`[2/4] Indexing ${FIXTURE_FILES.length} fixture docs...`);
    const result = await indexFixtures();
    chunkData = result.chunkData;
    Object.assign(guardrailsBase, result.guardrails);
  }

  console.log('[3/4] Building anchor map...');
  const { anchorMap, anchorsPerChunk, duplicateAnchors } = buildAnchorMap(chunkData);
  console.log(`  Found ${anchorMap.size} distinct anchors across ${chunkData.length} chunks`);
  if (duplicateAnchors.size > 0) {
    const details = [...duplicateAnchors.entries()]
      .map(([a, ids]) => `  ${a}: ${ids.join(', ')}`).join('\n');
    process.stderr.write(
      `\nError: ${duplicateAnchors.size} duplicate anchor(s) found in indexed chunks.\n` +
      `Each BENCH_ANCHOR name must appear in exactly one chunk.\n` +
      details + '\n'
    );
    process.exit(1);
  }

  // Collect all anchor names referenced in queries.
  const allQueriedAnchors = [...new Set(
    raw.queries.flatMap(q => (q.expectedAnchors ?? []).map(ea => ea.anchor))
  )];

  // Resolve anchors → chunkIds and fail-fast on missing.
  const resolvedQueries = resolveAnchors(raw.queries, anchorMap).map(normaliseQuery);

  // Compute chunking guardrails using all queried anchors.
  const chunkingGuardrails = computeChunkingGuardrails(
    chunkData, anchorMap, duplicateAnchors, allQueriedAnchors,
    anchorsPerChunk, guardrailsBase
  );

  console.log(`\n[4/4] Running ${resolvedQueries.length} queries...`);
  const queryResults = [];
  for (const q of resolvedQueries) {
    process.stdout.write(`  ${q.id}: ${q.query.slice(0, 44)}... `);
    const { results, latency } = await runQuery(q.query);
    queryResults.push({ query: q, results, latency });
    if (q.shouldHaveNoStrongHit) {
      console.log(`(neg) (${latency}ms)`);
    } else {
      const hit = chunkRecallHit(results, q.qrels, 5, 3);
      console.log(hit ? `Y (${latency}ms)` : `N (${latency}ms)`);
    }
  }

  const metrics = computeMetrics(queryResults);
  printQueryResults(queryResults);
  printSummary(metrics, chunkingGuardrails, providerLabel);
  saveResult(metrics, chunkingGuardrails, providerLabel, anchorMap);
}

main().catch(err => { console.error(err); process.exit(1); });
