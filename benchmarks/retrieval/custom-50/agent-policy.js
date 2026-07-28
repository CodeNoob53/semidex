// Agent-policy evaluation for custom-50 quality benchmark.
//
// Models semidex as an agentic retrieval system: the "agent" runs a first search
// step and, on a miss, applies a follow-up recovery step. Evaluates whether
// structured two-step policies can close the gap vs a single wider search.
//
// Runs directly against Qdrant — no child processes. Requires the
// bench-retrieval-custom-50 collection to be indexed (run bench:custom50 first,
// or set BENCH_SKIP_INDEX=0 to re-index before evaluating).
//
// Policies:
//   1. baseline-top5               — single hybrid search, top-5
//   2. baseline-top10              — single hybrid search, top-10
//   3. top5-then-top10-if-miss     — top-5 first; on miss, widen to top-10
//   4. top5-then-rerank-if-miss    — top-5 first; on miss, fetch top-40 + rerank
//   5. top5-then-window-if-neighbor — top-5 first; on miss, if a ±1 neighbor of
//                                    any exact chunk is in top-5, fetch that
//                                    chunk + its ±1 window via qdrant_get_chunk
//
// IMPORTANT — oracle upper bounds:
//   Policies 3–5 use qrels (exactIds) to decide whether the first-step result is
//   a miss and whether to fire a recovery step. A real agent does not have access
//   to qrels — it would use a heuristic or LLM judge to decide. This means:
//   - agentSuccess@2steps is an ORACLE UPPER BOUND, not a realistic success rate.
//   - avgSearchCalls and avgLatency are OPTIMISTIC — the oracle never wastes a
//     recovery call on a false-miss.
//   Policy 5 is especially optimistic: hasWindowNeighbor() uses oracle knowledge
//   to determine whether to attempt window expansion.
//
// IMPORTANT — provider / parameter isolation:
//   This script runs in-process. qdrant.js reads RRF_K and HYBRID_PREFETCH_LIMIT
//   at module load time (ESM hoisting), so those values cannot be overridden here.
//   The script requires default values (RRF_K=60, HYBRID_PREFETCH_LIMIT=2) and will
//   exit with an error if either is set to a non-default value in the environment.
//   ONNX_EMBED is forced unconditionally — see the env setup block below.
//
// Usage:
//   npm run bench:custom50:agent
//   BENCH_SKIP_INDEX=1 npm run bench:custom50:agent

if (process.argv.includes('--help')) {
  process.stdout.write(`custom-50 agent-policy evaluation

Models semidex as a two-step agentic retrieval system. Evaluates 5 policies:
  1. baseline-top5                — single hybrid search, top-5
  2. baseline-top10               — single hybrid search, top-10
  3. top5-then-top10-if-miss      — widen search on miss
  4. top5-then-rerank-if-miss     — rerank rescue on miss
  5. top5-then-window-if-neighbor — qdrant_get_chunk window expansion on miss

Usage:
  npm run bench:custom50:agent
  BENCH_SKIP_INDEX=1 npm run bench:custom50:agent

Options (env vars):
  BENCH_SKIP_INDEX=1   Reuse existing bench-retrieval-custom-50 collection
  BENCH_WINDOW=1       Adjacency window for window-expansion policy (default: 1)

Note: ONNX provider (bge-m3-onnx) is forced unconditionally. BENCH_PROVIDER is
ignored. RRF_K and HYBRID_PREFETCH_LIMIT must be unset or at their defaults (60/2) —
qdrant.js reads them at module load time; the script exits with an error if they
are set to non-default values.

Output: benchmarks/retrieval/results/YYYY-MM-DD-custom50-agent-policy.txt
Prerequisites: QDRANT_URL and QDRANT_KEY in .env or environment.
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
  deleteBySourceFile,
  upsertPoints, hybridSearch, scroll,
} from '../../../src/core/qdrant.js';
import { embedForIndex, embedForSearch } from '../../../src/core/embeddings.js';
import { rerankResults } from '../../../src/core/rerank.js';
import { createStorageAdapter } from '../../../src/core/storage/factory.js';
import { resolveBenchProfile } from '../../lib/resolve-profile.js';

const storageAdapter = createStorageAdapter();
// Resolved once in ensureCollection() before indexing/search — embedForIndex/
// embedForSearch require a resolved profile object, not a bare collection
// name (see benchmarks/lib/resolve-profile.js's header comment).
let PROFILE = null;

const __dirname    = dirname(fileURLToPath(import.meta.url));
const FIXTURES_SHARED = resolve(__dirname, '../fixtures/docs');
const FIXTURES_OWN    = resolve(__dirname, 'fixtures/docs');
const QUERIES_PATH    = resolve(__dirname, 'queries.json');
const RESULTS         = resolve(__dirname, '../results');

const COLLECTION  = 'bench-retrieval-custom-50';
const SKIP_INDEX  = process.env.BENCH_SKIP_INDEX === '1';
const BENCH_WINDOW = parseInt(process.env.BENCH_WINDOW ?? '1');

// Fail fast if RRF_K or HYBRID_PREFETCH_LIMIT are set to non-default values.
// qdrant.js reads these at module load time (ESM hoisting), before this code runs,
// so they cannot be reset here. Running with stale values would silently produce
// results that don't match what the docs describe.
const _rrfK = process.env.RRF_K;
const _prefetch = process.env.HYBRID_PREFETCH_LIMIT;
if ((_rrfK !== undefined && _rrfK !== '60') || (_prefetch !== undefined && _prefetch !== '2')) {
  process.stderr.write(
    `\nError: RRF_K=${_rrfK ?? '(unset)'} HYBRID_PREFETCH_LIMIT=${_prefetch ?? '(unset)'}\n` +
    `agent-policy.js always requires default values (RRF_K=60, HYBRID_PREFETCH_LIMIT=2).\n` +
    `qdrant.js reads these at module load time and they cannot be reset in-process.\n` +
    `Unset the variables before running:\n` +
    `  Remove-Item Env:RRF_K, Env:HYBRID_PREFETCH_LIMIT   # PowerShell\n` +
    `  unset RRF_K HYBRID_PREFETCH_LIMIT                  # bash\n`
  );
  process.exit(1);
}

// Force ONNX unconditionally. embeddings.js checks ONNX_EMBED at call time (not
// import time), so setting it here is sufficient.
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

// True if any rel≥3 chunk appears in the result list.
function hasExactHit(results, exactIds) {
  return results.some(r => exactIds.has(resultChunkId(r)));
}

// True if a ±window neighbor of any exact chunk appears in results.
function hasWindowNeighbor(results, exactIds, window) {
  for (const exactId of exactIds) {
    const ep = parseChunkId(exactId);
    if (!ep) continue;
    if (results.some(r => {
      const rp = parseChunkId(resultChunkId(r));
      if (!rp) return false;
      return rp.sourceFile === ep.sourceFile && Math.abs(rp.chunkIndex - ep.chunkIndex) <= window;
    })) return true;
  }
  return false;
}

// File-chunk cache to avoid redundant Qdrant calls across policies.
const _fileChunkCache = new Map();

async function getChunksForFile(sourceFile) {
  if (_fileChunkCache.has(sourceFile)) return _fileChunkCache.get(sourceFile);
  const pts = await scroll(
    COLLECTION,
    { must: [{ key: 'source_file', match: { value: sourceFile } }] },
    500
  );
  _fileChunkCache.set(sourceFile, pts);
  return pts;
}

// Fetch chunks in index range [exactIdx-window, exactIdx+window] for a file.
// chunk_index has no payload index, so we filter locally after fetching all
// chunks for the file (source_file IS indexed).
async function fetchWindowChunks(sourceFile, exactIdx, window) {
  const from = Math.max(0, exactIdx - window);
  const to   = exactIdx + window;
  const all  = await getChunksForFile(sourceFile);
  return all.filter(p => {
    const ci = p.payload?.chunk_index;
    return ci != null && ci >= from && ci <= to;
  });
}

// True if any fetched window chunk is or contains an exact chunk ID.
function windowChunksHaveExact(windowChunks, exactIds) {
  return windowChunks.some(p => {
    const sf = p.payload?.source_file;
    const ci = p.payload?.chunk_index;
    if (!sf || ci == null) return false;
    return exactIds.has(`${sf}#${ci}`);
  });
}

function pad(s, n)  { return String(s).padEnd(n); }
function lpad(s, n) { return String(s).padStart(n); }
function pct(v, d = 1) { return v == null ? 'n/a' : `${(v * 100).toFixed(d)}%`; }
function f2(v)  { return v == null ? 'n/a' : v.toFixed(2); }

function today() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

// ── Indexing ───────────────────────────────────────────────────────────────────

async function ensureCollection() {
  PROFILE = await resolveBenchProfile(storageAdapter, COLLECTION, { vectorSize: 1024 });
  return { denseProvider: PROFILE.embedding.dense.provider, sparseProvider: PROFILE.embedding.sparse?.provider ?? null };
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
          total_chunks: chunk.totalChunks, file_hash: 'bench-agent',
          vector_size: 1024, ...meta,
        },
      });
    }
    await upsertPoints(COLLECTION, points);
    process.stderr.write(`  indexed ${name} (${points.length} chunks)\n`);
  }
}

async function fetchStoredProvider() {
  const pts = await scroll(COLLECTION, undefined, 1, ['dense_provider', 'sparse_provider']);
  const p = pts[0]?.payload;
  if (!p) return null;
  return { denseProvider: p.dense_provider ?? null, sparseProvider: p.sparse_provider ?? null };
}

// ── Policy runner ─────────────────────────────────────────────────────────────
//
// Each policy is async (query, exactIds) → { found, steps, latency }
// found   : boolean — did the policy surface a rel≥3 chunk?
// steps   : number  — how many Qdrant search calls were made
// latency : number  — total ms for all steps
//
// Policies call Qdrant directly; embed once and reuse vectors across policies
// by accepting pre-embedded { dense, sparse }.

async function policy1_top5(vectors, exactIds) {
  const t0 = Date.now();
  const results = await hybridSearch(COLLECTION, vectors.dense, vectors.sparse, 5);
  return { found: hasExactHit(results, exactIds), steps: 1, latency: Date.now() - t0, step1Results: results };
}

async function policy2_top10(vectors, exactIds) {
  const t0 = Date.now();
  const results = await hybridSearch(COLLECTION, vectors.dense, vectors.sparse, 10);
  return { found: hasExactHit(results, exactIds), steps: 1, latency: Date.now() - t0 };
}

async function policy3_top5_then_top10(vectors, exactIds) {
  const t0 = Date.now();
  const r1 = await hybridSearch(COLLECTION, vectors.dense, vectors.sparse, 5);
  if (hasExactHit(r1, exactIds)) return { found: true, foundAtStep: 1, steps: 1, latency: Date.now() - t0 };
  const r2 = await hybridSearch(COLLECTION, vectors.dense, vectors.sparse, 10);
  return { found: hasExactHit(r2, exactIds), foundAtStep: hasExactHit(r2, exactIds) ? 2 : null, steps: 2, latency: Date.now() - t0 };
}

async function policy4_top5_then_rerank(vectors, exactIds, queryText) {
  const t0 = Date.now();
  const r1 = await hybridSearch(COLLECTION, vectors.dense, vectors.sparse, 5);
  if (hasExactHit(r1, exactIds)) return { found: true, foundAtStep: 1, steps: 1, latency: Date.now() - t0 };
  // Rescue: fetch 40 candidates, rerank, take top-10.
  const candidates = await hybridSearch(COLLECTION, vectors.dense, vectors.sparse, 40);
  const reranked   = rerankResults(candidates, queryText, { finalLimit: 10, collection: COLLECTION });
  return { found: hasExactHit(reranked, exactIds), foundAtStep: hasExactHit(reranked, exactIds) ? 2 : null, steps: 2, latency: Date.now() - t0 };
}

async function policy5_top5_then_window(vectors, exactIds) {
  const t0 = Date.now();
  const r1 = await hybridSearch(COLLECTION, vectors.dense, vectors.sparse, 5);
  if (hasExactHit(r1, exactIds)) return { found: true, foundAtStep: 1, steps: 1, latency: Date.now() - t0 };

  // Only attempt window expansion if a neighbor is already in top-5.
  if (!hasWindowNeighbor(r1, exactIds, BENCH_WINDOW)) {
    return { found: false, foundAtStep: null, steps: 1, latency: Date.now() - t0 };
  }

  // Simulate qdrant_get_chunk(window=BENCH_WINDOW) for each exact chunk whose
  // neighbor is in top-5. Counts as one additional Qdrant call per expansion.
  let found = false;
  let calls = 1;
  for (const exactId of exactIds) {
    const ep = parseChunkId(exactId);
    if (!ep) continue;
    const neighborInTop5 = r1.some(r => {
      const rp = parseChunkId(resultChunkId(r));
      if (!rp) return false;
      return rp.sourceFile === ep.sourceFile && Math.abs(rp.chunkIndex - ep.chunkIndex) <= BENCH_WINDOW;
    });
    if (!neighborInTop5) continue;
    calls++;
    const windowChunks = await fetchWindowChunks(ep.sourceFile, ep.chunkIndex, BENCH_WINDOW);
    if (windowChunksHaveExact(windowChunks, exactIds)) { found = true; break; }
  }
  return { found, foundAtStep: found ? 2 : null, steps: calls, latency: Date.now() - t0 };
}

// ── Per-query evaluation ──────────────────────────────────────────────────────

async function evalQuery(q, queryText) {
  const qrels    = q.relevantChunks ?? [];
  const exactIds = new Set(qrels.filter(rc => rc.relevance >= 3).map(rc => rc.chunkId));
  if (!exactIds.size) return null; // no exact qrels — skip (negative or support-only)

  const t0 = Date.now();
  const vectors = await embedForSearch(PROFILE, queryText);
  const embedLatency = Date.now() - t0;

  const [p1, p2, p3, p4, p5] = await Promise.all([
    policy1_top5(vectors, exactIds),
    policy2_top10(vectors, exactIds),
    policy3_top5_then_top10(vectors, exactIds),
    policy4_top5_then_rerank(vectors, exactIds, queryText),
    policy5_top5_then_window(vectors, exactIds),
  ]);

  return {
    id:          q.id,
    type:        q.type,
    query:       queryText,
    embedLatency,
    p1, p2, p3, p4, p5,
  };
}

// ── Aggregate metrics ─────────────────────────────────────────────────────────

function aggregatePolicy(results, pKey) {
  const r = results.filter(r => r !== null);
  const n = r.length;
  if (!n) return {};

  let success1 = 0, success2 = 0, totalCalls = 0, totalLatency = 0;
  for (const qr of r) {
    const p = qr[pKey];
    if (p.foundAtStep === 1 || (pKey === 'p1' || pKey === 'p2') && p.found) success1++;
    if (p.found) success2++;
    totalCalls   += p.steps;
    totalLatency += p.latency + qr.embedLatency;
  }

  // For single-step policies (p1, p2): agentSuccess@1step == agentSuccess@2steps.
  const isSingleStep = pKey === 'p1' || pKey === 'p2';
  const s1 = isSingleStep ? success2 : success1;

  return {
    singleShotRecall5: pKey === 'p1' ? success2 / n : null,
    agentSuccess1:     s1  / n,
    agentSuccess2:     success2 / n,
    avgSearchCalls:    totalCalls / n,
    avgLatency:        totalLatency / n,
    remaining:         r.filter(qr => !qr[pKey].found).map(qr => qr.id),
  };
}

// ── Report ────────────────────────────────────────────────────────────────────

function buildReport(evalResults, rawQueries) {
  const lines = [];
  const SEP  = '═'.repeat(90);
  const SEP2 = '─'.repeat(90);

  const queryMap = new Map(rawQueries.queries.map(q => [q.id, q]));
  const valid    = evalResults.filter(r => r !== null);

  const POLICIES = [
    { key: 'p1', label: 'baseline-top5' },
    { key: 'p2', label: 'baseline-top10' },
    { key: 'p3', label: 'top5→top10-on-miss' },
    { key: 'p4', label: 'top5→rerank-on-miss' },
    { key: 'p5', label: 'top5→window-on-miss' },
  ];

  // ── Header ─────────────────────────────────────────────────────────────────
  lines.push(SEP);
  lines.push('  custom-50 agent-policy evaluation');
  lines.push(`  Provider : onnx (bge-m3-onnx/bge-m3-onnx), hybrid RRF`);
  lines.push(`  Queries  : ${valid.length} positive with rel≥3 qrels`);
  lines.push(`  Window   : ±${BENCH_WINDOW} (policy 5 expansion)`);
  lines.push('');
  lines.push('  NOTE: policies 3–5 use qrels to detect misses and trigger recovery.');
  lines.push('  agentSuccess@2steps, avgSearchCalls, and avgLatency are ORACLE UPPER');
  lines.push('  BOUNDS — a real agent cannot inspect qrels to decide when to recover.');
  lines.push(SEP);
  lines.push('');

  // ── Aggregate metrics table ────────────────────────────────────────────────
  const COL = 22;
  const LW  = 24;
  const msep = '-'.repeat(LW + POLICIES.length * (COL + 2));

  lines.push('Aggregate metrics:');
  lines.push(msep);
  let hdr = pad('', LW);
  for (const p of POLICIES) hdr += '  ' + lpad(p.label, COL);
  lines.push(hdr);
  lines.push(msep);

  const agg = Object.fromEntries(POLICIES.map(p => [p.key, aggregatePolicy(valid, p.key)]));

  function mrow(name, fn) {
    let line = pad(name, LW);
    for (const p of POLICIES) line += '  ' + lpad(fn(agg[p.key]), COL);
    lines.push(line);
  }

  mrow('singleShotRecall@5',  a => a.singleShotRecall5 != null ? pct(a.singleShotRecall5) : '(n/a — top10)');
  mrow('agentSuccess@1step',  a => pct(a.agentSuccess1));
  mrow('agentSuccess@2steps', a => pct(a.agentSuccess2));
  mrow('avgSearchCalls',      a => f2(a.avgSearchCalls));
  mrow('avgLatency ms',       a => `${Math.round(a.avgLatency)}ms`);
  mrow('remainingMisses',     a => String(a.remaining?.length ?? 0));

  lines.push(msep);
  lines.push('');

  // ── Remaining misses per policy ───────────────────────────────────────────
  lines.push('Remaining misses per policy:');
  lines.push(msep);
  for (const p of POLICIES) {
    const a = agg[p.key];
    lines.push(`  ${pad(p.label, 22)} : ${(a.remaining ?? []).join(', ') || '—'}`);
  }
  lines.push('');

  // ── Per-query outcome table ────────────────────────────────────────────────
  lines.push('Per-query outcome (✓=found, ✗=miss, 2=found at step 2):');
  lines.push(SEP2);
  const qhdr = pad('ID', 5) + '  ' + pad('Query (truncated)', 40) + '  ' +
    POLICIES.map(p => lpad(p.label.slice(0, COL), COL)).join('  ');
  lines.push(qhdr);
  lines.push(SEP2);

  for (const qr of valid) {
    const rawQ  = queryMap.get(qr.id);
    const qtext = (rawQ?.query ?? qr.id).slice(0, 39);
    let line = pad(qr.id, 5) + '  ' + pad(qtext, 40) + '  ';
    line += POLICIES.map(p => {
      const pol = qr[p.key];
      let sym;
      if (!pol.found) sym = '✗';
      else if (p.key === 'p1' || p.key === 'p2') sym = '✓';
      else if (pol.foundAtStep === 1) sym = '✓';
      else sym = '2';
      return lpad(sym, COL);
    }).join('  ');
    lines.push(line);
  }

  lines.push(SEP2);
  lines.push('');

  // ── Improvements and regressions vs baseline-top5 (p1) ───────────────────
  lines.push('Changes vs baseline-top5:');
  lines.push('');

  for (const p of POLICIES.slice(1)) {
    const improved  = valid.filter(qr => !qr.p1.found &&  qr[p.key].found).map(qr => qr.id);
    const regressed = valid.filter(qr =>  qr.p1.found && !qr[p.key].found).map(qr => qr.id);

    lines.push(`  ${p.label}:`);
    const isSingle = p.key === 'p2';
    if (improved.length) {
      lines.push(`    Improved  (${improved.length}): ${improved.map(id => {
        const qr   = valid.find(r => r.id === id);
        const step = isSingle ? 1 : (qr[p.key].foundAtStep ?? '?');
        return `${id} [step ${step}]`;
      }).join(', ')}`);
    } else {
      lines.push('    Improved  (0): —');
    }
    if (regressed.length) {
      lines.push(`    Regressed (${regressed.length}): ${regressed.map(id => {
        const rawQ = queryMap.get(id);
        return `${id} (${(rawQ?.query ?? '').slice(0, 40)})`;
      }).join('; ')}`);
    } else {
      lines.push('    Regressed (0): —');
    }
    lines.push('');
  }

  // ── Recommendation ────────────────────────────────────────────────────────
  lines.push(SEP);
  lines.push('Recommendation (based on this run only — do not change production defaults):');
  lines.push('');

  const base = agg.p1;
  for (const p of POLICIES.slice(1)) {
    const a = agg[p.key];
    const dSuccess = (a.agentSuccess2 - base.agentSuccess2) * 100;
    const dCalls   = a.avgSearchCalls - base.avgSearchCalls;
    const dLatency = a.avgLatency - base.avgLatency;
    const sign1 = v => (v > 0 ? '+' : '') + v.toFixed(1);
    const sign2 = v => (v > 0 ? '+' : '') + v.toFixed(2);

    let verdict;
    if (dSuccess > 0.001 && dCalls <= 1.5) verdict = 'Promising — improves success rate at acceptable call overhead.';
    else if (dSuccess > 0.001)             verdict = 'Gains success but high call overhead — consider cost vs benefit.';
    else if (dSuccess < -0.001)            verdict = 'Regresses — do not use.';
    else                                   verdict = 'Neutral — no meaningful change vs top-5 baseline.';

    lines.push(`  ${p.label}:`);
    lines.push(`    agentSuccess@2steps ${sign1(dSuccess)}pp  avgCalls ${sign2(dCalls)}  avgLatency ${sign1(dLatency)}ms`);
    lines.push(`    ${verdict}`);
    lines.push('');
  }

  lines.push('  Production defaults should not be changed from a single run.');
  lines.push('  Re-run after indexing changes to validate policy stability.');
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

  process.stderr.write(`\n=== semidex custom-50 agent-policy evaluation ===\n`);
  process.stderr.write(`Provider : ${denseProvider}/${sparseProvider}\n`);
  process.stderr.write(`Window   : ±${BENCH_WINDOW}\n\n`);

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

  process.stderr.write('Running queries (all policies in parallel per query)...\n');
  const evalResults = [];
  for (const q of rawQueries.queries) {
    if (q.shouldHaveNoStrongHit) { evalResults.push(null); continue; }
    process.stderr.write(`  ${q.id}: ${q.query.slice(0, 45)}...\n`);
    evalResults.push(await evalQuery(q, q.query));
  }

  process.stderr.write('\nBuilding report...\n');
  const report = buildReport(evalResults, rawQueries);
  process.stdout.write(report + '\n');

  mkdirSync(RESULTS, { recursive: true });
  const outPath = resolve(RESULTS, `${today()}-custom50-agent-policy.txt`);
  writeFileSync(outPath, report + '\n', 'utf8');
  process.stderr.write(`\nSaved: ${outPath}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
