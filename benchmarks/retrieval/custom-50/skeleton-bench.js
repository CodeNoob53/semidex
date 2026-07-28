// Skeleton vs legacy chunker — REAL chunk-level benchmark for custom-50.
//
// Replaces the preliminary file-level skeleton-bench.js.
// Indexes the same fixture files twice (legacy chunkFile / skeleton chunkFromSkeleton),
// runs 50 queries sequentially against each collection, migrates qrels from legacy
// chunk boundaries to skeleton chunk boundaries via content-overlap matching, then
// reports full chunk-level metrics (chunkRecall, MRR, nDCG, windowRecall, supportRecall).
//
// Usage:
//   node benchmarks/retrieval/custom-50/skeleton-bench.js
//   npm run bench:custom50:skeleton
//   BENCH_SKIP_INDEX=1 npm run bench:custom50:skeleton
//   BENCH_TOP_K=10 npm run bench:custom50:skeleton
//
// Verdict codes:
//   SKELETON_ACCEPT                   — no hard regressions, all qrels mapped exactly/window
//   SKELETON_ACCEPT_WITH_QREL_MIGRATION — no hard regressions but some window/ambiguous qrel drift
//   SKELETON_BLOCKED_BY_QREL_DRIFT    — cannot determine due to missing qrels
//   SKELETON_REJECT_RETRIEVAL_REGRESSION — hard regressions confirmed

if (process.argv.includes('--help')) {
  process.stdout.write(`custom-50 skeleton vs legacy — REAL chunk-level benchmark

Usage:
  npm run bench:custom50:skeleton

Options (env vars):
  BENCH_SKIP_INDEX=1    Reuse existing bench-custom50-legacy + bench-custom50-skeleton
  BENCH_TOP_K=<n>       Search depth (default: 10)
  BENCH_WINDOW=<n>      Adjacency window for windowRecall (default: 1)
  BENCH_LLM=1           Include LLM phase in indexing:
                          legacy  → addContext() on every chunk (N Ollama calls)
                          skeleton→ generateNavSummaries() on nav nodes (much fewer calls)
                        Without this flag both candidates run embed-only (no LLM), which
                        is not representative of real production indexing.
  CONTEXT_MODEL=<m>     Ollama model for LLM phase (default: gemma3:4b)
`);
  process.exit(0);
}

import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { chunkFile } from '../../../src/indexer/phases/chunk.js';
import { addContext } from '../../../src/indexer/phases/context.js';
import { parseSkeleton } from '../../../src/indexer/phases/skeleton.js';
import { chunkFromSkeleton } from '../../../src/indexer/phases/skeleton-chunk.js';
import { generateNavSummaries } from '../../../src/indexer/phases/skeleton-summary.js';
import { buildFileSkeleton } from '../../../src/indexer/phases/skeleton-index.js';
import {
  deleteCollection,
  upsertPoints, hybridSearch, scroll,
} from '../../../src/core/qdrant.js';
import { embedForIndex, embedForSearch } from '../../../src/core/embeddings.js';
import { createStorageAdapter } from '../../../src/core/storage/factory.js';
import { resolveBenchProfile } from '../../lib/resolve-profile.js';

// Force ONNX for reproducibility (no Ollama dependency).
process.env.ONNX_EMBED = '1';
delete process.env.DENSE_PROVIDER;
delete process.env.SPARSE_PROVIDER;

const storageAdapter = createStorageAdapter();
// Resolved per-collection in setupCollection()/main() before indexing/search —
// embedForIndex/embedForSearch require a resolved profile object, not a bare
// collection name (see benchmarks/lib/resolve-profile.js's header comment).
let PROFILE_LEGACY   = null;
let PROFILE_SKELETON = null;

const __dirname       = dirname(fileURLToPath(import.meta.url));
const FIXTURES_SHARED = resolve(__dirname, '../fixtures/docs');
const FIXTURES_OWN    = resolve(__dirname, 'fixtures/docs');
const QUERIES_PATH    = resolve(__dirname, 'queries.json');
const OVERLAY_PATH    = resolve(__dirname, 'qrels.skeleton-v1.json');
const RESULTS_DIR     = resolve(__dirname, '../results');

// Load qrel overlay (manual drift fixes verified by content inspection).
const overlay = existsSync(OVERLAY_PATH)
  ? JSON.parse(readFileSync(OVERLAY_PATH, 'utf8'))
  : { overrides: [] };
const OVERLAY_MAP = new Map(
  (overlay.overrides ?? []).map(o => [
    `${o.queryId}::${o.legacyChunkId}`,
    o,
  ])
);

const COLLECTION_LEGACY   = 'bench-custom50-legacy';
const COLLECTION_SKELETON = 'bench-custom50-skeleton';
const VECTOR_SIZE = 1024;

const TOP_K        = parseInt(process.env.BENCH_TOP_K   ?? '10', 10) || 10;
const BENCH_WINDOW = parseInt(process.env.BENCH_WINDOW  ?? '1',  10) || 1;
const SKIP_INDEX   = process.env.BENCH_SKIP_INDEX === '1';
const BENCH_LLM    = process.env.BENCH_LLM === '1';

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

// ── Collection setup ──────────────────────────────────────────────────────────

// Deletes the collection if it exists, then resolves (and creates) a fresh
// profile from current env via resolveBenchProfile — since the collection is
// always deleted first here, resolveBenchProfile always takes its "doesn't
// exist yet" branch, i.e. this always derives a NEW profile from current env
// (ONNX forced above), matching the original delete+recreate semantics.
async function setupCollection(name) {
  const existing = await storageAdapter.getCollection(name);
  if (existing) await deleteCollection(name);
  return resolveBenchProfile(storageAdapter, name, { vectorSize: VECTOR_SIZE });
}

// ── Indexing ──────────────────────────────────────────────────────────────────

// Returns { stats, registry, wallMs, llmMs, embedMs, upsertMs }
async function indexLegacy() {
  const stats    = {};
  const registry = new Map(); // "file#N" → { text, section }
  let llmMs = 0, embedMs = 0, upsertMs = 0;
  const t0 = Date.now();

  for (const { name, dir } of FIXTURE_FILES) {
    const filePath = resolve(dir, name);
    const text     = readFileSync(filePath, 'utf8');
    let chunks     = chunkFile(filePath, text, name);

    // LLM context phase (opt-in: BENCH_LLM=1).
    // In production legacy indexing every chunk goes through addContext() — one
    // Ollama generate() call per chunk. This is the dominant indexing cost.
    if (BENCH_LLM) {
      const tLlm = Date.now();
      const withCtx = [];
      for (const chunk of chunks) withCtx.push(await addContext(chunk));
      chunks = withCtx;
      llmMs += Date.now() - tLlm;
    }

    const points = [];
    for (const chunk of chunks) {
      registry.set(`${name}#${chunk.chunkIndex}`, {
        text:    chunk.text,
        section: chunk.section ?? '',
      });
      const embedText = BENCH_LLM ? `${chunk.context ?? ''}\n\n${chunk.text}`.trim() : chunk.text;
      const tEmbed = Date.now();
      const { dense, sparse, meta } = await embedForIndex(PROFILE_LEGACY, embedText);
      embedMs += Date.now() - tEmbed;
      points.push({
        id: randomUUID(),
        vector: { dense, sparse },
        payload: {
          text: chunk.text, section: chunk.section ?? '',
          source_file: name,
          chunk_index: chunk.chunkIndex, total_chunks: chunk.totalChunks,
          file_hash: 'bench-skel', vector_size: VECTOR_SIZE, ...meta,
        },
      });
    }

    const tUpsert = Date.now();
    await upsertPoints(COLLECTION_LEGACY, points);
    upsertMs += Date.now() - tUpsert;
    stats[name] = points.length;
    process.stderr.write(`  [legacy]   ${name} → ${points.length} chunks${BENCH_LLM ? ' (llm+embed)' : ''}\n`);
  }

  return { stats, registry, wallMs: Date.now() - t0, llmMs, embedMs, upsertMs };
}

// Returns { stats, registry, wallMs, llmMs, embedMs, upsertMs }
async function indexSkeleton() {
  const stats    = {};
  const registry = new Map();
  let llmMs = 0, embedMs = 0, upsertMs = 0;
  const t0 = Date.now();

  for (const { name, dir } of FIXTURE_FILES) {
    const filePath = resolve(dir, name);
    const text     = readFileSync(filePath, 'utf8');
    const nodes    = parseSkeleton(text, { sourceFile: name });
    const chunks   = chunkFromSkeleton(nodes, { sourceFile: name });

    // LLM nav-summary phase (opt-in: BENCH_LLM=1).
    // In production skeleton indexing: generateNavSummaries() runs on nav nodes
    // (~2 per file), not on every chunk. This is far fewer LLM calls than legacy.
    let navSummaryChunks = chunks;
    if (BENCH_LLM) {
      const tLlm = Date.now();
      const { navPoints } = buildFileSkeleton(nodes, { sourceFile: name });
      if (navPoints.length > 0) {
        await generateNavSummaries(navPoints, chunks, { windowTokens: 8000 });
      }
      llmMs += Date.now() - tLlm;
    }

    const points = [];
    for (let i = 0; i < navSummaryChunks.length; i++) {
      const chunk = navSummaryChunks[i];
      registry.set(`${name}#${i}`, {
        text:         chunk.text,
        section:      chunk.section ?? '',
        heading_path: chunk.heading_path ?? [],
      });
      const embedText = `${chunk.context ?? ''}\n\n${chunk.text}`.trim();
      const tEmbed = Date.now();
      const { dense, sparse, meta } = await embedForIndex(PROFILE_SKELETON, embedText);
      embedMs += Date.now() - tEmbed;
      points.push({
        id: randomUUID(),
        vector: { dense, sparse },
        payload: {
          text: chunk.text,
          section: chunk.section ?? chunk.heading_path?.join(' > ') ?? '',
          source_file: name, chunk_index: i, total_chunks: chunks.length,
          file_hash: 'bench-skel', vector_size: VECTOR_SIZE,
          chunking_model: 'skeleton-v1', ...meta,
        },
      });
    }

    const tUpsert = Date.now();
    await upsertPoints(COLLECTION_SKELETON, points);
    upsertMs += Date.now() - tUpsert;
    stats[name] = points.length;
    process.stderr.write(`  [skeleton] ${name} → ${points.length} chunks${BENCH_LLM ? ' (llm+embed)' : ''}\n`);
  }

  return { stats, registry, wallMs: Date.now() - t0, llmMs, embedMs, upsertMs };
}

// ── Qrel migration ────────────────────────────────────────────────────────────

// Tokenise to a word-set for overlap calculation.
function wordSet(text) {
  return new Set((text ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
}

// Jaccard-like overlap: |intersection| / |legacy words|
// We use legacy as denominator (how much of the legacy chunk is covered).
function wordOverlap(legacyText, candidateText) {
  const lWords = wordSet(legacyText);
  const cWords = wordSet(candidateText);
  if (!lWords.size) return 0;
  let hits = 0;
  for (const w of lWords) if (cWords.has(w)) hits++;
  return hits / lWords.size;
}

// Classification thresholds (per task spec):
//   exact  : overlap > 0.50
//   window : overlap 0.20-0.50 OR adjacent windows cover > 0.50 together
//   missing: best overlap < 0.20

function classifyAndMapQrel(legacyChunkId, legacyRegistry, skeletonRegistry) {
  const parsed = parseChunkId(legacyChunkId);
  if (!parsed) return { type: 'missing', skeletonIds: [], reason: 'bad chunkId format' };

  const { sourceFile, chunkIndex } = parsed;
  const legacyEntry = legacyRegistry.get(legacyChunkId);
  if (!legacyEntry) return { type: 'missing', skeletonIds: [], reason: 'legacy chunk not found' };

  const legacyText = legacyEntry.text;

  // Find all skeleton chunks from the same file.
  const candidates = [];
  for (const [key, val] of skeletonRegistry.entries()) {
    if (!key.startsWith(`${sourceFile}#`)) continue;
    const p = parseChunkId(key);
    if (!p) continue;
    const score = wordOverlap(legacyText, val.text);
    candidates.push({ chunkId: key, chunkIndex: p.chunkIndex, score, text: val.text, section: val.section });
  }

  if (!candidates.length) return { type: 'missing', skeletonIds: [], reason: 'no skeleton chunks for this file' };

  // Sort by overlap descending.
  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];
  const secondBest = candidates[1];

  // Multiple strong matches → ambiguous.
  if (best.score > 0.50 && secondBest && secondBest.score > 0.50) {
    return { type: 'ambiguous', skeletonIds: [best.chunkId, secondBest.chunkId], bestScore: best.score };
  }

  // Single strong match → exact.
  if (best.score > 0.50) {
    return { type: 'exact', skeletonIds: [best.chunkId], bestScore: best.score };
  }

  // Check window: adjacent skeleton chunks combined coverage.
  if (best.score >= 0.20 && best.score <= 0.50) {
    return { type: 'window', skeletonIds: [best.chunkId], bestScore: best.score };
  }

  // Window: best < 0.20 but within ±2 index of the mapped position, with combined > 0.50.
  const nearChunks = candidates.filter(c => Math.abs(c.chunkIndex - best.chunkIndex) <= 2);
  const combined = new Set();
  let combinedText = '';
  for (const nc of nearChunks.slice(0, 3)) {
    for (const w of wordSet(nc.text)) combined.add(w);
    combinedText += ' ' + nc.text;
  }
  const combinedScore = wordOverlap(legacyText, combinedText);
  if (combinedScore > 0.50) {
    return { type: 'window', skeletonIds: nearChunks.slice(0, 3).map(c => c.chunkId), bestScore: combinedScore };
  }

  return { type: 'missing', skeletonIds: [], bestScore: best.score };
}

function buildSkeletonQrels(queries, legacyRegistry, skeletonRegistry) {
  const migrationReport = {
    total: 0, exact: 0, window: 0, missing: 0, ambiguous: 0, overlay: 0,
    overlayTotal: OVERLAY_MAP.size,
    details: [],
  };

  const querySkeletonQrels = [];

  for (const q of queries) {
    if (q.shouldHaveNoStrongHit) {
      querySkeletonQrels.push({ query: q, skeletonQrels: new Map(), migrationStatus: 'negative', overlayApplied: false });
      continue;
    }

    const skeletonQrelsMap = new Map();
    let hasMissing = false;
    let overlayApplied = false;

    for (const rc of (q.relevantChunks ?? [])) {
      migrationReport.total++;
      const overlayKey = `${q.id}::${rc.chunkId}`;
      const overlayEntry = OVERLAY_MAP.get(overlayKey);

      let result = classifyAndMapQrel(rc.chunkId, legacyRegistry, skeletonRegistry);

      // Apply overlay: if a manual override exists, replace auto-migration result.
      if (overlayEntry) {
        migrationReport.overlay++;
        overlayApplied = true;
        result = {
          type: 'overlay',
          skeletonIds: [overlayEntry.skeletonChunkId],
          bestScore: null,
          reason: overlayEntry.reason,
        };
        migrationReport.details.push({
          query: q.id,
          legacyId: rc.chunkId,
          relevance: rc.relevance,
          type: 'overlay',
          skeletonIds: result.skeletonIds,
          bestScore: null,
          reason: overlayEntry.reason,
          overlayKey: overlayEntry.skeletonChunkId,
        });
      } else {
        migrationReport[result.type] = (migrationReport[result.type] ?? 0) + 1;
        migrationReport.details.push({
          query: q.id,
          legacyId: rc.chunkId,
          relevance: rc.relevance,
          type: result.type,
          skeletonIds: result.skeletonIds,
          bestScore: result.bestScore ?? null,
          reason: result.reason ?? null,
        });
      }

      if (result.type === 'missing') {
        hasMissing = true;
      } else {
        // Map each skeleton chunk ID with the same relevance.
        for (const sid of result.skeletonIds) {
          // Take max relevance if same chunk mapped from multiple legacy qrels.
          const existing = skeletonQrelsMap.get(sid);
          if (!existing || rc.relevance > existing) {
            skeletonQrelsMap.set(sid, rc.relevance);
          }
        }
      }
    }

    const allMissing = !q.shouldHaveNoStrongHit && q.relevantChunks?.length > 0 && hasMissing &&
      [...skeletonQrelsMap.keys()].length === 0;

    querySkeletonQrels.push({
      query: q,
      skeletonQrels: skeletonQrelsMap,
      migrationStatus: hasMissing ? (allMissing ? 'all-missing' : 'partial-missing') : 'ok',
      overlayApplied,
    });
  }

  return { querySkeletonQrels, migrationReport };
}

// ── Search ────────────────────────────────────────────────────────────────────

// Deterministic tie-break sort — exact copy from sort-results.js (benchmarking only).
// Removes RRF score noise that can swap adjacent ranks between identical runs.
function stableSortResults(results) {
  return results.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const sfA = a.payload?.source_file ?? '';
    const sfB = b.payload?.source_file ?? '';
    if (sfA !== sfB) return sfA < sfB ? -1 : 1;
    const ciA = a.payload?.chunk_index ?? 0;
    const ciB = b.payload?.chunk_index ?? 0;
    if (ciA !== ciB) return ciA - ciB;
    const idA = String(a.id ?? '');
    const idB = String(b.id ?? '');
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  });
}

async function runQuery(collection, profile, queryText) {
  const t0 = Date.now();
  const { dense, sparse } = await embedForSearch(profile, queryText);
  const results = stableSortResults(await hybridSearch(collection, dense, sparse, TOP_K));
  return { results, latencyMs: Date.now() - t0 };
}

// ── Metric helpers (exact copies from run-v3.js) ──────────────────────────────

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

function idealDCG(qrels, k) {
  const gains = [...qrels.values()].map(rel => Math.pow(2, rel) - 1).sort((a, b) => b - a);
  let idcg = 0;
  for (let i = 0; i < Math.min(gains.length, k); i++) {
    idcg += gains[i] / Math.log2(i + 2);
  }
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
  const relevantIds = new Set([...qrels.entries()].filter(([, r]) => r >= minRel).map(([id]) => id));
  if (!relevantIds.size) return null;
  return results.slice(0, k).some(r => relevantIds.has(resultChunkId(r)));
}

function mrrAt(results, qrels, k, minRel = 3) {
  if (!qrels.size) return null;
  const relevantIds = new Set([...qrels.entries()].filter(([, r]) => r >= minRel).map(([id]) => id));
  if (!relevantIds.size) return null;
  for (let i = 0; i < Math.min(results.length, k); i++) {
    if (relevantIds.has(resultChunkId(results[i]))) return 1 / (i + 1);
  }
  return 0;
}

function windowRecallHit(results, qrels, k, window) {
  if (!qrels.size) return null;
  const exactIds = [...qrels.entries()].filter(([, r]) => r >= 3).map(([id]) => id);
  if (!exactIds.length) return null;
  const topK = results.slice(0, k);
  const directHit = topK.some(r => {
    const cid = resultChunkId(r);
    return cid && qrels.get(cid) >= 3;
  });
  if (directHit) return true;
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

function supportRecall(results, qrels, k) {
  return chunkRecallHit(results, qrels, k, 2);
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

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p / 100) - 1)];
}

// Build qrel Map from legacy relevantChunks array.
function buildLegacyQrels(relevantChunks) {
  const map = new Map();
  for (const rc of (relevantChunks ?? [])) map.set(rc.chunkId, rc.relevance ?? 3);
  return map;
}

function tokenise(str) {
  return (str ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

// ── Aggregate metrics for one candidate ───────────────────────────────────────

function computeAggregateMetrics(qResults, qrelsFn, latenciesFn) {
  // qResults: array of { query, results, qrels }
  const positives = qResults.filter(r => !r.query.shouldHaveNoStrongHit);
  const negatives = qResults.filter(r =>  r.query.shouldHaveNoStrongHit);

  let cr3=0, cr5=0, cr10=0, wr5=0, wr10=0, suppK=0;
  let ndcgSum=0, mrrSum=0, mrrCount=0;
  let negPass=0;

  let hasExact = 0, hasAnyQrels = 0;

  for (const r of positives) {
    const qrels = r.qrels;
    if (!qrels.size) continue;
    hasAnyQrels++;
    const hasExact3 = [...qrels.values()].some(v => v >= 3);
    if (hasExact3) hasExact++;

    const cr3h  = chunkRecallHit(r.results, qrels, 3,      3);
    const cr5h  = chunkRecallHit(r.results, qrels, 5,      3);
    const cr10h = chunkRecallHit(r.results, qrels, TOP_K,  3);
    const wr5h  = windowRecallHit(r.results, qrels, 5,  BENCH_WINDOW);
    const wr10h = windowRecallHit(r.results, qrels, TOP_K, BENCH_WINDOW);
    const suppH = supportRecall(r.results, qrels, TOP_K);
    const ndcgV = gradedNDCG(r.results, qrels, TOP_K);
    const mrrV  = mrrAt(r.results, qrels, 10, 3);

    if (cr3h  !== null && hasExact3) cr3  += cr3h  ? 1 : 0;
    if (cr5h  !== null && hasExact3) cr5  += cr5h  ? 1 : 0;
    if (cr10h !== null && hasExact3) cr10 += cr10h ? 1 : 0;
    if (wr5h  !== null && hasExact3) wr5  += wr5h  ? 1 : 0;
    if (wr10h !== null && hasExact3) wr10 += wr10h ? 1 : 0;
    if (suppH !== null) suppK += suppH ? 1 : 0;
    if (ndcgV !== null) ndcgSum += ndcgV;
    if (mrrV  !== null) { mrrSum += mrrV; mrrCount++; }
  }

  for (const r of negatives) {
    if (!r.results.length) { negPass++; continue; }
    const top1Words = new Set([
      ...tokenise(r.results[0].payload?.text    ?? ''),
      ...tokenise(r.results[0].payload?.section ?? ''),
    ]);
    const expectedTokens = r.query.expectedTokens ?? [];
    const strongHit = expectedTokens.some(t => top1Words.has(t));
    if (!strongHit) negPass++;
  }

  const lats = qResults.map(r => r.latencyMs).filter(Number.isFinite);

  return {
    chunkRecall3:    hasExact > 0    ? cr3  / hasExact : null,
    chunkRecall5:    hasExact > 0    ? cr5  / hasExact : null,
    chunkRecall10:   hasExact > 0    ? cr10 / hasExact : null,
    windowRecall5:   hasExact > 0    ? wr5  / hasExact : null,
    windowRecall10:  hasExact > 0    ? wr10 / hasExact : null,
    supportRecallK:  hasAnyQrels > 0 ? suppK / hasAnyQrels : null,
    ndcgK:           hasAnyQrels > 0 ? ndcgSum / hasAnyQrels : null,
    mrr10:           mrrCount > 0    ? mrrSum / mrrCount : null,
    negativePassRate: negatives.length > 0 ? negPass / negatives.length : null,
    p50: percentile(lats, 50),
    p95: percentile(lats, 95),
    nPositive: positives.length,
    nNegative: negatives.length,
  };
}

// ── Per-query delta table ─────────────────────────────────────────────────────

function classifyDelta(legMRR, skelMRR, legCR5, skelCR5, overlayApplied = false) {
  // HARD_REGR: chunkRecall@5 drops (legacy hit, skeleton miss).
  if (legCR5 === true && skelCR5 === false) {
    // If the overlay was applied and we still miss, it's a genuine regression.
    // But if the overlay was applied and we now hit, that is QREL_DRIFT_FIXED.
    return 'HARD_REGR';
  }
  // QREL_DRIFT_FIXED: overlay was applied and skeleton hits (legacy appeared to miss but was qrel drift).
  if (overlayApplied && skelCR5 === true) return 'QREL_DRIFT_FIXED';
  // IMPR: MRR or cR@5 improves.
  if (
    (skelCR5 === true && legCR5 !== true) ||
    (typeof skelMRR === 'number' && typeof legMRR === 'number' && skelMRR - legMRR > 0.1)
  ) return 'IMPR';
  // SOFT_REGR: same recall but MRR or nDCG worse by >0.1.
  if (typeof skelMRR === 'number' && typeof legMRR === 'number' && legMRR - skelMRR > 0.1) return 'SOFT_REGR';
  return 'UNCHANGED';
}

function buildDeltaRows(legacyQResults, skeletonQResults, querySkeletonQrels) {
  const rows = [];
  for (let i = 0; i < legacyQResults.length; i++) {
    const lr = legacyQResults[i];
    const sr = skeletonQResults[i];
    if (lr.query.shouldHaveNoStrongHit) continue;

    const overlayApplied = querySkeletonQrels[i]?.overlayApplied ?? false;

    const legMRR  = mrrAt(lr.results, lr.qrels, 10, 3);
    const skelMRR = mrrAt(sr.results, sr.qrels, 10, 3);
    const legCR5  = chunkRecallHit(lr.results, lr.qrels, 5, 3);
    const skelCR5 = chunkRecallHit(sr.results, sr.qrels, 5, 3);
    const delta   = classifyDelta(legMRR, skelMRR, legCR5, skelCR5, overlayApplied);

    rows.push({
      id:      lr.query.id,
      query:   lr.query.query,
      legMRR:  legMRR,
      skelMRR: skelMRR,
      legCR5:  legCR5,
      skelCR5: skelCR5,
      delta,
      overlayApplied,
      legResults:  lr.results,
      skelResults: sr.results,
      legQrels:    lr.qrels,
      skelQrels:   sr.qrels,
    });
  }
  return rows;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function today() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
}

function pct(v, dec=1) { return v == null ? 'n/a' : `${(v * 100).toFixed(dec)}%`; }
function f3(v)         { return v == null ? 'n/a' : v.toFixed(3); }
function pad(s, n)     { return String(s).padEnd(n); }
function lpad(s, n)    { return String(s).padStart(n); }

function deltaSign(d) { return d >= 0 ? '+' : ''; }
function deltaStr(l, s) {
  if (l == null || s == null) return 'n/a';
  const d = s - l;
  return `${deltaSign(d)}${(d * 100).toFixed(1)}%`;
}
function deltaF3(l, s) {
  if (l == null || s == null) return 'n/a';
  const d = s - l;
  return `${deltaSign(d)}${d.toFixed(3)}`;
}

function resultLine(r, legReg, skelReg) {
  const cid = resultChunkId(r);
  const sf  = r.payload?.source_file ?? '?';
  const ci  = r.payload?.chunk_index ?? '?';
  const sec = (r.payload?.section ?? '').slice(0, 30);
  const txt = (r.payload?.text ?? '').slice(0, 80).replace(/\n/g, ' ');
  return `    ${sf}#${ci} | ${sec.padEnd(30)} | ${txt}`;
}

// ── Report builder ────────────────────────────────────────────────────────────

function buildMarkdownReport({
  lm, sm, deltaRows, migrationReport,
  lStats, sStats, legacyWallMs, skelWallMs,
  legacyPhases, skelPhases,
  queries, legacyQResults, skeletonQResults,
  verdict, verdictJustification,
}) {
  const lines = [];
  const SEP  = '---';
  const today_ = today();

  // Report each collection's own recorded provider — both are forced to ONNX
  // above, but reporting PROFILE's own values (not a fresh env read) keeps
  // this accurate even if the two collections ever diverge or are reused
  // from a prior run with a different provider.
  const denseProvider  = PROFILE_LEGACY?.embedding?.dense?.provider ?? '(unresolved)';
  const sparseProvider = PROFILE_LEGACY?.embedding?.sparse?.provider ?? null;

  lines.push(`# custom-50 Skeleton vs Legacy Retrieval Benchmark`);
  lines.push('');
  lines.push(`**Date:** ${today_}`);
  lines.push(`**Provider:** ${denseProvider}/${sparseProvider} (ONNX_EMBED=1)`);
  lines.push(`**TOP_K:** ${TOP_K}   **BENCH_WINDOW:** ${BENCH_WINDOW}`);
  lines.push(`**Fixture files:** ${FIXTURE_FILES.length}   **Queries:** ${queries.length} (${queries.filter(q=>!q.shouldHaveNoStrongHit).length} positive, ${queries.filter(q=>q.shouldHaveNoStrongHit).length} negative)`);
  lines.push(`**Search mode:** hybrid (RRF), sequential — no interleaving`);
  lines.push('');
  lines.push(SEP);
  lines.push('');

  // ── 1. Chunk counts ──────────────────────────────────────────────────────────
  lines.push('## 1. Chunk Counts per File');
  lines.push('');
  lines.push('| File | Legacy | Skeleton | Delta |');
  lines.push('|------|--------|----------|-------|');
  for (const { name } of FIXTURE_FILES) {
    const l = lStats[name] ?? 0;
    const s = sStats[name] ?? 0;
    const d = s - l;
    lines.push(`| \`${name}\` | ${l} | ${s} | ${d >= 0 ? '+' : ''}${d} |`);
  }
  const totalL = Object.values(lStats).reduce((a,b)=>a+b,0);
  const totalS = Object.values(sStats).reduce((a,b)=>a+b,0);
  lines.push(`| **TOTAL** | **${totalL}** | **${totalS}** | **${deltaSign(totalS-totalL)}${totalS-totalL}** |`);
  lines.push('');

  // ── 2. Indexing wall time ────────────────────────────────────────────────────
  lines.push('## 2. Indexing Wall Time');
  lines.push('');
  if (BENCH_LLM && legacyPhases && skelPhases) {
    lines.push('| Phase | Legacy | Skeleton | Delta |');
    lines.push('|-------|--------|----------|-------|');
    const phases = [
      ['LLM',   legacyPhases.llmMs,   skelPhases.llmMs],
      ['Embed',  legacyPhases.embedMs,  skelPhases.embedMs],
      ['Upsert', legacyPhases.upsertMs, skelPhases.upsertMs],
      ['**Total**', legacyWallMs, skelWallMs],
    ];
    for (const [label, lv, sv] of phases) {
      const d = sv - lv;
      lines.push(`| ${label} | ${lv}ms | ${sv}ms | ${deltaSign(d)}${d}ms |`);
    }
  } else {
    lines.push(`| Candidate | Wall time |`);
    lines.push(`|-----------|-----------|`);
    lines.push(`| Legacy    | ${legacyWallMs}ms |`);
    lines.push(`| Skeleton  | ${skelWallMs}ms |`);
    lines.push(`| **Delta** | **${deltaSign(skelWallMs-legacyWallMs)}${skelWallMs-legacyWallMs}ms** |`);
  }
  lines.push('');

  // ── 3. Qrel migration ────────────────────────────────────────────────────────
  lines.push('## 3. Qrel Migration Summary');
  lines.push('');
  lines.push(`| Type | Count |`);
  lines.push(`|------|-------|`);
  lines.push(`| Total qrels | ${migrationReport.total} |`);
  lines.push(`| exact (>50% overlap) | ${migrationReport.exact} |`);
  lines.push(`| window (20-50% or adjacent combined) | ${migrationReport.window} |`);
  lines.push(`| missing (<20% overlap) | ${migrationReport.missing} |`);
  lines.push(`| ambiguous (multiple strong matches) | ${migrationReport.ambiguous} |`);
  lines.push(`| manual overlay (qrels.skeleton-v1.json) | ${migrationReport.overlay} / ${migrationReport.overlayTotal} |`);
  lines.push('');

  const missingDetails = migrationReport.details.filter(d => d.type === 'missing');
  const ambiguousDetails = migrationReport.details.filter(d => d.type === 'ambiguous');

  if (missingDetails.length > 0) {
    lines.push('### Missing qrels');
    lines.push('');
    lines.push('| Query | Legacy chunkId | Rel | Best overlap | Reason |');
    lines.push('|-------|---------------|-----|-------------|--------|');
    for (const d of missingDetails) {
      lines.push(`| ${d.query} | \`${d.legacyId}\` | ${d.relevance} | ${d.bestScore != null ? d.bestScore.toFixed(2) : 'n/a'} | ${d.reason ?? ''} |`);
    }
    lines.push('');
  }

  if (ambiguousDetails.length > 0) {
    lines.push('### Ambiguous qrels');
    lines.push('');
    lines.push('| Query | Legacy chunkId | Rel | Skeleton candidates | Best score |');
    lines.push('|-------|---------------|-----|---------------------|-----------|');
    for (const d of ambiguousDetails) {
      lines.push(`| ${d.query} | \`${d.legacyId}\` | ${d.relevance} | ${d.skeletonIds.join(', ')} | ${d.bestScore != null ? d.bestScore.toFixed(2) : 'n/a'} |`);
    }
    lines.push('');
  }

  // ── 4. Aggregate metrics ─────────────────────────────────────────────────────
  lines.push('## 4. Aggregate Metrics');
  lines.push('');
  lines.push('| Metric | Legacy | Skeleton | Delta |');
  lines.push('|--------|--------|----------|-------|');
  lines.push(`| chunkRecall@3 | ${pct(lm.chunkRecall3)} | ${pct(sm.chunkRecall3)} | ${deltaStr(lm.chunkRecall3, sm.chunkRecall3)} |`);
  lines.push(`| chunkRecall@5 | ${pct(lm.chunkRecall5)} | ${pct(sm.chunkRecall5)} | ${deltaStr(lm.chunkRecall5, sm.chunkRecall5)} |`);
  lines.push(`| chunkRecall@${TOP_K} | ${pct(lm.chunkRecall10)} | ${pct(sm.chunkRecall10)} | ${deltaStr(lm.chunkRecall10, sm.chunkRecall10)} |`);
  lines.push(`| windowRecall@5 (±${BENCH_WINDOW}) | ${pct(lm.windowRecall5)} | ${pct(sm.windowRecall5)} | ${deltaStr(lm.windowRecall5, sm.windowRecall5)} |`);
  lines.push(`| windowRecall@${TOP_K} (±${BENCH_WINDOW}) | ${pct(lm.windowRecall10)} | ${pct(sm.windowRecall10)} | ${deltaStr(lm.windowRecall10, sm.windowRecall10)} |`);
  lines.push(`| supportRecall@${TOP_K} | ${pct(lm.supportRecallK)} | ${pct(sm.supportRecallK)} | ${deltaStr(lm.supportRecallK, sm.supportRecallK)} |`);
  lines.push(`| nDCG@${TOP_K} | ${f3(lm.ndcgK)} | ${f3(sm.ndcgK)} | ${deltaF3(lm.ndcgK, sm.ndcgK)} |`);
  lines.push(`| MRR@10 | ${f3(lm.mrr10)} | ${f3(sm.mrr10)} | ${deltaF3(lm.mrr10, sm.mrr10)} |`);
  lines.push(`| negativePass | ${pct(lm.negativePassRate)} | ${pct(sm.negativePassRate)} | ${deltaStr(lm.negativePassRate, sm.negativePassRate)} |`);
  lines.push(`| p50 latency | ${lm.p50}ms | ${sm.p50}ms | ${deltaSign(sm.p50-lm.p50)}${sm.p50-lm.p50}ms |`);
  lines.push(`| p95 latency | ${lm.p95}ms | ${sm.p95}ms | ${deltaSign(sm.p95-lm.p95)}${sm.p95-lm.p95}ms |`);
  lines.push('');

  // ── 5. Per-query delta table ──────────────────────────────────────────────────
  const DELTA_ORDER = { HARD_REGR: 0, QREL_DRIFT_FIXED: 1, SOFT_REGR: 2, IMPR: 3, UNCHANGED: 4 };
  const sortedDeltaRows = deltaRows.slice().sort((a, b) => {
    const oa = DELTA_ORDER[a.delta] ?? 99;
    const ob = DELTA_ORDER[b.delta] ?? 99;
    if (oa !== ob) return oa - ob;
    return a.id.localeCompare(b.id);
  });

  lines.push('## 5. Per-Query Delta Table');
  lines.push('');
  lines.push('| ID | Legacy MRR | Skel MRR | Legacy cR@5 | Skel cR@5 | Delta class | Overlay | Query |');
  lines.push('|----|-----------|---------|------------|----------|-------------|---------|-------|');
  for (const r of sortedDeltaRows) {
    const lMRR  = r.legMRR  != null ? r.legMRR.toFixed(3)  : 'n/a';
    const sMRR  = r.skelMRR != null ? r.skelMRR.toFixed(3) : 'n/a';
    const lCR5  = r.legCR5  === null ? 'n/a' : (r.legCR5  ? '✓' : '✗');
    const sCR5  = r.skelCR5 === null ? 'n/a' : (r.skelCR5 ? '✓' : '✗');
    const q     = r.query.slice(0, 60);
    const ov    = r.overlayApplied ? 'yes' : '';
    lines.push(`| ${r.id} | ${lMRR} | ${sMRR} | ${lCR5} | ${sCR5} | ${r.delta} | ${ov} | ${q} |`);
  }
  lines.push('');

  // ── 6. Hard regression detail ─────────────────────────────────────────────────
  const hardRegrs = deltaRows.filter(r => r.delta === 'HARD_REGR');
  const driftFixed = deltaRows.filter(r => r.delta === 'QREL_DRIFT_FIXED');

  if (hardRegrs.length > 0 || driftFixed.length > 0) {
    lines.push('## 6. Regression / Overlay Detail');
    lines.push('');

    for (const r of hardRegrs) {
      lines.push(`### ${r.id}: ${r.query} — HARD_REGR`);
      lines.push('');
      lines.push('**Legacy top-5:**');
      lines.push('```');
      for (const res of r.legResults.slice(0, 5)) {
        const cid = resultChunkId(res);
        const rel = r.legQrels.get(cid) ?? 0;
        const sf  = res.payload?.source_file ?? '?';
        const ci  = res.payload?.chunk_index ?? '?';
        const sec = (res.payload?.section ?? '').slice(0, 30);
        const txt = (res.payload?.text ?? '').slice(0, 80).replace(/\n/g, ' ');
        lines.push(`  ${sf}#${ci} [rel=${rel}] | ${sec.padEnd(30)} | ${txt}`);
      }
      lines.push('```');
      lines.push('');
      lines.push('**Skeleton top-5:**');
      lines.push('```');
      for (const res of r.skelResults.slice(0, 5)) {
        const cid = resultChunkId(res);
        const rel = r.skelQrels.get(cid) ?? 0;
        const sf  = res.payload?.source_file ?? '?';
        const ci  = res.payload?.chunk_index ?? '?';
        const sec = (res.payload?.section ?? '').slice(0, 30);
        const txt = (res.payload?.text ?? '').slice(0, 80).replace(/\n/g, ' ');
        lines.push(`  ${sf}#${ci} [rel=${rel}] | ${sec.padEnd(30)} | ${txt}`);
      }
      lines.push('```');
      lines.push('');
    }

    if (driftFixed.length > 0) {
      lines.push('### Overlay-fixed (QREL_DRIFT_FIXED)');
      lines.push('');
      lines.push('These queries were previously classified as hard regressions due to qrel drift; the overlay corrected the skeleton qrel and skeleton now hits.');
      lines.push('');
      for (const r of driftFixed) {
        lines.push(`**${r.id}:** ${r.query}`);
        lines.push(`- Legacy MRR: ${r.legMRR != null ? r.legMRR.toFixed(3) : 'n/a'} → Skeleton MRR: ${r.skelMRR != null ? r.skelMRR.toFixed(3) : 'n/a'}`);
        lines.push(`- Legacy cR@5: ${r.legCR5 === null ? 'n/a' : (r.legCR5 ? '✓' : '✗')} → Skeleton cR@5: ${r.skelCR5 === null ? 'n/a' : (r.skelCR5 ? '✓' : '✗')}`);
        lines.push('');
      }
    }
  }

  // ── 7. Verdict ────────────────────────────────────────────────────────────────
  lines.push('## 7. Verdict');
  lines.push('');
  lines.push(`**${verdict}**`);
  lines.push('');
  lines.push(verdictJustification);
  lines.push('');

  return lines.join('\n');
}

// ── Verdict logic ─────────────────────────────────────────────────────────────

function computeVerdict(deltaRows, migrationReport) {
  const hardRegrs    = deltaRows.filter(r => r.delta === 'HARD_REGR').length;
  const softRegrs    = deltaRows.filter(r => r.delta === 'SOFT_REGR').length;
  const imprs        = deltaRows.filter(r => r.delta === 'IMPR').length;
  const driftFixed   = deltaRows.filter(r => r.delta === 'QREL_DRIFT_FIXED').length;
  const missing      = migrationReport.missing;
  const ambiguous    = migrationReport.ambiguous;
  const total        = migrationReport.total;
  const window_      = migrationReport.window;
  const exact        = migrationReport.exact;
  const overlayCount = migrationReport.overlay ?? 0;

  const missingFrac = total > 0 ? missing / total : 0;

  if (missingFrac > 0.3) {
    return {
      verdict: 'SKELETON_BLOCKED_BY_QREL_DRIFT',
      justification:
        `${missing}/${total} qrels (${(missingFrac*100).toFixed(1)}%) could not be mapped from legacy to skeleton ` +
        `(overlap <20%). Cannot confirm chunk-level metrics without reliable qrels. ` +
        `Hard regressions: ${hardRegrs}. Improvements: ${imprs}. Manual overlay: ${overlayCount}.`,
    };
  }

  if (hardRegrs > 0) {
    return {
      verdict: 'SKELETON_REJECT_RETRIEVAL_REGRESSION',
      justification:
        `${hardRegrs} hard regression(s) confirmed: queries where legacy cR@5=✓ but skeleton cR@5=✗. ` +
        `Soft regressions: ${softRegrs}. Improvements: ${imprs}. QREL_DRIFT_FIXED by overlay: ${driftFixed}. ` +
        `Qrel migration: ${exact} exact, ${window_} window, ${missing} missing, ${ambiguous} ambiguous, ${overlayCount} overlay.`,
    };
  }

  const hasQrelDrift = window_ > 0 || ambiguous > 0 || missing > 0 || overlayCount > 0;
  if (hasQrelDrift) {
    return {
      verdict: 'SKELETON_ACCEPT_WITH_QREL_MIGRATION',
      justification:
        `No hard regressions. Qrel drift resolved: ${exact} exact, ${window_} window, ` +
        `${missing} missing, ${ambiguous} ambiguous, ${overlayCount} manual overlay out of ${total} total. ` +
        `QREL_DRIFT_FIXED (overlay corrected): ${driftFixed}. ` +
        `Soft regressions (MRR worse by >0.1): ${softRegrs}. Improvements: ${imprs}.`,
    };
  }

  return {
    verdict: 'SKELETON_ACCEPT',
    justification:
      `No hard regressions. All ${total} qrels mapped exactly (no window/missing/ambiguous drift). ` +
      `Soft regressions: ${softRegrs}. Improvements: ${imprs}.`,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  process.stderr.write('=== custom-50 skeleton vs legacy REAL benchmark ===\n');
  process.stderr.write(`TOP_K=${TOP_K}  BENCH_WINDOW=${BENCH_WINDOW}  SKIP_INDEX=${SKIP_INDEX}\n\n`);

  const raw     = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  const queries = raw.queries.map(q => ({
    id:                    q.id,
    type:                  q.type ?? 'unknown',
    query:                 q.query,
    expectedFiles:         q.expectedFiles ?? [],
    relevantChunks:        q.relevantChunks ?? [],
    expectedTokens:        q.expectedTokens
      ? q.expectedTokens.flatMap(t => tokenise(t)).filter(Boolean)
      : null,
    shouldHaveNoStrongHit: q.shouldHaveNoStrongHit ?? false,
  }));

  let lStats = {}, sStats = {};
  let legacyWallMs = 0, skelWallMs = 0;
  let legacyPhases = null, skelPhases = null;
  let legacyRegistry = new Map();
  let skeletonRegistry = new Map();

  if (SKIP_INDEX) {
    process.stderr.write('[1/4] Skipping index (BENCH_SKIP_INDEX=1) — reading chunk data from Qdrant...\n');

    // Both collections are assumed to already exist (previously indexed run).
    // resolveBenchProfile reuses each collection's own recorded profile as-is
    // — required before the later search phase can call embedForSearch.
    PROFILE_LEGACY   = await resolveBenchProfile(storageAdapter, COLLECTION_LEGACY,   { vectorSize: VECTOR_SIZE });
    PROFILE_SKELETON = await resolveBenchProfile(storageAdapter, COLLECTION_SKELETON, { vectorSize: VECTOR_SIZE });

    for (const name of Object.keys(lStats)) lStats[name] = 0;
    const legPts = await scroll(COLLECTION_LEGACY, undefined, 5000, ['source_file', 'chunk_index', 'text', 'section']);
    for (const p of legPts) {
      const sf = p.payload?.source_file;
      const ci = p.payload?.chunk_index;
      if (sf && ci != null) {
        lStats[sf] = (lStats[sf] ?? 0) + 1;
        legacyRegistry.set(`${sf}#${ci}`, { text: p.payload?.text ?? '', section: p.payload?.section ?? '' });
      }
    }

    const skelPts = await scroll(COLLECTION_SKELETON, undefined, 5000, ['source_file', 'chunk_index', 'text', 'section']);
    for (const p of skelPts) {
      const sf = p.payload?.source_file;
      const ci = p.payload?.chunk_index;
      if (sf && ci != null) {
        sStats[sf] = (sStats[sf] ?? 0) + 1;
        skeletonRegistry.set(`${sf}#${ci}`, { text: p.payload?.text ?? '', section: p.payload?.section ?? '' });
      }
    }
  } else {
    process.stderr.write('[1/4] Setting up collections (delete + recreate)...\n');
    PROFILE_LEGACY   = await setupCollection(COLLECTION_LEGACY);
    PROFILE_SKELETON = await setupCollection(COLLECTION_SKELETON);

    process.stderr.write(`[2/4] Indexing legacy${BENCH_LLM ? ' (LLM+embed)' : ' (embed only)'}...\n`);
    const legResult  = await indexLegacy();
    lStats           = legResult.stats;
    legacyRegistry   = legResult.registry;
    legacyWallMs     = legResult.wallMs;
    legacyPhases     = { llmMs: legResult.llmMs, embedMs: legResult.embedMs, upsertMs: legResult.upsertMs };

    if (BENCH_LLM) {
      process.stderr.write(`  legacy phases — LLM: ${legResult.llmMs}ms  Embed: ${legResult.embedMs}ms  Upsert: ${legResult.upsertMs}ms  Total: ${legResult.wallMs}ms\n`);
    }

    process.stderr.write(`[3/4] Indexing skeleton${BENCH_LLM ? ' (LLM+embed)' : ' (embed only)'}...\n`);
    const skelResult = await indexSkeleton();
    sStats           = skelResult.stats;
    skeletonRegistry = skelResult.registry;
    skelWallMs       = skelResult.wallMs;
    skelPhases       = { llmMs: skelResult.llmMs, embedMs: skelResult.embedMs, upsertMs: skelResult.upsertMs };

    if (BENCH_LLM) {
      process.stderr.write(`  skeleton phases — LLM: ${skelResult.llmMs}ms  Embed: ${skelResult.embedMs}ms  Upsert: ${skelResult.upsertMs}ms  Total: ${skelResult.wallMs}ms\n`);
    }
  }

  process.stderr.write('\n[qrel] Running qrel migration...\n');
  const { querySkeletonQrels, migrationReport } = buildSkeletonQrels(queries, legacyRegistry, skeletonRegistry);

  process.stderr.write(`  exact=${migrationReport.exact}  window=${migrationReport.window}  ` +
    `missing=${migrationReport.missing}  ambiguous=${migrationReport.ambiguous}  overlay=${migrationReport.overlay}/${migrationReport.overlayTotal}\n`);

  if (migrationReport.missing > 0) {
    process.stderr.write('  Missing qrels:\n');
    for (const d of migrationReport.details.filter(x => x.type === 'missing')) {
      process.stderr.write(`    [${d.query}] ${d.legacyId} (rel=${d.relevance}) — ${d.reason ?? 'overlap<0.20'}\n`);
    }
  }
  if (migrationReport.ambiguous > 0) {
    process.stderr.write('  Ambiguous qrels:\n');
    for (const d of migrationReport.details.filter(x => x.type === 'ambiguous')) {
      process.stderr.write(`    [${d.query}] ${d.legacyId} → ${d.skeletonIds.join(', ')} (score=${d.bestScore?.toFixed(2)})\n`);
    }
  }

  // Build per-query results with appropriate qrels.
  const legacyQResults   = [];
  const skeletonQResults = [];

  // Pass 1: Legacy queries.
  process.stderr.write(`\n[4/4] Running ${queries.length} queries against legacy...\n`);
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    process.stderr.write(`  ${q.id}\r`);
    const { results, latencyMs } = await runQuery(COLLECTION_LEGACY, PROFILE_LEGACY, q.query);
    const legacyQrels = buildLegacyQrels(q.relevantChunks);
    legacyQResults.push({ query: q, results, latencyMs, qrels: legacyQrels });
  }
  process.stderr.write('\n');

  // Pass 2: Skeleton queries.
  process.stderr.write(`Running ${queries.length} queries against skeleton...\n`);
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    process.stderr.write(`  ${q.id}\r`);
    const { results, latencyMs } = await runQuery(COLLECTION_SKELETON, PROFILE_SKELETON, q.query);
    // Use migrated skeleton qrels.
    const sq = querySkeletonQrels[i];
    const skelQrels = sq ? sq.skeletonQrels : new Map();
    skeletonQResults.push({ query: q, results, latencyMs, qrels: skelQrels });
  }
  process.stderr.write('\n');

  // Compute aggregate metrics.
  const lm = computeAggregateMetrics(legacyQResults);
  const sm = computeAggregateMetrics(skeletonQResults);

  // Per-query delta table.
  const deltaRows = buildDeltaRows(legacyQResults, skeletonQResults, querySkeletonQrels);

  // Verdict.
  const { verdict, justification: verdictJustification } = computeVerdict(deltaRows, migrationReport);

  // Print console summary.
  process.stderr.write('\n=== AGGREGATE METRICS ===\n');
  process.stderr.write(`${'Metric'.padEnd(22)} ${'Legacy'.padStart(8)} ${'Skeleton'.padStart(10)} ${'Delta'.padStart(10)}\n`);
  process.stderr.write(`${'-'.repeat(55)}\n`);
  const metrics = [
    ['chunkRecall@3',   lm.chunkRecall3,   sm.chunkRecall3,   'pct'],
    ['chunkRecall@5',   lm.chunkRecall5,   sm.chunkRecall5,   'pct'],
    [`chunkRecall@${TOP_K}`, lm.chunkRecall10, sm.chunkRecall10, 'pct'],
    [`windowRecall@5`,  lm.windowRecall5,  sm.windowRecall5,  'pct'],
    [`windowRecall@${TOP_K}`,lm.windowRecall10,sm.windowRecall10,'pct'],
    [`supportRecall@${TOP_K}`,lm.supportRecallK,sm.supportRecallK,'pct'],
    [`nDCG@${TOP_K}`,   lm.ndcgK,          sm.ndcgK,          'f3'],
    ['MRR@10',          lm.mrr10,          sm.mrr10,          'f3'],
    ['negativePass',    lm.negativePassRate,sm.negativePassRate,'pct'],
    ['p50 latency',     lm.p50,            sm.p50,            'ms'],
    ['p95 latency',     lm.p95,            sm.p95,            'ms'],
  ];
  for (const [name, lv, sv, fmt] of metrics) {
    let ls, ss, ds;
    if (fmt === 'pct') { ls = pct(lv); ss = pct(sv); ds = deltaStr(lv, sv); }
    else if (fmt === 'f3') { ls = f3(lv); ss = f3(sv); ds = deltaF3(lv, sv); }
    else { ls = `${lv}ms`; ss = `${sv}ms`; ds = `${deltaSign(sv-lv)}${sv-lv}ms`; }
    process.stderr.write(`${name.padEnd(22)} ${ls.padStart(8)} ${ss.padStart(10)} ${ds.padStart(10)}\n`);
  }

  const hardRegrs  = deltaRows.filter(r => r.delta === 'HARD_REGR');
  const softRegrs  = deltaRows.filter(r => r.delta === 'SOFT_REGR');
  const imprs      = deltaRows.filter(r => r.delta === 'IMPR');
  const driftFixed = deltaRows.filter(r => r.delta === 'QREL_DRIFT_FIXED');
  process.stderr.write(`\nHard regressions: ${hardRegrs.length}   Soft regressions: ${softRegrs.length}   Improvements: ${imprs.length}   QREL_DRIFT_FIXED: ${driftFixed.length}\n`);

  process.stderr.write(`\n=== VERDICT: ${verdict} ===\n`);
  process.stderr.write(verdictJustification + '\n\n');

  // Build and write the Markdown report.
  const report = buildMarkdownReport({
    lm, sm, deltaRows, migrationReport,
    lStats, sStats, legacyWallMs, skelWallMs,
    legacyPhases, skelPhases,
    queries, legacyQResults, skeletonQResults,
    verdict, verdictJustification,
  });

  mkdirSync(RESULTS_DIR, { recursive: true });
  const suffix  = BENCH_LLM ? '-llm' : '-qrel-overlay';
  const outPath = resolve(RESULTS_DIR, `${today()}-custom50-skeleton-vs-legacy${suffix}.md`);
  writeFileSync(outPath, report, 'utf8');
  process.stderr.write(`Saved → ${outPath}\n`);

  // Also print report to stdout.
  process.stdout.write(report + '\n');
}

main().catch(err => { console.error(err); process.exit(1); });
