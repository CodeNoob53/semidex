// Runs the retrieval benchmark for both providers and prints a delta table.
// Usage: node benchmarks/retrieval/compare.js
//        npm run bench:retrieval:compare

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

// Run one provider and capture JSON output from run.js --json mode.
function runProvider(provider) {
  process.stderr.write(`\nRunning provider: ${provider}...\n`);
  const env = { ...process.env };
  delete env.BENCH_SKIP_INDEX; // compare always reindexes; skip would break provider switching
  if (provider === 'onnx') {
    env.ONNX_EMBED = '1';
    delete env.DENSE_PROVIDER;
    delete env.SPARSE_PROVIDER;
  }
  // For 'env': leave ONNX_EMBED/DENSE_PROVIDER/SPARSE_PROVIDER untouched so the
  // run reflects whatever provider is configured in .env, not a forced default.
  env.BENCH_PROVIDER = provider;
  env.BENCH_JSON = '1'; // signals run.js to emit JSON summary on stdout
  env.BENCH_SEARCH_MODE = 'hybrid';
  env.RERANK_ENABLED = '0';

  const out = execFileSync(
    process.execPath,
    [resolve(__dirname, 'run.js')],
    { env, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }
  );

  // run.js emits JSON as the last line of stdout (human output goes to stderr).
  // Any non-JSON lines before it (e.g. from lazy-loaded ONNX model init) are skipped.
  const lines = out.trim().split('\n');
  const jsonLine = [...lines].reverse().find(l => l.trimStart().startsWith('{'));
  if (!jsonLine) throw new Error(`No JSON found in run.js output for provider "${provider}"`);
  return JSON.parse(jsonLine);
}

function printDelta(a, b) {
  const W = { id: 4, query: 38, exp: 14, ra: 8, rb: 8, ma: 7, mb: 7, la: 7, lb: 7 };

  const provA = a.provider;
  const provB = b.provider;

  // Header
  const sep = '─'.repeat(4 + 2 + 38 + 2 + 14 + 2 + 8 + 2 + 8 + 2 + 7 + 2 + 7 + 2 + 7 + 2 + 7);
  console.log('\n' + sep);
  console.log(
    pad('ID', W.id) + '  ' + pad('Query', W.query) + '  ' + pad('Expected', W.exp) +
    '  ' + lpad(`${provA} rank`, W.ra) + '  ' + lpad(`${provB} rank`, W.rb) +
    '  ' + lpad(`${provA} ms`, W.la) + '  ' + lpad(`${provB} ms`, W.lb)
  );
  console.log(sep);

  for (const qa of a.queryResults) {
    const qb    = b.queryResults.find(x => x.id === qa.id);
    const q     = queries.find(x => x.id === qa.id);
    const rankA = qa.rank >= 0 ? `#${qa.rank + 1}` : 'miss';
    const rankB = qb.rank >= 0 ? `#${qb.rank + 1}` : 'miss';
    console.log(
      pad(qa.id, W.id) + '  ' +
      pad(q.query.slice(0, W.query - 1), W.query) + '  ' +
      pad(qa.expected[0], W.exp) + '  ' +
      lpad(rankA, W.ra) + '  ' +
      lpad(rankB, W.rb) + '  ' +
      lpad(qa.latency, W.la) + '  ' +
      lpad(qb.latency, W.lb)
    );
  }

  console.log(sep);

  // Summary delta
  const dr1  = b.metrics.recall1  - a.metrics.recall1;
  const drK  = b.metrics.recallK  - a.metrics.recallK;
  const dmrr = b.metrics.mrr      - a.metrics.mrr;
  const dms  = b.metrics.avgLatency - a.metrics.avgLatency;

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`                   ${pad(provA, 22)}  ${provB}`);
  console.log(`${'─'.repeat(50)}`);
  console.log(`Recall@1         : ${pad(pct(a.metrics.recall1), 22)}  ${pct(b.metrics.recall1)}  (Δ ${sign(dr1 * 100)}pp)`);
  console.log(`Recall@${a.topK}         : ${pad(pct(a.metrics.recallK), 22)}  ${pct(b.metrics.recallK)}  (Δ ${sign(drK * 100)}pp)`);
  console.log(`MRR              : ${pad(a.metrics.mrr.toFixed(3), 22)}  ${b.metrics.mrr.toFixed(3)}  (Δ ${sign(dmrr, 3)})`);
  console.log(`Avg ms           : ${pad(Math.round(a.metrics.avgLatency), 22)}  ${Math.round(b.metrics.avgLatency)}  (Δ ${sign(dms)}ms)`);
  console.log(`${'─'.repeat(50)}`);
}

const resultA = runProvider('env');
const resultB = runProvider('onnx');

console.log('\n\n=== COMPARE: env vs onnx ===');
printDelta(resultA, resultB);
console.log('');
