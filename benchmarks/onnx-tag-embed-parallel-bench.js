// Benchmark: ONNX tag lane + BGE-M3 embedding lane parallel overlap.
//
// Measures whether ONNX tag generation (CPU worker thread) and BGE-M3 embedding
// (ONNX CPU, main thread) can overlap across files in the pipeline without
// destructive CPU contention.
//
// Three variants:
//   A — current: TAG_PROVIDER=onnx  (tag in stageB ∥ embed in stageC cross-file)
//   B — no tags:  TAG_GEN=0         (lower bound: embed only, no tag CPU cost)
//   C — serial:   TAG_PROVIDER=ollama (Ollama tags — reference baseline if Ollama running)
//       Note: variant C requires Ollama with TAG_MODEL available; skip gracefully if not.
//
// Usage:
//   node benchmarks/onnx-tag-embed-parallel-bench.js
//   SKIP_OLLAMA_VARIANT=1 node benchmarks/onnx-tag-embed-parallel-bench.js
//
// Output: benchmarks/retrieval/results/<timestamp>-onnx-tag-embed-parallel-bench.md

import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, statSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const FIXTURE_DIR     = join(ROOT, 'benchmarks', 'retrieval', 'fixtures', 'combined-live');
const RESULTS_DIR     = join(ROOT, 'benchmarks', 'retrieval', 'results');
const NODE            = process.execPath;
const INDEXER         = join(ROOT, 'src', 'indexer', 'index.js');
const TAG_ONNX_MODEL  = process.env.TAG_ONNX_MODEL || 'onnx-community/Qwen2.5-Coder-1.5B-Instruct';
const TAG_ONNX_MODEL_FILE = join(
  ROOT, 'models', 'transformers-cache',
  ...TAG_ONNX_MODEL.split('/'), 'onnx', 'model_q4.onnx'
);
const BGE_MODEL_FILE  = join(ROOT, 'models', 'bge-m3-onnx', 'model.onnx');
const BGE_DATA_FILE   = join(ROOT, 'models', 'bge-m3-onnx', 'model.onnx.data');

const SKIP_OLLAMA = process.env.SKIP_OLLAMA_VARIANT === '1';
const BENCH_REPS  = parseInt(process.env.BENCH_REPS || '2', 10);  // reps per variant for averaging

// ── Prerequisite check ────────────────────────────────────────────────────────

function checkPrereqs() {
  const missing = [];
  if (!existsSync(FIXTURE_DIR))       missing.push(`fixture dir missing: ${FIXTURE_DIR.replace(ROOT + '\\', '').replace(ROOT + '/', '')}`);
  if (!existsSync(BGE_MODEL_FILE))    missing.push('BGE-M3 model not cached (run ONNX_EMBED=1 indexing once)');
  if (!existsSync(BGE_DATA_FILE))     missing.push('BGE-M3 model data file missing');
  if (!existsSync(TAG_ONNX_MODEL_FILE)) missing.push(`ONNX tag model not cached: ${TAG_ONNX_MODEL} (run bench:onnx-worker-budget once or set TAG_ONNX_ALLOW_DOWNLOAD=1)`);
  if (missing.length) {
    console.error('\n[bench] Missing prerequisites:');
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(1);
  }
  const dataGb = (statSync(BGE_DATA_FILE).size / 1e9).toFixed(2);
  console.log(`[bench] BGE-M3 model: ${dataGb} GB, ONNX tag model: ${TAG_ONNX_MODEL}`);
}

// ── Qdrant helpers ────────────────────────────────────────────────────────────

const QDRANT_URL = (process.env.QDRANT_URL || 'http://localhost:6333').replace(/\/$/, '');
const QDRANT_KEY = process.env.QDRANT_KEY || '';

function qdrantHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (QDRANT_KEY) h['api-key'] = QDRANT_KEY;
  return h;
}

async function fetchPoints(collection, limit = 30) {
  try {
    const r = await fetch(`${QDRANT_URL}/collections/${collection}/points/scroll`, {
      method: 'POST',
      headers: qdrantHeaders(),
      body: JSON.stringify({ limit, with_payload: true, with_vector: false }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.result?.points ?? null;
  } catch { return null; }
}

async function deleteCollection(collection) {
  try {
    await fetch(`${QDRANT_URL}/collections/${collection}`, {
      method: 'DELETE',
      headers: qdrantHeaders(),
      signal: AbortSignal.timeout(10000),
    });
  } catch { /* best effort */ }
}

// ── Indexer runner ────────────────────────────────────────────────────────────

async function runIndexer(collection, extraEnv, label) {
  const env = {
    ...process.env,
    COLLECTION:            collection,
    PIPELINE_MODE:         '1',
    ONNX_EMBED:            '1',
    FORCE_REINDEX:         '1',
    SKIP_PRE_DELETE:       '1',
    INDEX_PROFILE:         '1',
    TAG_ONNX_ALLOW_DOWNLOAD: '0',
    ...extraEnv,
  };

  const t0 = Date.now();
  let stdout = '', stderr = '', error = null;
  try {
    const r = await execFileAsync(NODE, [INDEXER, FIXTURE_DIR], {
      env,
      timeout: 8 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
    });
    stdout = r.stdout;
    stderr = r.stderr;
  } catch (err) {
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? '';
    error  = err.message;
  }
  const wallMs = Date.now() - t0;
  return { label, collection, wallMs, stdout, stderr, error };
}

// ── Profile parsing ───────────────────────────────────────────────────────────

// Parse INDEX_PROFILE=1 output lines like:
//   "    context            1234 ms"
//   "    total              5678 ms  (1.2 chunks/s)"
// Returns { phaseMs: { pre, chunk, context, tag, 'embed+upsert' }, totalMs }
function parseProfileBlock(block) {
  const phaseMs = {};
  let totalMs = null;

  for (const line of block.split('\n')) {
    const m = line.match(/^\s{4}(\S+)\s+(\d+)\s+ms/);
    if (!m) continue;
    const [, label, ms] = m;
    if (label === 'total') totalMs = parseInt(ms);
    else phaseMs[label] = parseInt(ms);
  }
  return { phaseMs, totalMs };
}

// Extract all per-file profile blocks from combined stdout.
function parseAllProfiles(stdout) {
  const results = [];
  // Profile blocks start with "  [profile]" line
  const blocks = stdout.split(/(?=  \[profile\])/);
  for (const block of blocks) {
    if (!block.includes('[profile]')) continue;
    results.push(parseProfileBlock(block));
  }
  return results;
}

function avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function p50(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.5)];
}

function p95(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.95)];
}

function fmtMs(ms) {
  return ms != null ? ms.toFixed(0) + ' ms' : '—';
}

function analyseRun(results) {
  // results: array of { phaseMs, totalMs } one per file per rep
  const phases = ['pre', 'chunk', 'context', 'tag', 'embed+upsert'];
  const out = { totalMs: [], phases: {} };
  for (const p of phases) out.phases[p] = [];

  for (const r of results) {
    if (r.totalMs) out.totalMs.push(r.totalMs);
    for (const p of phases) {
      if (r.phaseMs[p] != null) out.phases[p].push(r.phaseMs[p]);
    }
  }

  const stats = {};
  for (const p of phases) {
    const arr = out.phases[p];
    stats[p] = { avg: avg(arr), p50: p50(arr), p95: p95(arr), n: arr.length };
  }

  return {
    totalMs: { avg: avg(out.totalMs), p50: p50(out.totalMs), p95: p95(out.totalMs) },
    phases: stats,
  };
}

function analyseTagFill(points) {
  if (!points?.length) return { total: 0, withTags: 0, fillRate: null };
  const withTags = points.filter(p => Array.isArray(p.payload?.tags) && p.payload.tags.length > 0);
  return { total: points.length, withTags: withTags.length, fillRate: (withTags.length / points.length * 100).toFixed(0) + '%' };
}

// ── Variant definitions ───────────────────────────────────────────────────────

const VARIANTS = [
  {
    id: 'A',
    label: 'TAG_PROVIDER=onnx (current)',
    env: {
      TAG_GEN:         '1',
      TAG_PROVIDER:    'onnx',
      TAG_ONNX_MODEL:  TAG_ONNX_MODEL,
      TAG_ONNX_THREADS: '1',
      OLLAMA_STAGE_CONCURRENCY: '1',
      EMBED_STAGE_CONCURRENCY:  '1',
    },
    skip: false,
  },
  {
    id: 'B',
    label: 'TAG_GEN=0 (lower bound)',
    env: {
      TAG_GEN:         '0',
      OLLAMA_STAGE_CONCURRENCY: '1',
      EMBED_STAGE_CONCURRENCY:  '1',
    },
    skip: false,
  },
  {
    id: 'C',
    label: 'TAG_PROVIDER=ollama (reference)',
    env: {
      TAG_GEN:         '1',
      OLLAMA_STAGE_CONCURRENCY: '1',
      EMBED_STAGE_CONCURRENCY:  '1',
    },
    skip: SKIP_OLLAMA,
    skipReason: 'SKIP_OLLAMA_VARIANT=1',
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

checkPrereqs();

const date  = new Date().toISOString().slice(0, 19).replace('T', ' ');
const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');

console.log(`[bench] Fixture: ${FIXTURE_DIR.replace(ROOT + '\\', '').replace(ROOT + '/', '')}`);
console.log(`[bench] Reps per variant: ${BENCH_REPS}`);
console.log(`[bench] Variants: ${VARIANTS.filter(v => !v.skip).map(v => v.id).join(', ')}\n`);

const variantResults = [];

for (const variant of VARIANTS) {
  if (variant.skip) {
    console.log(`[bench] Variant ${variant.id} skipped: ${variant.skipReason}`);
    variantResults.push({ variant, runs: [], skipped: true });
    continue;
  }

  console.log(`[bench] --- Variant ${variant.id}: ${variant.label} ---`);
  const runs = [];

  for (let rep = 0; rep < BENCH_REPS; rep++) {
    const col = `bench-tag-embed-parallel-${variant.id.toLowerCase()}-${Date.now()}`;
    process.stdout.write(`  rep ${rep + 1}/${BENCH_REPS}... `);
    const run = await runIndexer(col, variant.env, variant.label);
    const profiles = parseAllProfiles(run.stdout);
    process.stdout.write(`wall=${fmtMs(run.wallMs)}  files=${profiles.length}${run.error ? '  ERROR' : ''}\n`);
    runs.push({ run, profiles, col });

    // Keep last rep's collection for tag fill rate sampling; clean others immediately.
    if (rep < BENCH_REPS - 1) {
      await deleteCollection(col);
    }
  }

  // Sample tags from last rep's collection then clean up.
  const lastCol = runs[runs.length - 1]?.col;
  let tagFill = null;
  let tagSamples = [];
  if (lastCol && !runs[runs.length - 1]?.run?.error) {
    const points = await fetchPoints(lastCol, 30);
    tagFill = analyseTagFill(points);
    tagSamples = (points ?? [])
      .filter(p => Array.isArray(p.payload?.tags) && p.payload.tags.length > 0)
      .slice(0, 5)
      .map(p => ({ source_file: p.payload?.source_file ?? '?', tags: p.payload?.tags ?? [] }));
  }
  if (lastCol) await deleteCollection(lastCol);

  variantResults.push({ variant, runs, skipped: false, tagFill, tagSamples });

  // Summary across reps
  const allProfiles = runs.flatMap(r => r.profiles);
  const stats = analyseRun(allProfiles);
  console.log(`  total/file — avg=${fmtMs(stats.totalMs.avg)} p50=${fmtMs(stats.totalMs.p50)} p95=${fmtMs(stats.totalMs.p95)}`);
  const tagMs   = stats.phases['tag'];
  const embedMs = stats.phases['embed+upsert'];
  if (tagMs.avg != null)   console.log(`  tag         — avg=${fmtMs(tagMs.avg)} p50=${fmtMs(tagMs.p50)}`);
  if (embedMs.avg != null) console.log(`  embed       — avg=${fmtMs(embedMs.avg)} p50=${fmtMs(embedMs.p50)}`);
  if (tagFill)             console.log(`  tag fill    — ${tagFill.withTags}/${tagFill.total} (${tagFill.fillRate})`);
  console.log();
}

// ── Analysis ──────────────────────────────────────────────────────────────────

// Compute cross-variant overlap analysis:
// Sequential tag+embed time = tag_avg + embed_avg per file
// Parallel ideal time = max(tag_avg, embed_avg) (what full overlap would give)
// Current pipeline gives cross-file overlap: stageC of file N ∥ stageB of file N+1

function computeOverlapStats(variantResult) {
  if (variantResult.skipped) return null;
  const allProfiles = variantResult.runs.flatMap(r => r.profiles);
  return analyseRun(allProfiles);
}

const statsA = computeOverlapStats(variantResults[0]);
const statsB = computeOverlapStats(variantResults[1]);
const statsC = computeOverlapStats(variantResults[2]);

function computeParallelHypothesis(tagAvg, embedAvg) {
  if (tagAvg == null || embedAvg == null) return null;
  const seqTime   = tagAvg + embedAvg;
  const idealTime = Math.max(tagAvg, embedAvg);
  const savings   = seqTime - idealTime;
  const pct       = (savings / seqTime * 100).toFixed(0);
  return { seqTime, idealTime, savings, pct };
}

const hyp = statsA
  ? computeParallelHypothesis(statsA.phases['tag']?.avg, statsA.phases['embed+upsert']?.avg)
  : null;

// Wall speedup of A vs B (B = no-tag lower bound)
let speedupVsLowerBound = null;
if (statsA?.totalMs?.avg && statsB?.totalMs?.avg) {
  speedupVsLowerBound = (statsA.totalMs.avg / statsB.totalMs.avg).toFixed(2);
}

// Verdict
function computeVerdict() {
  if (!statsA) return 'INCONCLUSIVE';
  const tagAvg = statsA.phases['tag']?.avg;
  const embedAvg = statsA.phases['embed+upsert']?.avg;
  if (tagAvg == null || embedAvg == null) return 'INCONCLUSIVE';

  // If tag time is small relative to embed, full overlap is already happening cross-file
  // and a dedicated overlap within one file isn't necessary.
  const tagToEmbed = tagAvg / embedAvg;

  if (!statsB?.totalMs?.avg) {
    // No lower bound — can't assess overhead
    return tagToEmbed < 0.5
      ? 'ONNX_TAG_HIDDEN (tag << embed: already overlapping cross-file)'
      : 'INVESTIGATE';
  }

  const overhead = (statsA.totalMs.avg - statsB.totalMs.avg) / statsB.totalMs.avg;
  if (overhead > 0.5) return 'CONTENTION_DETECTED (tag adds >50% overhead vs no-tag)';
  if (overhead > 0.2) return 'NEEDS_TUNING (tag adds 20-50% overhead)';
  if (tagToEmbed < 0.6) return 'ONNX_TAG_HIDDEN (tag time < 60% embed: mostly hidden cross-file)';
  return 'ONNX_TAG_ACCEPT (modest overhead, tag time within acceptable range)';
}

const verdict = computeVerdict();

// ── Report builder ────────────────────────────────────────────────────────────

function fmtPhaseRow(label, stats) {
  if (!stats) return `| ${label} | — | — | — |`;
  return `| ${label} | ${fmtMs(stats.avg)} | ${fmtMs(stats.p50)} | ${fmtMs(stats.p95)} |`;
}

function buildMarkdown() {
  const lines = [];
  lines.push(`# ONNX Tag Lane + BGE-M3 Embed Lane Parallel Benchmark`);
  lines.push(``);
  lines.push(`**Date:** ${date}  `);
  lines.push(`**Fixture:** benchmarks/retrieval/fixtures/combined-live (${5} files)  `);
  lines.push(`**ONNX tag model:** ${TAG_ONNX_MODEL}  `);
  lines.push(`**Reps per variant:** ${BENCH_REPS}  `);
  lines.push(`**Common env:** PIPELINE_MODE=1 ONNX_EMBED=1 FORCE_REINDEX=1 INDEX_PROFILE=1`);
  lines.push(``);

  // ── Variant commands
  lines.push(`## Variant Commands`);
  lines.push(``);
  for (const vr of VARIANTS) {
    lines.push(`### Variant ${vr.id}: ${vr.label}`);
    lines.push('```');
    const envLines = Object.entries(vr.env).map(([k, v]) => `${k}=${v}`).join(' ');
    lines.push(`PIPELINE_MODE=1 ONNX_EMBED=1 FORCE_REINDEX=1 ${envLines} COLLECTION=<tmp> npm run index benchmarks/retrieval/fixtures/combined-live`);
    lines.push('```');
    lines.push(``);
  }

  // ── Wall clock summary
  lines.push(`## Wall-Clock Summary (per-file average over all reps)`);
  lines.push(``);
  lines.push(`| Variant | Description | Files×Reps | Wall avg | Wall p50 | Wall p95 | Error |`);
  lines.push(`|---------|------------|:----------:|--------:|--------:|--------:|-------|`);

  for (const vr of variantResults) {
    if (vr.skipped) {
      lines.push(`| ${vr.variant.id} | ${vr.variant.label} | — | — | — | — | skipped |`);
      continue;
    }
    const st = computeOverlapStats(vr);
    const fileReps = vr.runs.reduce((s, r) => s + r.profiles.length, 0);
    const hasErr   = vr.runs.some(r => r.run.error);
    lines.push(
      `| ${vr.variant.id} | ${vr.variant.label} | ${fileReps} | ${fmtMs(st?.totalMs?.avg)} | ${fmtMs(st?.totalMs?.p50)} | ${fmtMs(st?.totalMs?.p95)} | ${hasErr ? 'YES' : '—'} |`
    );
  }

  // ── Stage timings per variant
  lines.push(``);
  lines.push(`## Stage Timings (per file, avg over all reps)`);
  lines.push(``);
  lines.push(`*Profiler phase names from INDEX_PROFILE=1 output.*`);
  lines.push(``);

  const PHASE_LABELS = [
    ['pre',          'pre (hash+skip check)'],
    ['chunk',        'chunk'],
    ['context',      'context (Ollama)'],
    ['tag',          'tag (ONNX or Ollama)'],
    ['embed+upsert', 'embed (BGE-M3 ONNX)'],
  ];

  for (const vr of variantResults) {
    if (vr.skipped) continue;
    const st = computeOverlapStats(vr);
    lines.push(`### Variant ${vr.variant.id}: ${vr.variant.label}`);
    lines.push(``);
    lines.push(`| Phase | avg | p50 | p95 |`);
    lines.push(`|-------|----:|----:|----:|`);
    for (const [key, label] of PHASE_LABELS) {
      lines.push(fmtPhaseRow(label, st?.phases[key]));
    }
    lines.push(fmtPhaseRow('**total/file**', st?.totalMs ? { avg: st.totalMs.avg, p50: st.totalMs.p50, p95: st.totalMs.p95 } : null));
    lines.push(``);

    if (vr.tagFill) {
      lines.push(`Tag fill: **${vr.tagFill.withTags}/${vr.tagFill.total}** (${vr.tagFill.fillRate})`);
      lines.push(``);
    }

    if (vr.tagSamples?.length) {
      lines.push(`Sample tags (last rep):`);
      for (const s of vr.tagSamples) {
        lines.push(`- \`${s.source_file}\`: ${s.tags.map(t => `\`${t}\``).join(', ')}`);
      }
      lines.push(``);
    }
  }

  // ── Overlap analysis
  lines.push(`## Parallel Overlap Analysis`);
  lines.push(``);

  if (hyp) {
    lines.push(`### Tag vs Embed time (Variant A)`);
    lines.push(``);
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|------:|`);
    lines.push(`| Tag avg (ONNX worker) | ${fmtMs(statsA.phases['tag']?.avg)} |`);
    lines.push(`| Embed avg (BGE-M3) | ${fmtMs(statsA.phases['embed+upsert']?.avg)} |`);
    lines.push(`| Tag / Embed ratio | ${(statsA.phases['tag']?.avg / statsA.phases['embed+upsert']?.avg).toFixed(2)}× |`);
    lines.push(`| Sequential tag+embed | ${fmtMs(hyp.seqTime)} |`);
    lines.push(`| Ideal parallel max | ${fmtMs(hyp.idealTime)} |`);
    lines.push(`| Potential savings per file | ${fmtMs(hyp.savings)} (${hyp.pct}%) |`);
    lines.push(``);
    lines.push(`**Cross-file overlap:** In PIPELINE_MODE=1, stageC (embed) of file N`);
    lines.push(`runs while stageB (tags) of file N+1 is active — provided ollamaSem`);
    lines.push(`and embedSem both allow it. With concurrency=1 on both semaphores,`);
    lines.push(`this cross-file overlap is limited to: stageC_N ∥ stageA_{N+1}`);
    lines.push(`(stageB_{N+1} waits for ollamaSem after stageA_{N+1} completes).`);
    lines.push(``);
  }

  if (speedupVsLowerBound) {
    lines.push(`### Overhead vs no-tag lower bound (A vs B)`);
    lines.push(``);
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|------:|`);
    lines.push(`| Variant A total/file avg | ${fmtMs(statsA?.totalMs?.avg)} |`);
    lines.push(`| Variant B total/file avg (no tags) | ${fmtMs(statsB?.totalMs?.avg)} |`);
    lines.push(`| A/B ratio | ${speedupVsLowerBound}× |`);
    lines.push(`| Tag overhead per file | ${fmtMs((statsA?.totalMs?.avg ?? 0) - (statsB?.totalMs?.avg ?? 0))} |`);
    lines.push(``);
  }

  // ── Conclusion
  lines.push(`## Conclusion`);
  lines.push(``);
  lines.push(`**Verdict:** \`${verdict}\``);
  lines.push(``);

  if (hyp) {
    const tagAvg   = statsA.phases['tag']?.avg ?? 0;
    const embedAvg = statsA.phases['embed+upsert']?.avg ?? 1;
    const ratio    = tagAvg / embedAvg;

    if (ratio < 0.6) {
      lines.push(`ONNX tag generation takes ~${fmtMs(tagAvg)}/file — significantly shorter than BGE-M3`);
      lines.push(`embedding at ~${fmtMs(embedAvg)}/file. Cross-file pipeline overlap already hides`);
      lines.push(`most of the tag cost inside the embed lane of the next file.`);
    } else if (ratio < 1.2) {
      lines.push(`ONNX tag (~${fmtMs(tagAvg)}/file) and BGE-M3 embed (~${fmtMs(embedAvg)}/file) are similar`);
      lines.push(`in duration. Cross-file overlap partially hides the tag cost, but a dedicated`);
      lines.push(`within-file tag∥embed overlap could reduce sequential latency further.`);
    } else {
      lines.push(`ONNX tag (~${fmtMs(tagAvg)}/file) is longer than BGE-M3 embed (~${fmtMs(embedAvg)}/file).`);
      lines.push(`This means embed finishes first in stageC, and tag in stageB is the bottleneck.`);
      lines.push(`Investigate: reduce TAG_ONNX_THREADS contention, or accept tag cost as pipeline tail.`);
    }
  }

  lines.push(``);
  lines.push(`### Recommended next step`);
  lines.push(``);

  if (speedupVsLowerBound && parseFloat(speedupVsLowerBound) > 1.5) {
    lines.push(`Tag overhead is significant (A/B ratio: ${speedupVsLowerBound}×). Consider:`);
    lines.push(`- Raising EMBED_STAGE_CONCURRENCY to allow stageC of file N to run while stageB of file N runs`);
    lines.push(`  (true within-pipeline tag∥embed overlap across concurrent files)`);
    lines.push(`- Profiling whether CPU contention between tag worker and BGE-M3 threads causes the overhead`);
    lines.push(`- Comparing TAG_ONNX_THREADS=2 vs TAG_ONNX_THREADS=1 to see if more threads help or hurt`);
  } else if (speedupVsLowerBound && parseFloat(speedupVsLowerBound) > 1.2) {
    lines.push(`Tag adds modest overhead. Current cross-file overlap is working adequately.`);
    lines.push(`If throughput is a concern: test OLLAMA_STAGE_CONCURRENCY=2 to pipeline more files`);
    lines.push(`and give the embed lane more opportunities to overlap with tag generation.`);
  } else {
    lines.push(`Tag overhead is within noise of no-tag baseline. Current architecture is effective.`);
    lines.push(`ONNX tag lane is well-hidden inside the pipeline. No architecture change needed.`);
  }

  lines.push(``);
  lines.push(`### Caveats`);
  lines.push(`- Fixture is small (5 files). Wall-time averages include model warm-up on first file.`);
  lines.push(`- INDEX_PROFILE=1 times include semaphore queue wait in pipeline mode.`);
  lines.push(`- "embed+upsert" phase label covers embed only (upsert is in stageD, not profiled separately).`);
  lines.push(`- Ollama context generation is the dominant GPU cost; not measured here (no INDEX_PROFILE for Ollama wall).`);
  lines.push(``);

  return lines.join('\n');
}

// ── Write report ──────────────────────────────────────────────────────────────

const md = buildMarkdown();
mkdirSync(RESULTS_DIR, { recursive: true });
const reportPath = join(RESULTS_DIR, `${stamp}-onnx-tag-embed-parallel-bench.md`);
writeFileSync(reportPath, md, 'utf8');

console.log(`${'─'.repeat(60)}`);
console.log(`Verdict: ${verdict}`);
if (speedupVsLowerBound) console.log(`A/B ratio (onnx-tag vs no-tag): ${speedupVsLowerBound}×`);
if (hyp) {
  console.log(`Tag avg: ${fmtMs(statsA?.phases['tag']?.avg)}  Embed avg: ${fmtMs(statsA?.phases['embed+upsert']?.avg)}`);
  console.log(`Sequential tag+embed: ${fmtMs(hyp.seqTime)} → ideal parallel: ${fmtMs(hyp.idealTime)} (${hyp.pct}% savings)`);
}
console.log(`Report: ${reportPath.replace(ROOT + '\\', '').replace(ROOT + '/', '')}`);
console.log(`${'─'.repeat(60)}\n`);
