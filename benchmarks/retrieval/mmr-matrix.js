// MMR diversity benchmark: compares hybrid RRF against dense MMR for both
// providers and several diversity values.
//
// MMR is evaluated as a dense-nearest query mode. It is not a replacement for
// hybrid RRF in production; this script measures the relevance/diversity tradeoff.
//
// Usage:
//   npm run bench:retrieval:mmr
//   MMR_DIVERSITIES=0.2,0.5,0.8 npm run bench:retrieval:mmr
//   MMR_CANDIDATES_LIMIT=200 npm run bench:retrieval:mmr

if (process.argv.includes('--help')) {
  process.stdout.write(`semidex MMR diversity matrix

Usage:
  node benchmarks/retrieval/mmr-matrix.js
  npm run bench:retrieval:mmr

Options (env vars):
  MMR_DIVERSITIES=0.3,0.5,0.7   Comma-separated diversity values in [0, 1]
  MMR_CANDIDATES_LIMIT=100      Dense MMR preselect candidate count
  BENCH_TOP_K=5                 Search depth passed to run.js

This script compares hybrid RRF baselines against dense MMR variants for both
ollama and bge-m3-onnx providers. MMR variants reuse the same provider index
with BENCH_SKIP_INDEX=1 to avoid measuring reindex variance.
`);
  process.exit(0);
}

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUERIES_PATH = resolve(__dirname, 'queries.json');
const queries = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));

function pad(s, n)  { return String(s).padEnd(n); }
function lpad(s, n) { return String(s).padStart(n); }
function pct(v)     { return v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`; }
function sign(v, decimals = 1) { return v > 0 ? `+${v.toFixed(decimals)}` : v.toFixed(decimals); }

function parseDiversities() {
  const raw = process.env.MMR_DIVERSITIES ?? '0.3,0.5,0.7';
  const values = raw.split(',').map(v => Number.parseFloat(v.trim())).filter(Number.isFinite);
  const valid = values.filter(v => v >= 0 && v <= 1);
  if (!valid.length) throw new Error(`MMR_DIVERSITIES="${raw}" has no valid values in [0, 1]`);
  return valid;
}

const DIVERSITIES = parseDiversities();

function providerEnv(env, provider) {
  if (provider === 'onnx') {
    env.ONNX_EMBED      = '1';
    env.DENSE_PROVIDER  = 'bge-m3-onnx';
    env.SPARSE_PROVIDER = 'bge-m3-onnx';
    delete env.DENSE_MODEL;
    delete env.EMBED_MODEL;
  } else {
    env.ONNX_EMBED      = '0';
    env.DENSE_PROVIDER  = 'ollama';
    env.SPARSE_PROVIDER = 'hashed-tf';
    env.DENSE_MODEL     = 'bge-m3';
    env.EMBED_MODEL     = 'bge-m3';
  }
}

function buildVariants() {
  const variants = [];
  for (const provider of ['ollama', 'onnx']) {
    variants.push({
      label: `${provider}-rrf`,
      provider,
      benchProvider: provider === 'onnx' ? 'onnx' : 'env',
      searchMode: 'hybrid',
      skipIndex: false,
    });
    for (const diversity of DIVERSITIES) {
      variants.push({
        label: `${provider}-mmr${diversity}`,
        provider,
        benchProvider: provider === 'onnx' ? 'onnx' : 'env',
        searchMode: 'dense-mmr',
        diversity,
        skipIndex: true,
      });
    }
  }
  return variants;
}

function runVariant(v) {
  process.stderr.write(`\nRunning: ${v.label}...\n`);
  const env = { ...process.env };
  providerEnv(env, v.provider);
  env.BENCH_PROVIDER    = v.benchProvider;
  env.BENCH_JSON        = '1';
  env.BENCH_SEARCH_MODE = v.searchMode;
  env.RERANK_ENABLED    = '0';

  if (v.skipIndex) env.BENCH_SKIP_INDEX = '1';
  else delete env.BENCH_SKIP_INDEX;

  if (v.searchMode === 'dense-mmr') {
    env.MMR_DIVERSITY = String(v.diversity);
  } else {
    delete env.MMR_DIVERSITY;
  }

  const out = execFileSync(
    process.execPath,
    [resolve(__dirname, 'run.js')],
    { env, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }
  );

  const lines = out.trim().split('\n');
  const jsonLine = [...lines].reverse().find(l => l.trimStart().startsWith('{'));
  if (!jsonLine) throw new Error(`No JSON output from run.js for variant "${v.label}"`);
  return { label: v.label, ...JSON.parse(jsonLine) };
}

function printMatrix(results) {
  const labels = results.map(r => r.label);
  const COL = Math.max(12, Math.max(...labels.map(l => l.length)));

  const W_ID = 4;
  const W_QUERY = 34;
  const W_EXP = 13;
  const rowWidth = W_ID + 2 + W_QUERY + 2 + W_EXP + labels.reduce((s) => s + 2 + COL, 0);
  const sep = '-'.repeat(rowWidth);

  console.log('\n' + sep);
  let header = pad('ID', W_ID) + '  ' + pad('Query', W_QUERY) + '  ' + pad('Expected', W_EXP);
  for (const l of labels) header += '  ' + lpad(l, COL);
  console.log(header);
  console.log(sep);

  for (const q of queries) {
    const row0 = results[0].queryResults.find(r => r.id === q.id);
    let line = pad(q.id, W_ID) + '  ' + pad(q.query.slice(0, W_QUERY - 1), W_QUERY) + '  ' + pad(row0.expected[0] ?? '', W_EXP);
    for (const res of results) {
      const qr = res.queryResults.find(r => r.id === q.id);
      const rankStr = qr.rank >= 0 ? `#${qr.rank + 1}` : (qr.rank === -2 ? 'neg' : 'miss');
      line += '  ' + lpad(rankStr, COL);
    }
    console.log(line);
  }

  console.log(sep);

  const summarySep = '-'.repeat(28 + labels.length * (COL + 2));
  console.log('\n' + summarySep);
  let hdr = pad('', 26);
  for (const l of labels) hdr += '  ' + lpad(l.slice(0, COL), COL);
  console.log(hdr);
  console.log(summarySep);

  function row(name, fn) {
    let line = pad(name, 26);
    for (const r of results) line += '  ' + lpad(fn(r.metrics), COL);
    console.log(line);
  }

  row('Recall@1',       m => pct(m.recall1));
  row(`Recall@${results[0].topK}`, m => pct(m.recallK));
  row('MRR',            m => m.mrr?.toFixed(3) ?? 'n/a');
  row(`nDCG@${results[0].topK}`,   m => m.ndcgK?.toFixed(3) ?? 'n/a');
  row('dupSourceRate',  m => pct(m.duplicateSourceRate));
  row('sourceDiversity', m => m.sourceDiversityAvg?.toFixed(2) ?? 'n/a');
  row('Avg ms',         m => `${Math.round(m.avgLatency)}ms`);
  console.log(summarySep);

  console.log('\nDeltas vs provider RRF baseline:');
  for (const provider of ['ollama', 'onnx']) {
    const group = results.filter(r => r.label.startsWith(`${provider}-`));
    const base = group.find(r => r.searchMode === 'hybrid');
    for (const candidate of group.filter(r => r.searchMode === 'dense-mmr')) {
      const dr1 = (candidate.metrics.recall1 - base.metrics.recall1) * 100;
      const dmrr = candidate.metrics.mrr - base.metrics.mrr;
      const ddup = (candidate.metrics.duplicateSourceRate - base.metrics.duplicateSourceRate) * 100;
      const ddiv = candidate.metrics.sourceDiversityAvg - base.metrics.sourceDiversityAvg;
      console.log(
        `  ${pad(candidate.label, COL)} vs ${pad(base.label, COL)}: ` +
        `Recall@1 ${sign(dr1)}pp  MRR ${sign(dmrr, 3)}  ` +
        `dup ${sign(ddup)}pp  diversity ${sign(ddiv, 2)}`
      );
    }
  }
}

const results = [];
for (const variant of buildVariants()) {
  results.push(runVariant(variant));
}

console.log('\n\n=== MMR DIVERSITY MATRIX ===');
printMatrix(results);
console.log('');
