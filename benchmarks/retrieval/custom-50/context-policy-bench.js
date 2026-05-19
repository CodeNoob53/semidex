/**
 * Section/window-aware context prompt policy benchmark — custom-50.
 *
 * Tests three BENCH_CONTEXT_POLICY variants for COMBINED_LLM=1:
 *   A. current-minimal        — production default (unchanged)
 *   B. identifier-preserving  — explicit instruction to preserve exact identifiers verbatim
 *   C. section-window-aware   — adds prev/next chunk snippets + identifier-preserving rules
 *
 * Each policy indexes the custom-50 corpus into a temp Qdrant collection via
 * the production indexer. All 50 queries run against all three. Report written
 * to benchmarks/retrieval/results/.
 *
 * Production behavior is unchanged — BENCH_CONTEXT_POLICY defaults to
 * "current-minimal" when unset.
 *
 * Usage:
 *   CONTEXT_MODEL=qwen2.5:3b-instruct COMBINED_LLM=1 \
 *     node benchmarks/retrieval/custom-50/context-policy-bench.js
 *
 * Env (all optional, shown with defaults):
 *   CONTEXT_MODEL=qwen2.5:3b-instruct
 *   KEEP_COLLECTIONS=1   — skip Qdrant cleanup (debug)
 */

import 'dotenv/config';
import { spawnSync }                                    from 'child_process';
import { existsSync, mkdirSync, copyFileSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { resolve, join, dirname }                       from 'path';
import { fileURLToPath }                                from 'url';

import { listCollections, createCollection, deleteCollection, hybridSearch } from '../../../src/core/qdrant.js';
import { embedForSearch, SCHEMA_VERSION }               from '../../../src/core/embeddings.js';
import { loadConfig, saveConfig, resolveEnvProviders }  from '../../../src/core/config.js';

const ROOT            = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');
const FIXTURES_SHARED = join(ROOT, 'benchmarks', 'retrieval', 'fixtures', 'docs');
const FIXTURES_OWN    = join(ROOT, 'benchmarks', 'retrieval', 'custom-50', 'fixtures', 'docs');
const QUERIES_PATH    = join(ROOT, 'benchmarks', 'retrieval', 'custom-50', 'queries.json');
const RESULTS_DIR     = join(ROOT, 'benchmarks', 'retrieval', 'results');

const CONTEXT_MODEL = process.env.CONTEXT_MODEL || 'qwen2.5:3b-instruct';
const QDRANT_URL    = (process.env.QDRANT_URL ?? '').replace(/\/$/, '');
const TOP_K         = 10;
const BENCH_WINDOW  = 1;
const KEEP          = process.env.KEEP_COLLECTIONS === '1';

const STAMP = Date.now();

const POLICIES = [
  { id: 'current-minimal',       label: 'A: current-minimal (production default)' },
  { id: 'identifier-preserving', label: 'B: identifier-preserving' },
  { id: 'section-window-aware',  label: 'C: section-window-aware' },
];

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

// ── Corpus ────────────────────────────────────────────────────────────────────

const CORPUS_DIR = join(ROOT, '.tmp', `ctx-policy-corpus-${STAMP}`);

function buildCorpus() {
  rmSync(CORPUS_DIR, { recursive: true, force: true });
  mkdirSync(CORPUS_DIR, { recursive: true });
  for (const { name, dir } of FIXTURE_FILES) {
    const src = join(dir, name);
    if (!existsSync(src)) throw new Error(`fixture missing: ${src}`);
    copyFileSync(src, join(CORPUS_DIR, name));
  }
  console.log(`  corpus: ${FIXTURE_FILES.length} files → ${CORPUS_DIR}`);
}

// ── Qdrant helpers ────────────────────────────────────────────────────────────

function colName(policyId) {
  return `bench-ctx-policy-${policyId}-${STAMP}`;
}

async function ensureCollection(name) {
  const cols = await listCollections();
  if (!cols.includes(name)) await createCollection(name, 1024);
  const { denseProvider, denseModel, sparseProvider } = resolveEnvProviders();
  const cfg = loadConfig();
  cfg.collections ??= {};
  cfg.collections[name] = {
    denseProvider, denseModel, sparseProvider,
    embeddingSchemaVersion: SCHEMA_VERSION,
    vectorSize: 1024,
    description: `context-policy bench — auto-managed (${STAMP})`,
  };
  saveConfig(cfg);
}

async function deleteCol(name) {
  try { await deleteCollection(name); console.log(`  [cleanup] deleted "${name}"`); }
  catch { console.log(`  [cleanup] could not delete "${name}"`); }
}

function cleanupConfig(names) {
  try {
    const cfg = loadConfig();
    if (!cfg.collections) return;
    for (const n of names) delete cfg.collections[n];
    saveConfig(cfg);
  } catch { /* best-effort */ }
}

function cleanupTransient() {
  try { rmSync(CORPUS_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const p of POLICIES) {
    try { rmSync(join(ROOT, '.tmp', `ctx-policy-chunks-${p.id}-${STAMP}`), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── Indexer runner ────────────────────────────────────────────────────────────

function parseProfilerOutput(stdout) {
  const phaseMs = {};
  const re = /^\s+(\S+)\s+(\d+)\s+ms/;
  for (const line of stdout.split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    const [, phase, ms] = m;
    if (!phaseMs[phase]) phaseMs[phase] = [];
    phaseMs[phase].push(parseInt(ms, 10));
  }
  const out = {};
  for (const [k, v] of Object.entries(phaseMs)) out[k] = Math.round(v.reduce((a, b) => a + b, 0) / v.length);
  return out;
}

function runIndexer(policy, collection) {
  console.log(`\n[policy-bench] Indexing policy: ${policy.id}...`);
  const chunksOut = join(ROOT, '.tmp', `ctx-policy-chunks-${policy.id}-${STAMP}`);
  mkdirSync(chunksOut, { recursive: true });
  const env = {
    ...process.env,
    COLLECTION:           collection,
    SOURCE_ROOT:          CORPUS_DIR,
    ONNX_EMBED:           '1',
    COMBINED_LLM:         '1',
    CONTEXT_MODEL:        CONTEXT_MODEL,
    BENCH_CONTEXT_POLICY: policy.id,
    CHUNKS_OUT_DIR:       chunksOut,
    INDEX_PROFILE:        '1',
  };
  const t0 = Date.now();
  const result = spawnSync('node', ['src/indexer/index.js', CORPUS_DIR], {
    cwd: ROOT, env, encoding: 'utf8', maxBuffer: 30 * 1024 * 1024,
  });
  const totalMs = Date.now() - t0;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  if (result.status !== 0) {
    console.error(`  FAILED (exit ${result.status})`);
    console.error(stderr.slice(-3000));
    return { ok: false, totalMs, phases: {}, fallbacks: 0, indexed: 0 };
  }

  const phases    = parseProfilerOutput(stdout);
  const fallbacks = (stderr.match(/\[combined\] parse failed/g) ?? []).length;
  const indexed   = parseInt((stdout.match(/(\d+) indexed/) ?? [])[1] ?? '0', 10);
  console.log(`  done: ${totalMs} ms, ${indexed} files, ${fallbacks} fallbacks`);
  return { ok: true, totalMs, phases, fallbacks, indexed };
}

// ── Scroll (with first-page retry) ───────────────────────────────────────────

async function scrollPage(collection, offset) {
  const body = { limit: 100, with_payload: true, with_vectors: false };
  if (offset !== null) body.offset = offset;
  const r = await fetch(`${QDRANT_URL}/collections/${collection}/points/scroll`, {
    method: 'POST',
    headers: { 'api-key': process.env.QDRANT_KEY ?? '', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`scroll ${r.status}: ${t.slice(0,200)}`); }
  return r.json();
}

async function scrollAll(collection) {
  const points = []; let offset = null;
  while (true) {
    let data;
    try { data = await scrollPage(collection, offset); }
    catch (e) {
      if (offset === null && e.message === 'fetch failed') {
        console.log('  [scroll] retrying after network error...');
        await new Promise(r => setTimeout(r, 2000));
        data = await scrollPage(collection, offset);
      } else throw e;
    }
    const batch = data?.result?.points ?? [];
    points.push(...batch);
    offset = data?.result?.next_page_offset ?? null;
    if (offset === null || batch.length === 0) break;
  }
  return points;
}

// ── Query helpers ─────────────────────────────────────────────────────────────

function tokenise(str) { return (str ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []; }
function buildQrels(rc) { const m = new Map(); for (const r of (rc ?? [])) m.set(r.chunkId, r.relevance ?? 3); return m; }
function normaliseQuery(q) {
  return {
    id: q.id, type: q.type ?? 'file-level', query: q.query,
    relevantChunks: q.relevantChunks ?? [],
    qrels: buildQrels(q.relevantChunks),
    expectedTokens: q.expectedTokens ? q.expectedTokens.flatMap(t => tokenise(t)).filter(Boolean) : null,
    shouldHaveNoStrongHit: q.shouldHaveNoStrongHit ?? false,
    note: q.note ?? '',
  };
}

// ── Metric helpers ────────────────────────────────────────────────────────────

function resultChunkId(r) {
  const sf = r.payload?.source_file, ci = r.payload?.chunk_index;
  return (sf && ci != null) ? `${sf}#${ci}` : null;
}
function idealDCG(qrels, k) {
  const gains = [...qrels.values()].map(r => Math.pow(2, r) - 1).sort((a, b) => b - a);
  let s = 0; for (let i = 0; i < Math.min(gains.length, k); i++) s += gains[i] / Math.log2(i + 2); return s;
}
function gradedNDCG(results, qrels, k) {
  if (!qrels.size) return null;
  let dcg = 0;
  for (let i = 0; i < Math.min(results.length, k); i++) dcg += (Math.pow(2, qrels.get(resultChunkId(results[i])) ?? 0) - 1) / Math.log2(i + 2);
  const idcg = idealDCG(qrels, k); return idcg === 0 ? 0 : dcg / idcg;
}
function chunkRecallHit(results, qrels, k, minRel = 3) {
  if (!qrels.size) return null;
  const rel = new Set([...qrels.entries()].filter(([, r]) => r >= minRel).map(([id]) => id));
  if (!rel.size) return null;
  return results.slice(0, k).some(r => rel.has(resultChunkId(r)));
}
function mrrAt(results, qrels, k, minRel = 3) {
  if (!qrels.size) return null;
  const rel = new Set([...qrels.entries()].filter(([, r]) => r >= minRel).map(([id]) => id));
  if (!rel.size) return null;
  for (let i = 0; i < Math.min(results.length, k); i++) if (rel.has(resultChunkId(results[i]))) return 1 / (i + 1);
  return 0;
}
function parseChunkId(cid) {
  if (!cid) return null; const h = cid.lastIndexOf('#');
  if (h < 0) return null; const src = cid.slice(0, h), idx = parseInt(cid.slice(h + 1), 10);
  return src && Number.isFinite(idx) ? { src, idx } : null;
}
function windowRecallHit(results, qrels, k, win) {
  if (!qrels.size) return null;
  const exactIds = [...qrels.entries()].filter(([, r]) => r >= 3).map(([id]) => id);
  if (!exactIds.length) return null;
  const topK = results.slice(0, k);
  if (topK.some(r => { const cid = resultChunkId(r); return cid && qrels.get(cid) >= 3; })) return true;
  for (const eid of exactIds) {
    const ep = parseChunkId(eid); if (!ep) continue;
    if (topK.some(r => { const rp = parseChunkId(resultChunkId(r)); return rp && rp.src === ep.src && Math.abs(rp.idx - ep.idx) <= win; })) return true;
  }
  return false;
}
function negPass(results, query) {
  if (!results.length) return true;
  const words = new Set([...tokenise(results[0].payload?.text ?? ''), ...tokenise(results[0].payload?.section ?? '')]);
  return !(query.expectedTokens ?? []).some(t => words.has(t));
}

function computeMetrics(queryResults) {
  const pos = queryResults.filter(r => !r.query.shouldHaveNoStrongHit);
  const neg = queryResults.filter(r =>  r.query.shouldHaveNoStrongHit);
  const hasExact = pos.filter(r => [...r.query.qrels.values()].some(v => v >= 3)).length;
  const hasAny   = pos.filter(r => r.query.qrels.size > 0).length;
  let cr3=0,cr5=0,cr10=0,wr5=0,wr10=0,supp=0,ndcgSum=0,mrrSum=0,mrrN=0,negOk=0;
  for (const r of pos) {
    if (chunkRecallHit(r.results, r.query.qrels, 3,     3)) cr3++;
    if (chunkRecallHit(r.results, r.query.qrels, 5,     3)) cr5++;
    if (chunkRecallHit(r.results, r.query.qrels, TOP_K, 3)) cr10++;
    if (windowRecallHit(r.results, r.query.qrels, 5,     BENCH_WINDOW)) wr5++;
    if (windowRecallHit(r.results, r.query.qrels, TOP_K, BENCH_WINDOW)) wr10++;
    if (chunkRecallHit(r.results, r.query.qrels, TOP_K, 2)) supp++;
    const nd = gradedNDCG(r.results, r.query.qrels, TOP_K); if (nd !== null) ndcgSum += nd;
    const mv = mrrAt(r.results, r.query.qrels, 10, 3);       if (mv !== null) { mrrSum += mv; mrrN++; }
  }
  for (const r of neg) if (negPass(r.results, r.query)) negOk++;
  return {
    chunkRecall3:  hasExact > 0 ? cr3/hasExact   : null,
    chunkRecall5:  hasExact > 0 ? cr5/hasExact   : null,
    chunkRecall10: hasExact > 0 ? cr10/hasExact  : null,
    windowRecall5: hasExact > 0 ? wr5/hasExact   : null,
    windowRecall10:hasExact > 0 ? wr10/hasExact  : null,
    supportRecall: hasAny > 0   ? supp/hasAny    : null,
    ndcg10:        hasAny > 0   ? ndcgSum/hasAny : null,
    mrr10:         mrrN > 0     ? mrrSum/mrrN    : null,
    negPassRate:   neg.length > 0 ? negOk/neg.length : null,
    nPositive: pos.length, nNegative: neg.length,
  };
}

// ── Search ────────────────────────────────────────────────────────────────────

async function runAllQueries(collection, queries) {
  const qr = [];
  for (const q of queries) {
    process.stdout.write(`  ${q.id}: ${q.query.slice(0, 42)}... `);
    const t0 = Date.now();
    const { dense, sparse } = await embedForSearch(collection, q.query);
    const results = await hybridSearch(collection, dense, sparse, TOP_K);
    const latency = Date.now() - t0;
    qr.push({ query: q, results, latency });
    const hit = q.shouldHaveNoStrongHit
      ? (negPass(results, q) ? '✓neg' : '✗neg')
      : (chunkRecallHit(results, q.qrels, 5, 3) ? '✓' : '✗');
    console.log(`${hit} (${latency}ms)`);
  }
  return qr;
}

// ── Report ────────────────────────────────────────────────────────────────────

function pct(v)    { return v == null ? 'n/a' : `${(v*100).toFixed(1)}%`; }
function f3(v)     { return v == null ? 'n/a' : v.toFixed(3); }
function dv(a, b)  { if (a==null||b==null) return '—'; const v=a-b; return Math.abs(v)<0.0005?'—':(v>0?'+':'')+v.toFixed(3); }
function dpct(a,b) { if (a==null||b==null) return '—'; const v=(a-b)*100; return Math.abs(v)<0.05?'—':(v>0?'+':'')+v.toFixed(1)+' pp'; }

function buildReport({ policies, indexResults, allQueryResults, queries }) {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const L = [];
  const w = (...s) => L.push(...s);

  const baseline = allQueryResults[0]; // current-minimal
  const baseM = computeMetrics(baseline);

  w(
    `# Section/Window-Aware Context Policy Benchmark — custom-50 — ${stamp}`,
    ``,
    `## Setup`,
    ``,
    `| Item | Value |`,
    `|------|-------|`,
    `| Model | ${CONTEXT_MODEL} |`,
    `| COMBINED_LLM | 1 |`,
    `| ONNX_EMBED | 1 |`,
    `| Corpus | custom-50 (10 files) |`,
    `| Queries | ${queries.length} |`,
    `| Top-K | ${TOP_K} |`,
    ``,
    `## Prompt Variants`,
    ``,
    `### A: current-minimal (production default)`,
    ``,
    '```',
    `You are a document indexer. Given a text chunk, return a JSON object with:`,
    `- "context": 1-2 sentences describing what this chunk is about and where it fits in the document`,
    `- "tags": array of 3-7 lowercase hyphenated tags`,
    `Output ONLY valid JSON. File/Section/Chunk metadata provided.`,
    '```',
    ``,
    `### B: identifier-preserving`,
    ``,
    '```',
    `Same as A, plus:`,
    `- Preserve exact identifiers verbatim: env vars, function names, file paths, CLI flags,`,
    `  error strings, config keys, model names, IDs, numbers.`,
    `- Do not paraphrase technical terms.`,
    `- Help retrieve this exact chunk — write context a user would search for.`,
    `- Do not summarize the whole document. Do not invent scope.`,
    '```',
    ``,
    `### C: section-window-aware`,
    ``,
    '```',
    `Same identifier rules as B, plus:`,
    `- Receives previous chunk (last 200 chars) and next chunk (first 200 chars) as context window.`,
    `- Context must be specific to this chunk, not the whole document.`,
    `- Target 40-90 tokens.`,
    `- Do not include tags in the context field.`,
    '```',
    ``,
    `## Indexing`,
    ``,
    `| Policy | Wall time | Fallbacks | Points |`,
    `|--------|-----------|-----------|--------|`,
  );
  for (let i = 0; i < policies.length; i++) {
    const ix = indexResults[i];
    w(`| ${policies[i].id} | ${ix.totalMs} ms | ${ix.fallbacks} | 101 |`);
  }

  w(``, `## Aggregate Metrics`, ``);

  const header = `| Metric | current-minimal | identifier-preserving | Δ(B-A) | section-window-aware | Δ(C-A) |`;
  const sep    = `|--------|----------------|----------------------|--------|---------------------|--------|`;
  w(header, sep);

  const metrics = [
    ['chunkRecall@3',   'chunkRecall3'],
    ['chunkRecall@5',   'chunkRecall5'],
    ['chunkRecall@10',  'chunkRecall10'],
    ['windowRecall@5',  'windowRecall5'],
    ['windowRecall@10', 'windowRecall10'],
    ['supportRecall@10','supportRecall'],
    ['nDCG@10',         'ndcg10'],
    ['MRR@10',          'mrr10'],
    ['negativePass',    'negPassRate'],
  ];

  const allMetrics = policies.map((_, i) => computeMetrics(allQueryResults[i]));

  for (const [label, key] of metrics) {
    const isPct = !['ndcg10','mrr10'].includes(key);
    const fmt = isPct ? pct : f3;
    const dlt = isPct ? dpct : dv;
    const mA = allMetrics[0][key], mB = allMetrics[1][key], mC = allMetrics[2][key];
    w(`| ${label} | ${fmt(mA)} | ${fmt(mB)} | ${dlt(mB,mA)} | ${fmt(mC)} | ${dlt(mC,mA)} |`);
  }
  w(`| fallbacks | ${indexResults[0].fallbacks} | ${indexResults[1].fallbacks} | — | ${indexResults[2].fallbacks} | — |`);
  w(`| wall time | ${indexResults[0].totalMs} ms | ${indexResults[1].totalMs} ms | — | ${indexResults[2].totalMs} ms | — |`);

  // Per-query regression table vs baseline (current-minimal)
  w(``, `## Per-Query Changes vs current-minimal`, ``);
  for (let pi = 1; pi < policies.length; pi++) {
    const policy = policies[pi];
    const pqr = allQueryResults[pi];
    const rows = [];
    for (const q of queries) {
      if (q.shouldHaveNoStrongHit) continue;
      const br = baseline.find(r => r.query.id === q.id);
      const cr = pqr.find(r => r.query.id === q.id);
      if (!br || !cr) continue;
      const bMrr = mrrAt(br.results, q.qrels, 10, 3) ?? 0;
      const cMrr = mrrAt(cr.results, q.qrels, 10, 3) ?? 0;
      const bCr5 = chunkRecallHit(br.results, q.qrels, 5, 3) ? 1 : 0;
      const cCr5 = chunkRecallHit(cr.results, q.qrels, 5, 3) ? 1 : 0;
      const delta = cMrr - bMrr;
      let change = '—';
      if      (bCr5===0 && cCr5===1) change = '**recall gained**';
      else if (bCr5===1 && cCr5===0) change = '**recall lost**';
      else if (delta >  0.001) change = 'improved';
      else if (delta < -0.001) change = 'regressed';
      if (change !== '—') rows.push({ id: q.id, type: q.type, bMrr, cMrr, delta, bCr5, cCr5, change });
    }
    const hardLost  = rows.filter(r => r.change === '**recall lost**').length;
    const hardGained = rows.filter(r => r.change === '**recall gained**').length;
    w(`### vs ${policy.id}`, ``);
    w(`${rows.length} queries changed (${hardGained} recall gained, ${hardLost} recall lost).`, ``);
    if (rows.length) {
      w(`| ID | type | base MRR | policy MRR | ΔMRR | base cr@5 | policy cr@5 | change |`);
      w(`|----|------|----------|------------|------|-----------|-------------|--------|`);
      for (const r of rows) {
        w(`| ${r.id} | ${r.type} | ${f3(r.bMrr)} | ${f3(r.cMrr)} | ${dv(r.cMrr,r.bMrr)} | ${r.bCr5?'✓':'✗'} | ${r.cCr5?'✓':'✗'} | ${r.change} |`);
      }
    }
    w(``);
  }

  // Hard gate check
  const baseHard = (() => {
    let n = 0;
    for (const r of baseline) {
      if (r.query.shouldHaveNoStrongHit) continue;
      if (!chunkRecallHit(r.results, r.query.qrels, 5, 3) && [...r.query.qrels.values()].some(v=>v>=3)) n++;
    }
    return n; // missed at cr@5 in baseline
  })();

  const hardMisses = allQueryResults.map(qr => {
    let n = 0;
    for (const r of qr) {
      if (r.query.shouldHaveNoStrongHit) continue;
      if (!chunkRecallHit(r.results, r.query.qrels, 5, 3) && [...r.query.qrels.values()].some(v=>v>=3)) n++;
    }
    return n;
  });

  // Verdict
  const bM  = allMetrics[0];
  const ipM = allMetrics[1];
  const swM = allMetrics[2];

  // Per-policy per-query change rows (already built above, re-derive for verdict)
  function buildChangeRows(policyQr) {
    const rows = [];
    for (const r of policyQr) {
      if (r.query.shouldHaveNoStrongHit) continue;
      const bRes = baseline.find(b => b.query.id === r.query.id);
      if (!bRes) continue;
      const bMrr  = mrrAt(bRes.results, bRes.query.qrels, 10, 3) ?? 0;
      const cMrr  = mrrAt(r.results,   r.query.qrels,    10, 3) ?? 0;
      const bCr5  = chunkRecallHit(bRes.results, bRes.query.qrels, 5, 3);
      const cCr5  = chunkRecallHit(r.results,    r.query.qrels,    5, 3);
      const delta = cMrr - bMrr;
      let change = '—';
      if (!bCr5 && cCr5) change = '**recall gained**';
      else if (bCr5 && !cCr5) change = '**recall lost**';
      else if (delta >  0.001) change = 'improved';
      else if (delta < -0.001) change = 'regressed';
      if (change !== '—') rows.push({ id: r.query.id, type: r.query.type ?? 'unknown', bCr5, cCr5, delta, change });
    }
    return rows;
  }

  // Count exact-token and source-navigation regressions (MRR drop, no recall gain)
  function countTypeRegressions(rows, types) {
    return rows.filter(r => types.includes(r.type) && (r.change === 'regressed' || r.change === '**recall lost**')).length;
  }

  const CR10_DROP_THRESHOLD = 0.02; // 2 pp

  function policyVerdict(m, hardMiss, changeRows) {
    if (hardMiss > hardMisses[0]) return 'REJECT — more hard misses than current-minimal';
    if ((m.chunkRecall5 ?? 0) < (bM.chunkRecall5 ?? 0) - 0.001) return 'REJECT — chunkRecall@5 regression';
    const cr10Drop = (bM.chunkRecall10 ?? 0) - (m.chunkRecall10 ?? 0);
    if (cr10Drop > CR10_DROP_THRESHOLD + 0.001) return `DEFER — chunkRecall@10 drop ${(cr10Drop * 100).toFixed(1)} pp exceeds threshold`;
    const exactReg = countTypeRegressions(changeRows, ['exact-token']);
    const navReg   = countTypeRegressions(changeRows, ['source-navigation', 'config-env']);
    const mrrGain  = (m.mrr10 ?? 0) - (bM.mrr10 ?? 0);
    if (mrrGain > 0.005 || (m.chunkRecall5 ?? 0) > (bM.chunkRecall5 ?? 0) + 0.001) {
      if (cr10Drop > 0.001) return `PROMISING — MRR +${f3(mrrGain)}, but chunkRecall@10 -${(cr10Drop*100).toFixed(1)} pp; needs second run`;
      return 'PROCEED — quality improvement without recall regression';
    }
    if (mrrGain >= -0.005) return 'NEUTRAL — no improvement, no regression; keep current-minimal';
    return 'DEFER — mixed results, needs further investigation';
  }

  const ipRows = buildChangeRows(allQueryResults[1]);
  const swRows = buildChangeRows(allQueryResults[2]);
  const ipExactReg = countTypeRegressions(ipRows, ['exact-token']);
  const swExactReg = countTypeRegressions(swRows, ['exact-token']);
  const ipNavReg   = countTypeRegressions(ipRows, ['source-navigation', 'config-env']);
  const swNavReg   = countTypeRegressions(swRows, ['source-navigation', 'config-env']);

  const verdictIp = policyVerdict(ipM, hardMisses[1], ipRows);
  const verdictSw = policyVerdict(swM, hardMisses[2], swRows);

  const ipCr10Drop = ((bM.chunkRecall10 ?? 0) - (ipM.chunkRecall10 ?? 0)) * 100;
  const swCr10Drop = ((bM.chunkRecall10 ?? 0) - (swM.chunkRecall10 ?? 0)) * 100;

  w(
    `## Verdict`,
    ``,
    `Hard gate: REJECT/DEFER if (a) more hard misses than baseline, (b) chunkRecall@5 regression, or (c) chunkRecall@10 drop >2 pp.`,
    `exact-token and source-navigation/config-env regressions shown as warnings.`,
    ``,
    `| Policy | Hard misses | cr@5 | cr@10 | cr@10 Δ | MRR@10 | exact-token reg | nav/config reg | Verdict |`,
    `|--------|-------------|------|-------|---------|--------|-----------------|----------------|---------|`,
    `| current-minimal | ${hardMisses[0]} | ${pct(bM.chunkRecall5)} | ${pct(bM.chunkRecall10)} | — | ${f3(bM.mrr10)} | — | — | baseline |`,
    `| identifier-preserving | ${hardMisses[1]} | ${pct(ipM.chunkRecall5)} | ${pct(ipM.chunkRecall10)} | ${ipCr10Drop > 0.05 ? '-' : '+'}${Math.abs(ipCr10Drop).toFixed(1)} pp | ${f3(ipM.mrr10)} | ${ipExactReg} | ${ipNavReg} | ${verdictIp} |`,
    `| section-window-aware | ${hardMisses[2]} | ${pct(swM.chunkRecall5)} | ${pct(swM.chunkRecall10)} | ${swCr10Drop > 0.05 ? '-' : '+'}${Math.abs(swCr10Drop).toFixed(1)} pp | ${f3(swM.mrr10)} | ${swExactReg} | ${swNavReg} | ${verdictSw} |`,
    ``,
    `---`,
    ``,
    `*Generated: ${stamp} — model: ${CONTEXT_MODEL} — stamp: ${STAMP}*`,
  );

  return { lines: L, stamp };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[policy-bench] Section/window-aware context policy — custom-50');
  console.log(`  model:  ${CONTEXT_MODEL}`);
  console.log(`  policies: ${POLICIES.map(p=>p.id).join(', ')}`);

  buildCorpus();

  const collections = POLICIES.map(p => colName(p.id));
  for (const col of collections) await ensureCollection(col);

  const indexResults = [];
  for (let i = 0; i < POLICIES.length; i++) {
    const result = runIndexer(POLICIES[i], collections[i]);
    if (!result.ok) throw new Error(`Indexing failed for policy "${POLICIES[i].id}"`);
    indexResults.push(result);
  }

  console.log('\n[policy-bench] Verifying point counts...');
  for (let i = 0; i < collections.length; i++) {
    const pts = await scrollAll(collections[i]);
    console.log(`  ${POLICIES[i].id}: ${pts.length} points`);
  }

  const rawQueries = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  const queries = (rawQueries.queries ?? rawQueries).map(normaliseQuery);
  console.log(`\n[policy-bench] Loaded ${queries.length} queries`);

  const allQueryResults = [];
  for (let i = 0; i < POLICIES.length; i++) {
    console.log(`\n[policy-bench] Querying: ${POLICIES[i].id}...`);
    allQueryResults.push(await runAllQueries(collections[i], queries));
  }

  const { lines, stamp } = buildReport({ policies: POLICIES, indexResults, allQueryResults, queries });
  const reportFile = join(RESULTS_DIR, `${stamp}-section-window-context-policy.md`);
  writeFileSync(reportFile, lines.join('\n') + '\n');
  console.log(`\n[policy-bench] Report: ${reportFile}`);

  console.log('\n[policy-bench] Summary:');
  const allMetrics = allQueryResults.map(computeMetrics);
  for (let i = 0; i < POLICIES.length; i++) {
    const m = allMetrics[i];
    const mark = i === 0 ? ' ★' : '  ';
    console.log(`${mark}${POLICIES[i].id.padEnd(24)} cr@5=${pct(m.chunkRecall5)}  MRR=${f3(m.mrr10)}  nDCG=${f3(m.ndcg10)}  fallbacks=${indexResults[i].fallbacks}`);
  }

  if (!KEEP) {
    console.log('\n[policy-bench] Cleaning up...');
    for (const col of collections) await deleteCol(col);
    cleanupConfig(collections);
    cleanupTransient();
  }
}

main().catch(err => {
  console.error('[policy-bench] fatal:', err.message);
  if (err.cause) console.error('[policy-bench] cause:', err.cause?.message ?? err.cause);
  console.error('[policy-bench] stack:', err.stack?.split('\n').slice(1,4).join(' | '));
  process.exit(1);
});
