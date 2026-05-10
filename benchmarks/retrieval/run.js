// Retrieval benchmark for semidex.
//
// Supports v1 queries (expected: [...]) and v2 queries (expectedFiles,
// expectedSections, expectedAllTokens, expectedAnyTokens, type).
// v1 fields are accepted as-is; missing v2 fields produce n/a for those metrics.
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

const COLLECTION           = 'bench-retrieval';
const TOP_K                = envInt('BENCH_TOP_K', 5, 1, 1000);
const SKIP_INDEX           = process.env.BENCH_SKIP_INDEX === '1';
const BENCH_PROVIDER       = process.env.BENCH_PROVIDER ?? 'env'; // 'env' | 'onnx'
const JSON_MODE            = process.env.BENCH_JSON === '1';
const RERANK_ENABLED       = process.env.RERANK_ENABLED === '1';
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
if (BENCH_PROVIDER === 'onnx') {
  process.env.ONNX_EMBED = '1';
  delete process.env.DENSE_PROVIDER;
  delete process.env.SPARSE_PROVIDER;
}

// ── v2 query schema helpers ───────────────────────────────────────────────────

// Normalise a raw query entry to a consistent internal shape.
// v1: { id, query, expected, note }
// v2: { id, type, query, expectedFiles, expectedSections,
//       expectedAllTokens, expectedAnyTokens, shouldHaveNoStrongHit, note }
// Flatten token list: each entry is split by the same regex as tokenise() so that
// multi-part values like "config.json" → ["config","json"] match correctly.
function flattenTokenList(arr) {
  if (!arr?.length) return null;
  return arr.flatMap(t => tokenise(t)).filter(Boolean);
}

function normaliseQuery(q) {
  return {
    id:                   q.id,
    type:                 q.type ?? 'file-level',
    query:                q.query,
    expectedFiles:        q.expectedFiles ?? q.expected ?? [],
    expectedSections:     q.expectedSections ?? null,
    // Normalise token lists through tokenise() so "config.json" → ["config","json"]
    expectedAllTokens:    flattenTokenList(q.expectedAllTokens),
    expectedAnyTokens:    flattenTokenList(q.expectedAnyTokens),
    shouldHaveNoStrongHit: q.shouldHaveNoStrongHit ?? false,
    note:                 q.note ?? '',
    expected:             q.expected ?? q.expectedFiles ?? [],
  };
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
    description: 'retrieval benchmark — auto-managed',
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

async function indexFixtures() {
  const files = ['providers.md', 'qdrant.md', 'chunking.md', 'sync.md'];

  for (const name of files) {
    const filePath   = resolve(FIXTURES_DIR, name);
    const text       = readFileSync(filePath, 'utf8');
    const sourceFile = name;

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

// Returns full Qdrant result objects (with payload) plus latency.
async function runQuery(queryText) {
  const t0 = Date.now();
  const { dense, sparse } = await embedForSearch(COLLECTION, queryText);

  let results;
  if (RERANK_ENABLED) {
    const candidateLimit = Math.max(TOP_K * RERANK_PREFETCH_MULT, TOP_K + 5);
    const candidates = await hybridSearch(COLLECTION, dense, sparse, candidateLimit);
    results = rerankResults(candidates, queryText, { finalLimit: TOP_K, collection: COLLECTION });
  } else {
    results = await hybridSearch(COLLECTION, dense, sparse, TOP_K);
  }

  const latency = Date.now() - t0;
  return { results, latency };
}

// ── v2 hit evaluation ─────────────────────────────────────────────────────────

function tokenise(str) {
  return (str ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

// Filter results to those whose source_file is in expectedFiles.
// Used to scope sectionHit/tokenHit to the correct-file chunks only.
function filterToExpected(results, expectedFiles) {
  if (!expectedFiles?.length) return results;
  return results.filter(r => expectedFiles.includes(r.payload?.source_file));
}

// Does the result list contain a chunk whose section matches any expectedSection?
// Pass results pre-filtered to expectedFiles for the primary (scoped) metric.
function sectionHit(results, expectedSections) {
  if (!expectedSections?.length) return null; // n/a
  return results.some(r => expectedSections.includes(r.payload?.section));
}

// Does any chunk in results contain ALL allTokens and at least ONE of anyTokens?
// Tokens are already normalised through tokenise() by normaliseQuery.
// Pass results pre-filtered to expectedFiles for the primary (scoped) metric.
function tokenHit(results, allTokens, anyTokens) {
  if (!allTokens?.length && !anyTokens?.length) return null; // n/a
  return results.some(r => {
    const words = new Set([
      ...tokenise(r.payload?.text    ?? ''),
      ...tokenise(r.payload?.section ?? ''),
    ]);
    const allOk = !allTokens?.length || allTokens.every(t => words.has(t));
    const anyOk = !anyTokens?.length || anyTokens.some(t  => words.has(t));
    return allOk && anyOk;
  });
}

// nDCG@K: relevance = 1 if file matches, 0 otherwise (binary).
function ndcg(rankedFiles, expectedFiles, k) {
  const topK = rankedFiles.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    if (expectedFiles.includes(topK[i])) dcg += 1 / Math.log2(i + 2);
  }
  // Ideal DCG: all relevant docs at top positions (capped at expectedFiles.length hits).
  const idealHits = Math.min(expectedFiles.length, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Metrics ───────────────────────────────────────────────────────────────────

function computeMetrics(queryResults) {
  // Separate positive and negative queries.
  const positives = queryResults.filter(r => !r.query.shouldHaveNoStrongHit);
  const negatives = queryResults.filter(r => r.query.shouldHaveNoStrongHit);

  let recall1 = 0, recallK = 0, mrr = 0, ndcgSum = 0;
  let sectionHits = 0, sectionTotal = 0;
  let tokenHits   = 0, tokenTotal   = 0;
  let negPass     = 0;
  const latencies = queryResults.map(r => r.latency).sort((a, b) => a - b);
  const dupRates  = [];
  const diversities = [];

  for (const r of positives) {
    const { rankedFiles, latency, query } = r;
    const ef = query.expectedFiles;

    if (rankedFiles.slice(0, 1).some(f => ef.includes(f))) recall1++;
    if (rankedFiles.slice(0, TOP_K).some(f => ef.includes(f))) recallK++;
    const rankIdx = rankedFiles.findIndex(f => ef.includes(f));
    if (rankIdx >= 0) mrr += 1 / (rankIdx + 1);
    ndcgSum += ndcg(rankedFiles, ef, TOP_K);

    // Scope section/token hits to chunks from expectedFiles only.
    const expectedResults = filterToExpected(r.results, ef);
    const sh = sectionHit(expectedResults, query.expectedSections);
    if (sh !== null) { sectionTotal++; if (sh) sectionHits++; }

    const th = tokenHit(expectedResults, query.expectedAllTokens, query.expectedAnyTokens);
    if (th !== null) { tokenTotal++; if (th) tokenHits++; }

    // Duplicate source rate: fraction of top-K results sharing the same source_file.
    const topFiles = r.results.slice(0, TOP_K).map(x => x.payload?.source_file).filter(Boolean);
    const uniqueFiles = new Set(topFiles);
    dupRates.push(topFiles.length > 0 ? 1 - uniqueFiles.size / topFiles.length : 0);
    diversities.push(uniqueFiles.size);
  }

  for (const r of negatives) {
    // A negative query passes if the top result's file is NOT in expectedFiles (which is []).
    // Since expectedFiles is [], any result means no expected file was hit → pass.
    // We define pass as: top result exists and does NOT match any strong expected token.
    // Simple criterion: no result has score above a threshold — but we don't have a meaningful
    // threshold here. For now: negative passes if none of expectedAllTokens appear in top-1.
    const { results: res, query } = r;
    if (!res.length) { negPass++; continue; }
    const top1Tokens = new Set(tokenise(res[0].payload?.text ?? '').concat(tokenise(res[0].payload?.section ?? '')));
    const strongHit = (query.expectedAllTokens ?? []).some(t => top1Tokens.has(t.toLowerCase()));
    if (!strongHit) negPass++;
  }

  const n = positives.length;
  const sortedLat = [...latencies]; // already sorted above
  return {
    recall1:         n > 0 ? recall1 / n : null,
    recallK:         n > 0 ? recallK / n : null,
    mrr:             n > 0 ? mrr / n     : null,
    ndcgK:           n > 0 ? ndcgSum / n : null,
    sectionHitK:     sectionTotal > 0 ? sectionHits / sectionTotal : null,
    tokenHitK:       tokenTotal   > 0 ? tokenHits   / tokenTotal   : null,
    negativePassRate: negatives.length > 0 ? negPass / negatives.length : null,
    duplicateSourceRate: dupRates.length > 0 ? dupRates.reduce((a, b) => a + b, 0) / dupRates.length : null,
    sourceDiversityAvg:  diversities.length > 0 ? diversities.reduce((a, b) => a + b, 0) / diversities.length : null,
    avgLatency: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
    p50Latency: percentile(sortedLat, 50),
    p95Latency: percentile(sortedLat, 95),
    nPositive: n,
    nNegative: negatives.length,
  };
}

// ── Table rendering ───────────────────────────────────────────────────────────

function pct(v) { return v === null ? 'n/a' : `${(v * 100).toFixed(0)}%`; }
function pctF(v) { return v === null ? ' n/a' : `${(v * 100).toFixed(1)}%`; }
function pad(s, n)  { return String(s).padEnd(n); }
function lpad(s, n) { return String(s).padStart(n); }

function printResults(queryResults, queries) {
  const hK = `@${TOP_K}`;
  const W  = { id: 4, query: 42, expected: 14, rank: 6, h1: 4, hK: hK.length + 1, sh: 4, th: 4, ms: 6 };
  const header = [
    pad('ID',       W.id),
    pad('Query',    W.query),
    pad('Expected', W.expected),
    lpad('Rank',    W.rank),
    lpad('@1',      W.h1),
    lpad(hK,        W.hK),
    lpad('sec',     W.sh),
    lpad('tok',     W.th),
    lpad('ms',      W.ms),
  ].join('  ');

  log('\n' + '─'.repeat(header.length));
  log(header);
  log('─'.repeat(header.length));

  for (const r of queryResults) {
    const q      = r.query;
    const ef     = q.expectedFiles;
    const rankIdx = r.rankedFiles.findIndex(f => ef.includes(f));
    const rankStr = q.shouldHaveNoStrongHit ? 'neg' : (rankIdx >= 0 ? `#${rankIdx + 1}` : 'miss');
    const hit1    = !q.shouldHaveNoStrongHit && r.rankedFiles.slice(0, 1).some(f => ef.includes(f))  ? '✓' : (q.shouldHaveNoStrongHit ? '–' : '✗');
    const hitK    = !q.shouldHaveNoStrongHit && r.rankedFiles.slice(0, TOP_K).some(f => ef.includes(f)) ? '✓' : (q.shouldHaveNoStrongHit ? '–' : '✗');
    const expRes  = filterToExpected(r.results, ef);
    const sh      = sectionHit(expRes, q.expectedSections);
    const th      = tokenHit(expRes, q.expectedAllTokens, q.expectedAnyTokens);
    const shStr   = sh === null ? '–' : (sh ? '✓' : '✗');
    const thStr   = th === null ? '–' : (th ? '✓' : '✗');
    log([
      pad(q.id,                           W.id),
      pad(q.query.slice(0, W.query - 1),  W.query),
      pad(ef[0] ?? '(none)',              W.expected),
      lpad(rankStr,                       W.rank),
      lpad(hit1,                          W.h1),
      lpad(hitK,                          W.hK),
      lpad(shStr,                         W.sh),
      lpad(thStr,                         W.th),
      lpad(r.latency,                     W.ms),
    ].join('  '));
  }

  log('─'.repeat(header.length));
}

function printSummary(metrics, provider) {
  log(`\nProvider        : ${provider}`);
  log(`Queries         : ${metrics.nPositive} positive, ${metrics.nNegative} negative`);
  log(`fileRecall@1    : ${pct(metrics.recall1)}`);
  log(`fileRecall@${TOP_K}   : ${pct(metrics.recallK)}`);
  log(`MRR             : ${metrics.mrr?.toFixed(3) ?? 'n/a'}`);
  log(`nDCG@${TOP_K}         : ${metrics.ndcgK?.toFixed(3) ?? 'n/a'}`);
  if (metrics.sectionHitK !== null) log(`sectionHit@${TOP_K}   : ${pctF(metrics.sectionHitK)}`);
  if (metrics.tokenHitK   !== null) log(`tokenHit@${TOP_K}     : ${pctF(metrics.tokenHitK)}`);
  if (metrics.negativePassRate !== null) log(`negativePass    : ${pctF(metrics.negativePassRate)}`);
  log(`dupSourceRate   : ${pctF(metrics.duplicateSourceRate)}`);
  log(`sourceDiversity : ${metrics.sourceDiversityAvg?.toFixed(1) ?? 'n/a'} avg unique files/@${TOP_K}`);
  log(`Latency p50/p95 : ${metrics.p50Latency}ms / ${metrics.p95Latency}ms`);
  log(`Avg ms          : ${Math.round(metrics.avgLatency)}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const rawQueries = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  const queries    = rawQueries.map(normaliseQuery);
  const { denseProvider, sparseProvider } = resolveEnvProviders();

  log(`\n=== semidex retrieval benchmark ===`);
  log(`Provider  : ${BENCH_PROVIDER}  (${denseProvider}/${sparseProvider})`);
  log(`Top-K     : ${TOP_K}`);
  log(`Queries   : ${queries.length} (${queries.filter(q => !q.shouldHaveNoStrongHit).length} positive, ${queries.filter(q => q.shouldHaveNoStrongHit).length} negative)`);

  log('\n[1/2] Setup collection...');
  await ensureCollection();

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
    log('[2/2] Skipping index (BENCH_SKIP_INDEX=1)');
  } else {
    log('[2/2] Indexing fixtures...');
    await indexFixtures();
  }

  log('\nRunning queries...');
  const queryResults = [];
  for (const q of queries) {
    logw(`  ${q.id}: ${q.query.slice(0, 40)}... `);
    const { results, latency } = await runQuery(q.query);

    // Build ranked file list (dedup, preserve order) for file-level metrics.
    const seen = new Set();
    const rankedFiles = [];
    for (const r of results) {
      const sf = r.payload?.source_file;
      if (sf && !seen.has(sf)) { seen.add(sf); rankedFiles.push(sf); }
    }

    queryResults.push({ query: q, results, rankedFiles, latency });

    const ef = q.expectedFiles;
    const hit = !q.shouldHaveNoStrongHit && rankedFiles.slice(0, TOP_K).some(f => ef.includes(f));
    if (q.shouldHaveNoStrongHit) {
      log(`(neg) (${latency}ms)`);
    } else {
      log(hit ? `✓ (${latency}ms)` : `✗ top-${TOP_K}: [${rankedFiles.slice(0, TOP_K).join(', ')}] (${latency}ms)`);
    }
  }

  const metrics = computeMetrics(queryResults);
  printResults(queryResults, queries);
  printSummary(metrics, BENCH_PROVIDER);
  log('');

  if (JSON_MODE) {
    process.stdout.write(JSON.stringify({
      provider:      BENCH_PROVIDER,
      denseProvider,
      sparseProvider,
      topK:          TOP_K,
      metrics,
      queryResults:  queryResults.map(r => ({
        id:       r.query.id,
        type:     r.query.type,
        expected: r.query.expected,  // v1 compat
        expectedFiles: r.query.expectedFiles,
        rank:     r.query.shouldHaveNoStrongHit ? -2 : r.rankedFiles.findIndex(f => r.query.expectedFiles.includes(f)),
        latency:  r.latency,
        sectionHit: sectionHit(filterToExpected(r.results, r.query.expectedFiles), r.query.expectedSections),
        tokenHit:   tokenHit(filterToExpected(r.results, r.query.expectedFiles), r.query.expectedAllTokens, r.query.expectedAnyTokens),
      })),
    }) + '\n');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
