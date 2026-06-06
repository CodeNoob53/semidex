// Repeatable indexing performance benchmark harness.
// Measures wall-clock phase timings across multiple runs against a local corpus.
// Does NOT change production indexing behavior — reads INDEX_PROFILE=1 output.
//
// Usage:
//   npm run bench:indexing
//   BENCH_INDEX_RUNS=3 BENCH_INDEX_EP=dml npm run bench:indexing
//
// Required Qdrant + Ollama. See docs/en/benchmarking.md — Indexing Benchmark.

import 'dotenv/config';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, copyFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../');

// ── Config ────────────────────────────────────────────────────────────────────

const PROVIDER    = (process.env.BENCH_INDEX_PROVIDER ?? 'onnx').toLowerCase();
const EP          = (process.env.BENCH_INDEX_EP        ?? 'cpu').toLowerCase();
const CLEANUP     = process.env.BENCH_INDEX_CLEANUP !== '0';
const OVERWRITE   = process.env.BENCH_INDEX_OVERWRITE === '1';
const BATCH_SIZE  = process.env.ONNX_BATCH_SIZE ?? '4';
const CUDA_STRICT = process.env.ONNX_CUDA_STRICT ?? '';

// Validate BENCH_INDEX_RUNS: must be a positive integer.
const _runsRaw = process.env.BENCH_INDEX_RUNS ?? '3';
const _runsParsed = parseInt(_runsRaw, 10);
if (!Number.isInteger(_runsParsed) || _runsParsed < 1) {
  console.error(`[bench:indexing] BENCH_INDEX_RUNS="${_runsRaw}" is not a positive integer. Exiting.`);
  process.exit(1);
}
const RUNS = _runsParsed;

// Collection name: must start with bench-indexing- for safety guard.
const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
const COLLECTION = process.env.BENCH_INDEX_COLLECTION ?? `bench-indexing-perf-${ts}`;

if (!COLLECTION.startsWith('bench-indexing-')) {
  console.error(`[bench:indexing] BENCH_INDEX_COLLECTION must start with "bench-indexing-". Got: "${COLLECTION}"`);
  process.exit(1);
}

// ── Corpus temp dir ───────────────────────────────────────────────────────────

// Corpus: README.md, AGENTS.md, docs/en/*.md only.
// We copy these into a temp dir that mirrors their relative paths, then pass
// SOURCE_ROOT=corpusTempDir so source_file IDs are stable (e.g. docs/en/configuration.md).
// This gives us a single directory target for one indexer process per run, without
// picking up benchmark fixtures, result files, src/, docs/ua/, etc.
// The temp dir is always cleaned up on exit (success or failure).

const CORPUS_FILES = [
  'README.md',
  'AGENTS.md',
];

function collectDocsEn() {
  const dir = join(ROOT, 'docs', 'en');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => join('docs', 'en', f));
}

function buildCorpusTempDir() {
  const tmpDir = join(ROOT, '.bench-indexing-corpus');
  // Always start fresh to avoid stale files from a previous aborted run.
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });

  const relPaths = [...CORPUS_FILES, ...collectDocsEn()];
  for (const rel of relPaths) {
    const src = join(ROOT, rel);
    const dst = join(tmpDir, rel);
    if (!existsSync(src)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }

  console.log(`  corpus:     ${relPaths.length} files in ${tmpDir}`);
  return tmpDir;
}

function removeCorpusTempDir(tmpDir) {
  try {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`  [cleanup] could not remove temp corpus dir: ${e.message}`);
  }
}

// ── Phase parsing ─────────────────────────────────────────────────────────────

// Parse INDEX_PROFILE=1 output from one indexer run's combined stdout+stderr.
// Returns array of { file, phases: {label→ms}, chunksIn, chunksOut, tokensEst, totalMs }.
function parseProfileOutput(output) {
  const fileResults = [];
  let current = null;

  for (const line of output.split('\n')) {
    const fileMatch = line.match(/^→ (.+)$/);
    if (fileMatch) {
      if (current) fileResults.push(current);
      current = { file: fileMatch[1].trim(), phases: {}, chunksIn: 0, chunksOut: 0, tokensEst: 0, totalMs: 0 };
      continue;
    }
    if (!current) continue;

    // [profile] 18→17 chunks, ~4210 tokens
    const headerMatch = line.match(/\[profile\]\s+(\d+)→(\d+)\s+chunks,\s*~(\d+)\s+tokens/);
    if (headerMatch) {
      current.chunksIn  = parseInt(headerMatch[1]);
      current.chunksOut = parseInt(headerMatch[2]);
      current.tokensEst = parseInt(headerMatch[3]);
      continue;
    }

    // Phase lines:  pre              12 ms
    const phaseMatch = line.match(/^\s+(\S+)\s+(\d+)\s+ms(?:\s+\(.+\))?$/);
    if (phaseMatch) {
      const label = phaseMatch[1];
      const ms    = parseInt(phaseMatch[2]);
      if (label === 'total') {
        current.totalMs = ms;
      } else {
        current.phases[label] = ms;
      }
    }
  }
  if (current) fileResults.push(current);
  return fileResults.filter(r => r.totalMs > 0);
}

// ── Indexer invocation ────────────────────────────────────────────────────────

function buildEnv(collection) {
  const env = { ...process.env };
  if (PROVIDER === 'onnx') {
    env.ONNX_EMBED = '1';
  } else {
    env.ONNX_EMBED = '0';
    delete env.DENSE_PROVIDER;
    delete env.SPARSE_PROVIDER;
  }
  env.ONNX_EXECUTION_PROVIDER = EP;
  env.ONNX_BATCH_SIZE = BATCH_SIZE;
  if (CUDA_STRICT) env.ONNX_CUDA_STRICT = CUDA_STRICT;

  env.COLLECTION    = collection;
  env.INDEX_PROFILE = '1';
  return env;
}

// Run the indexer once against the corpus temp dir in a single process.
// One ONNX session init, one tokenizer load, and one Qdrant preflight per run —
// matches production directory indexing behavior.
function runIndexerOnCorpus(corpusDir, env) {
  console.log(`  [run] indexing...`);
  const result = spawnSync(process.execPath, ['src/indexer/index.js', corpusDir], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && result.status !== null) {
    console.error(`  [run] indexer exited ${result.status}`);
    if (result.stderr) console.error(result.stderr.slice(-3000));
    return null;
  }
  return (result.stdout ?? '') + '\n' + (result.stderr ?? '');
}

// ── Stats helpers ─────────────────────────────────────────────────────────────

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const i = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, i)];
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function deleteCollection(name) {
  const url = (process.env.QDRANT_URL ?? '').replace(/\/$/, '');
  const key = process.env.QDRANT_KEY ?? '';
  if (!url) return;
  try {
    const r = await fetch(`${url}/collections/${name}`, {
      method: 'DELETE',
      headers: { 'api-key': key, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok && r.status !== 404) {
      console.warn(`  [cleanup] DELETE /collections/${name} returned ${r.status}`);
    } else {
      console.log(`  [cleanup] deleted collection "${name}"`);
    }
  } catch (e) {
    console.warn(`  [cleanup] could not delete collection: ${e.message}`);
  }
}

async function collectionExists(name) {
  const url = (process.env.QDRANT_URL ?? '').replace(/\/$/, '');
  const key = process.env.QDRANT_KEY ?? '';
  if (!url) return false;
  try {
    const r = await fetch(`${url}/collections/${name}`, {
      headers: { 'api-key': key },
      signal: AbortSignal.timeout(5_000),
    });
    return r.ok;
  } catch { return false; }
}

// ── Output formatting ─────────────────────────────────────────────────────────

const PHASE_ORDER = ['pre', 'chunk', 'context', 'tag', 'embed+upsert'];

function writeMarkdownReport(path, config, runs, allFileResults) {
  const totalMsList = runs.map(r => r.totalMs).filter(Boolean);
  const filesIndexed = runs.map(r => r.filesIndexed ?? 0);
  const filesSkipped = runs.map(r => r.filesSkipped ?? 0);
  const chunksTotal  = runs.map(r => r.chunksTotal ?? 0);

  const phaseAgg = {};
  for (const runFiles of allFileResults) {
    for (const f of runFiles) {
      for (const [label, ms] of Object.entries(f.phases)) {
        if (!phaseAgg[label]) phaseAgg[label] = [];
        phaseAgg[label].push(ms);
      }
    }
  }

  const lines = [];
  lines.push(`# Indexing Performance Benchmark — ${config.date} — ${config.provider}/${config.ep}`);
  lines.push('');
  lines.push('## Configuration');
  lines.push('');
  lines.push('| Setting | Value |');
  lines.push('|---------|-------|');
  lines.push(`| Provider | ${config.provider} |`);
  lines.push(`| ONNX_EMBED | ${config.onnxEmbed} |`);
  lines.push(`| ONNX_EXECUTION_PROVIDER | ${config.ep} |`);
  lines.push(`| ONNX_BATCH_SIZE | ${config.batchSize} |`);
  lines.push(`| ONNX_CUDA_STRICT | ${config.cudaStrict || '(unset)'} |`);
  lines.push(`| Runs | ${config.runs} |`);
  lines.push(`| Collection | ${config.collection} |`);
  lines.push(`| Corpus files | ${config.corpusFileCount} (README.md, AGENTS.md, docs/en/*.md) |`);
  lines.push(`| SOURCE_ROOT | ${config.sourceRoot} |`);
  lines.push(`| Cleanup | ${config.cleanup} |`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Runs completed | ${runs.length} |`);
  if (totalMsList.length) {
    lines.push(`| Mean total ms | ${mean(totalMsList).toFixed(0)} ms |`);
    lines.push(`| Stdev total ms | ${stddev(totalMsList).toFixed(0)} ms |`);
    lines.push(`| Min total ms | ${Math.min(...totalMsList)} ms |`);
    lines.push(`| Max total ms | ${Math.max(...totalMsList)} ms |`);
  }
  lines.push(`| Mean files indexed | ${mean(filesIndexed).toFixed(1)} |`);
  lines.push(`| Mean files skipped | ${mean(filesSkipped).toFixed(1)} |`);
  lines.push(`| Mean chunks produced | ${mean(chunksTotal).toFixed(1)} |`);
  const meanChunks = mean(chunksTotal);
  const meanMs = mean(totalMsList);
  const cps = meanChunks > 0 && meanMs > 0 ? (meanChunks / (meanMs / 1000)).toFixed(2) : '—';
  const mpc = meanChunks > 0 && meanMs > 0 ? (meanMs / meanChunks).toFixed(1) : '—';
  lines.push(`| Mean chunks/sec | ${cps} |`);
  lines.push(`| Mean ms/chunk | ${mpc} |`);
  lines.push('');

  lines.push('## Per-Run Results');
  lines.push('');
  lines.push('| Run | Total ms | Files indexed | Files skipped | Chunks | chunks/sec |');
  lines.push('|-----|----------|---------------|---------------|--------|------------|');
  for (const r of runs) {
    const cpsRun = r.chunksTotal > 0 && r.totalMs > 0
      ? (r.chunksTotal / (r.totalMs / 1000)).toFixed(2) : '—';
    lines.push(`| ${r.run} | ${r.totalMs ?? '—'} | ${r.filesIndexed ?? '—'} | ${r.filesSkipped ?? '—'} | ${r.chunksTotal ?? '—'} | ${cpsRun} |`);
  }
  lines.push('');

  lines.push('## Phase Timing Summary (indexed files only)');
  lines.push('');
  lines.push('Run 1 includes ONNX session init, tokenizer load, and Ollama model warmup.');
  lines.push('The profiler emits no phase lines for skipped files, so this table reflects Run 1 data only.');
  lines.push('Skip-path cost (Run 2+) is visible only in the per-run total ms above.');
  lines.push('');
  lines.push('| Phase | Samples | Mean ms | p50 ms | p95 ms |');
  lines.push('|-------|---------|---------|--------|--------|');
  const orderedPhases = [...PHASE_ORDER, ...Object.keys(phaseAgg).filter(p => !PHASE_ORDER.includes(p))];
  for (const label of orderedPhases) {
    const vals = phaseAgg[label];
    if (!vals?.length) continue;
    lines.push(`| ${label} | ${vals.length} | ${mean(vals).toFixed(0)} | ${pct(vals, 50)} | ${pct(vals, 95)} |`);
  }
  lines.push('');

  lines.push('## What This Benchmark Can and Cannot Prove');
  lines.push('');
  lines.push('**Can prove:**');
  lines.push('- Wall-clock phase timings for this corpus on this machine/provider combination.');
  lines.push('- Relative speedup between invocations with different `BENCH_INDEX_EP` / `BENCH_INDEX_PROVIDER` values.');
  lines.push('- Chunk throughput and phase bottleneck identification (Run 1).');
  lines.push('');
  lines.push('**Cannot prove:**');
  lines.push('- Absolute timings are not portable across machines or Node.js versions.');
  lines.push('- Run 1 always includes model warmup (ONNX session init, tokenizer load, Ollama model load).');
  lines.push('  Run 1 total ms is the best signal for end-to-end cold-start cost.');
  lines.push('- After Run 1 all files hash as unchanged and are skipped. Runs 2+ measure process');
  lines.push('  startup, collection/config setup, file scan, hash check, and');
  lines.push('  getStoredMeta lookup — not re-indexing throughput. The profiler emits no phase');
  lines.push('  lines for skipped files; skip-path cost is visible only in per-run total ms.');
  lines.push('- DML batching is only active with `BENCH_INDEX_EP=dml` and the `shouldUseOnnxBatching` gate.');
  lines.push('');
  lines.push('**DML batching comparison:** Run this script twice — once with `BENCH_INDEX_EP=cpu`,');
  lines.push('once with `BENCH_INDEX_EP=dml`. Compare Run 1 `total ms` and `chunks/sec` from the');
  lines.push('two JSON artifacts (same-day runs have distinct filenames by provider+EP).');
  lines.push('');
  lines.push(`*Generated: ${config.date} — ${config.provider}/${config.ep}*`);

  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const dateStr = new Date().toISOString().slice(0, 10);

  console.log('[bench:indexing] Indexing Performance Benchmark');
  console.log(`  provider:   ${PROVIDER}`);
  console.log(`  ep:         ${EP}`);
  console.log(`  runs:       ${RUNS}`);
  console.log(`  collection: ${COLLECTION}`);
  console.log(`  source_root:(temp corpus dir — set after build)`);
  console.log(`  cleanup:    ${CLEANUP}`);

  // Guard: collection must not exist unless OVERWRITE.
  if (await collectionExists(COLLECTION)) {
    if (!OVERWRITE) {
      console.error(`[bench:indexing] Collection "${COLLECTION}" already exists.`);
      console.error('  Set BENCH_INDEX_OVERWRITE=1 to reuse it, or use a different BENCH_INDEX_COLLECTION.');
      process.exit(1);
    }
    console.warn(`[bench:indexing] Collection "${COLLECTION}" exists — reusing (BENCH_INDEX_OVERWRITE=1).`);
  }

  // Build bounded corpus temp dir (README.md, AGENTS.md, docs/en/*.md only).
  // Relative paths are preserved under ROOT so SOURCE_ROOT produces stable IDs.
  // Cleaned up in the finally block regardless of success or failure.
  const corpusTempDir = buildCorpusTempDir();
  const corpusFileCount = [...CORPUS_FILES, ...collectDocsEn()].length;

  const env = buildEnv(COLLECTION);
  // SOURCE_ROOT = corpusTempDir so the indexer computes source_file as the path
  // relative to the temp root (e.g. docs/en/configuration.md), which matches the
  // layout used by production/bootstrap runs. Setting SOURCE_ROOT=ROOT would produce
  // .bench-indexing-corpus/docs/en/configuration.md instead.
  env.SOURCE_ROOT = corpusTempDir;
  const runResults = [];
  const allFileResults = [];

  try {
    for (let run = 1; run <= RUNS; run++) {
      console.log(`\n[bench:indexing] Run ${run}/${RUNS}`);
      const runStart = Date.now();

      const output = runIndexerOnCorpus(corpusTempDir, env);
      if (output === null) {
        console.error(`  [run ${run}] indexer failed — aborting benchmark.`);
        process.exitCode = 1;
        return;
      }

      const parsed = parseProfileOutput(output);
      allFileResults.push(parsed);

      let filesIndexed = 0, filesSkipped = 0, chunksTotal = 0;
      for (const line of output.split('\n')) {
        if (line.includes('✓ unchanged, skipping')) filesSkipped++;
      }
      for (const f of parsed) {
        filesIndexed++;
        chunksTotal += f.chunksOut ?? 0;
      }

      const totalMs = Date.now() - runStart;
      runResults.push({ run, totalMs, filesIndexed, filesSkipped, chunksTotal });
      console.log(`  [run ${run}] done in ${totalMs} ms — indexed ${filesIndexed}, skipped ${filesSkipped}, ${chunksTotal} chunks`);
    }

    if (!runResults.length) return;

    // ── Write artifacts ────────────────────────────────────────────────────────

    const resultsDir = join(ROOT, 'benchmarks', 'retrieval', 'results');
    mkdirSync(resultsDir, { recursive: true });

    // Include provider and EP in filename so same-day CPU and DML runs don't overwrite each other.
    const fileSlug = `${dateStr}-indexing-perf-${PROVIDER}-${EP}`;
    const jsonPath = join(resultsDir, `${fileSlug}.json`);
    const mdPath   = join(resultsDir, `${fileSlug}.md`);

    const config = {
      date: dateStr,
      provider: PROVIDER,
      onnxEmbed: PROVIDER === 'onnx' ? '1' : '0',
      ep: EP,
      batchSize: BATCH_SIZE,
      cudaStrict: CUDA_STRICT,
      runs: RUNS,
      collection: COLLECTION,
      corpusFileCount,
      sourceRoot: corpusTempDir,
      cleanup: CLEANUP,
    };

    writeFileSync(jsonPath, JSON.stringify({ config, runs: runResults, fileResults: allFileResults }, null, 2) + '\n', 'utf8');
    console.log(`\n[bench:indexing] JSON: ${jsonPath}`);

    writeMarkdownReport(mdPath, config, runResults, allFileResults);
    console.log(`[bench:indexing] MD:   ${mdPath}`);

    // ── Summary ───────────────────────────────────────────────────────────────

    const totalMsList = runResults.map(r => r.totalMs);
    console.log('\n[bench:indexing] Summary');
    if (totalMsList.length) {
      console.log(`  mean total: ${mean(totalMsList).toFixed(0)} ms`);
      console.log(`  min/max:    ${Math.min(...totalMsList)} / ${Math.max(...totalMsList)} ms`);
    }
    const meanChunks = mean(runResults.map(r => r.chunksTotal));
    const meanMs = mean(totalMsList);
    if (meanChunks > 0 && meanMs > 0) {
      console.log(`  chunks/sec: ${(meanChunks / (meanMs / 1000)).toFixed(2)}`);
    }
  } finally {
    // Always clean up the temp corpus dir, whether the benchmark succeeded,
    // aborted, or threw. Qdrant cleanup runs here too so bench-prefixed
    // collections are not left behind on indexer failure.
    removeCorpusTempDir(corpusTempDir);

    if (CLEANUP) {
      await deleteCollection(COLLECTION);
    } else {
      console.log(`\n[bench:indexing] Collection "${COLLECTION}" left in Qdrant (BENCH_INDEX_CLEANUP=0).`);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
