// Threshold sweep for custom-50 search diagnostics.
//
// DIAGNOSTICS EXPERIMENT — does not change any runtime or MCP behavior.
//
// Context: diagnostics v1 found that SPREAD_THRESHOLD=0.05 is too high for
// custom-50 — topScoreSpread has max ~0.017, so low-spread fires on 100% of
// queries and is useless as a trigger. This script sweeps a range of thresholds
// to find values where the trigger is discriminative (FPR << 100%, missRecall > 0).
//
// Approach:
//   1. Run all queries once: embed + top-5 hybrid search + recovery checks.
//   2. For each threshold in SPREAD_THRESHOLDS, re-evaluate triggers in-memory
//      (no repeated Qdrant calls per threshold).
//   3. Also sweep combined trigger: low-diversity OR low-spread (no-tech-token
//      excluded — it gave 0% trigger rate in v1 and adds no signal here).
//
// Recovery checks are computed unconditionally per query (not just for triggered
// queries) so every threshold level can query recovery potential accurately.
// Recovery metrics are reported only for triggered MISSES (isMiss=true).
//
// Usage:
//   npm run bench:custom50:sweep
//   BENCH_SKIP_INDEX=1 npm run bench:custom50:sweep
//   BENCH_WINDOW=2 npm run bench:custom50:sweep

if (process.argv.includes('--help')) {
  process.stdout.write(`custom-50 threshold sweep for low-spread trigger (experiment — no runtime changes)

Usage:
  npm run bench:custom50:sweep
  BENCH_SKIP_INDEX=1 npm run bench:custom50:sweep

Options (env vars):
  BENCH_SKIP_INDEX=1   Reuse existing bench-retrieval-custom-50 collection
  BENCH_WINDOW=1       Adjacency window for window neighbor check (default: 1)

Note: ONNX (bge-m3-onnx) is forced unconditionally. RRF_K and HYBRID_PREFETCH_LIMIT
must be unset or at their defaults (60/2) — the script exits with an error otherwise.

Output: benchmarks/retrieval/results/YYYY-MM-DD-custom50-threshold-sweep.txt
`);
  process.exit(0);
}

import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
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
import { rerankResults } from '../../../src/core/rerank.js';

const __dirname       = dirname(fileURLToPath(import.meta.url));
const FIXTURES_SHARED = resolve(__dirname, '../fixtures/docs');
const FIXTURES_OWN    = resolve(__dirname, 'fixtures/docs');
const QUERIES_PATH    = resolve(__dirname, 'queries.json');
const RESULTS         = resolve(__dirname, '../results');

const COLLECTION   = 'bench-retrieval-custom-50';
const SKIP_INDEX   = process.env.BENCH_SKIP_INDEX === '1';
const BENCH_WINDOW = parseInt(process.env.BENCH_WINDOW ?? '1', 10);

// Thresholds to sweep for the low-spread trigger.
// Chosen to cover the actual topScoreSpread distribution observed in v1:
// min=0.001, p25=0.002, p50=0.002, p75=0.003, max=0.017.
const SPREAD_THRESHOLDS = [0.001, 0.002, 0.003, 0.005, 0.008, 0.01, 0.015, 0.02];

const _rrfK     = process.env.RRF_K;
const _prefetch = process.env.HYBRID_PREFETCH_LIMIT;
if ((_rrfK !== undefined && _rrfK !== '60') || (_prefetch !== undefined && _prefetch !== '2')) {
  process.stderr.write(
    `\nError: RRF_K=${_rrfK ?? '(unset)'} HYBRID_PREFETCH_LIMIT=${_prefetch ?? '(unset)'}\n` +
    `threshold-sweep.js requires default values (RRF_K=60, HYBRID_PREFETCH_LIMIT=2).\n` +
    `Unset the variables before running:\n` +
    `  Remove-Item Env:RRF_K, Env:HYBRID_PREFETCH_LIMIT   # PowerShell\n` +
    `  unset RRF_K HYBRID_PREFETCH_LIMIT                  # bash\n`
  );
  process.exit(1);
}

process.env.ONNX_EMBED = '1';
delete process.env.DENSE_PROVIDER;
delete process.env.SPARSE_PROVIDER;

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function pad(s, n)  { return String(s).padEnd(n); }
function lpad(s, n) { return String(s).padStart(n); }
function pct(v, d = 1) { return v == null ? 'n/a' : `${(v * 100).toFixed(d)}%`; }
function f4(v) { return v == null ? 'n/a' : v.toFixed(4); }

function today() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

function parseChunkId(id) {
  if (!id) return null;
  const h = id.lastIndexOf('#');
  if (h < 0) return null;
  const sf = id.slice(0, h);
  const ci = parseInt(id.slice(h + 1), 10);
  if (!sf || !Number.isFinite(ci)) return null;
  return { sourceFile: sf, chunkIndex: ci };
}

function resultChunkId(r) {
  const sf = r.payload?.source_file;
  const ci = r.payload?.chunk_index;
  if (!sf || ci == null) return null;
  return `${sf}#${ci}`;
}

// ── Indexing ──────────────────────────────────────────────────────────────────

async function ensureCollection() {
  const cols = await listCollections();
  if (!cols.includes(COLLECTION)) await createCollection(COLLECTION, 1024);
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
  const pts = await scroll(COLLECTION, undefined, 1, ['dense_provider', 'sparse_provider']);
  const p = pts[0]?.payload;
  if (!p) return null;
  return { denseProvider: p.dense_provider ?? null, sparseProvider: p.sparse_provider ?? null };
}

async function indexFixtures() {
  for (const { name, dir } of FIXTURE_FILES) {
    const filePath = resolve(dir, name);
    const text     = readFileSync(filePath, 'utf8');
    await deleteBySourceFile(COLLECTION, name);
    const chunks = chunkFile(filePath, text, name);
    const points = [];
    for (const chunk of chunks) {
      const { dense, sparse, meta } = await embedForIndex(COLLECTION, chunk.text);
      points.push({
        id: randomUUID(),
        vector: { dense, sparse },
        payload: {
          text: chunk.text, section: chunk.section,
          source_file: name, chunk_index: chunk.chunkIndex,
          total_chunks: chunk.totalChunks, file_hash: 'bench-sweep',
          vector_size: 1024, ...meta,
        },
      });
    }
    await upsertPoints(COLLECTION, points);
    process.stderr.write(`  indexed ${name} (${points.length} chunks)\n`);
  }
}

// ── Per-query data collection ─────────────────────────────────────────────────

// Compute signals from top-5 results (no qrel access for observable signals).
function computeSignals(top5) {
  const scores = top5.map(r => r.score ?? 0);
  const s1 = scores[0] ?? 0;
  const s5 = scores[scores.length - 1] ?? 0;

  const sources = top5.map(r => r.payload?.source_file).filter(Boolean);
  const top1Source      = sources[0];
  const top1SourceCount = sources.filter(s => s === top1Source).length;

  return {
    topScoreSpread:    s1 - s5,
    topScoreRatio:     s5 === 0 ? null : s1 / s5,
    sourceDiversity:   new Set(sources).size,
    duplicateSourceRate: top1Source ? top1SourceCount / top5.length : 0,
    top1SourceRepeated:  top1SourceCount >= 3,
  };
}

// Compute eval-only labels (require qrels).
function computeEvalLabels(top5, exactIds) {
  const resultIds = top5.map(resultChunkId);
  const isMiss = !resultIds.some(id => id && exactIds.has(id));

  let hasNeighborCandidate = false;
  for (const exactId of exactIds) {
    const ep = parseChunkId(exactId);
    if (!ep) continue;
    if (top5.some(r => {
      const rp = parseChunkId(resultChunkId(r));
      if (!rp) return false;
      return rp.sourceFile === ep.sourceFile && Math.abs(rp.chunkIndex - ep.chunkIndex) <= BENCH_WINDOW;
    })) { hasNeighborCandidate = true; break; }
  }

  return { isMiss, hasNeighborCandidate };
}

// Compute recovery outcomes.
// Window recovery: simulate qdrant_get_chunk(window=N) called on a returned top-5
// chunk that is already a neighbor of an exact chunk — not on the exact chunk itself.
async function computeRecovery(vectors, queryText, exactIds, top5) {
  const top10 = await hybridSearch(COLLECTION, vectors.dense, vectors.sparse, 10);
  const recoversAtTop10 = top10.some(r => exactIds.has(resultChunkId(r)));

  const candidates    = await hybridSearch(COLLECTION, vectors.dense, vectors.sparse, 40);
  const reranked      = rerankResults(candidates, queryText, { finalLimit: 10, collection: COLLECTION });
  const recoversAtRerank = reranked.some(r => exactIds.has(resultChunkId(r)));

  let recoversAtWindow = false;
  for (const r5 of top5) {
    const rp = parseChunkId(resultChunkId(r5));
    if (!rp) continue;
    let isNeighbor = false;
    for (const exactId of exactIds) {
      const ep = parseChunkId(exactId);
      if (!ep) continue;
      if (ep.sourceFile === rp.sourceFile && Math.abs(ep.chunkIndex - rp.chunkIndex) <= BENCH_WINDOW) {
        isNeighbor = true; break;
      }
    }
    if (!isNeighbor) continue;
    const allChunks = await scroll(
      COLLECTION,
      { must: [{ key: 'source_file', match: { value: rp.sourceFile } }] },
      500
    );
    const from = Math.max(0, rp.chunkIndex - BENCH_WINDOW);
    const to   = rp.chunkIndex + BENCH_WINDOW;
    if (allChunks.some(p => {
      const ci = p.payload?.chunk_index;
      const sf = p.payload?.source_file;
      return sf === rp.sourceFile && ci != null && ci >= from && ci <= to && exactIds.has(`${sf}#${ci}`);
    })) { recoversAtWindow = true; break; }
  }

  return { recoversAtTop10, recoversAtRerank, recoversAtWindow };
}

async function collectQuery(q) {
  const qrels    = q.relevantChunks ?? [];
  const exactIds = new Set(qrels.filter(rc => rc.relevance >= 3).map(rc => rc.chunkId));

  const vectors = await embedForSearch(COLLECTION, q.query);
  const top5    = await hybridSearch(COLLECTION, vectors.dense, vectors.sparse, 5);

  const signals    = computeSignals(top5);
  const evalLabels = computeEvalLabels(top5, exactIds);

  // Compute recovery unconditionally — the sweep evaluates every threshold level,
  // so we cannot know in advance which queries will be "triggered".
  // For negative queries (no exactIds) recovery is meaningless; skip it.
  const recovery = exactIds.size > 0
    ? await computeRecovery(vectors, q.query, exactIds, top5)
    : null;

  return {
    id:         q.id,
    type:       q.type,
    isNegative: q.shouldHaveNoStrongHit ?? false,
    hasExactQrels: exactIds.size > 0,
    signals,
    evalLabels,
    recovery,
  };
}

// ── Trigger evaluation at a given threshold ───────────────────────────────────

// Evaluate one (trigger-fn, positive-queries) pair and return metrics.
// triggerFn: (signals) => boolean — must not access evalLabels fields.
function evalTrigger(triggerFn, positive) {
  const misses = positive.filter(r => r.evalLabels.isMiss);
  const hits   = positive.filter(r => !r.evalLabels.isMiss);

  const triggered        = positive.filter(r => triggerFn(r.signals));
  const triggeredMisses  = misses.filter(r => triggerFn(r.signals));
  const triggeredHits    = hits.filter(r => triggerFn(r.signals));

  // Recovery: triggered misses that have recovery data (all should, by construction).
  const trigMissWithRecov = triggeredMisses.filter(r => r.recovery !== null);

  const triggerRate  = triggered.length / positive.length;
  const missRecall   = misses.length > 0 ? triggeredMisses.length / misses.length : null;
  const precision    = triggered.length > 0 ? triggeredMisses.length / triggered.length : null;
  const fpr          = hits.length > 0 ? triggeredHits.length / hits.length : null;

  const recov10     = trigMissWithRecov.length > 0
    ? trigMissWithRecov.filter(r => r.recovery.recoversAtTop10).length / trigMissWithRecov.length
    : null;
  const recovRerank = trigMissWithRecov.length > 0
    ? trigMissWithRecov.filter(r => r.recovery.recoversAtRerank).length / trigMissWithRecov.length
    : null;
  const recovWindow = trigMissWithRecov.length > 0
    ? trigMissWithRecov.filter(r => r.recovery.recoversAtWindow).length / trigMissWithRecov.length
    : null;

  return {
    triggerRate, missRecall, precision, fpr,
    recov10, recovRerank, recovWindow,
    triggeredCount: triggered.length,
    caughtMisses:   triggeredMisses.length,
    falsePositives: triggeredHits.length,
    totalMisses:    misses.length,
    totalHits:      hits.length,
    totalPositive:  positive.length,
  };
}

// ── Report ────────────────────────────────────────────────────────────────────

function buildReport(queryData) {
  const lines = [];
  const SEP  = '═'.repeat(110);
  const SEP2 = '─'.repeat(110);

  const positive = queryData.filter(r => r.hasExactQrels && !r.isNegative);
  const misses   = positive.filter(r => r.evalLabels.isMiss);

  lines.push(SEP);
  lines.push('  custom-50 threshold sweep — low-spread and combined trigger');
  lines.push('  EXPERIMENT — does not change runtime or MCP behavior');
  lines.push(`  Provider : onnx (bge-m3-onnx/bge-m3-onnx), hybrid RRF`);
  lines.push(`  Queries  : ${positive.length} positive (rel≥3) + ${queryData.filter(r => r.isNegative).length} negative`);
  lines.push(`  Misses   : ${misses.length} (top-5 baseline)`);
  lines.push(`  Window   : ±${BENCH_WINDOW}`);
  lines.push('');
  lines.push('  Thresholds swept: ' + SPREAD_THRESHOLDS.join(', '));
  lines.push('');
  lines.push('  SPREAD_THRESHOLD=0.05 (diagnostics v1 default) fired on 100% of queries because');
  lines.push('  topScoreSpread max is ~0.017 for this corpus. Thresholds must be set below the');
  lines.push('  observed spread distribution to be discriminative.');
  lines.push(SEP);
  lines.push('');

  // ── topScoreSpread distribution ───────────────────────────────────────────
  const spreads = positive.map(r => r.signals.topScoreSpread).sort((a, b) => a - b);
  const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  lines.push('topScoreSpread distribution (positive queries):');
  lines.push(SEP2);
  lines.push(`  n=${spreads.length}  mean=${f4(mean)}  min=${f4(spreads[0])}  p10=${f4(spreads[Math.floor(spreads.length*0.10)])}  p25=${f4(spreads[Math.floor(spreads.length*0.25)])}  p50=${f4(spreads[Math.floor(spreads.length*0.50)])}  p75=${f4(spreads[Math.floor(spreads.length*0.75)])}  p90=${f4(spreads[Math.floor(spreads.length*0.90)])}  max=${f4(spreads[spreads.length-1])}`);
  lines.push('');

  // Miss vs hit spread
  const mSpreads = misses.map(r => r.signals.topScoreSpread).sort((a, b) => a - b);
  const hSpreads = positive.filter(r => !r.evalLabels.isMiss).map(r => r.signals.topScoreSpread).sort((a, b) => a - b);
  const mMean = mSpreads.length ? mSpreads.reduce((a,b)=>a+b,0)/mSpreads.length : null;
  const hMean = hSpreads.length ? hSpreads.reduce((a,b)=>a+b,0)/hSpreads.length : null;
  lines.push(`  miss spread  : mean=${f4(mMean)}  min=${f4(mSpreads[0])}  max=${f4(mSpreads[mSpreads.length-1])}`);
  lines.push(`  hit  spread  : mean=${f4(hMean)}  min=${f4(hSpreads[0])}  max=${f4(hSpreads[hSpreads.length-1])}`);
  lines.push('');

  // sourceDiversity distribution
  const divs = positive.map(r => r.signals.sourceDiversity).sort((a, b) => a - b);
  const divCounts = [1,2,3,4,5].map(d => `${d}:${divs.filter(v=>v===d).length}`).join('  ');
  const lowDivCount = divs.filter(v => v < 2).length;
  lines.push('sourceDiversity distribution (positive queries):');
  lines.push(SEP2);
  lines.push(`  counts: ${divCounts}   (sourceDiversity<2: ${lowDivCount}/${positive.length})`);
  lines.push('');

  // ── Section 1: low-spread sweep ───────────────────────────────────────────
  const HDR_W = [8, 10, 12, 10, 8, 10, 14, 11, 14, 12, 14];
  const HDRS  = ['thresh', 'trigRate', 'missRecall', 'precision', 'FPR', 'recov@10', 'recov@rerank', 'recov@win', 'triggered', 'caught', 'falsePos'];
  const rowSep = '─'.repeat(HDR_W.reduce((a,b)=>a+b+2, 0));

  function tableRow(cells) {
    return cells.map((c, i) => lpad(String(c), HDR_W[i])).join('  ');
  }

  lines.push('Section 1 — low-spread sweep (sourceDiversity unrestricted):');
  lines.push(SEP2);
  lines.push(tableRow(HDRS));
  lines.push(rowSep);

  for (const t of SPREAD_THRESHOLDS) {
    const m = evalTrigger(sig => sig.topScoreSpread < t, positive);
    lines.push(tableRow([
      f4(t),
      pct(m.triggerRate),
      pct(m.missRecall),
      pct(m.precision),
      pct(m.fpr),
      m.recov10   != null ? pct(m.recov10)    : '—',
      m.recovRerank != null ? pct(m.recovRerank) : '—',
      m.recovWindow != null ? pct(m.recovWindow) : '—',
      m.triggeredCount,
      m.caughtMisses,
      m.falsePositives,
    ]));
  }
  lines.push(rowSep);
  lines.push('');

  // ── Section 2: combined sweep (low-diversity OR low-spread) ───────────────
  lines.push('Section 2 — combined sweep (low-diversity OR low-spread):');
  lines.push('  "low-diversity" = sourceDiversity < 2 (fixed conservative threshold)');
  lines.push('  "low-spread"    = topScoreSpread < threshold (swept)');
  lines.push(SEP2);
  lines.push(tableRow(HDRS));
  lines.push(rowSep);

  for (const t of SPREAD_THRESHOLDS) {
    const m = evalTrigger(
      sig => sig.sourceDiversity < 2 || sig.topScoreSpread < t,
      positive
    );
    lines.push(tableRow([
      f4(t),
      pct(m.triggerRate),
      pct(m.missRecall),
      pct(m.precision),
      pct(m.fpr),
      m.recov10   != null ? pct(m.recov10)    : '—',
      m.recovRerank != null ? pct(m.recovRerank) : '—',
      m.recovWindow != null ? pct(m.recovWindow) : '—',
      m.triggeredCount,
      m.caughtMisses,
      m.falsePositives,
    ]));
  }
  lines.push(rowSep);
  lines.push('');

  // ── Section 3: low-diversity alone (fixed, no sweep) ─────────────────────
  lines.push('Section 3 — low-diversity alone (sourceDiversity < 2, no threshold):');
  lines.push(SEP2);
  const mDiv = evalTrigger(sig => sig.sourceDiversity < 2, positive);
  lines.push(`  triggerRate=${pct(mDiv.triggerRate)}  missRecall=${pct(mDiv.missRecall)}  precision=${pct(mDiv.precision)}  FPR=${pct(mDiv.fpr)}`);
  lines.push(`  recov@10=${mDiv.recov10 != null ? pct(mDiv.recov10) : '—'}  recov@rerank=${mDiv.recovRerank != null ? pct(mDiv.recovRerank) : '—'}  recov@window=${mDiv.recovWindow != null ? pct(mDiv.recovWindow) : '—'}`);
  lines.push(`  triggered=${mDiv.triggeredCount}  caught=${mDiv.caughtMisses}  falsePos=${mDiv.falsePositives}  totalMisses=${mDiv.totalMisses}`);
  lines.push('');

  // ── Per-query spread values (sorted) ─────────────────────────────────────
  lines.push('Per-query topScoreSpread (sorted ascending, eval labels shown):');
  lines.push(SEP2);
  const sorted = [...positive].sort((a, b) => a.signals.topScoreSpread - b.signals.topScoreSpread);
  lines.push(pad('ID', 5) + '  ' + lpad('spread', 8) + '  ' + lpad('srcDiv', 6) + '  ' + lpad('isMiss', 6) + '  ' + lpad('hasNbr', 6));
  lines.push(SEP2);
  for (const r of sorted) {
    lines.push(
      pad(r.id, 5) + '  ' +
      lpad(f4(r.signals.topScoreSpread), 8) + '  ' +
      lpad(String(r.signals.sourceDiversity), 6) + '  ' +
      lpad(r.evalLabels.isMiss ? 'MISS' : 'hit', 6) + '  ' +
      lpad(r.evalLabels.hasNeighborCandidate ? 'Y' : 'n', 6)
    );
  }
  lines.push(SEP2);
  lines.push('');

  // ── Recommendation ────────────────────────────────────────────────────────
  lines.push(SEP);
  lines.push('Recommendation (based on this run only — do not change production defaults):');
  lines.push('');

  // Best threshold selection: among candidates with FPR<50% and missRecall>0,
  // prefer highest precision (fewest false positives), break ties by highest
  // missRecall, then by highest threshold (least conservative).
  function pickBest(trigFn) {
    const candidates = SPREAD_THRESHOLDS
      .map(t => ({ t, m: evalTrigger(sig => trigFn(sig, t), positive) }))
      .filter(({ m }) => m.fpr != null && m.fpr < 0.50 && m.missRecall != null && m.missRecall > 0);
    if (!candidates.length) return null;
    candidates.sort((a, b) =>
      (b.m.precision ?? 0) - (a.m.precision ?? 0) ||
      (b.m.missRecall ?? 0) - (a.m.missRecall ?? 0) ||
      b.t - a.t
    );
    return candidates[0];
  }

  const bestSpread = pickBest((sig, t) => sig.topScoreSpread < t);
  if (bestSpread) {
    lines.push(`  Best low-spread threshold (highest precision, FPR<50%, missRecall>0): ${f4(bestSpread.t)}`);
    lines.push(`    missRecall=${pct(bestSpread.m.missRecall)}  FPR=${pct(bestSpread.m.fpr)}  precision=${pct(bestSpread.m.precision)}  triggered=${bestSpread.m.triggeredCount}/${positive.length}`);
  } else {
    lines.push('  No low-spread threshold achieves FPR<50% with missRecall>0 in this run.');
    lines.push('  The topScoreSpread signal may not be discriminative enough for this corpus.');
  }
  lines.push('');

  const bestCombined = pickBest((sig, t) => sig.sourceDiversity < 2 || sig.topScoreSpread < t);
  if (bestCombined) {
    lines.push(`  Best combined threshold (highest precision, FPR<50%, missRecall>0): ${f4(bestCombined.t)}`);
    lines.push(`    missRecall=${pct(bestCombined.m.missRecall)}  FPR=${pct(bestCombined.m.fpr)}  precision=${pct(bestCombined.m.precision)}  triggered=${bestCombined.m.triggeredCount}/${positive.length}`);
  } else {
    lines.push('  No combined threshold achieves FPR<50% with missRecall>0 in this run.');
  }

  lines.push('');
  lines.push('  Cross-validate across multiple runs before adjusting any trigger threshold.');
  lines.push('  A single run is insufficient due to query ordering and reranker variance.');
  lines.push('');
  lines.push(SEP);

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const rawQueries = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  const { denseProvider, sparseProvider } = resolveEnvProviders();

  process.stderr.write(`\n=== semidex custom-50 threshold sweep ===\n`);
  process.stderr.write(`Provider   : ${denseProvider}/${sparseProvider}\n`);
  process.stderr.write(`Window     : ±${BENCH_WINDOW}\n`);
  process.stderr.write(`Thresholds : ${SPREAD_THRESHOLDS.join(', ')}\n\n`);

  process.stderr.write('[1/2] Setup collection...\n');
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
    process.stderr.write('[2/2] Skipping index (BENCH_SKIP_INDEX=1).\n\n');
  } else {
    process.stderr.write(`[2/2] Indexing ${FIXTURE_FILES.length} fixture docs...\n`);
    await indexFixtures();
    process.stderr.write('\n');
  }

  process.stderr.write('Collecting query data (embed + search + recovery per query)...\n');
  const queryData = [];
  for (const q of rawQueries.queries) {
    process.stderr.write(`  ${q.id}: ${q.query.slice(0, 50)}...\n`);
    queryData.push(await collectQuery(q));
  }

  process.stderr.write('\nBuilding report (threshold sweep in-memory)...\n');
  const report = buildReport(queryData);
  process.stdout.write(report + '\n');

  mkdirSync(RESULTS, { recursive: true });
  const outPath = resolve(RESULTS, `${today()}-custom50-threshold-sweep.txt`);
  writeFileSync(outPath, report + '\n', 'utf8');
  process.stderr.write(`\nSaved: ${outPath}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
