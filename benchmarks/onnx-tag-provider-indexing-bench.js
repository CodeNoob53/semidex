// Indexing benchmark: TAG_PROVIDER=ollama vs TAG_PROVIDER=onnx.
// Indexes the same combined-live fixture twice (once per provider) and records
// wall time, tag fill rate, and sample tags for inspection.
//
// Both runs use PIPELINE_MODE=1 ONNX_EMBED=1 FORCE_REINDEX=1 against a throwaway
// collection so production collections are never touched.
//
// Usage:
//   COLLECTION_PREFIX=bench-tag-provider node benchmarks/onnx-tag-provider-indexing-bench.js
//
// Output: benchmarks/retrieval/results/<timestamp>-onnx-tag-provider-indexing-bench.md
// Verdict: ONNX_TAG_PROVIDER_ACCEPT | ONNX_TAG_PROVIDER_NEEDS_TUNING | ONNX_TAG_PROVIDER_REJECT

import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, statSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const FIXTURE_DIR   = join(ROOT, 'benchmarks', 'retrieval', 'fixtures', 'combined-live');
const RESULTS_DIR   = join(ROOT, 'benchmarks', 'retrieval', 'results');
const NODE          = process.execPath;
const INDEXER       = join(ROOT, 'src', 'indexer', 'index.js');
const TAG_ONNX_MODEL = process.env.TAG_ONNX_MODEL || 'onnx-community/Qwen2.5-Coder-0.5B-Instruct';
const TAG_ONNX_MODEL_FILE = join(
  ROOT, 'models', 'transformers-cache',
  ...TAG_ONNX_MODEL.split('/'), 'onnx', 'model_q4.onnx'
);
const BGE_MODEL_FILE = join(ROOT, 'models', 'bge-m3-onnx', 'model.onnx');
const BGE_DATA_FILE  = join(ROOT, 'models', 'bge-m3-onnx', 'model.onnx.data');

const COLLECTION_OLLAMA = `bench-tag-provider-ollama-${Date.now()}`;
const COLLECTION_ONNX   = `bench-tag-provider-onnx-${Date.now()}`;

function checkPrereqs() {
  const missing = [];
  if (!existsSync(FIXTURE_DIR)) missing.push(`fixture dir: ${FIXTURE_DIR.replace(ROOT + '\\', '')}`);
  if (!existsSync(BGE_MODEL_FILE)) missing.push('models/bge-m3-onnx/model.onnx (run ONNX_EMBED=1 indexing once)');
  if (!existsSync(BGE_DATA_FILE))  missing.push('models/bge-m3-onnx/model.onnx.data');
  if (!existsSync(TAG_ONNX_MODEL_FILE)) {
    missing.push(`models/transformers-cache/${TAG_ONNX_MODEL}/onnx/model_q4.onnx (set TAG_ONNX_ALLOW_DOWNLOAD=1 once)`);
  }
  if (missing.length) {
    console.error('\n[bench] Missing prerequisites:');
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(1);
  }
  console.log('[bench] Prerequisites ok');
}

async function runIndexer(collection, extraEnv, label) {
  const env = {
    ...process.env,
    COLLECTION: collection,
    PIPELINE_MODE: '1',
    ONNX_EMBED: '1',
    FORCE_REINDEX: '1',
    SKIP_PRE_DELETE: '1',
    TAG_ONNX_ALLOW_DOWNLOAD: '0',
    ...extraEnv,
  };

  const t0 = Date.now();
  let stdout = '', stderr = '';
  let error = null;

  try {
    const result = await execFileAsync(NODE, [INDEXER, FIXTURE_DIR], {
      env,
      timeout: 5 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? '';
    error  = err.message;
  }

  const wallMs = Date.now() - t0;
  return { label, collection, wallMs, stdout, stderr, error };
}

function parseIndexerOutput(stdout) {
  const doneMatch = stdout.match(/Done\.\s+(\d+)\s+file\(s\):\s+(\d+)\s+indexed,\s+(\d+)\s+skipped/);
  const files   = doneMatch ? parseInt(doneMatch[1]) : null;
  const indexed = doneMatch ? parseInt(doneMatch[2]) : null;
  const skipped = doneMatch ? parseInt(doneMatch[3]) : null;

  // Count chunk lines like "12 chunks" in the output
  const chunkMatches = [...stdout.matchAll(/(\d+) chunks$/gm)];
  const totalChunks = chunkMatches.reduce((s, m) => s + parseInt(m[1]), 0);

  return { files, indexed, skipped, totalChunks };
}

async function fetchTagSample(collection) {
  // Query Qdrant for a few points to inspect tag fill rate.
  const qdrantUrl = (process.env.QDRANT_URL || 'http://localhost:6333').replace(/\/$/, '');
  const qdrantKey = process.env.QDRANT_KEY || '';
  const headers = { 'Content-Type': 'application/json' };
  if (qdrantKey) headers['api-key'] = qdrantKey;

  try {
    const r = await fetch(`${qdrantUrl}/collections/${collection}/points/scroll`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ limit: 20, with_payload: true, with_vector: false }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.result?.points ?? null;
  } catch {
    return null;
  }
}

async function cleanupCollection(collection) {
  const qdrantUrl = (process.env.QDRANT_URL || 'http://localhost:6333').replace(/\/$/, '');
  const qdrantKey = process.env.QDRANT_KEY || '';
  const headers = {};
  if (qdrantKey) headers['api-key'] = qdrantKey;
  try {
    await fetch(`${qdrantUrl}/collections/${collection}`, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(10000),
    });
  } catch { /* best effort */ }
}

function analysePoints(points) {
  if (!points?.length) return { total: 0, withTags: 0, fillRate: null, samples: [] };
  const withTags = points.filter(p => Array.isArray(p.payload?.tags) && p.payload.tags.length > 0);
  const samples  = withTags.slice(0, 5).map(p => ({
    source_file: p.payload?.source_file ?? '?',
    tags: p.payload?.tags ?? [],
  }));
  return {
    total: points.length,
    withTags: withTags.length,
    fillRate: (withTags.length / points.length * 100).toFixed(0) + '%',
    samples,
  };
}

function fmtMs(ms) {
  return ms != null ? (ms / 1000).toFixed(1) + 's' : '--';
}

function verdict(ollamaResult, onnxResult, ollamaAnalysis, onnxAnalysis) {
  if (onnxResult.error) return { label: 'ONNX_TAG_PROVIDER_REJECT', reason: 'indexer exited with error' };

  const fillNum = parseInt(onnxAnalysis.fillRate ?? '0');
  if (fillNum < 50) return { label: 'ONNX_TAG_PROVIDER_REJECT', reason: `tag fill rate too low: ${onnxAnalysis.fillRate}` };

  const speedup = ollamaResult.wallMs / onnxResult.wallMs;
  if (speedup < 0.85) {
    return { label: 'ONNX_TAG_PROVIDER_NEEDS_TUNING', reason: `ONNX path slower than ollama (${speedup.toFixed(2)}x)` };
  }
  if (fillNum < 70) {
    return { label: 'ONNX_TAG_PROVIDER_NEEDS_TUNING', reason: `tag fill rate marginal: ${onnxAnalysis.fillRate}` };
  }
  return { label: 'ONNX_TAG_PROVIDER_ACCEPT', reason: `fill rate ${onnxAnalysis.fillRate}, speedup ${speedup.toFixed(2)}x` };
}

function buildMarkdown(ollamaResult, onnxResult, ollamaAnalysis, onnxAnalysis, verd, date) {
  const speedup = onnxResult.wallMs && ollamaResult.wallMs
    ? (ollamaResult.wallMs / onnxResult.wallMs).toFixed(2) + 'x'
    : '—';

  const lines = [];
  lines.push(`# ONNX Tag Provider Indexing Benchmark`);
  lines.push(``);
  lines.push(`**Date:** ${date}  `);
  lines.push(`**Fixture:** benchmarks/retrieval/fixtures/combined-live (${ollamaAnalysis.total ?? '?'} points sampled)  `);
  lines.push(`**ONNX tag model:** ${TAG_ONNX_MODEL}  `);
  lines.push(`**Both runs:** PIPELINE_MODE=1 ONNX_EMBED=1 FORCE_REINDEX=1`);
  lines.push(``);
  lines.push(`## Wall-Clock Comparison`);
  lines.push(``);
  lines.push(`| Provider | Wall time | Files | Indexed | Total chunks (logged) | Error |`);
  lines.push(`|----------|----------:|------:|--------:|---------------------:|-------|`);

  for (const [res, parsed] of [[ollamaResult, parseIndexerOutput(ollamaResult.stdout)], [onnxResult, parseIndexerOutput(onnxResult.stdout)]]) {
    const err = res.error ? `\`${res.error.slice(0, 60)}\`` : '--';
    lines.push(`| ${res.label} | ${fmtMs(res.wallMs)} | ${parsed.files ?? '?'} | ${parsed.indexed ?? '?'} | ${parsed.totalChunks || '?'} | ${err} |`);
  }

  lines.push(``);
  lines.push(`ONNX speedup vs ollama: **${speedup}**`);
  lines.push(``);
  lines.push(`## Tag Quality (sampled from Qdrant, ~20 points each)`);
  lines.push(``);
  lines.push(`| Provider | Points sampled | With tags | Fill rate |`);
  lines.push(`|----------|---------------:|----------:|----------:|`);
  lines.push(`| ollama   | ${ollamaAnalysis.total} | ${ollamaAnalysis.withTags} | ${ollamaAnalysis.fillRate ?? '--'} |`);
  lines.push(`| onnx     | ${onnxAnalysis.total} | ${onnxAnalysis.withTags} | ${onnxAnalysis.fillRate ?? '--'} |`);
  lines.push(``);

  if (onnxAnalysis.samples.length > 0) {
    lines.push(`### Sample ONNX tags`);
    lines.push(``);
    for (const s of onnxAnalysis.samples) {
      lines.push(`- \`${s.source_file}\`: ${s.tags.map(t => `\`${t}\``).join(', ')}`);
    }
    lines.push(``);
  }

  if (ollamaAnalysis.samples.length > 0) {
    lines.push(`### Sample Ollama tags`);
    lines.push(``);
    for (const s of ollamaAnalysis.samples) {
      lines.push(`- \`${s.source_file}\`: ${s.tags.map(t => `\`${t}\``).join(', ')}`);
    }
    lines.push(``);
  }

  lines.push(`## Verdict`);
  lines.push(``);
  lines.push(`**${verd.label}**`);
  lines.push(``);
  lines.push(`Reason: ${verd.reason}`);
  lines.push(``);
  lines.push(`### Thresholds`);
  lines.push(`- ACCEPT: no errors, fill rate >= 70%, ONNX wall >= 0.85x ollama wall`);
  lines.push(`- NEEDS_TUNING: fill rate 50-70%, or ONNX slower than 0.85x ollama`);
  lines.push(`- REJECT: indexer error, or fill rate < 50%`);
  lines.push(``);
  lines.push(`### Notes`);
  lines.push(`- Both runs use throw-away collections (deleted after benchmark)`);
  lines.push(`- TAG_ONNX_THREADS=1 (recommended initial budget per worker-budget benchmark)`);
  lines.push(`- ONNX tag worker runs in parallel with Ollama context generation after merge`);
  lines.push(`- Wall time includes model load/warm-up on first file`);
  lines.push(``);

  return lines.join('\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────

checkPrereqs();

console.log(`[bench] Fixture: ${FIXTURE_DIR.replace(ROOT + '\\', '')}`);
console.log(`[bench] Ollama collection: ${COLLECTION_OLLAMA}`);
console.log(`[bench] ONNX collection:   ${COLLECTION_ONNX}\n`);

// Run ollama provider
console.log('[bench] --- Run 1: TAG_PROVIDER=ollama ---');
const ollamaResult = await runIndexer(COLLECTION_OLLAMA, { TAG_PROVIDER: 'ollama' }, 'ollama');
console.log(`  wall: ${fmtMs(ollamaResult.wallMs)}${ollamaResult.error ? '  ERROR: ' + ollamaResult.error.slice(0, 80) : ''}`);

// Run onnx provider
console.log('\n[bench] --- Run 2: TAG_PROVIDER=onnx ---');
const onnxResult = await runIndexer(COLLECTION_ONNX, {
  TAG_PROVIDER: 'onnx',
  TAG_ONNX_THREADS: '1',
}, 'onnx');
console.log(`  wall: ${fmtMs(onnxResult.wallMs)}${onnxResult.error ? '  ERROR: ' + onnxResult.error.slice(0, 80) : ''}`);

// Fetch tag samples
console.log('\n[bench] fetching tag samples from Qdrant...');
const [ollamaPoints, onnxPoints] = await Promise.all([
  fetchTagSample(COLLECTION_OLLAMA),
  fetchTagSample(COLLECTION_ONNX),
]);
const ollamaAnalysis = analysePoints(ollamaPoints);
const onnxAnalysis   = analysePoints(onnxPoints);
console.log(`  ollama: ${ollamaAnalysis.total} points, fill=${ollamaAnalysis.fillRate}`);
console.log(`  onnx:   ${onnxAnalysis.total} points, fill=${onnxAnalysis.fillRate}`);

// Cleanup collections
console.log('\n[bench] cleaning up bench collections...');
await Promise.all([cleanupCollection(COLLECTION_OLLAMA), cleanupCollection(COLLECTION_ONNX)]);

// Build report
const verd  = verdict(ollamaResult, onnxResult, ollamaAnalysis, onnxAnalysis);
const date  = new Date().toISOString().slice(0, 19).replace('T', ' ');
const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
const md    = buildMarkdown(ollamaResult, onnxResult, ollamaAnalysis, onnxAnalysis, verd, date);

mkdirSync(RESULTS_DIR, { recursive: true });
const reportPath = join(RESULTS_DIR, `${stamp}-onnx-tag-provider-indexing-bench.md`);
writeFileSync(reportPath, md, 'utf8');

console.log(`\n${'─'.repeat(60)}`);
console.log(`Verdict: ${verd.label}`);
console.log(`Reason:  ${verd.reason}`);
console.log(`Report:  ${reportPath.replace(ROOT + '\\', '').replace(ROOT + '/', '')}`);
console.log(`${'─'.repeat(60)}\n`);
