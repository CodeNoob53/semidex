// Tuning matrix for custom-50 quality benchmark.
//
// Evaluates RRF_K, HYBRID_PREFETCH_LIMIT, and RERANK_ENABLED knobs
// against the ONNX baseline without changing any retrieval algorithm.
//
// All variants after the first reuse the indexed collection (BENCH_SKIP_INDEX=1).
// Results are printed to stdout and saved to benchmarks/retrieval/results/.
//
// Usage:
//   npm run bench:custom50:tune
//   BENCH_TOP_K=10 npm run bench:custom50:tune

if (process.argv.includes('--help')) {
  process.stdout.write(`semidex custom-50 tuning matrix

Variants (all using bge-m3-onnx, hybrid RRF, top-10 unless noted):
  1.  baseline              — default RRF_K=60, HYBRID_PREFETCH_LIMIT=2
  2.  rrf-k30               — RRF_K=30
  3.  rrf-k20               — RRF_K=20
  4.  prefetch-4            — HYBRID_PREFETCH_LIMIT=4
  5.  prefetch-8            — HYBRID_PREFETCH_LIMIT=8
  6.  prefetch-20           — HYBRID_PREFETCH_LIMIT=20
  7.  prefetch-40           — HYBRID_PREFETCH_LIMIT=40
  8.  prefetch-80           — HYBRID_PREFETCH_LIMIT=80
  9.  rerank                — RERANK_ENABLED=1, no top-1 protection
  10. rerank+protect        — RERANK_ENABLED=1, default RERANK_PROTECT_TOP1_DELTA=0.05
  11. prefetch-20+rerank    — HYBRID_PREFETCH_LIMIT=20 + RERANK_ENABLED=1
  12. prefetch-40+rerank    — HYBRID_PREFETCH_LIMIT=40 + RERANK_ENABLED=1
  13. prefetch-80+rerank    — HYBRID_PREFETCH_LIMIT=80 + RERANK_ENABLED=1
  14. prefetch-20+rerank+p  — HYBRID_PREFETCH_LIMIT=20 + rerank with protection
  15. prefetch-40+rerank+p  — HYBRID_PREFETCH_LIMIT=40 + rerank with protection
  16. prefetch-80+rerank+p  — HYBRID_PREFETCH_LIMIT=80 + rerank with protection
  17. dense-mmr             — BENCH_SEARCH_MODE=dense-mmr (control, no RRF)

Usage:
  npm run bench:custom50:tune
  BENCH_TOP_K=10 npm run bench:custom50:tune

Output: benchmarks/retrieval/results/YYYY-MM-DD-custom50-tuning-matrix.txt
`);
  process.exit(0);
}

import { execFileSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_V3    = resolve(__dirname, 'run-v3.js');
const RESULTS   = resolve(__dirname, '../results');

function pad(s, n)  { return String(s).padEnd(n); }
function lpad(s, n) { return String(s).padStart(n); }
function pct(v, d = 1) { return v == null ? 'n/a' : `${(v * 100).toFixed(d)}%`; }
function f3(v)    { return v == null ? 'n/a' : v.toFixed(3); }
function sign(v, d = 1) {
  if (v == null) return 'n/a';
  return (v > 0 ? '+' : '') + (v * 100).toFixed(d) + 'pp';
}
function signF(v, d = 3) {
  if (v == null) return 'n/a';
  return (v > 0 ? '+' : '') + v.toFixed(d);
}

// rerank env: no top-1 protection (isolates pure rerank effect).
const RERANK_PLAIN   = { RERANK_ENABLED: '1', RERANK_PROTECT_TOP1_DELTA: '0' };
// rerank+protect env: uses default RERANK_PROTECT_TOP1_DELTA=0.05.
const RERANK_PROTECT = { RERANK_ENABLED: '1' };

const VARIANTS = [
  // ── RRF_K variants ───────────────────────────────────────────────────────
  { label: 'baseline',    env: {},                                            skipIndex: false, searchMode: 'hybrid' },
  { label: 'rrf-k30',     env: { RRF_K: '30' },                              skipIndex: true,  searchMode: 'hybrid' },
  { label: 'rrf-k20',     env: { RRF_K: '20' },                              skipIndex: true,  searchMode: 'hybrid' },

  // ── Prefetch-only variants ────────────────────────────────────────────────
  { label: 'prefetch-4',  env: { HYBRID_PREFETCH_LIMIT: '4' },               skipIndex: true,  searchMode: 'hybrid' },
  { label: 'prefetch-8',  env: { HYBRID_PREFETCH_LIMIT: '8' },               skipIndex: true,  searchMode: 'hybrid' },
  { label: 'prefetch-20', env: { HYBRID_PREFETCH_LIMIT: '20' },              skipIndex: true,  searchMode: 'hybrid' },
  { label: 'prefetch-40', env: { HYBRID_PREFETCH_LIMIT: '40' },              skipIndex: true,  searchMode: 'hybrid' },
  { label: 'prefetch-80', env: { HYBRID_PREFETCH_LIMIT: '80' },              skipIndex: true,  searchMode: 'hybrid' },

  // ── Rerank-only variants (default prefetch) ───────────────────────────────
  { label: 'rerank',         env: { ...RERANK_PLAIN },                        skipIndex: true,  searchMode: 'hybrid' },
  { label: 'rerank+protect', env: { ...RERANK_PROTECT },                      skipIndex: true,  searchMode: 'hybrid' },

  // ── Combined prefetch + rerank (no protection) ────────────────────────────
  { label: 'prefetch-20+rerank', env: { HYBRID_PREFETCH_LIMIT: '20', ...RERANK_PLAIN },   skipIndex: true, searchMode: 'hybrid' },
  { label: 'prefetch-40+rerank', env: { HYBRID_PREFETCH_LIMIT: '40', ...RERANK_PLAIN },   skipIndex: true, searchMode: 'hybrid' },
  { label: 'prefetch-80+rerank', env: { HYBRID_PREFETCH_LIMIT: '80', ...RERANK_PLAIN },   skipIndex: true, searchMode: 'hybrid' },

  // ── Combined prefetch + rerank + top-1 protection ─────────────────────────
  { label: 'prefetch-20+rerank+p', env: { HYBRID_PREFETCH_LIMIT: '20', ...RERANK_PROTECT }, skipIndex: true, searchMode: 'hybrid' },
  { label: 'prefetch-40+rerank+p', env: { HYBRID_PREFETCH_LIMIT: '40', ...RERANK_PROTECT }, skipIndex: true, searchMode: 'hybrid' },
  { label: 'prefetch-80+rerank+p', env: { HYBRID_PREFETCH_LIMIT: '80', ...RERANK_PROTECT }, skipIndex: true, searchMode: 'hybrid' },

  // ── Control: dense MMR (no RRF, no rerank) ────────────────────────────────
  { label: 'dense-mmr', env: { MMR_DIVERSITY: '0.5' },                        skipIndex: true,  searchMode: 'dense-mmr' },
];

function runVariant(v) {
  process.stderr.write(`\nRunning: ${v.label}...\n`);
  const env = { ...process.env };

  // Force ONNX provider.
  env.ONNX_EMBED     = '1';
  env.BENCH_PROVIDER = 'onnx';
  delete env.DENSE_PROVIDER;
  delete env.SPARSE_PROVIDER;

  // Rerank off by default unless variant sets it.
  env.RERANK_ENABLED = '0';

  // Apply variant-specific overrides.
  for (const [k, val] of Object.entries(v.env)) {
    env[k] = val;
  }

  env.BENCH_SEARCH_MODE = v.searchMode;
  env.BENCH_JSON        = '1';
  if (v.skipIndex) env.BENCH_SKIP_INDEX = '1';
  else delete env.BENCH_SKIP_INDEX;

  const out = execFileSync(
    process.execPath,
    [RUN_V3],
    { env, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }
  );

  const lines    = out.trim().split('\n');
  const jsonLine = [...lines].reverse().find(l => l.trimStart().startsWith('{'));
  if (!jsonLine) throw new Error(`No JSON output from run-v3.js for variant "${v.label}"`);
  return { label: v.label, ...JSON.parse(jsonLine) };
}

function buildTable(results) {
  const labels = results.map(r => r.label);
  const COL    = Math.max(14, Math.max(...labels.map(l => l.length)));
  const LW     = 22;
  const sep    = '-'.repeat(LW + labels.length * (COL + 2));

  const lines = [];

  lines.push('');
  lines.push('=== custom-50 TUNING MATRIX ===');
  lines.push('');

  // ── Main metrics table ────────────────────────────────────────────────────
  lines.push(sep);
  let hdr = pad('', LW);
  for (const l of labels) hdr += '  ' + lpad(l.slice(0, COL), COL);
  lines.push(hdr);
  lines.push(sep);

  function row(name, fn) {
    let line = pad(name, LW);
    for (const r of results) line += '  ' + lpad(fn(r.metrics), COL);
    lines.push(line);
  }

  row('chunkRecall@5',    m => pct(m.chunkRecall5));
  row('chunkRecall@10',   m => pct(m.chunkRecall10));
  row('windowRecall@5',   m => pct(m.windowRecall5));
  row('windowRecall@10',  m => pct(m.windowRecall10));
  row('supportRecall@10', m => pct(m.supportRecallK));
  row('nDCG@10',          m => f3(m.ndcgK));
  row('MRR@10',           m => f3(m.mrr10));
  row('fileRecall@10',    m => pct(m.fileRecallK));
  row('p50 ms',           m => `${m.p50Latency}ms`);
  row('p95 ms',           m => `${m.p95Latency}ms`);

  lines.push(sep);
  lines.push('');

  // ── Delta table vs baseline ───────────────────────────────────────────────
  const base = results.find(r => r.label === 'baseline');
  if (base) {
    const nonBase = results.filter(r => r.label !== 'baseline');
    const dsep = '-'.repeat(LW + nonBase.length * (COL + 2));

    lines.push('Deltas vs baseline:');
    lines.push(dsep);
    let dhdr = pad('', LW);
    for (const r of nonBase) dhdr += '  ' + lpad(r.label.slice(0, COL), COL);
    lines.push(dhdr);
    lines.push(dsep);

    function deltaRow(name, fn, fmt) {
      let line = pad(name, LW);
      for (const r of nonBase) {
        const bv = fn(base.metrics);
        const rv = fn(r.metrics);
        const delta = (bv != null && rv != null) ? rv - bv : null;
        line += '  ' + lpad(fmt(delta), COL);
      }
      lines.push(line);
    }

    deltaRow('chunkRecall@5',   m => m.chunkRecall5,   sign);
    deltaRow('chunkRecall@10',  m => m.chunkRecall10,  sign);
    deltaRow('windowRecall@5',  m => m.windowRecall5,  sign);
    deltaRow('windowRecall@10', m => m.windowRecall10, sign);
    deltaRow('nDCG@10',         m => m.ndcgK,          signF);
    deltaRow('MRR@10',          m => m.mrr10,          signF);

    lines.push(dsep);
    lines.push('');
  }

  // ── Best candidates block ─────────────────────────────────────────────────
  const baseCR5 = base?.metrics?.chunkRecall5 ?? 0;

  // "No regression" = chunkRecall@5 >= baseline.
  const noReg = results.filter(r => (r.metrics?.chunkRecall5 ?? 0) >= baseCR5);

  function bestMetric(pool, fn, fmt, higher = true) {
    let winner = null;
    let winVal = higher ? -Infinity : Infinity;
    for (const r of pool) {
      const v = fn(r.metrics);
      if (v == null) continue;
      if (higher ? v > winVal : v < winVal) { winVal = v; winner = r.label; }
    }
    return winner ? `${winner} (${fmt(winVal)})` : 'n/a';
  }

  lines.push('Best candidates:');
  lines.push(`  best chunkRecall@5    : ${bestMetric(results, m => m.chunkRecall5,   pct)}`);
  lines.push(`  best windowRecall@5   : ${bestMetric(results, m => m.windowRecall5,  pct)}`);
  lines.push(`  best nDCG@10          : ${bestMetric(results, m => m.ndcgK,          f3)}`);
  lines.push(`  best MRR@10           : ${bestMetric(results, m => m.mrr10,          f3)}`);
  lines.push(`  lowest p95 (no-regr.) : ${bestMetric(noReg,   m => m.p95Latency,     v => `${v}ms`, false)}`);
  lines.push('');
  lines.push('  "no-regr." = chunkRecall@5 >= baseline. Do not change production');
  lines.push('  defaults from a single run; cross-validate across multiple runs.');
  lines.push('');

  return lines.join('\n');
}

function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const results = [];
for (const v of VARIANTS) {
  results.push(runVariant(v));
}

const table = buildTable(results);
process.stdout.write(table + '\n');

mkdirSync(RESULTS, { recursive: true });
const outPath = resolve(RESULTS, `${today()}-custom50-tuning-matrix.txt`);
writeFileSync(outPath, table + '\n', 'utf8');
process.stderr.write(`\nSaved: ${outPath}\n`);
