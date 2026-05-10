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

Variants (all using bge-m3-onnx, hybrid RRF, top-10):
  1. baseline           — default RRF_K=60, HYBRID_PREFETCH_LIMIT=2
  2. rrf-k30            — RRF_K=30
  3. rrf-k20            — RRF_K=20
  4. prefetch-40        — HYBRID_PREFETCH_LIMIT=40
  5. prefetch-80        — HYBRID_PREFETCH_LIMIT=80
  6. rerank             — RERANK_ENABLED=1
  7. rerank+protect     — RERANK_ENABLED=1 + RERANK_PROTECT_TOP1_DELTA=0.05 (default)
  8. dense-mmr          — BENCH_SEARCH_MODE=dense-mmr (control, no RRF)

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

const VARIANTS = [
  {
    label:   'baseline',
    env:     {},
    skipIndex: false,
    searchMode: 'hybrid',
  },
  {
    label:   'rrf-k30',
    env:     { RRF_K: '30' },
    skipIndex: true,
    searchMode: 'hybrid',
  },
  {
    label:   'rrf-k20',
    env:     { RRF_K: '20' },
    skipIndex: true,
    searchMode: 'hybrid',
  },
  {
    label:   'prefetch-40',
    env:     { HYBRID_PREFETCH_LIMIT: '40' },
    skipIndex: true,
    searchMode: 'hybrid',
  },
  {
    label:   'prefetch-80',
    env:     { HYBRID_PREFETCH_LIMIT: '80' },
    skipIndex: true,
    searchMode: 'hybrid',
  },
  {
    label:   'rerank',
    env:     { RERANK_ENABLED: '1', RERANK_PROTECT_TOP1_DELTA: '0' },
    skipIndex: true,
    searchMode: 'hybrid',
  },
  {
    label:   'rerank+protect',
    env:     { RERANK_ENABLED: '1' },
    skipIndex: true,
    searchMode: 'hybrid',
  },
  {
    label:   'dense-mmr',
    env:     { MMR_DIVERSITY: '0.5' },
    skipIndex: true,
    searchMode: 'dense-mmr',
  },
];

function runVariant(v) {
  process.stderr.write(`\nRunning: ${v.label}...\n`);
  const env = { ...process.env };

  // Force ONNX provider.
  env.ONNX_EMBED       = '1';
  env.BENCH_PROVIDER   = 'onnx';
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

  // Header
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

  row('chunkRecall@5',     m => pct(m.chunkRecall5));
  row('chunkRecall@10',    m => pct(m.chunkRecall10));
  row('windowRecall@5',    m => pct(m.windowRecall5));
  row('windowRecall@10',   m => pct(m.windowRecall10));
  row('supportRecall@10',  m => pct(m.supportRecallK));
  row('nDCG@10',           m => f3(m.ndcgK));
  row('MRR@10',            m => f3(m.mrr10));
  row('fileRecall@10',     m => pct(m.fileRecallK));
  row('p50 ms',            m => `${m.p50Latency}ms`);
  row('p95 ms',            m => `${m.p95Latency}ms`);

  lines.push(sep);
  lines.push('');

  // Delta table vs baseline.
  const base = results.find(r => r.label === 'baseline');
  if (base) {
    lines.push('Deltas vs baseline:');
    lines.push(sep);
    let dhdr = pad('', LW);
    for (const l of labels.filter(l => l !== 'baseline'))
      dhdr += '  ' + lpad(l.slice(0, COL), COL);
    lines.push(dhdr);
    lines.push(sep);

    function deltaRow(name, fn, fmt) {
      const nonBase = results.filter(r => r.label !== 'baseline');
      let line = pad(name, LW);
      for (const r of nonBase) {
        const bv = fn(base.metrics);
        const rv = fn(r.metrics);
        const delta = (bv != null && rv != null) ? rv - bv : null;
        line += '  ' + lpad(fmt(delta), COL);
      }
      lines.push(line);
    }

    deltaRow('chunkRecall@5',    m => m.chunkRecall5,   sign);
    deltaRow('chunkRecall@10',   m => m.chunkRecall10,  sign);
    deltaRow('windowRecall@5',   m => m.windowRecall5,  sign);
    deltaRow('windowRecall@10',  m => m.windowRecall10, sign);
    deltaRow('nDCG@10',          m => m.ndcgK,          signF);
    deltaRow('MRR@10',           m => m.mrr10,          signF);

    lines.push(sep);
    lines.push('');
  }

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

// Save to results directory.
mkdirSync(RESULTS, { recursive: true });
const outPath = resolve(RESULTS, `${today()}-custom50-tuning-matrix.txt`);
writeFileSync(outPath, table + '\n', 'utf8');
process.stderr.write(`\nSaved: ${outPath}\n`);
