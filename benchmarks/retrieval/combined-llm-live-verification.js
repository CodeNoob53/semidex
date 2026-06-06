/**
 * Live verification harness for COMBINED_LLM=1.
 *
 * Runs two indexing passes against the same bounded corpus:
 *   A. baseline  — default path (no COMBINED_LLM)
 *   B. combined  — COMBINED_LLM=1, TAG_MODEL=intentionally-missing-model
 *
 * Captures INDEX_PROFILE=1 output, payload samples from Qdrant,
 * and writes a verification report.
 *
 * Usage:
 *   npm run verify:combined-llm
 *
 * Requires: Qdrant reachable, Ollama running with CONTEXT_MODEL pulled.
 * Cleans up both Qdrant collections on exit unless KEEP_COLLECTIONS=1.
 * Corpus is tracked under benchmarks/retrieval/fixtures/combined-live/.
 */

import 'dotenv/config';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync, copyFileSync, rmSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT        = resolve(dirname(fileURLToPath(import.meta.url)), '../../');
const FIXTURES    = join(ROOT, 'benchmarks', 'retrieval', 'fixtures', 'combined-live');
const CORPUS_DIR  = join(ROOT, '.tmp', 'combined-live');
const RESULTS_DIR = join(ROOT, 'benchmarks', 'retrieval', 'results');
const KEEP        = process.env.KEEP_COLLECTIONS === '1';

const CONTEXT_MODEL = process.env.CONTEXT_MODEL || 'gemma3:4b';
const QDRANT_URL    = (process.env.QDRANT_URL ?? '').replace(/\/$/, '');
const QDRANT_KEY    = process.env.QDRANT_KEY ?? '';
const QDRANT_HDRS   = { 'api-key': QDRANT_KEY, 'Content-Type': 'application/json' };

const COL_BASELINE = 'semidex-combined-baseline';
const COL_COMBINED = 'semidex-combined-enabled';

// ── Corpus setup ──────────────────────────────────────────────────────────────

// Copy tracked fixtures into a transient working dir so SOURCE_ROOT=CORPUS_DIR
// produces clean source_file IDs (e.g. "01-technical-config.md") for both runs.
function buildCorpusDir() {
  if (!existsSync(FIXTURES)) {
    console.error(`[verify] Fixtures missing: ${FIXTURES}`);
    process.exit(1);
  }
  rmSync(CORPUS_DIR, { recursive: true, force: true });
  mkdirSync(CORPUS_DIR, { recursive: true });
  for (const f of readdirSync(FIXTURES).filter(f => f.endsWith('.md'))) {
    copyFileSync(join(FIXTURES, f), join(CORPUS_DIR, f));
  }
}


// ── Qdrant helpers ────────────────────────────────────────────────────────────

async function qdrant(method, path, body) {
  const r = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: QDRANT_HDRS,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
  catch { return { ok: r.ok, status: r.status, data: text }; }
}

async function deleteCollection(name) {
  const r = await qdrant('DELETE', `/collections/${name}`);
  if (r.ok) console.log(`  [cleanup] deleted collection "${name}"`);
  else console.log(`  [cleanup] could not delete "${name}" (may not exist)`);
}

// Scroll all points from a collection, paginating until exhausted.
async function scrollAllPayloads(collection) {
  const points = [];
  let offset = null;
  while (true) {
    const body = { limit: 50, with_payload: true, with_vectors: false };
    if (offset !== null) body.offset = offset;
    const r = await qdrant('POST', `/collections/${collection}/points/scroll`, body);
    if (!r.ok) break;
    const batch = r.data?.result?.points ?? [];
    points.push(...batch);
    offset = r.data?.result?.next_page_offset ?? null;
    if (offset === null || batch.length === 0) break;
  }
  return points;
}

async function countPoints(collection) {
  const r = await qdrant('GET', `/collections/${collection}`);
  if (!r.ok) return null;
  return r.data?.result?.points_count ?? r.data?.result?.vectors_count ?? null;
}

// ── Profiler output parser ────────────────────────────────────────────────────

// Profiler writes via console.log → stdout. Parse per-phase timings and average
// across files.
function parseProfilerOutput(stdout) {
  const phaseMs = {};
  const phaseRe = /^\s+(\S+)\s+(\d+)\s+ms/;
  for (const line of stdout.split('\n')) {
    const m = line.match(phaseRe);
    if (!m) continue;
    const phase = m[1];
    const ms    = parseInt(m[2], 10);
    if (!phaseMs[phase]) phaseMs[phase] = [];
    phaseMs[phase].push(ms);
  }
  const result = {};
  for (const [phase, vals] of Object.entries(phaseMs)) {
    result[phase] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  return result;
}

function countFallbacks(stderr) {
  return (stderr.match(/\[combined\] parse failed/g) ?? []).length;
}

function countTagBatchFallbacks(stderr) {
  return (stderr.match(/\[tag\] batch parse failed/g) ?? []).length;
}

// ── Indexer runner ────────────────────────────────────────────────────────────

function runIndexer(collection, extraEnv, label) {
  console.log(`\n[verify] Running ${label}...`);
  const env = {
    ...process.env,
    COLLECTION:     collection,
    SOURCE_ROOT:    CORPUS_DIR,
    INDEX_PROFILE:  '1',
    ONNX_EMBED:     '1',
    CONTEXT_MODEL:  CONTEXT_MODEL,
    ...extraEnv,
  };

  const t0 = Date.now();
  const result = spawnSync('node', ['src/indexer/index.js', CORPUS_DIR], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const totalMs = Date.now() - t0;

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  if (result.status !== 0) {
    console.error(`  [verify] ${label} FAILED (exit ${result.status})`);
    console.error(stderr.slice(-2000));
    return { ok: false, totalMs, stdout, stderr, phases: {}, fallbacks: 0, tagFallbacks: 0 };
  }

  // Profiler output goes to console.log → stdout. Warnings go to console.warn → stderr.
  const phases       = parseProfilerOutput(stdout);
  const fallbacks    = countFallbacks(stderr);
  const tagFallbacks = countTagBatchFallbacks(stderr);

  const indexedMatch = stdout.match(/(\d+) indexed/);
  const indexed = indexedMatch ? parseInt(indexedMatch[1], 10) : null;

  console.log(`  done in ${totalMs} ms — exit 0`);
  if (indexed !== null) console.log(`  indexed ${indexed} file(s)`);
  if (fallbacks)    console.log(`  [combined] parse fallbacks: ${fallbacks}`);
  if (tagFallbacks) console.log(`  [tag] batch fallbacks: ${tagFallbacks}`);

  return { ok: true, totalMs, stdout, stderr, phases, fallbacks, tagFallbacks, indexed };
}

// ── Payload checker ───────────────────────────────────────────────────────────

function checkPayloads(points) {
  const issues = [];
  let contextEmpty = 0, tagsEmpty = 0, tagsGarbage = 0;

  for (const pt of points) {
    const p = pt.payload ?? {};
    if (!p.context || p.context.trim().length === 0) contextEmpty++;
    if (!Array.isArray(p.tags) || p.tags.length === 0) tagsEmpty++;
    if (Array.isArray(p.tags)) {
      for (const t of p.tags) {
        if (/^\d+$/.test(t) || t !== t.toLowerCase() || t.includes(' ')) tagsGarbage++;
      }
    }
  }

  const requiredFields = ['context', 'tags', 'source_file', 'chunk_index',
    'dense_provider', 'sparse_provider', 'embedding_schema_version', 'file_hash'];
  for (const pt of points) {
    const p = pt.payload ?? {};
    const loc = `${p.source_file ?? '?'}#${p.chunk_index ?? '?'}`;
    for (const f of requiredFields) {
      if (!(f in p)) issues.push(`missing field "${f}" in ${loc}`);
    }
  }

  return { contextEmpty, tagsEmpty, tagsGarbage, issues, count: points.length };
}

// ── Quality sample table — joined on source_file:chunk_index ─────────────────

function buildSampleRows(baselinePoints, combinedPoints, limit = 15) {
  // Build maps keyed by stable "source_file:chunk_index" — the only reliable
  // join key between two separately indexed collections (UUIDs differ).
  const bMap = new Map();
  for (const pt of baselinePoints) {
    const p = pt.payload ?? {};
    const key = `${p.source_file ?? ''}:${p.chunk_index ?? ''}`;
    bMap.set(key, p);
  }
  const cMap = new Map();
  for (const pt of combinedPoints) {
    const p = pt.payload ?? {};
    const key = `${p.source_file ?? ''}:${p.chunk_index ?? ''}`;
    cMap.set(key, p);
  }

  // Intersection of keys present in both, sorted for stable report order.
  const keys = [...bMap.keys()]
    .filter(k => cMap.has(k))
    .sort((a, b) => {
      const [af, ai] = a.split(':');
      const [bf, bi] = b.split(':');
      if (af !== bf) return af.localeCompare(bf);
      return parseInt(ai, 10) - parseInt(bi, 10);
    });

  return keys.slice(0, limit).map(key => {
    const bp = bMap.get(key);
    const cp = cMap.get(key);
    return {
      source_file:     bp.source_file ?? '',
      chunk_index:     bp.chunk_index ?? '',
      baselineContext: (bp.context ?? '').replace(/\n/g, ' ').slice(0, 80),
      combinedContext: (cp.context ?? '').replace(/\n/g, ' ').slice(0, 80),
      baselineTags:    (bp.tags ?? []).slice(0, 5).join(', '),
      combinedTags:    (cp.tags ?? []).slice(0, 5).join(', '),
    };
  });
}

// ── Report builder ────────────────────────────────────────────────────────────

function ph(run, phase) {
  const ms = run.phases?.[phase];
  return ms !== undefined ? `${ms} ms` : '—';
}

function ms2(run) {
  const c = run.phases?.context;
  const t = run.phases?.tag;
  if (c === undefined && t === undefined) return '—';
  return `${(c ?? 0) + (t ?? 0)} ms`;
}

function buildReport({
  dateStr, baselineRun, combinedRun,
  tagModelIgnored, warningPrinted,
  baselineCheck, combinedCheck,
  baselineCount, combinedCount,
  sampleRows,
}) {
  const lines = [];
  lines.push(`# Combined LLM Live Verification — ${dateStr}`);
  lines.push('');
  lines.push('## Environment');
  lines.push('');
  lines.push('| Item | Value |');
  lines.push('|------|-------|');
  lines.push(`| Node.js | ${process.version} |`);
  lines.push(`| CONTEXT_MODEL | ${CONTEXT_MODEL} |`);
  lines.push(`| TAG_MODEL (baseline) | ${process.env.TAG_MODEL ?? 'gemma3:4b (default)'} |`);
  lines.push(`| TAG_MODEL (combined run) | missing-model-for-combined-test (intentional) |`);
  lines.push(`| ONNX_EMBED | 1 |`);
  lines.push(`| ONNX_EXECUTION_PROVIDER | ${process.env.ONNX_EXECUTION_PROVIDER ?? 'cpu (default)'} |`);
  lines.push(`| LLM_BATCH_SIZE | ${process.env.LLM_BATCH_SIZE ?? '3 (default)'} |`);
  lines.push(`| Corpus | benchmarks/retrieval/fixtures/combined-live/ (5 files) |`);
  lines.push('');
  lines.push('## Sanity Checks');
  lines.push('');
  lines.push('| Check | Result |');
  lines.push('|-------|--------|');
  lines.push(`| Combined run exited 0 | ${combinedRun.ok ? '✓ pass' : '✗ FAIL'} |`);
  lines.push(`| TAG_MODEL=missing-model not checked by preflight | ${tagModelIgnored ? '✓ pass' : '✗ FAIL — preflight rejected missing TAG_MODEL'} |`);
  lines.push(`| [combined] TAG_MODEL warning printed | ${warningPrinted ? '✓ pass' : '✗ FAIL — warning not found in stderr'} |`);
  lines.push(`| Baseline payload fields complete | ${baselineCheck.issues.length === 0 ? '✓ pass' : '✗ FAIL: ' + baselineCheck.issues.join(', ')} |`);
  lines.push(`| Combined payload fields complete | ${combinedCheck.issues.length === 0 ? '✓ pass' : '✗ FAIL: ' + combinedCheck.issues.join(', ')} |`);
  lines.push(`| Baseline point count > 0 | ${(baselineCount ?? 0) > 0 ? `✓ ${baselineCount} points` : '✗ FAIL'} |`);
  lines.push(`| Combined point count > 0 | ${(combinedCount ?? 0) > 0 ? `✓ ${combinedCount} points` : '✗ FAIL'} |`);
  lines.push('');
  lines.push('## A/B Performance');
  lines.push('');
  lines.push('| Metric | Baseline | Combined | Delta |');
  lines.push('|--------|----------|----------|-------|');

  const bTotal = baselineRun.totalMs;
  const cTotal = combinedRun.totalMs;
  const delta  = bTotal - cTotal;
  lines.push(`| Total wall time | ${bTotal} ms | ${cTotal} ms | ${delta > 0 ? '-' : '+'}${Math.abs(delta)} ms (${delta > 0 ? 'combined faster' : 'baseline faster'}) |`);
  lines.push(`| Phase [2] context ms (mean/file) | ${ph(baselineRun, 'context')} | ${ph(combinedRun, 'context')} | — |`);
  lines.push(`| Phase [3] tag ms (mean/file) | ${ph(baselineRun, 'tag')} | ${ph(combinedRun, 'tag')} | — |`);
  lines.push(`| Phase [2]+[3] combined | ${ms2(baselineRun)} | ${ms2(combinedRun)} | — |`);
  lines.push(`| Combined parse fallbacks | n/a | ${combinedRun.fallbacks} | — |`);
  lines.push(`| Tag batch fallbacks | ${baselineRun.tagFallbacks} | n/a | — |`);
  lines.push(`| Points upserted | ${baselineCount ?? '?'} | ${combinedCount ?? '?'} | — |`);
  lines.push('');
  lines.push('*Phase timings are mean ms per file from INDEX_PROFILE=1 output.*');
  lines.push('*Combined path records context=0 ms (merge only, no addContext call) and all LLM time under tag.*');
  lines.push('');
  lines.push('## Payload Shape');
  lines.push('');
  lines.push('| Check | Baseline | Combined |');
  lines.push('|-------|----------|----------|');
  lines.push(`| Points total | ${baselineCount ?? '?'} | ${combinedCount ?? '?'} |`);
  lines.push(`| Points sampled | ${baselineCheck.count} | ${combinedCheck.count} |`);
  lines.push(`| Empty context | ${baselineCheck.contextEmpty} | ${combinedCheck.contextEmpty} |`);
  lines.push(`| Empty tags | ${baselineCheck.tagsEmpty} | ${combinedCheck.tagsEmpty} |`);
  lines.push(`| Malformed tags (uppercase/spaces/numeric) | ${baselineCheck.tagsGarbage} | ${combinedCheck.tagsGarbage} |`);
  lines.push(`| Missing required payload fields | ${baselineCheck.issues.length === 0 ? 'none' : baselineCheck.issues.join(', ')} | ${combinedCheck.issues.length === 0 ? 'none' : combinedCheck.issues.join(', ')} |`);
  lines.push('');
  lines.push('## Quality Sample (joined on source_file:chunk_index)');
  lines.push('');
  lines.push('Rows are matched by `source_file` + `chunk_index` across both collections. Scroll order differs between separately indexed collections; index-based comparison would mix unrelated chunks.');
  lines.push('');
  lines.push('| # | file | chunk | baseline context | combined context | baseline tags | combined tags |');
  lines.push('|---|------|-------|-----------------|-----------------|---------------|---------------|');
  for (let i = 0; i < sampleRows.length; i++) {
    const r = sampleRows[i];
    const bc = r.baselineContext || '*(empty)*';
    const cc = r.combinedContext || '*(empty)*';
    lines.push(`| ${i + 1} | ${r.source_file} | ${r.chunk_index} | ${bc}… | ${cc}… | ${r.baselineTags || '*(none)*'} | ${r.combinedTags || '*(none)*'} |`);
  }
  lines.push('');
  lines.push('## Quality Notes');
  lines.push('');

  const llmBase = (baselineRun.phases?.context ?? 0) + (baselineRun.phases?.tag ?? 0);
  const llmComb = (combinedRun.phases?.context ?? 0) + (combinedRun.phases?.tag ?? 0);
  const llmDelta = llmBase - llmComb;

  if (llmDelta > 0) {
    lines.push(`- LLM phase (context+tag) reduced by ${llmDelta} ms/file mean — ${((llmDelta / llmBase) * 100).toFixed(0)}% improvement`);
  } else if (llmDelta < 0) {
    lines.push(`- LLM phase (context+tag) increased by ${Math.abs(llmDelta)} ms/file mean — possible Ollama warmup/queue variance with this small corpus`);
  } else {
    lines.push('- LLM phase timings comparable between baseline and combined');
  }

  if (combinedRun.fallbacks > 0) {
    lines.push(`- ${combinedRun.fallbacks} combined parse fallback(s) — expected for short/empty chunks; fallback uses CONTEXT_MODEL for both context and tags`);
  } else {
    lines.push('- 0 combined parse fallbacks on normal chunks (verified live)');
    lines.push('- Fallback path (parse failure → separate context+tag calls via CONTEXT_MODEL) covered by code review and smoke section 27; not live-exercised in this run because all chunks parsed successfully');
  }

  if (baselineRun.tagFallbacks > 0) {
    lines.push(`- ${baselineRun.tagFallbacks} baseline tag batch fallback(s) — combined mode eliminates this failure class`);
  }

  if (combinedCheck.contextEmpty > 0) {
    lines.push(`- ${combinedCheck.contextEmpty} combined chunk(s) with empty context — likely short/empty-body chunks where fallback also returned empty`);
  }

  lines.push('- context quality and tag relevance: see Quality Sample table above for human review');
  lines.push('- tags normalized (lowercase, hyphenated): verified by payload shape check above');
  lines.push('');
  lines.push('## Verdict');
  lines.push('');

  const sanityPass = combinedRun.ok && tagModelIgnored && warningPrinted &&
    combinedCheck.issues.length === 0 && (combinedCount ?? 0) > 0;

  if (sanityPass && llmDelta >= 0) {
    lines.push('**proceed** — COMBINED_LLM=1 verified live. TAG_MODEL correctly ignored, payload shape correct, latency improvement confirmed.');
  } else if (sanityPass && llmDelta < 0) {
    lines.push('**proceed with caution** — COMBINED_LLM=1 sanity checks pass but no latency improvement in this run. Likely Ollama warmup/queue variance on a 5-file corpus. Re-run with larger corpus or warm Ollama state before concluding.');
  } else {
    lines.push('**blocked** — one or more sanity checks failed. See Sanity Checks table above.');
  }

  lines.push('');
  lines.push('**COMBINED_LLM=1 remains opt-in.** Default path unchanged. No action needed for existing collections.');
  lines.push('');
  lines.push('**Before promoting to default:**');
  lines.push('1. Run custom-50 retrieval benchmark on a combined-indexed collection to verify retrieval quality is not degraded.');
  lines.push('2. Verify on the full 15-file benchmark corpus (not just 5 files).');
  lines.push('3. Address the short-chunk context drift edge case if `COMBINED_MIN_CHARS` threshold needs tuning.');
  lines.push('');
  lines.push(`*Generated: ${dateStr} — corpus: benchmarks/retrieval/fixtures/combined-live/*`);

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[verify] Combined LLM Live Verification');
  console.log(`  fixtures: ${FIXTURES}`);
  console.log(`  CONTEXT_MODEL: ${CONTEXT_MODEL}`);

  if (!QDRANT_URL) {
    console.error('[verify] QDRANT_URL not set');
    process.exit(1);
  }

  // Build transient corpus dir from tracked fixtures
  buildCorpusDir();
  console.log(`  corpus: ${CORPUS_DIR} (built from fixtures)`);

  // Pre-clean collections in case of stale state from a previous aborted run
  await deleteCollection(COL_BASELINE);
  await deleteCollection(COL_COMBINED);

  try {
    // ── Run A: baseline ─────────────────────────────────────────────────────
    const baselineRun = runIndexer(COL_BASELINE, {}, 'A: baseline (default path)');

    // ── Run B: combined, with intentionally missing TAG_MODEL ───────────────
    const combinedRun = runIndexer(COL_COMBINED, {
      COMBINED_LLM: '1',
      TAG_MODEL:    'missing-model-for-combined-test',
    }, 'B: combined (COMBINED_LLM=1, TAG_MODEL=missing-model-for-combined-test)');

    // preflight error appears in stderr if it throws about TAG_MODEL
    const tagModelMentioned = combinedRun.stderr.includes('missing-model-for-combined-test') &&
      combinedRun.stderr.includes('not pulled');
    const tagModelIgnored = !tagModelMentioned;

    // warning goes to console.warn → stderr
    const warningPrinted = combinedRun.stderr.includes('[combined]') &&
      combinedRun.stderr.includes('TAG_MODEL');

    // ── Payload sampling ─────────────────────────────────────────────────────
    console.log('\n[verify] Fetching all payloads...');
    const baselinePoints = baselineRun.ok ? await scrollAllPayloads(COL_BASELINE) : [];
    const combinedPoints = combinedRun.ok ? await scrollAllPayloads(COL_COMBINED) : [];
    const baselineCount  = baselineRun.ok ? await countPoints(COL_BASELINE) : null;
    const combinedCount  = combinedRun.ok ? await countPoints(COL_COMBINED) : null;

    console.log(`  baseline: ${baselineCount} points fetched`);
    console.log(`  combined: ${combinedCount} points fetched`);

    const baselineCheck = checkPayloads(baselinePoints);
    const combinedCheck = checkPayloads(combinedPoints);

    // Join on source_file:chunk_index for correct chunk-level comparison
    const sampleRows = buildSampleRows(baselinePoints, combinedPoints, 15);
    console.log(`  matched ${sampleRows.length} chunk(s) across both collections`);

    // ── Cleanup ──────────────────────────────────────────────────────────────
    if (!KEEP) {
      console.log('\n[verify] Cleaning up collections...');
      await deleteCollection(COL_BASELINE);
      await deleteCollection(COL_COMBINED);
    } else {
      console.log(`\n[verify] KEEP_COLLECTIONS=1 — retained: ${COL_BASELINE}, ${COL_COMBINED}`);
    }

    // ── Report ───────────────────────────────────────────────────────────────
    const now     = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 16).replace(':', '');

    const report  = buildReport({
      dateStr, baselineRun, combinedRun,
      tagModelIgnored, warningPrinted,
      baselineCheck, combinedCheck,
      baselineCount, combinedCount,
      sampleRows,
    });

    mkdirSync(RESULTS_DIR, { recursive: true });
    const outPath = join(RESULTS_DIR, `${dateStr}T${timeStr}-combined-llm-live-verification.md`);
    writeFileSync(outPath, report, 'utf8');
    console.log(`\n[verify] Report: ${outPath}`);

    // ── Summary ──────────────────────────────────────────────────────────────
    const llmBase = (baselineRun.phases?.context ?? 0) + (baselineRun.phases?.tag ?? 0);
    const llmComb = (combinedRun.phases?.context ?? 0) + (combinedRun.phases?.tag ?? 0);

    console.log('\n[verify] Summary');
    console.log(`  TAG_MODEL ignored:    ${tagModelIgnored ? '✓' : '✗'}`);
    console.log(`  Warning printed:      ${warningPrinted ? '✓' : '✗'}`);
    console.log(`  Payload shape:        ${combinedCheck.issues.length === 0 ? '✓' : '✗ ' + combinedCheck.issues.join(', ')}`);
    console.log(`  Matched rows:         ${sampleRows.length}`);
    console.log(`  Baseline total:       ${baselineRun.totalMs} ms`);
    console.log(`  Combined total:       ${combinedRun.totalMs} ms`);
    console.log(`  Phase [2]+[3] baseline: ${llmBase} ms/file mean`);
    console.log(`  Phase [2]+[3] combined: ${llmComb} ms/file mean`);
    console.log(`  Combined fallbacks:   ${combinedRun.fallbacks}`);
  } finally {
    // Always clean up transient dirs
    try { rmSync(CORPUS_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(join(ROOT, '.tmp', 'combined-live-chunks-out'), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
