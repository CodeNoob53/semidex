// Search diagnostics v1 — custom-50 quality benchmark.
//
// DIAGNOSTICS EXPERIMENT — does not change any runtime or MCP behavior.
//
// Computes per-query signal features from a baseline top-5 hybrid search and
// tests simple trigger rules that could predict when top-5 is likely to miss.
// Qrels are used ONLY to evaluate triggers, never to compute signals or fire them.
//
// Goal: identify cheap, deterministic signals that are observable at query time
// (no qrel access) and correlate with real top-5 misses.
//
// Signals computed per query (all from search results only):
//   topScoreSpread        score(rank1) - score(rank5)
//   topScoreRatio         score(rank1) / score(rank5), guarded for zero
//   sourceDiversity       unique source_file count in top-5
//   duplicateSourceRate   fraction of top-5 results sharing the top-1 source
//   exactQueryTokenHits   fraction of query tokens found in top-5 text/section/source
//   technicalTokenHits    fraction of known technical tokens found in top-5 text
//   top1SourceRepeated    boolean — top-1 source appears ≥3 times in top-5
//
// Signals that require qrels (evaluation-only, never used to fire triggers):
//   hasNeighborCandidate  a ±BENCH_WINDOW neighbor of any rel≥3 chunk is in top-5
//   top5ContainsExpectedFile  a result from any expected file is in top-5
//   isMiss                no rel≥3 chunk in top-5
//
// Trigger rules tested (no qrel access):
//   1. low-diversity       sourceDiversity < 2
//   2. low-spread          topScoreSpread < SPREAD_THRESHOLD (tunable)
//   3. no-tech-token-hit   technicalTokenHits === 0 (for exact-token queries only)
//   4. combined            any of: low-diversity OR low-spread OR no-tech-token-hit
//
// Trigger evaluation metrics:
//   triggerRate            % of queries where trigger fires
//   missRecall             % of real misses (isMiss) caught by trigger
//   falsePositiveRate      % of non-misses incorrectly triggered
//   recoveryPotential@10   if trigger fires, % of those queries where top-10 finds it
//   recoveryPotential@rerank  if trigger fires, % where top-40 + rerank finds it
//   recoveryPotential@window  if trigger fires, % where window expansion finds it
//
// Usage:
//   npm run bench:custom50:diagnostics
//   BENCH_SKIP_INDEX=1 npm run bench:custom50:diagnostics
//   BENCH_WINDOW=1 npm run bench:custom50:diagnostics
//   SPREAD_THRESHOLD=0.05 npm run bench:custom50:diagnostics

if (process.argv.includes('--help')) {
  process.stdout.write(`custom-50 search diagnostics v1 (experiment — no runtime changes)

Usage:
  npm run bench:custom50:diagnostics
  BENCH_SKIP_INDEX=1 npm run bench:custom50:diagnostics

Options (env vars):
  BENCH_SKIP_INDEX=1     Reuse existing bench-retrieval-custom-50 collection
  BENCH_WINDOW=1         Adjacency window for window neighbor check (default: 1)
  SPREAD_THRESHOLD=0.05  Score spread below which "low-spread" trigger fires (default: 0.05)

Note: ONNX (bge-m3-onnx) is forced unconditionally. RRF_K and HYBRID_PREFETCH_LIMIT
must be unset or at their defaults (60/2) — the script exits with an error otherwise.

Output: benchmarks/retrieval/results/YYYY-MM-DD-custom50-diagnostics.txt
`);
  process.exit(0);
}

import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { chunkFile } from '../../../src/shared/indexer/phases/chunk.js';
import {
  deleteBySourceFile,
  upsertPoints, hybridSearch, scroll,
} from '../../../src/shared/core/qdrant.js';
import { embedForIndex, embedForSearch } from '../../../src/shared/core/embeddings.js';
import { rerankResults } from '../../../src/core/rerank.js';
import { createStorageAdapter } from '../../../src/core/storage/factory.js';
import { resolveBenchProfile } from '../../lib/resolve-profile.js';

const storageAdapter = createStorageAdapter();
// Resolved once in main() before indexing/search — embedForIndex/embedForSearch
// require a resolved profile object, not a bare collection name (see
// benchmarks/lib/resolve-profile.js's header comment).
let PROFILE = null;

const __dirname       = dirname(fileURLToPath(import.meta.url));
const FIXTURES_SHARED = resolve(__dirname, '../fixtures/docs');
const FIXTURES_OWN    = resolve(__dirname, 'fixtures/docs');
const QUERIES_PATH    = resolve(__dirname, 'queries.json');
const RESULTS         = resolve(__dirname, '../results');

const COLLECTION       = 'bench-retrieval-custom-50';
const SKIP_INDEX       = process.env.BENCH_SKIP_INDEX === '1';
const BENCH_WINDOW     = parseInt(process.env.BENCH_WINDOW ?? '1', 10);
const SPREAD_THRESHOLD = parseFloat(process.env.SPREAD_THRESHOLD ?? '0.05');

// Fail fast: qdrant.js reads RRF_K and HYBRID_PREFETCH_LIMIT at ESM module load
// time. If they are set to non-default values the script cannot undo them.
const _rrfK     = process.env.RRF_K;
const _prefetch = process.env.HYBRID_PREFETCH_LIMIT;
if ((_rrfK !== undefined && _rrfK !== '60') || (_prefetch !== undefined && _prefetch !== '2')) {
  process.stderr.write(
    `\nError: RRF_K=${_rrfK ?? '(unset)'} HYBRID_PREFETCH_LIMIT=${_prefetch ?? '(unset)'}\n` +
    `diagnostics.js requires default values (RRF_K=60, HYBRID_PREFETCH_LIMIT=2).\n` +
    `Unset the variables before running:\n` +
    `  Remove-Item Env:RRF_K, Env:HYBRID_PREFETCH_LIMIT   # PowerShell\n` +
    `  unset RRF_K HYBRID_PREFETCH_LIMIT                  # bash\n`
  );
  process.exit(1);
}

// Force ONNX unconditionally. embeddings.js checks ONNX_EMBED at call time.
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

// Technical tokens that appear in semidex config/code — useful for exact-token queries.
const TECHNICAL_TOKENS = new Set([
  'onnx_embed', 'sparse_provider', 'dense_provider', 'rrf_k',
  'hybrid_prefetch_limit', 'rerank_enabled', 'rerank_prefetch_mult',
  'chunk_index', 'source_file', 'schema_version', 'bge', 'bge-m3',
  'qdrant_url', 'qdrant_key', 'collection', 'upsert', 'scroll',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function pad(s, n)  { return String(s).padEnd(n); }
function lpad(s, n) { return String(s).padStart(n); }
function pct(v, d = 1) { return v == null ? 'n/a' : `${(v * 100).toFixed(d)}%`; }
function f3(v) { return v == null ? 'n/a' : v.toFixed(3); }

function today() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

function tokenise(str) {
  return (str ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
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

function resultChunkId(r) {
  const sf = r.payload?.source_file;
  const ci = r.payload?.chunk_index;
  if (!sf || ci == null) return null;
  return `${sf}#${ci}`;
}

// ── Indexing ──────────────────────────────────────────────────────────────────

async function ensureCollection() {
  PROFILE = await resolveBenchProfile(storageAdapter, COLLECTION, { vectorSize: 1024 });
  return { denseProvider: PROFILE.embedding.dense.provider, sparseProvider: PROFILE.embedding.sparse?.provider ?? null };
}

async function fetchStoredProvider() {
  const pts = await scroll(COLLECTION, undefined, 1, ['dense_provider', 'sparse_provider']);
  const p = pts[0]?.payload;
  if (!p) return null;
  return { denseProvider: p.dense_provider ?? null, sparseProvider: p.sparse_provider ?? null };
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
      const { dense, sparse, meta } = await embedForIndex(PROFILE, chunk.text);
      points.push({
        id: randomUUID(),
        vector: { dense, sparse },
        payload: {
          text: chunk.text, section: chunk.section,
          source_file: sourceFile, chunk_index: chunk.chunkIndex,
          total_chunks: chunk.totalChunks, file_hash: 'bench-diag',
          vector_size: 1024, ...meta,
        },
      });
    }
    await upsertPoints(COLLECTION, points);
    process.stderr.write(`  indexed ${name} (${points.length} chunks)\n`);
  }
}

// ── Signal computation ────────────────────────────────────────────────────────

// Compute all signals for a single top-5 result list.
// queryTokens: tokenised query words (no qrel access).
// All returned fields are observable at query time, except the three eval-only
// fields (hasNeighborCandidate, top5ContainsExpectedFile, isMiss) which require
// qrels and must NOT be used to fire trigger rules.
function computeSignals(top5, queryTokens, queryText, evalCtx) {
  const { exactIds, expectedFiles, qrels } = evalCtx; // eval-only context

  // ── Score spread / ratio ─────────────────────────────────────────────────
  const scores = top5.map(r => r.score ?? 0);
  const s1 = scores[0] ?? 0;
  const s5 = scores[scores.length - 1] ?? 0;
  const topScoreSpread = s1 - s5;
  const topScoreRatio  = s5 === 0 ? null : s1 / s5;

  // ── Source diversity ──────────────────────────────────────────────────────
  const sources = top5.map(r => r.payload?.source_file).filter(Boolean);
  const uniqueSources = new Set(sources);
  const sourceDiversity = uniqueSources.size;
  const top1Source = sources[0];
  const top1SourceCount = sources.filter(s => s === top1Source).length;
  const duplicateSourceRate = top1Source ? top1SourceCount / top5.length : 0;
  const top1SourceRepeated  = top1SourceCount >= 3;

  // ── Exact query token hits ────────────────────────────────────────────────
  // Fraction of query tokens that appear in any of the top-5 results'
  // text, section, or source_file fields.
  const resultText = top5.map(r => [
    r.payload?.text ?? '',
    r.payload?.section ?? '',
    r.payload?.source_file ?? '',
  ].join(' ')).join(' ').toLowerCase();

  const totalQueryTokens = queryTokens.length;
  let queryTokenHits = 0;
  for (const tok of queryTokens) {
    if (resultText.includes(tok)) queryTokenHits++;
  }
  const exactQueryTokenHits = totalQueryTokens > 0 ? queryTokenHits / totalQueryTokens : null;

  // ── Technical token hits ──────────────────────────────────────────────────
  // Fraction of TECHNICAL_TOKENS that appear somewhere in the top-5 result text.
  // Useful signal for "exact-token" query type — if the technical term isn't in
  // any returned chunk, the query likely needs a better retrieval step.
  const techHitsCount = [...TECHNICAL_TOKENS].filter(tok => resultText.includes(tok)).length;
  const queryTextLower = queryText.toLowerCase();
  // Only count query-relevant technical tokens (ones the query itself mentions).
  const queryTechTokens = [...TECHNICAL_TOKENS].filter(tok => queryTextLower.includes(tok));
  const technicalTokenHits = queryTechTokens.length > 0
    ? queryTechTokens.filter(tok => resultText.includes(tok)).length / queryTechTokens.length
    : null; // null = query doesn't mention any technical tokens

  // ── Eval-only signals (use qrels — must not fire triggers) ───────────────
  const resultIds = top5.map(resultChunkId);
  const top5ContainsExpectedFile = expectedFiles.some(f => sources.includes(f));
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

  return {
    // Observable signals (safe to use in triggers)
    topScoreSpread,
    topScoreRatio,
    sourceDiversity,
    duplicateSourceRate,
    exactQueryTokenHits,
    technicalTokenHits,
    top1SourceRepeated,
    techHitsCount, // raw count across all tech tokens, for reference
    // Eval-only signals (qrel-dependent — must not fire triggers)
    hasNeighborCandidate,
    top5ContainsExpectedFile,
    isMiss,
  };
}

// ── Recovery potential ────────────────────────────────────────────────────────

// Compute recovery outcomes for a triggered query.
// Returns { recoversAtTop10, recoversAtRerank, recoversAtWindow }.
// All require qrels — called only during evaluation, not at runtime.
// top5: the baseline top-5 results (needed to simulate window expansion from a
//       returned chunk, not from the oracle exact chunk).
async function computeRecovery(vectors, queryText, exactIds, top5) {
  // top-10
  const top10 = await hybridSearch(COLLECTION, vectors.dense, vectors.sparse, 10);
  const recoversAtTop10 = top10.some(r => exactIds.has(resultChunkId(r)));

  // top-40 + rerank → top-10
  const candidates = await hybridSearch(COLLECTION, vectors.dense, vectors.sparse, 40);
  const reranked = rerankResults(candidates, queryText, { finalLimit: 10, collection: COLLECTION });
  const recoversAtRerank = reranked.some(r => exactIds.has(resultChunkId(r)));

  // window expansion: simulates qdrant_get_chunk(window=N) called on a top-5 result.
  // For each chunk in top-5 that is a ±BENCH_WINDOW neighbor of any exact chunk,
  // fetch the window [returnedIdx-N, returnedIdx+N] and check if the exact chunk
  // falls inside it. This models the real agent scenario: the agent sees a top-5
  // result, expands its window, and discovers the exact chunk as a neighbor.
  // (Expanding around the exact chunk itself would trivially recover in every case.)
  let recoversAtWindow = false;
  for (const r5 of top5) {
    const rp = parseChunkId(resultChunkId(r5));
    if (!rp) continue;
    // Is this returned chunk a neighbor of any exact chunk?
    let neighborExactId = null;
    for (const exactId of exactIds) {
      const ep = parseChunkId(exactId);
      if (!ep) continue;
      if (ep.sourceFile === rp.sourceFile && Math.abs(ep.chunkIndex - rp.chunkIndex) <= BENCH_WINDOW) {
        neighborExactId = exactId;
        break;
      }
    }
    if (!neighborExactId) continue;
    // Simulate qdrant_get_chunk: fetch window around the returned chunk.
    const allChunks = await scroll(
      COLLECTION,
      { must: [{ key: 'source_file', match: { value: rp.sourceFile } }] },
      500
    );
    const from = Math.max(0, rp.chunkIndex - BENCH_WINDOW);
    const to   = rp.chunkIndex + BENCH_WINDOW;
    const windowHasExact = allChunks.some(p => {
      const ci = p.payload?.chunk_index;
      const sf = p.payload?.source_file;
      return sf === rp.sourceFile && ci != null && ci >= from && ci <= to &&
             exactIds.has(`${sf}#${ci}`);
    });
    if (windowHasExact) { recoversAtWindow = true; break; }
  }

  return { recoversAtTop10, recoversAtRerank, recoversAtWindow };
}

// ── Trigger rules ─────────────────────────────────────────────────────────────

// Each rule takes per-query signals and returns boolean (fire/no-fire).
// Rules must not access qrel fields (isMiss, hasNeighborCandidate, etc.).
const TRIGGER_RULES = [
  {
    key:   'low-diversity',
    label: 'low-diversity (sourceDiversity < 2)',
    fn:    (sig) => sig.sourceDiversity < 2,
  },
  {
    key:   'low-spread',
    label: `low-spread (topScoreSpread < ${SPREAD_THRESHOLD})`,
    fn:    (sig) => sig.topScoreSpread < SPREAD_THRESHOLD,
  },
  {
    key:   'no-tech-token',
    label: 'no-tech-token-hit (technicalTokenHits === 0, exact-token queries only)',
    fn:    (sig, qtype) => qtype === 'exact-token' && sig.technicalTokenHits !== null && sig.technicalTokenHits === 0,
  },
  {
    key:   'combined',
    label: 'combined (any of: low-diversity OR low-spread OR no-tech-token)',
    fn:    (sig, qtype) =>
      sig.sourceDiversity < 2 ||
      sig.topScoreSpread < SPREAD_THRESHOLD ||
      (qtype === 'exact-token' && sig.technicalTokenHits !== null && sig.technicalTokenHits === 0),
  },
];

// ── Per-query evaluation ──────────────────────────────────────────────────────

async function evalQuery(q) {
  const qrels = q.relevantChunks ?? [];
  const exactIds = new Set(qrels.filter(rc => rc.relevance >= 3).map(rc => rc.chunkId));
  const evalCtx = {
    exactIds,
    expectedFiles: q.expectedFiles ?? [],
    qrels: new Map(qrels.map(rc => [rc.chunkId, rc.relevance])),
  };

  const queryTokens = tokenise(q.query);
  const vectors = await embedForSearch(PROFILE, q.query);
  const top5    = await hybridSearch(COLLECTION, vectors.dense, vectors.sparse, 5);

  const signals = computeSignals(top5, queryTokens, q.query, evalCtx);

  // Evaluate triggers
  const triggers = {};
  for (const rule of TRIGGER_RULES) {
    triggers[rule.key] = rule.fn(signals, q.type);
  }

  // Recovery potential for triggered queries only — only computed for combined trigger
  // to avoid inflating Qdrant call count. Individual rule recovery uses same gate.
  let recovery = null;
  if (triggers.combined && exactIds.size > 0) {
    recovery = await computeRecovery(vectors, q.query, exactIds, top5);
  }

  return {
    id:       q.id,
    type:     q.type,
    query:    q.query,
    signals,
    triggers,
    recovery,
    isNegative: q.shouldHaveNoStrongHit ?? false,
    hasExactQrels: exactIds.size > 0,
  };
}

// ── Report ────────────────────────────────────────────────────────────────────

function buildReport(queryResults, spreadThreshold) {
  const lines = [];
  const SEP  = '═'.repeat(100);
  const SEP2 = '─'.repeat(100);

  // Split into positive (has rel≥3 qrels) and negative queries
  const positive = queryResults.filter(r => r.hasExactQrels && !r.isNegative);
  const negative = queryResults.filter(r => r.isNegative);
  const exactToken = positive.filter(r => r.type === 'exact-token');

  lines.push(SEP);
  lines.push('  custom-50 search diagnostics v1');
  lines.push('  EXPERIMENT — does not change runtime or MCP behavior');
  lines.push(`  Provider : onnx (bge-m3-onnx/bge-m3-onnx), hybrid RRF`);
  lines.push(`  Queries  : ${positive.length} positive (rel≥3) + ${negative.length} negative`);
  lines.push(`  Window   : ±${BENCH_WINDOW}`);
  lines.push(`  SPREAD_THRESHOLD : ${spreadThreshold}`);
  lines.push('');
  lines.push('  NOTE: triggers use only query-time signals. Qrels are only used');
  lines.push('  to evaluate whether triggers correctly predict misses.');
  lines.push(SEP);
  lines.push('');

  // ── Signal distribution ───────────────────────────────────────────────────
  lines.push('Signal distribution (positive queries, n=' + positive.length + '):');
  lines.push(SEP2);

  function distStat(vals, label) {
    const v = vals.filter(x => x != null).sort((a, b) => a - b);
    if (!v.length) return;
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const p25  = v[Math.floor(v.length * 0.25)];
    const p50  = v[Math.floor(v.length * 0.50)];
    const p75  = v[Math.floor(v.length * 0.75)];
    lines.push(`  ${pad(label, 28)}  mean=${f3(mean)}  p25=${f3(p25)}  p50=${f3(p50)}  p75=${f3(p75)}  min=${f3(v[0])}  max=${f3(v[v.length-1])}`);
  }

  distStat(positive.map(r => r.signals.topScoreSpread),       'topScoreSpread');
  distStat(positive.map(r => r.signals.topScoreRatio),        'topScoreRatio');
  distStat(positive.map(r => r.signals.sourceDiversity),      'sourceDiversity');
  distStat(positive.map(r => r.signals.duplicateSourceRate),  'duplicateSourceRate');
  distStat(positive.map(r => r.signals.exactQueryTokenHits),  'exactQueryTokenHits');
  distStat(
    exactToken.map(r => r.signals.technicalTokenHits),
    'technicalTokenHits (exact-tok)'
  );
  lines.push('');
  const top1RepCount = positive.filter(r => r.signals.top1SourceRepeated).length;
  lines.push(`  top1SourceRepeated (≥3)  : ${top1RepCount}/${positive.length} (${pct(top1RepCount/positive.length)})`);
  lines.push('');

  // Miss vs non-miss signal comparison
  const misses    = positive.filter(r => r.signals.isMiss);
  const hits      = positive.filter(r => !r.signals.isMiss);
  lines.push(`Miss vs non-miss signal comparison  (misses=${misses.length}, hits=${hits.length}):`);
  lines.push(SEP2);

  function cmpRow(label, fn) {
    const mVals = misses.map(fn).filter(x => x != null);
    const hVals = hits.map(fn).filter(x => x != null);
    const mean  = vs => vs.length ? vs.reduce((a,b)=>a+b,0)/vs.length : null;
    lines.push(`  ${pad(label, 28)}  misses=${f3(mean(mVals))}  hits=${f3(mean(hVals))}`);
  }

  cmpRow('topScoreSpread',         r => r.signals.topScoreSpread);
  cmpRow('topScoreRatio',          r => r.signals.topScoreRatio);
  cmpRow('sourceDiversity',        r => r.signals.sourceDiversity);
  cmpRow('duplicateSourceRate',    r => r.signals.duplicateSourceRate);
  cmpRow('exactQueryTokenHits',    r => r.signals.exactQueryTokenHits);
  lines.push('');

  // Eval-only signal prevalence
  lines.push('Eval-only signal prevalence (qrel-based — not usable in triggers):');
  lines.push(SEP2);
  const neighborMisses = misses.filter(r => r.signals.hasNeighborCandidate).length;
  const expFileMisses  = misses.filter(r => r.signals.top5ContainsExpectedFile).length;
  const neighborHits   = hits.filter(r => r.signals.hasNeighborCandidate).length;
  lines.push(`  hasNeighborCandidate  misses: ${neighborMisses}/${misses.length}  hits: ${neighborHits}/${hits.length}`);
  lines.push(`  top5ContainsExpFile   misses: ${expFileMisses}/${misses.length}`);
  lines.push('');

  // ── Trigger evaluation table ──────────────────────────────────────────────
  lines.push('Trigger rule evaluation:');
  lines.push(SEP2);
  const TLW = 52;
  lines.push(
    pad('Rule', TLW) +
    lpad('trigRate', 10) + lpad('missRecall', 12) + lpad('FPR', 8) +
    lpad('recov@10', 10) + lpad('recov@rerank', 14) + lpad('recov@win', 11)
  );
  lines.push(SEP2);

  for (const rule of TRIGGER_RULES) {
    // Compute on positive queries only
    const triggered     = positive.filter(r => r.triggers[rule.key]);
    const trigRate      = triggered.length / positive.length;
    const missesCaught  = misses.filter(r => r.triggers[rule.key]).length;
    const missRecall    = misses.length > 0 ? missesCaught / misses.length : null;
    const fpTriggered   = hits.filter(r => r.triggers[rule.key]).length;
    const fpr           = hits.length > 0 ? fpTriggered / hits.length : null;

    // Recovery potential: only triggered MISSES with recovery data.
    // Filtering to isMiss ensures we measure "does recovery help real failures",
    // not "do successful top-5 hits re-confirm themselves in top-10".
    const triggeredWithRecovery = triggered.filter(r => r.signals.isMiss && r.recovery !== null);
    const recov10     = triggeredWithRecovery.length > 0
      ? triggeredWithRecovery.filter(r => r.recovery.recoversAtTop10).length / triggeredWithRecovery.length
      : null;
    const recovRerank = triggeredWithRecovery.length > 0
      ? triggeredWithRecovery.filter(r => r.recovery.recoversAtRerank).length / triggeredWithRecovery.length
      : null;
    const recovWin    = triggeredWithRecovery.length > 0
      ? triggeredWithRecovery.filter(r => r.recovery.recoversAtWindow).length / triggeredWithRecovery.length
      : null;

    lines.push(
      pad(rule.label, TLW) +
      lpad(pct(trigRate), 10) +
      lpad(missRecall != null ? pct(missRecall) : 'n/a', 12) +
      lpad(fpr != null ? pct(fpr) : 'n/a', 8) +
      lpad(recov10 != null ? pct(recov10) : '—', 10) +
      lpad(recovRerank != null ? pct(recovRerank) : '—', 14) +
      lpad(recovWin != null ? pct(recovWin) : '—', 11)
    );
  }
  lines.push(SEP2);
  lines.push('');
  lines.push('  recoveryPotential is computed for triggered MISSES only (isMiss=true).');
  lines.push('  Recovery data is collected via the "combined" trigger pass; individual rules');
  lines.push('  reuse it to avoid extra Qdrant calls. "—" means no triggered misses for that rule.');
  lines.push('');

  // ── Per-query signal table ────────────────────────────────────────────────
  lines.push('Per-query signals and trigger outcomes:');
  lines.push(SEP2);
  const ruleKeys = TRIGGER_RULES.map(r => r.key);
  const hdr =
    pad('ID', 4) + '  ' + pad('type', 12) + '  ' +
    lpad('spread', 7) + '  ' + lpad('ratio', 6) + '  ' +
    lpad('srcDiv', 6) + '  ' + lpad('dupRate', 7) + '  ' +
    lpad('qTok%', 6) + '  ' + lpad('techTok%', 8) + '  ' +
    lpad('t1Rep', 5) + '    ' +
    ruleKeys.map(k => lpad(k.slice(0, 8), 8)).join(' ') + '   ' +
    lpad('isMiss', 6) + '  ' + lpad('hasNbr', 6);
  lines.push(hdr);
  lines.push(SEP2);

  for (const qr of queryResults) {
    if (qr.isNegative) continue;
    const s = qr.signals;
    const trigStr = ruleKeys.map(k => lpad(qr.triggers[k] ? '!' : '.', 8)).join(' ');
    lines.push(
      pad(qr.id, 4) + '  ' + pad(qr.type, 12) + '  ' +
      lpad(f3(s.topScoreSpread), 7) + '  ' +
      lpad(s.topScoreRatio != null ? f3(s.topScoreRatio) : 'n/a', 6) + '  ' +
      lpad(String(s.sourceDiversity), 6) + '  ' +
      lpad(pct(s.duplicateSourceRate, 0), 7) + '  ' +
      lpad(s.exactQueryTokenHits != null ? pct(s.exactQueryTokenHits, 0) : 'n/a', 6) + '  ' +
      lpad(s.technicalTokenHits != null ? pct(s.technicalTokenHits, 0) : 'n/a', 8) + '  ' +
      lpad(s.top1SourceRepeated ? 'Y' : 'n', 5) + '    ' +
      trigStr + '   ' +
      lpad(s.isMiss ? 'MISS' : 'hit', 6) + '  ' +
      lpad(s.hasNeighborCandidate ? 'Y' : 'n', 6)
    );
  }

  lines.push(SEP2);
  lines.push('');

  // ── Summary and observations ──────────────────────────────────────────────
  lines.push(SEP);
  lines.push('Summary:');
  lines.push('');
  lines.push(`  Positive queries : ${positive.length}`);
  lines.push(`  Misses (top-5)   : ${misses.length}  (${pct(misses.length/positive.length)} of positive)`);
  lines.push(`  Window-reachable : ${neighborMisses}/${misses.length} misses have a neighbor in top-5`);
  lines.push('');
  lines.push('  Trigger rule summary:');
  for (const rule of TRIGGER_RULES) {
    const triggered    = positive.filter(r => r.triggers[rule.key]).length;
    const missesCaught = misses.filter(r => r.triggers[rule.key]).length;
    const fps          = hits.filter(r => r.triggers[rule.key]).length;
    lines.push(`    ${pad(rule.key, 16)} : fires on ${triggered}/${positive.length}  catches ${missesCaught}/${misses.length} misses  FP=${fps}/${hits.length}`);
  }
  lines.push('');
  lines.push('  Interpretation guide:');
  lines.push('    Good trigger: high missRecall, low FPR, high recoveryPotential.');
  lines.push('    A trigger with high FPR fires too often on successful queries and');
  lines.push('    wastes recovery calls. A trigger with low missRecall lets real misses');
  lines.push('    through without triggering recovery.');
  lines.push('');
  lines.push('  Next steps if a trigger looks promising:');
  lines.push('    - Cross-validate on a second run (stochastic reranker variance).');
  lines.push('    - Test whether the trigger adds value in agent-policy.js as a');
  lines.push('      non-oracle step-2 gate (replacing qrel-based miss detection).');
  lines.push('    - Do not change MCP runtime behavior until validated.');
  lines.push('');
  lines.push(SEP);

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const rawQueries = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));

  process.stderr.write('[1/2] Setup collection...\n');
  // Resolves PROFILE from the collection's own native metadata if it already
  // exists, or from current env if creating it fresh — never a second,
  // independent env read after this point (see benchmarks/retrieval/run.js).
  const { denseProvider, sparseProvider } = await ensureCollection();

  process.stderr.write(`\n=== semidex custom-50 search diagnostics v1 ===\n`);
  process.stderr.write(`Provider : ${denseProvider}/${sparseProvider}\n`);
  process.stderr.write(`Window   : ±${BENCH_WINDOW}   SPREAD_THRESHOLD=${SPREAD_THRESHOLD}\n\n`);

  if (SKIP_INDEX) {
    const stored = await fetchStoredProvider();
    if (!stored) {
      process.stderr.write(
        `\nError: BENCH_SKIP_INDEX=1 but no indexed points found in "${COLLECTION}".\n` +
        `Re-run without BENCH_SKIP_INDEX=1 to index fixtures first.\n`
      );
      process.exit(1);
    }
    // Sanity check: the collection's own point payload must agree with its
    // own recorded profile — a disagreement here means the collection was
    // partially reindexed with a different model, not that env changed.
    if (stored.denseProvider !== denseProvider || stored.sparseProvider !== sparseProvider) {
      process.stderr.write(
        `\nError: BENCH_SKIP_INDEX=1 but stored point payload (${stored.denseProvider}/${stored.sparseProvider}) ` +
        `disagrees with "${COLLECTION}"'s own recorded embedding profile (${denseProvider}/${sparseProvider}).\n` +
        `The collection may be partially reindexed with a different model. Delete it and re-run without ` +
        `BENCH_SKIP_INDEX=1 to rebuild it cleanly.\n`
      );
      process.exit(1);
    }
    process.stderr.write('[2/2] Skipping index (BENCH_SKIP_INDEX=1).\n\n');
  } else {
    process.stderr.write(`[2/2] Indexing ${FIXTURE_FILES.length} fixture docs...\n`);
    await indexFixtures();
    process.stderr.write('\n');
  }

  process.stderr.write('Running queries...\n');
  const queryResults = [];
  for (const q of rawQueries.queries) {
    process.stderr.write(`  ${q.id}: ${q.query.slice(0, 50)}...\n`);
    queryResults.push(await evalQuery(q));
  }

  process.stderr.write('\nBuilding report...\n');
  const report = buildReport(queryResults, SPREAD_THRESHOLD);
  process.stdout.write(report + '\n');

  mkdirSync(RESULTS, { recursive: true });
  const outPath = resolve(RESULTS, `${today()}-custom50-diagnostics.txt`);
  writeFileSync(outPath, report + '\n', 'utf8');
  process.stderr.write(`\nSaved: ${outPath}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
