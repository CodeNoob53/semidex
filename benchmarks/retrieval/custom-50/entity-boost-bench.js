/**
 * Entity-boost retrieval benchmark — custom-50, bench-only.
 *
 * After hybridSearch returns top-N candidates (ENTITY_BOOST_PREFETCH, default 20),
 * computes entity overlap between query entities and chunk entities, and applies
 * a small additive score bonus:
 *
 *   finalScore = rrfScore + ENTITY_BOOST_WEIGHT * |queryEntities ∩ chunkEntities|
 *
 * Stable-sorts the boosted list and evaluates at TOP_K (default 10).
 *
 * This is benchmark/research code only. Production MCP search.js is NOT changed.
 *
 * Usage:
 *   node benchmarks/retrieval/custom-50/entity-boost-bench.js
 *   npm run bench:custom50:entity-boost
 *   BENCH_PROVIDER=onnx npm run bench:custom50:entity-boost
 *   BENCH_SKIP_INDEX=1 npm run bench:custom50:entity-boost
 *   ENTITY_BOOST_WEIGHT=0.002 npm run bench:custom50:entity-boost
 *   ENTITY_BOOST_PREFETCH=30 npm run bench:custom50:entity-boost
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { stableSortResults } from './sort-results.js';
import { chunkFile } from '../../../src/indexer/phases/chunk.js';
import { extractEntities } from '../../../src/indexer/phases/entities.js';
import {
  listCollections, createCollection, deleteBySourceFile,
  upsertPoints, hybridSearch, scroll,
} from '../../../src/core/qdrant.js';
import { embedForIndex, embedForSearch, SCHEMA_VERSION } from '../../../src/core/embeddings.js';
import { loadConfig, saveConfig, resolveEnvProviders } from '../../../src/core/config.js';

const __dirname      = dirname(fileURLToPath(import.meta.url));
const FIXTURES_SHARED = resolve(__dirname, '../fixtures/docs');
const FIXTURES_OWN    = resolve(__dirname, 'fixtures/docs');
const QUERIES_PATH    = resolve(__dirname, 'queries.json');

const COLLECTION           = 'bench-retrieval-custom-50-entity';
const TOP_K                = parseInt(process.env.BENCH_TOP_K ?? '10');
const SKIP_INDEX           = process.env.BENCH_SKIP_INDEX === '1';
const BENCH_PROVIDER       = process.env.BENCH_PROVIDER ?? 'env';
const ENTITY_BOOST_WEIGHT  = parseFloat(process.env.ENTITY_BOOST_WEIGHT ?? '0.0015');
const ENTITY_BOOST_PREFETCH = parseInt(process.env.ENTITY_BOOST_PREFETCH ?? '20');

if (BENCH_PROVIDER === 'onnx') {
  process.env.ONNX_EMBED = '1';
  delete process.env.DENSE_PROVIDER;
  delete process.env.SPARSE_PROVIDER;
}

const FIXTURE_FILES = [
  { name: 'providers.md',         dir: FIXTURES_SHARED },
  { name: 'qdrant.md',            dir: FIXTURES_SHARED },
  { name: 'chunking.md',          dir: FIXTURES_SHARED },
  { name: 'sync.md',              dir: FIXTURES_SHARED },
  { name: 'mcp-workflow.md',      dir: FIXTURES_OWN },
  { name: 'obsidian.md',          dir: FIXTURES_OWN },
  { name: 'project-structure.md', dir: FIXTURES_OWN },
  { name: 'benchmarking.md',      dir: FIXTURES_OWN },
  { name: 'config-env.md',        dir: FIXTURES_OWN },
  { name: 'multilingual.md',      dir: FIXTURES_OWN },
];

// ── Helpers shared with run-v3 (copied to avoid coupling) ────────────────────

function resultChunkId(r) {
  const sf = r.payload?.source_file;
  const ci = r.payload?.chunk_index;
  if (!sf || ci == null) return null;
  return `${sf}#${ci}`;
}

function buildQrels(relevantChunks) {
  const map = new Map();
  for (const rc of (relevantChunks ?? [])) map.set(rc.chunkId, rc.relevance ?? 3);
  return map;
}

function idealDCG(qrels, k) {
  const gains = [...qrels.values()].map(r => Math.pow(2, r) - 1).sort((a, b) => b - a);
  let idcg = 0;
  for (let i = 0; i < Math.min(gains.length, k); i++) idcg += gains[i] / Math.log2(i + 2);
  return idcg;
}

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

function chunkRecallHit(results, qrels, k, minRel = 3) {
  if (!qrels.size) return null;
  const ids = new Set([...qrels.entries()].filter(([, r]) => r >= minRel).map(([id]) => id));
  if (!ids.size) return null;
  return results.slice(0, k).some(r => ids.has(resultChunkId(r)));
}

function mrrAt(results, qrels, k) {
  if (!qrels.size) return null;
  const ids = new Set([...qrels.entries()].filter(([, r]) => r >= 3).map(([id]) => id));
  if (!ids.size) return null;
  for (let i = 0; i < Math.min(results.length, k); i++) {
    if (ids.has(resultChunkId(results[i]))) return 1 / (i + 1);
  }
  return 0;
}

function pct(v) { return v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`; }
function fmt3(v) { return v === null ? 'n/a' : v.toFixed(3); }

// ── Entity helpers ────────────────────────────────────────────────────────────

/**
 * Extract entity tokens from a query string for overlap comparison.
 * Returns a Set of all strings extracted via the entity extractor
 * treating the query as a synthetic chunk with no source_file.
 */
function queryEntityTokens(queryText) {
  const { entities } = extractEntities({
    text: queryText,
    section: '',
    source_file: '',
  });
  const all = [
    ...entities.paths,
    ...entities.symbols,
    ...entities.env_vars,
    ...entities.commands,
  ];
  return new Set(all);
}

/**
 * Entity overlap count between query tokens and a chunk's stored entity payload.
 */
function entityOverlap(queryTokens, chunkPayload) {
  const e = chunkPayload?.entities;
  if (!e || !queryTokens.size) return 0;
  const chunkTokens = [
    ...(e.paths      ?? []),
    ...(e.symbols    ?? []),
    ...(e.env_vars   ?? []),
    ...(e.commands   ?? []),
  ];
  let count = 0;
  for (const t of chunkTokens) {
    if (queryTokens.has(t)) count++;
  }
  return count;
}

/**
 * Apply entity boost to a candidate list.
 * Returns new array with score boosted, then stable-sorted.
 */
function applyEntityBoost(candidates, queryTokens, boostWeight) {
  const boosted = candidates.map(r => {
    const overlap = entityOverlap(queryTokens, r.payload);
    const bonus   = overlap > 0 ? boostWeight * overlap : 0;
    return { ...r, score: (r.score ?? 0) + bonus, _entityOverlap: overlap };
  });
  return stableSortResults(boosted);
}

// ── Collection setup ──────────────────────────────────────────────────────────

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
    description: 'entity-boost bench collection — auto-managed',
  };
  saveConfig(cfg);
}

async function indexFixtures() {
  for (const { name, dir } of FIXTURE_FILES) {
    const filePath   = resolve(dir, name);
    const text       = readFileSync(filePath, 'utf8');
    const sourceFile = name;

    await deleteBySourceFile(COLLECTION, sourceFile);

    const chunks = chunkFile(filePath, text, sourceFile);
    const points = [];
    for (const chunk of chunks) {
      const { dense, sparse, meta } = await embedForIndex(COLLECTION, chunk.text);
      // Run entity extractor so stored payload has entities for boost comparison.
      const { entities, doc_role } = extractEntities(chunk);
      points.push({
        id: randomUUID(),
        vector: { dense, sparse },
        payload: {
          text:         chunk.text,
          section:      chunk.section,
          source_file:  sourceFile,
          chunk_index:  chunk.chunkIndex,
          total_chunks: chunk.totalChunks,
          file_hash:    'bench-entity-v1',
          vector_size:  1024,
          entities,
          doc_role,
          ...meta,
        },
      });
    }
    await upsertPoints(COLLECTION, points);
    process.stderr.write(`  indexed ${name} (${points.length} chunks)\n`);
  }
}

async function fetchIndexedChunkIds() {
  const points = await scroll(COLLECTION, undefined, 2000, ['source_file', 'chunk_index']);
  const ids = new Set();
  for (const p of points) {
    const sf = p.payload?.source_file;
    const ci = p.payload?.chunk_index;
    if (sf != null && ci != null) ids.add(`${sf}#${ci}`);
  }
  return ids;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  process.stderr.write(`\n=== Entity Boost Bench — custom-50 ===\n`);
  process.stderr.write(`  ENTITY_BOOST_WEIGHT  = ${ENTITY_BOOST_WEIGHT}\n`);
  process.stderr.write(`  ENTITY_BOOST_PREFETCH = ${ENTITY_BOOST_PREFETCH}\n`);
  process.stderr.write(`  TOP_K                = ${TOP_K}\n`);
  process.stderr.write(`  SKIP_INDEX           = ${SKIP_INDEX}\n\n`);

  await ensureCollection();

  if (!SKIP_INDEX) {
    process.stderr.write('Indexing fixtures...\n');
    await indexFixtures();
  } else {
    process.stderr.write('BENCH_SKIP_INDEX=1 — reusing existing collection.\n');
  }

  const indexedIds = await fetchIndexedChunkIds();

  const { queries } = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));

  // Validate qrels exist in index.
  const qrelErrors = [];
  for (const q of queries) {
    if (q.shouldHaveNoStrongHit) continue;
    for (const rc of (q.relevantChunks ?? [])) {
      if (!indexedIds.has(rc.chunkId)) {
        qrelErrors.push(`  [${q.id}] "${rc.chunkId}" not found`);
      }
    }
  }
  if (qrelErrors.length) {
    process.stderr.write(`\nQrel errors:\n${qrelErrors.join('\n')}\n`);
    process.exit(1);
  }

  const queryResults = [];

  for (const q of queries) {
    const qrels = buildQrels(q.relevantChunks);
    const queryTokens = queryEntityTokens(q.query);

    const { dense, sparse } = await embedForSearch(COLLECTION, q.query);

    // True baseline: same limit as the canonical bench (TOP_K), so HYBRID_PREFETCH_LIMIT
    // inside hybridSearch applies identically to the standard run-v3.js path.
    const trueBaseline = stableSortResults(await hybridSearch(COLLECTION, dense, sparse, TOP_K));

    // Wider candidate pool for entity re-ranking only.
    const prefetchLimit = Math.max(ENTITY_BOOST_PREFETCH, TOP_K + 1);
    const wideCandidates = prefetchLimit > TOP_K
      ? stableSortResults(await hybridSearch(COLLECTION, dense, sparse, prefetchLimit))
      : trueBaseline;

    // Apply entity boost and stable-sort; trim to TOP_K.
    const boosted = applyEntityBoost(wideCandidates, queryTokens, ENTITY_BOOST_WEIGHT);
    const results  = boosted.slice(0, TOP_K);

    queryResults.push({ query: q, qrels, results, baseline: trueBaseline, queryTokens });
  }

  // ── Per-query table ──────────────────────────────────────────────────────

  const SOURCE_NAV_IDS = new Set(['c35', 'c36', 'c37']);
  process.stdout.write('\n## Per-query results\n\n');
  process.stdout.write('| id | type | bCr5 | eCr5 | bMRR | eMRR | overlap | note |\n');
  process.stdout.write('|----|------|------|------|------|------|---------|------|\n');

  let sourcNavPassed = 0;
  let newHardReg = 0;

  for (const { query: q, qrels, results, baseline, queryTokens } of queryResults) {
    if (q.shouldHaveNoStrongHit) continue;

    const bCr5 = chunkRecallHit(baseline, qrels, 5);
    const eCr5 = chunkRecallHit(results,  qrels, 5);
    const bMRR = mrrAt(baseline, qrels, 10);
    const eMRR = mrrAt(results,  qrels, 10);

    const maxOverlap = Math.max(
      ...results.map(r => entityOverlap(queryTokens, r.payload)),
      0,
    );

    const bMark = bCr5 ? '✓' : '✗';
    const eMark = eCr5 ? '✓' : '✗';

    let note = '';
    if (bCr5 && !eCr5) { note = 'NEW REGRESSION'; newHardReg++; }
    else if (!bCr5 && eCr5) { note = 'fixed'; }
    if (SOURCE_NAV_IDS.has(q.id)) {
      if (eCr5) sourcNavPassed++;
    }

    process.stdout.write(
      `| ${q.id} | ${q.type ?? ''} | ${bMark} | ${eMark} | ${fmt3(bMRR)} | ${fmt3(eMRR)} | ${maxOverlap} | ${note} |\n`,
    );
  }

  // ── Aggregate ────────────────────────────────────────────────────────────

  const positives = queryResults.filter(r => !r.query.shouldHaveNoStrongHit);
  const bCr5All   = positives.filter(r => chunkRecallHit(r.baseline, r.qrels, 5) !== null);
  const eCr5All   = positives.filter(r => chunkRecallHit(r.results,  r.qrels, 5) !== null);

  const bCr5Rate  = bCr5All.length ? bCr5All.filter(r => chunkRecallHit(r.baseline, r.qrels, 5)).length / bCr5All.length : null;
  const eCr5Rate  = eCr5All.length ? eCr5All.filter(r => chunkRecallHit(r.results,  r.qrels, 5)).length / eCr5All.length : null;

  const bCr10All  = positives.filter(r => chunkRecallHit(r.baseline, r.qrels, 10) !== null);
  const eCr10All  = positives.filter(r => chunkRecallHit(r.results,  r.qrels, 10) !== null);
  const bCr10Rate = bCr10All.length ? bCr10All.filter(r => chunkRecallHit(r.baseline, r.qrels, 10)).length / bCr10All.length : null;
  const eCr10Rate = eCr10All.length ? eCr10All.filter(r => chunkRecallHit(r.results,  r.qrels, 10)).length / eCr10All.length : null;

  const mrrEntries = positives.filter(r => mrrAt(r.results, r.qrels, 10) !== null);
  const baseMrrEntries = positives.filter(r => mrrAt(r.baseline, r.qrels, 10) !== null);
  const eMRRAvg = mrrEntries.length ? mrrEntries.reduce((s, r) => s + mrrAt(r.results, r.qrels, 10), 0) / mrrEntries.length : null;
  const bMRRAvg = baseMrrEntries.length ? baseMrrEntries.reduce((s, r) => s + mrrAt(r.baseline, r.qrels, 10), 0) / baseMrrEntries.length : null;

  const ndcgEntries = positives.filter(r => gradedNDCG(r.results, r.qrels, 10) !== null);
  const baseNdcgEntries = positives.filter(r => gradedNDCG(r.baseline, r.qrels, 10) !== null);
  const eNDCGAvg = ndcgEntries.length ? ndcgEntries.reduce((s, r) => s + gradedNDCG(r.results, r.qrels, 10), 0) / ndcgEntries.length : null;
  const bNDCGAvg = baseNdcgEntries.length ? baseNdcgEntries.reduce((s, r) => s + gradedNDCG(r.baseline, r.qrels, 10), 0) / baseNdcgEntries.length : null;

  process.stdout.write('\n## Aggregate metrics\n\n');
  process.stdout.write('| Metric | baseline | entity-boost (Δ) |\n');
  process.stdout.write('|--------|----------|------------------|\n');
  process.stdout.write(`| chunkRecall@5  | ${pct(bCr5Rate)}  | ${pct(eCr5Rate)} (${eCr5Rate !== null && bCr5Rate !== null ? (((eCr5Rate - bCr5Rate) * 100).toFixed(1) + 'pp') : 'n/a'}) |\n`);
  process.stdout.write(`| chunkRecall@10 | ${pct(bCr10Rate)} | ${pct(eCr10Rate)} (${eCr10Rate !== null && bCr10Rate !== null ? (((eCr10Rate - bCr10Rate) * 100).toFixed(1) + 'pp') : 'n/a'}) |\n`);
  process.stdout.write(`| nDCG@10        | ${fmt3(bNDCGAvg)} | ${fmt3(eNDCGAvg)} (${eNDCGAvg !== null && bNDCGAvg !== null ? (eNDCGAvg - bNDCGAvg >= 0 ? '+' : '') + (eNDCGAvg - bNDCGAvg).toFixed(3) : 'n/a'}) |\n`);
  process.stdout.write(`| MRR@10         | ${fmt3(bMRRAvg)} | ${fmt3(eMRRAvg)} (${eMRRAvg !== null && bMRRAvg !== null ? (eMRRAvg - bMRRAvg >= 0 ? '+' : '') + (eMRRAvg - bMRRAvg).toFixed(3) : 'n/a'}) |\n`);

  process.stdout.write('\n## Source-navigation focus (c35, c36, c37)\n\n');
  process.stdout.write(`  cr@5 with entity boost: ${sourcNavPassed}/3\n`);

  process.stdout.write('\n## Config\n\n');
  process.stdout.write(`  ENTITY_BOOST_WEIGHT   = ${ENTITY_BOOST_WEIGHT}\n`);
  process.stdout.write(`  ENTITY_BOOST_PREFETCH = ${ENTITY_BOOST_PREFETCH}\n`);
  process.stdout.write(`  collection            = ${COLLECTION}\n`);

  if (newHardReg > 0) {
    process.stdout.write(`\n⚠ NEW HARD REGRESSIONS: ${newHardReg} (queries that were ✓ baseline but ✗ entity-boost)\n`);
  } else {
    process.stdout.write('\n✓ No new hard regressions introduced by entity boost.\n');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
