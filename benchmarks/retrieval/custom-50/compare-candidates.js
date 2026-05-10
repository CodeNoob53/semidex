// Candidate comparison for custom-50 quality benchmark.
//
// Runs 4 candidate presets against the same ONNX index and produces a
// failure-level comparison: per-query rank changes, improvements, regressions,
// remaining failure categories, and a recommendation section.
//
// Candidates:
//   1. baseline              — default RRF_K=60, HYBRID_PREFETCH_LIMIT=2
//   2. prefetch-20           — HYBRID_PREFETCH_LIMIT=20
//   3. rerank                — RERANK_ENABLED=1, no top-1 protection
//   4. prefetch-20+rerank    — HYBRID_PREFETCH_LIMIT=20 + RERANK_ENABLED=1
//
// Usage:
//   npm run bench:custom50:compare
//   BENCH_TOP_K=10 npm run bench:custom50:compare

if (process.argv.includes('--help')) {
  process.stdout.write(`custom-50 candidate comparison

Runs 4 candidate presets (baseline, prefetch-20, rerank, prefetch-20+rerank)
and compares them at per-query failure level, not just aggregate metrics.

Usage:
  npm run bench:custom50:compare

Output: benchmarks/retrieval/results/YYYY-MM-DD-custom50-candidate-comparison.txt

Options:
  BENCH_TOP_K=<n>   Search depth for all candidates (default: 10)
`);
  process.exit(0);
}

import { execFileSync } from 'child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname     = dirname(fileURLToPath(import.meta.url));
const RUN_V3        = resolve(__dirname, 'run-v3.js');
const QUERIES_PATH  = resolve(__dirname, 'queries.json');
const RESULTS       = resolve(__dirname, '../results');

// Window for category classification (same default as analyze-failures.js).
const WINDOW = parseInt(process.env.FAIL_WINDOW ?? '1');

const CANDIDATES = [
  {
    label:     'baseline',
    env:       {},
    skipIndex: false,
  },
  {
    label:     'prefetch-20',
    env:       { HYBRID_PREFETCH_LIMIT: '20' },
    skipIndex: true,
  },
  {
    label:     'rerank',
    env:       { RERANK_ENABLED: '1', RERANK_PROTECT_TOP1_DELTA: '0' },
    skipIndex: true,
  },
  {
    label:     'prefetch-20+rerank',
    env:       { HYBRID_PREFETCH_LIMIT: '20', RERANK_ENABLED: '1', RERANK_PROTECT_TOP1_DELTA: '0' },
    skipIndex: true,
  },
];

// ── Child process runner ───────────────────────────────────────────────────────

function runCandidate(c) {
  process.stderr.write(`\nRunning: ${c.label}...\n`);
  const env = { ...process.env };

  env.ONNX_EMBED     = '1';
  env.BENCH_PROVIDER = 'onnx';
  delete env.DENSE_PROVIDER;
  delete env.SPARSE_PROVIDER;

  // Reset all tuning knobs to known defaults before applying variant overrides,
  // so stale shell vars (e.g. HYBRID_PREFETCH_LIMIT=20 from a prior tuning run)
  // cannot silently corrupt the baseline or other candidates.
  env.RRF_K                  = '60';
  env.HYBRID_PREFETCH_LIMIT  = '2';
  env.RERANK_PREFETCH_MULT   = '4';
  env.RERANK_ENABLED         = '0';
  delete env.RERANK_PROTECT_TOP1_DELTA;
  delete env.MMR_DIVERSITY;
  delete env.MMR_CANDIDATES_LIMIT;

  env.BENCH_SEARCH_MODE = 'hybrid';
  env.BENCH_JSON        = '1';

  for (const [k, v] of Object.entries(c.env)) env[k] = v;

  if (c.skipIndex) env.BENCH_SKIP_INDEX = '1';
  else delete env.BENCH_SKIP_INDEX;

  const out = execFileSync(process.execPath, [RUN_V3], {
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  });

  const lines    = out.trim().split('\n');
  const jsonLine = [...lines].reverse().find(l => l.trimStart().startsWith('{'));
  if (!jsonLine) throw new Error(`No JSON from run-v3.js for "${c.label}"`);
  return JSON.parse(jsonLine);
}

// ── Query helpers ─────────────────────────────────────────────────────────────

function parseChunkId(chunkId) {
  if (!chunkId) return null;
  const hash = chunkId.lastIndexOf('#');
  if (hash < 0) return null;
  const sourceFile  = chunkId.slice(0, hash);
  const chunkIndex  = parseInt(chunkId.slice(hash + 1), 10);
  if (!sourceFile || !Number.isFinite(chunkIndex)) return null;
  return { sourceFile, chunkIndex };
}

// Best rank of any rel≥3 chunk in topChunks (1-based, or null if not found).
function bestExactRank(topChunks, exactIds) {
  for (let i = 0; i < topChunks.length; i++) {
    if (exactIds.has(topChunks[i].chunkId)) return i + 1;
  }
  return null;
}

// Classify a failing query (chunkRecall@5 !== true) by most specific category.
function classifyFailure(qr, qrelMap) {
  const relevantChunks = qrelMap.get(qr.id) ?? [];
  const exactIds  = new Set(relevantChunks.filter(rc => rc.relevance >= 3).map(rc => rc.chunkId));
  const supportIds = new Set(relevantChunks.filter(rc => rc.relevance >= 2).map(rc => rc.chunkId));
  const returned  = qr.topChunks ?? [];

  // rank6-10: exact chunk present in results but outside top-5.
  if (returned.slice(5).some(c => exactIds.has(c.chunkId))) return 'rank6-10';

  // window: a ±WINDOW neighbor of an exact chunk is in top-K.
  const windowHit = [...exactIds].some(exactId => {
    const ep = parseChunkId(exactId);
    if (!ep) return false;
    return returned.some(c => {
      const rp = parseChunkId(c.chunkId);
      if (!rp) return false;
      return rp.sourceFile === ep.sourceFile && Math.abs(rp.chunkIndex - ep.chunkIndex) <= WINDOW;
    });
  });
  if (windowHit) return 'window';

  if (returned.some(c => supportIds.has(c.chunkId))) return 'support-only';
  return 'total-miss';
}

// ── Formatting ────────────────────────────────────────────────────────────────

function pad(s, n)  { return String(s).padEnd(n); }
function lpad(s, n) { return String(s).padStart(n); }
function pct(v, d = 1) { return v == null ? 'n/a' : `${(v * 100).toFixed(d)}%`; }
function f3(v)  { return v == null ? 'n/a' : v.toFixed(3); }

function today() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

// ── Report builder ────────────────────────────────────────────────────────────

function buildReport(candidateResults, rawQueries) {
  const lines = [];
  const SEP  = '═'.repeat(88);
  const SEP2 = '─'.repeat(88);
  const labels = candidateResults.map(r => r.label);

  const qrelMap = new Map(
    rawQueries.queries.map(q => [q.id, q.relevantChunks ?? []])
  );
  const queryMap = new Map(rawQueries.queries.map(q => [q.id, q]));

  // ── Header ─────────────────────────────────────────────────────────────────
  lines.push(SEP);
  lines.push('  custom-50 candidate comparison');
  lines.push(`  Candidates : ${labels.join(', ')}`);
  lines.push(`  Provider   : onnx (bge-m3-onnx/bge-m3-onnx), hybrid RRF, top-${candidateResults[0].topK}`);
  lines.push(SEP);
  lines.push('');

  // ── Aggregate metrics table ────────────────────────────────────────────────
  const COL = Math.max(18, Math.max(...labels.map(l => l.length)));
  const LW  = 22;
  const msep = '-'.repeat(LW + labels.length * (COL + 2));

  lines.push('Aggregate metrics:');
  lines.push(msep);
  let hdr = pad('', LW);
  for (const l of labels) hdr += '  ' + lpad(l, COL);
  lines.push(hdr);
  lines.push(msep);

  function mrow(name, fn) {
    let line = pad(name, LW);
    for (const r of candidateResults) line += '  ' + lpad(fn(r.metrics), COL);
    lines.push(line);
  }

  mrow('chunkRecall@5',    m => pct(m.chunkRecall5));
  mrow('chunkRecall@10',   m => pct(m.chunkRecall10));
  mrow('windowRecall@5',   m => pct(m.windowRecall5));
  mrow('windowRecall@10',  m => pct(m.windowRecall10));
  mrow('supportRecall@10', m => pct(m.supportRecallK));
  mrow('nDCG@10',          m => f3(m.ndcgK));
  mrow('MRR@10',           m => f3(m.mrr10));
  mrow('fileRecall@10',    m => pct(m.fileRecallK));
  mrow('p50 ms',           m => `${m.p50Latency}ms`);
  mrow('p95 ms',           m => `${m.p95Latency}ms`);

  lines.push(msep);
  lines.push('');

  // ── Per-query rank comparison ──────────────────────────────────────────────
  // For each positive query: best rank of any rel≥3 chunk per candidate.

  const baseResult = candidateResults[0];
  const positiveIds = baseResult.queryResults
    .filter(r => !r.isNegative)
    .map(r => r.id);

  lines.push('Per-query best rank of rel≥3 chunk (— = not found in top-K):');
  lines.push(msep);
  const rankHdr = pad('ID', 5) + '  ' + pad('Query (truncated)', 38) + '  ' +
    labels.map(l => lpad(l.slice(0, COL), COL)).join('  ');
  lines.push(rankHdr);
  lines.push(msep);

  // Build per-query rank lookup: label → id → rank|null
  const rankLookup = new Map(); // label → Map(id → rank|null)
  for (const cr of candidateResults) {
    const m = new Map();
    for (const qr of cr.queryResults) {
      if (qr.isNegative) continue;
      const relevantChunks = qrelMap.get(qr.id) ?? [];
      const exactIds = new Set(relevantChunks.filter(rc => rc.relevance >= 3).map(rc => rc.chunkId));
      m.set(qr.id, bestExactRank(qr.topChunks ?? [], exactIds));
    }
    rankLookup.set(cr.label, m);
  }

  for (const id of positiveIds) {
    const rawQ  = queryMap.get(id);
    const qtext = (rawQ?.query ?? id).slice(0, 37);
    let line = pad(id, 5) + '  ' + pad(qtext, 38) + '  ';
    const rankCells = labels.map(l => {
      const rank = rankLookup.get(l)?.get(id);
      return lpad(rank != null ? `#${rank}` : '—', COL);
    });
    line += rankCells.join('  ');
    lines.push(line);
  }

  lines.push(msep);
  lines.push('');

  // ── Improvements and regressions vs baseline ──────────────────────────────
  // A query "improves" if rank moved from null→found, or rank decreased (closer to 1).
  // A query "regresses" if rank moved from found→null, or rank increased.

  const baseRankMap = rankLookup.get(baseResult.label);

  for (const cr of candidateResults.slice(1)) {
    const cRankMap = rankLookup.get(cr.label);
    const improved  = [];
    const regressed = [];
    const unchanged = [];

    for (const id of positiveIds) {
      const baseRank = baseRankMap.get(id);
      const cRank    = cRankMap.get(id);

      if (baseRank === cRank) {
        unchanged.push({ id, rank: cRank });
      } else if (cRank != null && (baseRank == null || cRank < baseRank)) {
        improved.push({ id, from: baseRank, to: cRank });
      } else {
        regressed.push({ id, from: baseRank, to: cRank });
      }
    }

    lines.push(SEP2);
    lines.push(`${cr.label} vs baseline:`);
    lines.push(SEP2);

    if (improved.length) {
      lines.push(`  Improved (${improved.length}):`);
      for (const { id, from, to } of improved) {
        const rawQ  = queryMap.get(id);
        const fromS = from != null ? `#${from}` : 'miss';
        lines.push(`    ${pad(id, 5)}  ${fromS} → #${to}  ${(rawQ?.query ?? '').slice(0, 55)}`);
      }
    } else {
      lines.push('  Improved (0): —');
    }
    lines.push('');

    if (regressed.length) {
      lines.push(`  Regressed (${regressed.length}):`);
      for (const { id, from, to } of regressed) {
        const rawQ  = queryMap.get(id);
        const fromS = from != null ? `#${from}` : 'miss';
        const toS   = to   != null ? `#${to}`   : 'miss';
        lines.push(`    ${pad(id, 5)}  ${fromS} → ${toS}  ${(rawQ?.query ?? '').slice(0, 55)}`);
      }
    } else {
      lines.push('  Regressed (0): —');
    }
    lines.push('');
  }

  // ── Remaining failures per candidate ─────────────────────────────────────
  lines.push(SEP);
  lines.push('Remaining failures (chunkRecall@5) per candidate:');
  lines.push('');

  const topK = candidateResults[0].topK ?? 10;
  const rankLabel = `rank6-${topK}`;

  for (const cr of candidateResults) {
    const failures = cr.queryResults.filter(r => !r.isNegative && r.chunkRecall5 !== true);
    const cats = { 'rank6-10': [], 'window': [], 'support-only': [], 'total-miss': [] };
    for (const qr of failures) cats[classifyFailure(qr, qrelMap)].push(qr.id);

    lines.push(`  ${cr.label}  (${failures.length} failures):`);
    lines.push(`    ${pad(rankLabel, 12)} : ${cats['rank6-10'].length}  ${cats['rank6-10'].join(', ')}`);
    lines.push(`    window (±${WINDOW})  : ${cats['window'].length}  ${cats['window'].join(', ')}`);
    lines.push(`    support-only : ${cats['support-only'].length}  ${cats['support-only'].join(', ')}`);
    lines.push(`    total-miss   : ${cats['total-miss'].length}  ${cats['total-miss'].join(', ')}`);
    lines.push('');
  }

  // ── Recommendation ────────────────────────────────────────────────────────
  lines.push(SEP);
  lines.push('Recommendation (based on this run only — cross-validate before changing defaults):');
  lines.push('');

  // Auto-derive observations from the data.
  const base = candidateResults[0];
  const observations = [];

  for (const cr of candidateResults.slice(1)) {
    const dCR5  = ((cr.metrics.chunkRecall5  ?? 0) - (base.metrics.chunkRecall5  ?? 0)) * 100;
    const dCR10 = ((cr.metrics.chunkRecall10 ?? 0) - (base.metrics.chunkRecall10 ?? 0)) * 100;
    const dNDCG = (cr.metrics.ndcgK  ?? 0) - (base.metrics.ndcgK  ?? 0);
    const dMRR  = (cr.metrics.mrr10  ?? 0) - (base.metrics.mrr10  ?? 0);
    const dP95  = (cr.metrics.p95Latency ?? 0) - (base.metrics.p95Latency ?? 0);

    const sign = v => (v > 0 ? '+' : '') + v.toFixed(1);
    const sign3 = v => (v > 0 ? '+' : '') + v.toFixed(3);

    const crStr  = `CR@5 ${sign(dCR5)}pp, CR@10 ${sign(dCR10)}pp`;
    const rankStr = `nDCG ${sign3(dNDCG)}, MRR ${sign3(dMRR)}`;
    const latStr  = `p95 ${sign(dP95)}ms`;

    const noRegress = dCR5 >= -0.001;
    const rankGain  = dNDCG > 0.005 || dMRR > 0.010;

    let verdict;
    if (!noRegress) {
      verdict = 'REGRESSES recall — do not promote.';
    } else if (rankGain) {
      verdict = 'Improves ranking without recall regression — promising candidate.';
    } else {
      verdict = 'Neutral — no meaningful recall or ranking change.';
    }

    observations.push(`  ${cr.label}:`);
    observations.push(`    ${crStr} | ${rankStr} | ${latStr}`);
    observations.push(`    ${verdict}`);
    observations.push('');
  }

  lines.push(...observations);
  lines.push('  Production defaults should not be changed from a single run.');
  lines.push('  Cross-validate across multiple runs and inspect per-query regressions before promoting.');
  lines.push('');
  lines.push(SEP);

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

const rawQueries    = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
const candidateData = [];

for (const c of CANDIDATES) {
  candidateData.push({ label: c.label, ...runCandidate(c) });
}

const report = buildReport(candidateData, rawQueries);
process.stdout.write(report + '\n');

mkdirSync(RESULTS, { recursive: true });
const outPath = resolve(RESULTS, `${today()}-custom50-candidate-comparison.txt`);
writeFileSync(outPath, report + '\n', 'utf8');
process.stderr.write(`\nSaved: ${outPath}\n`);
