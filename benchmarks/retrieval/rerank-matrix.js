// Rerank matrix benchmark: runs 4 provider × rerank combinations and prints a
// side-by-side summary so you can see the effect of reranking on both providers.
//
// Combinations:
//   ollama+hashed-tf  without rerank
//   ollama+hashed-tf  with    rerank (RERANK_ENABLED=1)
//   bge-m3-onnx       without rerank
//   bge-m3-onnx       with    rerank (RERANK_ENABLED=1)
//
// Usage:
//   npm run bench:retrieval:rerank
//   RERANK_PREFETCH_MULT=8 npm run bench:retrieval:rerank

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUERIES_PATH = resolve(__dirname, 'queries.json');
const queries = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));

function pad(s, n)  { return String(s).padEnd(n); }
function lpad(s, n) { return String(s).padStart(n); }
function pct(v)     { return `${(v * 100).toFixed(1)}%`; }
function sign(v, decimals = 1) { return v > 0 ? `+${v.toFixed(decimals)}` : v.toFixed(decimals); }

// rerank=false → fresh index; rerank=true → BENCH_SKIP_INDEX=1 on the same index.
// This ensures no-rerank and +rerank variants run against identical vectors,
// making the delta meaningful.
const VARIANTS = [
  { label: 'ollama',        provider: 'env',  rerank: false, skipIndex: false },
  { label: 'ollama+rerank', provider: 'env',  rerank: true,  skipIndex: true  },
  { label: 'onnx',          provider: 'onnx', rerank: false, skipIndex: false },
  { label: 'onnx+rerank',   provider: 'onnx', rerank: true,  skipIndex: true  },
];

function runVariant({ label, provider, rerank, skipIndex }) {
  process.stderr.write(`\nRunning: ${label}...\n`);
  const env = { ...process.env };
  if (skipIndex) {
    env.BENCH_SKIP_INDEX = '1';
  } else {
    delete env.BENCH_SKIP_INDEX;
  }
  if (provider === 'onnx') {
    env.ONNX_EMBED      = '1';
    env.DENSE_PROVIDER  = 'bge-m3-onnx';
    env.SPARSE_PROVIDER = 'bge-m3-onnx';
    delete env.DENSE_MODEL;
    delete env.EMBED_MODEL;
  } else {
    // Force ollama+hashed-tf explicitly so a .env with ONNX_EMBED=1 can't bleed in.
    env.ONNX_EMBED      = '0';
    env.DENSE_PROVIDER  = 'ollama';
    env.SPARSE_PROVIDER = 'hashed-tf';
    env.DENSE_MODEL     = 'bge-m3';
    env.EMBED_MODEL     = 'bge-m3';
  }
  env.BENCH_PROVIDER = provider;
  env.BENCH_JSON     = '1';
  env.BENCH_SEARCH_MODE = 'hybrid';
  env.RERANK_ENABLED = rerank ? '1' : '0';

  const out = execFileSync(
    process.execPath,
    [resolve(__dirname, 'run.js')],
    { env, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }
  );

  const lines = out.trim().split('\n');
  const jsonLine = [...lines].reverse().find(l => l.trimStart().startsWith('{'));
  if (!jsonLine) throw new Error(`No JSON output from run.js for variant "${label}"`);
  return { label, ...JSON.parse(jsonLine) };
}

function printMatrix(results) {
  const labels = results.map(r => r.label);
  const COL = 14; // column width per variant

  // ── Per-query table ────────────────────────────────────────────────────────
  const W_ID    = 4;
  const W_QUERY = 36;
  const W_EXP   = 13;
  const rowWidth = W_ID + 2 + W_QUERY + 2 + W_EXP + labels.reduce((s) => s + 2 + COL, 0);
  const sep = '─'.repeat(rowWidth);

  console.log('\n' + sep);
  let header = pad('ID', W_ID) + '  ' + pad('Query', W_QUERY) + '  ' + pad('Expected', W_EXP);
  for (const l of labels) header += '  ' + lpad(l, COL);
  console.log(header);
  console.log(sep);

  for (const q of queries) {
    const row0 = results[0].queryResults.find(r => r.id === q.id);
    let line = pad(q.id, W_ID) + '  ' + pad(q.query.slice(0, W_QUERY - 1), W_QUERY) + '  ' + pad(row0.expected[0], W_EXP);
    for (const res of results) {
      const qr = res.queryResults.find(r => r.id === q.id);
      const rankStr = qr.rank >= 0 ? `#${qr.rank + 1}` : 'miss';
      line += '  ' + lpad(rankStr, COL);
    }
    console.log(line);
  }

  console.log(sep);

  // ── Summary table ──────────────────────────────────────────────────────────
  const SEP2 = '─'.repeat(50);
  console.log('\n' + SEP2);
  const LW = 16;
  let hdr = pad('', LW);
  for (const l of labels) hdr += '  ' + lpad(l.slice(0, COL), COL);
  console.log(hdr);
  console.log(SEP2);

  function metricRow(name, fn) {
    let line = pad(name, LW);
    for (const r of results) line += '  ' + lpad(fn(r.metrics), COL);
    console.log(line);
  }

  metricRow('Recall@1',  m => pct(m.recall1));
  metricRow(`Recall@${results[0].topK}`, m => pct(m.recallK));
  metricRow('MRR',       m => m.mrr.toFixed(3));
  metricRow('Avg ms',    m => `${Math.round(m.avgLatency)}ms`);

  console.log(SEP2);

  // ── Delta vs no-rerank baseline (per provider) ─────────────────────────────
  console.log('\nDeltas vs no-rerank baseline:');
  const pairs = [
    { base: results[0], reranked: results[1] }, // ollama vs ollama+rerank
    { base: results[2], reranked: results[3] }, // onnx   vs onnx+rerank
  ];
  for (const { base, reranked } of pairs) {
    const dr1  = (reranked.metrics.recall1   - base.metrics.recall1)   * 100;
    const dmrr =  reranked.metrics.mrr       - base.metrics.mrr;
    const dms  =  reranked.metrics.avgLatency - base.metrics.avgLatency;
    console.log(
      `  ${pad(reranked.label, 14)} vs ${pad(base.label, 14)}: ` +
      `Recall@1 ${sign(dr1)}pp  MRR ${sign(dmrr, 3)}  ms ${sign(dms)}ms`
    );
  }
}

const results = [];
for (const v of VARIANTS) {
  results.push(runVariant(v));
}

console.log('\n\n=== RERANK MATRIX ===');
printMatrix(results);
console.log('');
