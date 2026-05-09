// Retrieval benchmark for semidex.
//
// For each query in queries.json it searches the benchmark collection and checks
// whether the expected source file appears in the results. Reports Recall@1,
// Recall@K, MRR, and average latency.
//
// Usage:
//   node benchmarks/retrieval/run.js              # use provider from .env (default)
//   BENCH_PROVIDER=onnx node benchmarks/...       # force bge-m3-onnx regardless of .env
//   BENCH_SKIP_INDEX=1 node benchmarks/...        # skip re-indexing (must match stored provider)
//   BENCH_TOP_K=10 node benchmarks/...            # change search depth (default 5)
//
// Prerequisites: QDRANT_URL + QDRANT_KEY must be set in .env or the environment.

import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { chunkFile } from '../../src/indexer/phases/chunk.js';
import {
  listCollections, createCollection, deleteBySourceFile,
  upsertPoints, hybridSearch, scroll,
} from '../../src/core/qdrant.js';
import { embedForIndex, embedForSearch, SCHEMA_VERSION } from '../../src/core/embeddings.js';
import { loadConfig, saveConfig, resolveEnvProviders } from '../../src/core/config.js';
import { rerankResults } from '../../src/core/rerank.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, 'fixtures/docs');
const QUERIES_PATH = resolve(__dirname, 'queries.json');

const COLLECTION     = 'bench-retrieval';
const TOP_K          = envInt('BENCH_TOP_K', 5, 1, 1000);
const SKIP_INDEX     = process.env.BENCH_SKIP_INDEX === '1';
const BENCH_PROVIDER = process.env.BENCH_PROVIDER ?? 'env'; // 'env' | 'onnx'
const JSON_MODE      = process.env.BENCH_JSON === '1';
const RERANK_ENABLED = process.env.RERANK_ENABLED === '1';
const RERANK_PREFETCH_MULT = envInt('RERANK_PREFETCH_MULT', 4, 1, 100);

// In JSON mode all human-readable output goes to stderr so stdout stays clean JSON.
const log  = (...a) => JSON_MODE ? process.stderr.write(a.join(' ') + '\n') : console.log(...a);
const logw = (s)    => JSON_MODE ? process.stderr.write(s) : process.stdout.write(s);

function envInt(name, def, min, max) {
  const v = parseInt(process.env[name] ?? '');
  if (!Number.isFinite(v) || v < min || v > max) {
    if (process.env[name] !== undefined)
      console.warn(`[bench] ${name}="${process.env[name]}" is invalid — using default ${def}`);
    return def;
  }
  return v;
}

// Apply provider override before any config reads.
// 'onnx' forces bge-m3-onnx regardless of .env.
// 'env'  (default) uses whatever ONNX_EMBED/DENSE_PROVIDER/SPARSE_PROVIDER are already set.
if (BENCH_PROVIDER === 'onnx') {
  process.env.ONNX_EMBED = '1';
  delete process.env.DENSE_PROVIDER;
  delete process.env.SPARSE_PROVIDER;
}

// ── Indexing ──────────────────────────────────────────────────────────────────

async function ensureCollection() {
  const cols = await listCollections();
  if (!cols.includes(COLLECTION)) {
    await createCollection(COLLECTION, 1024);
  }
  // Record current provider in config.json so embedForSearch uses the same vectors.
  const { denseProvider, denseModel, sparseProvider } = resolveEnvProviders();
  const cfg = loadConfig();
  cfg.collections ??= {};
  cfg.collections[COLLECTION] = {
    denseProvider, denseModel, sparseProvider,
    embeddingSchemaVersion: SCHEMA_VERSION,
    vectorSize: 1024,
    description: 'retrieval benchmark — auto-managed',
  };
  saveConfig(cfg);
  return { denseProvider, sparseProvider };
}

// Fetch the provider stored in one point's payload from Qdrant.
async function fetchStoredProvider() {
  const points = await scroll(COLLECTION, undefined, 1, ['dense_provider', 'sparse_provider']);
  const p = points[0]?.payload;
  if (!p) return null;
  return { denseProvider: p.dense_provider ?? null, sparseProvider: p.sparse_provider ?? null };
}

async function indexFixtures() {
  const files = ['providers.md', 'qdrant.md', 'chunking.md', 'sync.md'];

  for (const name of files) {
    const filePath   = resolve(FIXTURES_DIR, name);
    const text       = readFileSync(filePath, 'utf8');
    const sourceFile = name; // filename only — stable across platforms

    await deleteBySourceFile(COLLECTION, sourceFile);

    const chunks = chunkFile(filePath, text, sourceFile);
    const points = [];
    for (const chunk of chunks) {
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
          file_hash:    'bench',
          vector_size:  1024,
          ...meta,
        },
      });
    }
    await upsertPoints(COLLECTION, points);
    logw(`  indexed ${name} (${points.length} chunks)\n`);
  }
}

// ── Search ────────────────────────────────────────────────────────────────────

async function runQuery(query) {
  const t0 = Date.now();
  const { dense, sparse } = await embedForSearch(COLLECTION, query);

  let results;
  if (RERANK_ENABLED) {
    const candidateLimit = Math.max(TOP_K * RERANK_PREFETCH_MULT, TOP_K + 5);
    const candidates = await hybridSearch(COLLECTION, dense, sparse, candidateLimit);
    results = rerankResults(candidates, query, { finalLimit: TOP_K, collection: COLLECTION });
  } else {
    results = await hybridSearch(COLLECTION, dense, sparse, TOP_K);
  }

  const latency = Date.now() - t0;
  // Deduplicate by source_file, preserve rank order.
  const seen   = new Set();
  const ranked = [];
  for (const r of results) {
    const sf = r.payload?.source_file;
    if (sf && !seen.has(sf)) { seen.add(sf); ranked.push(sf); }
  }
  return { ranked, latency };
}

// ── Metrics ───────────────────────────────────────────────────────────────────

function computeMetrics(results) {
  let recall1 = 0, recallK = 0, mrr = 0;
  const latencies = [];

  for (const { ranked, latency, expected } of results) {
    latencies.push(latency);
    if (ranked.slice(0, 1).some(f => expected.includes(f))) recall1++;
    if (ranked.slice(0, TOP_K).some(f => expected.includes(f))) recallK++;
    const rankIdx = ranked.findIndex(f => expected.includes(f));
    if (rankIdx >= 0) mrr += 1 / (rankIdx + 1);
  }

  const n = results.length;
  return {
    recall1:    recall1 / n,
    recallK:    recallK / n,
    mrr:        mrr / n,
    avgLatency: latencies.reduce((a, b) => a + b, 0) / n,
  };
}

// ── Table rendering ───────────────────────────────────────────────────────────

function pct(v) { return `${(v * 100).toFixed(0)}%`; }
function pad(s, n)  { return String(s).padEnd(n); }
function lpad(s, n) { return String(s).padStart(n); }

function printResults(queryResults, queries) {
  const hK = `@${TOP_K}`;
  const W  = { id: 4, query: 42, expected: 14, rank: 6, h1: 4, hK: hK.length + 1, ms: 6 };
  const header = [
    pad('ID',       W.id),
    pad('Query',    W.query),
    pad('Expected', W.expected),
    lpad('Rank',    W.rank),
    lpad('@1',      W.h1),
    lpad(hK,        W.hK),
    lpad('ms',      W.ms),
  ].join('  ');

  log('\n' + '─'.repeat(header.length));
  log(header);
  log('─'.repeat(header.length));

  for (const { id, ranked, latency, expected } of queryResults) {
    const q       = queries.find(x => x.id === id);
    const rankIdx = ranked.findIndex(f => expected.includes(f));
    const rankStr = rankIdx >= 0 ? `#${rankIdx + 1}` : 'miss';
    const hit1    = ranked.slice(0, 1).some(f    => expected.includes(f)) ? '✓' : '✗';
    const hitK    = ranked.slice(0, TOP_K).some(f => expected.includes(f)) ? '✓' : '✗';
    log([
      pad(id,                           W.id),
      pad(q.query.slice(0, W.query - 1), W.query),
      pad(expected[0],                  W.expected),
      lpad(rankStr,                     W.rank),
      lpad(hit1,                        W.h1),
      lpad(hitK,                        W.hK),
      lpad(latency,                     W.ms),
    ].join('  '));
  }

  log('─'.repeat(header.length));
}

function printSummary(metrics, provider) {
  log(`\nProvider   : ${provider}`);
  log(`Recall@1   : ${pct(metrics.recall1)}`);
  log(`Recall@${TOP_K}   : ${pct(metrics.recallK)}`);
  log(`MRR        : ${metrics.mrr.toFixed(3)}`);
  log(`Avg ms     : ${Math.round(metrics.avgLatency)}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const queries = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  const { denseProvider, sparseProvider } = resolveEnvProviders();

  log(`\n=== semidex retrieval benchmark ===`);
  log(`Provider  : ${BENCH_PROVIDER}  (${denseProvider}/${sparseProvider})`);
  log(`Top-K     : ${TOP_K}`);
  log(`Queries   : ${queries.length}`);

  log('\n[1/2] Setup collection...');
  await ensureCollection();

  if (SKIP_INDEX) {
    // Guard: empty collection or provider mismatch both produce meaningless results.
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
    log('[2/2] Skipping index (BENCH_SKIP_INDEX=1)');
  } else {
    log('[2/2] Indexing fixtures...');
    await indexFixtures();
  }

  log('\nRunning queries...');
  const queryResults = [];
  for (const q of queries) {
    logw(`  ${q.id}: ${q.query.slice(0, 40)}... `);
    const { ranked, latency } = await runQuery(q.query);
    const rankIdx = ranked.findIndex(f => q.expected.includes(f));
    queryResults.push({ id: q.id, ranked, latency, expected: q.expected, rank: rankIdx });
    const hit = ranked.slice(0, TOP_K).some(f => q.expected.includes(f));
    log(hit ? `✓ (${latency}ms)` : `✗ top-${TOP_K}: [${ranked.slice(0, TOP_K).join(', ')}] (${latency}ms)`);
  }

  const metrics = computeMetrics(queryResults);
  printResults(queryResults, queries);
  printSummary(metrics, BENCH_PROVIDER);
  log('');

  if (JSON_MODE) {
    process.stdout.write(JSON.stringify({
      provider: BENCH_PROVIDER,
      denseProvider,
      sparseProvider,
      topK:    TOP_K,
      metrics,
      queryResults: queryResults.map(r => ({
        id:       r.id,
        expected: r.expected,
        rank:     r.rank,
        latency:  r.latency,
      })),
    }) + '\n');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
