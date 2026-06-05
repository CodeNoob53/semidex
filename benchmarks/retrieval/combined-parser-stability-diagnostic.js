/**
 * Combined context+tags parser stability diagnostic.
 *
 * Probes parseCombinedResponse() stability for each model on a given corpus.
 * Uses production chunking + empty-section routing, then calls generate() directly
 * with the production current-minimal prompt (mirrors buildPromptCurrentMinimal in
 * combined.js — must stay in sync) and passes the raw output through
 * parseCombinedResponse(). Does NOT call addContextAndTags(); fallback behavior is
 * not tested here — only the parser/model JSON format stability.
 * Collects per-chunk parse result, failure reason, tag quality metrics, and latency.
 *
 * Required env:
 *   CORPUS_ROOT  — absolute path to directory containing source files
 *   CORPUS_FILES — comma-separated relative paths under CORPUS_ROOT
 *
 * Optional env:
 *   COMBINED_MODELS    — comma-separated models (default: gemma3:4b,qwen2.5:3b-instruct)
 *   COMBINED_MAX_CHUNKS — max normal chunks to test (default: all)
 *
 * Outputs:
 *   .tmp/combined-parser-stability-<stamp>/raw/<model>/chunk-XXXX.txt — raw LLM output (failures only)
 *   benchmarks/retrieval/results/YYYY-MM-DDTHHMM-combined-parser-stability.md
 *
 * Raw outputs are NOT committed (covered by .gitignore on .tmp/).
 * Report contains no private file paths or raw chunk content.
 */

import 'dotenv/config';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { resolve, join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

import { generate }             from '../../src/core/ollama.js';
import { chunkFileFromPath }    from '../../src/indexer/phases/chunk.js';
import { partitionChunks }      from '../../src/indexer/phases/empty-section.js';
import { parseCombinedResponse, COMBINED_MIN_CHARS } from '../../src/indexer/phases/combined.js';

const ROOT        = resolve(dirname(fileURLToPath(import.meta.url)), '../../');
const RESULTS_DIR = join(ROOT, 'benchmarks', 'retrieval', 'results');
const STAMP       = Date.now();
const TMP_DIR     = join(ROOT, '.tmp', `combined-parser-stability-${STAMP}`);

// ── Env / config ──────────────────────────────────────────────────────────────

const CORPUS_ROOT  = process.env.CORPUS_ROOT;
const CORPUS_FILES = process.env.CORPUS_FILES;

if (!CORPUS_ROOT || !CORPUS_FILES) {
  console.error('Error: CORPUS_ROOT and CORPUS_FILES env vars are required.');
  console.error('  CORPUS_ROOT  — absolute path to the source directory');
  console.error('  CORPUS_FILES — comma-separated relative paths under CORPUS_ROOT');
  process.exit(1);
}

const SOURCE_FILES = CORPUS_FILES.split(',').map(f => f.trim()).filter(Boolean);

const MODELS = (process.env.COMBINED_MODELS || 'gemma3:4b,qwen2.5:3b-instruct')
  .split(',').map(m => m.trim()).filter(Boolean);

const MAX_CHUNKS = process.env.COMBINED_MAX_CHUNKS
  ? parseInt(process.env.COMBINED_MAX_CHUNKS, 10)
  : Infinity;

// ── Failure classification ────────────────────────────────────────────────────

function classifyFailure(raw, parsed) {
  if (!raw || raw.trim().length === 0) return 'empty_or_refusal';

  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  // parsed here means JSON.parse succeeded but parseCombinedResponse rejected it
  let obj = null;
  try { obj = JSON.parse(stripped); } catch { return 'invalid_json'; }

  if (Array.isArray(obj)) {
    // Single-element array is handled by parser; if it got here, inner item failed
    if (obj.length === 0) return 'wrong_shape';
    const item = obj[0];
    if (!item || typeof item !== 'object') return 'wrong_shape';
    if (typeof item.context !== 'string' || !item.context.trim()) return 'missing_context';
    if (!Array.isArray(item.tags)) return 'missing_tags';
    return 'wrong_shape';
  }

  if (typeof obj === 'object' && obj !== null) {
    if (typeof obj.context !== 'string') return 'missing_context';
    if (!obj.context.trim()) return 'empty_context';
    if (!Array.isArray(obj.tags)) return 'missing_tags';
    if (!obj.tags.every(t => typeof t === 'string')) return 'tags_not_array';
    // JSON valid, shape valid, but parseCombinedResponse rejected it — shouldn't reach here
    return 'unknown';
  }

  return 'wrong_shape';
}

// ── Prompt builder — mirrors src/indexer/phases/combined.js exactly ──────────
// Must stay in sync with buildPromptCurrentMinimal() in combined.js.
// Only current-minimal policy (production default) is tested here.

function buildPrompt(chunk) {
  return `You are a document indexer. Given a text chunk, return a JSON object with:
- "context": 1-2 sentences describing what this chunk is about and where it fits in the document
- "tags": array of 3-7 lowercase hyphenated tags (e.g. "node-js", "qdrant-hybrid-search")

Output ONLY valid JSON, nothing else. Example: {"context":"This chunk explains X.","tags":["x","y"]}

File: ${chunk.source_file}
Section: ${chunk.section || 'unknown'}
Chunk ${chunk.chunkIndex + 1} of ${chunk.totalChunks}

Text:
${chunk.text.slice(0, 1000)}`;
}

// ── Per-chunk probe ───────────────────────────────────────────────────────────

async function probeOneChunk(chunk, model, rawDir, chunkIdx) {
  const t0 = Date.now();

  // Mirror production: short chunks skip combined call
  const tooShort = chunk.text.trim().length < COMBINED_MIN_CHARS;
  if (tooShort) {
    return {
      ok: false,
      reason: 'too_short_skipped',
      latencyMs: 0,
      context: null,
      tags: null,
      rawPath: null,
      skipped: true,
    };
  }

  let raw = '';
  try {
    raw = await generate(model, buildPrompt(chunk), { format: 'json' });
  } catch (e) {
    const rawPath = join(rawDir, `chunk-${String(chunkIdx).padStart(4, '0')}-error.txt`);
    writeFileSync(rawPath, e.message + '\n---\n' + (raw || ''));
    return {
      ok: false,
      reason: 'timeout_or_generate_error',
      latencyMs: Date.now() - t0,
      context: null,
      tags: null,
      rawPath,
      skipped: false,
    };
  }

  const parsed = parseCombinedResponse(raw);
  const latencyMs = Date.now() - t0;

  if (parsed) {
    return {
      ok: true,
      reason: 'ok',
      latencyMs,
      context: parsed.context,
      tags: parsed.tags,
      rawPath: null,
      skipped: false,
    };
  }

  const reason = classifyFailure(raw, false);
  const rawPath = join(rawDir, `chunk-${String(chunkIdx).padStart(4, '0')}.txt`);
  writeFileSync(rawPath, raw);

  return {
    ok: false,
    reason,
    latencyMs,
    context: null,
    tags: null,
    rawPath,
    skipped: false,
  };
}

// ── Corpus loading ────────────────────────────────────────────────────────────

async function loadCorpus() {
  const perFile = [];
  let totalRaw = 0, totalMerged = 0, totalNormal = 0, totalEmpty = 0;

  for (const rel of SOURCE_FILES) {
    const abs = join(CORPUS_ROOT, rel);
    if (!existsSync(abs)) {
      console.warn(`  [corpus] skipped (not found): ${rel}`);
      perFile.push({ rel, status: 'missing', raw: 0, merged: 0, normal: 0, empty: 0, chunks: [] });
      continue;
    }
    const raw    = await chunkFileFromPath(abs, rel);
    const merged = raw;
    const { normal, empty } = partitionChunks(merged);
    totalRaw    += raw.length;
    totalMerged += merged.length;
    totalNormal += normal.length;
    totalEmpty  += empty.length;
    perFile.push({ rel, status: 'ok', raw: raw.length, merged: merged.length,
                   normal: normal.length, empty: empty.length, chunks: normal });
    console.log(`  [corpus] ${basename(rel).padEnd(30)} raw=${raw.length} merged=${merged.length} normal=${normal.length} empty=${empty.length}`);
  }

  let allNormal = perFile.flatMap(f => f.chunks);

  // Deterministic sample: take first MAX_CHUNKS in corpus order
  const totalBeforeSample = allNormal.length;
  if (allNormal.length > MAX_CHUNKS) {
    allNormal = allNormal.slice(0, MAX_CHUNKS);
    console.log(`  [corpus] sample: first ${MAX_CHUNKS} of ${totalBeforeSample} normal chunks`);
  }

  return { perFile, allNormal, totalRaw, totalMerged, totalNormal, totalEmpty, totalBeforeSample };
}

// ── Matrix runner ─────────────────────────────────────────────────────────────

async function runMatrix(allNormal) {
  const results = [];

  for (const model of MODELS) {
    console.log(`\n[diag] model=${model}  chunks=${allNormal.length}`);
    const rawDir = join(TMP_DIR, 'raw', model.replace(/[:/]/g, '_'));
    mkdirSync(rawDir, { recursive: true });

    let parseOk = 0, parseFail = 0, tooShortSkipped = 0;
    const reasons = {};
    const latencies = [];
    const tagCounts = [];
    let emptyContextCount = 0;
    let emptyTagsCount = 0;
    let invalidTagsCount = 0;

    for (let idx = 0; idx < allNormal.length; idx++) {
      const chunk = allNormal[idx];
      process.stdout.write(`  chunk ${idx + 1}/${allNormal.length}... `);
      const r = await probeOneChunk(chunk, model, rawDir, idx);

      if (r.skipped) {
        tooShortSkipped++;
        process.stdout.write(`skipped (too_short)\n`);
        continue;
      }

      latencies.push(r.latencyMs);

      if (r.ok) {
        parseOk++;
        const tc = r.tags.length;
        tagCounts.push(tc);
        if (tc === 0) emptyTagsCount++;
        // Validate tag format: lowercase, hyphenated, no spaces
        const bad = r.tags.filter(t => /[A-Z\s]/.test(t) || t.length < 2 || t.length > 40);
        if (bad.length > 0) invalidTagsCount++;
        if (!r.context || !r.context.trim()) emptyContextCount++;
        process.stdout.write(`ok tags=${tc} (${r.latencyMs}ms)\n`);
      } else {
        parseFail++;
        reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
        process.stdout.write(`FAIL ${r.reason} (${r.latencyMs}ms)\n`);
      }
    }

    const tested = parseOk + parseFail;
    const latSorted = [...latencies].sort((a, b) => a - b);
    const mean   = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
    const p50    = latSorted[Math.floor(latSorted.length * 0.5)] ?? 0;
    const p95    = latSorted[Math.floor(latSorted.length * 0.95)] ?? 0;
    const meanTags = tagCounts.length ? (tagCounts.reduce((a, b) => a + b, 0) / tagCounts.length).toFixed(1) : '—';
    const failRate = tested > 0 ? parseFail / tested : 0;

    console.log(`  parseOk=${parseOk} parseFail=${parseFail} failRate=${(failRate*100).toFixed(1)}% tooShort=${tooShortSkipped} mean=${mean}ms p50=${p50}ms p95=${p95}ms`);

    results.push({
      model, tested, parseOk, parseFail, tooShortSkipped,
      failRate, reasons,
      emptyContextCount, emptyTagsCount, invalidTagsCount,
      meanTags, mean, p50, p95,
    });
  }

  return results;
}

// ── Verdict ───────────────────────────────────────────────────────────────────

function deriveVerdict(results) {
  const stable   = results.filter(r => r.failRate < 0.05);
  const risky    = results.filter(r => r.failRate >= 0.05 && r.failRate < 0.20);
  const unstable = results.filter(r => r.failRate >= 0.20);
  const hasTimeouts = results.some(r => (r.reasons.timeout_or_generate_error ?? 0) > 0);

  if (unstable.length === 0 && risky.length === 0) {
    const label = results.length === 2 ? 'COMBINED_BOTH_STABLE'
      : results[0]?.model.startsWith('gemma') ? 'COMBINED_STABLE_GEMMA'
      : 'COMBINED_STABLE_QWEN';
    return { label, detail: `All models pass with <5% parse fail rate. COMBINED_LLM=1 parser path is stable on this sampled corpus; quality still depends on retrieval benchmarks.` };
  }

  if (hasTimeouts && unstable.length === 0) {
    return {
      label: 'COMBINED_TIMEOUT_RISK',
      detail: `Parse quality is acceptable but generate_error (timeout) failures are present. ` +
        `Ollama infrastructure stability is the limiting factor.`,
    };
  }

  if (unstable.length > 0 && stable.length > 0) {
    const stableNames   = stable.map(r => r.model).join(', ');
    const unstableNames = unstable.map(r => r.model).join(', ');
    return {
      label: unstableNames.includes('gemma') ? 'COMBINED_STABLE_QWEN' : 'COMBINED_STABLE_GEMMA',
      detail: `${stableNames} is stable (<5% fail rate). ${unstableNames} is not recommended for COMBINED_LLM=1.`,
    };
  }

  if (results.every(r => r.failRate >= 0.20)) {
    return {
      label: 'COMBINED_NOT_READY',
      detail: `All tested models have ≥20% parse fail rate. COMBINED_LLM=1 is not production-ready on this corpus.`,
    };
  }

  return {
    label: 'COMBINED_PARSER_RISK',
    detail: `Parse fail rates are elevated (5–20%). Monitor in production; consider staying on separate path.`,
  };
}

// ── Report ────────────────────────────────────────────────────────────────────

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

function formatDate() {
  const d = new Date();
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}`,
  };
}

function writeReport({ corpus, results, verdict }) {
  const { date, time } = formatDate();
  const filename = `${date}T${time}-combined-parser-stability.md`;
  const filepath  = join(RESULTS_DIR, filename);

  const sampleNote = corpus.totalBeforeSample > corpus.tested
    ? `first ${corpus.tested} of ${corpus.totalBeforeSample} (COMBINED_MAX_CHUNKS=${corpus.tested})`
    : `${corpus.tested} (all)`;

  const lines = [
    `# Combined Context+Tags Parser Stability — ${date}`,
    '',
    '## Purpose',
    '',
    'Verify parser stability of the COMBINED_LLM=1 path (one LLM call per chunk,',
    'returns `{"context":"...","tags":[...]}`) across gemma3:4b and qwen2.5:3b-instruct.',
    'Diagnostic only — no Qdrant indexing, no production default changes.',
    'Corpus = private files; report contains only aggregate counts.',
    '',
    '## Corpus Summary',
    '',
    '| Metric | Count |',
    '|--------|-------|',
    `| Files | ${corpus.totalFiles} (${corpus.skipped} skipped) |`,
    `| Raw chunks | ${corpus.totalRaw} |`,
    `| Merged chunks | ${corpus.totalMerged} |`,
    `| Normal chunks total | ${corpus.totalNormal} |`,
    `| Normal chunks tested | ${sampleNote} |`,
    `| Empty-section skipped | ${corpus.totalEmpty} |`,
    `| Too-short skipped (< ${COMBINED_MIN_CHARS} chars) | ${results.reduce((a, r) => Math.max(a, r.tooShortSkipped), 0)} |`,
    '',
    '## Model Matrix',
    '',
    '| model | chunks tested | parse fail | fail rate | empty tags | mean tags | mean ms | p50 ms | p95 ms |',
    '|-------|---------------|------------|-----------|------------|-----------|---------|--------|--------|',
    ...results.map(r =>
      `| ${r.model} | ${r.tested} | ${r.parseFail} | ${(r.failRate*100).toFixed(1)}% | ${r.emptyTagsCount} | ${r.meanTags} | ${r.mean} | ${r.p50} | ${r.p95} |`
    ),
    '',
    '## Failure Reasons',
  ];

  for (const r of results) {
    lines.push('', `### ${r.model}`, '');
    const total = Object.values(r.reasons).reduce((a, b) => a + b, 0);
    if (total === 0) {
      lines.push('No parse failures.');
    } else {
      lines.push(
        '| reason | count | share |',
        '|--------|-------|-------|',
        ...Object.entries(r.reasons)
          .sort(([,a],[,b]) => b - a)
          .map(([reason, n]) => `| ${reason} | ${n} | ${(n/total*100).toFixed(0)}% |`),
      );
    }
    // Note: invalidTagsCount is measured on already-normalized output (parseCombinedResponse
    // calls normalizeTags before returning). Raw model output may have had uppercase or
    // spaces that the normalizer silently fixed — invalidTagsCount=0 does not mean the
    // model always outputs clean tags.
    if (r.invalidTagsCount > 0) {
      lines.push('', `Note: ${r.invalidTagsCount} chunks had tags with uppercase or spaces even after normalization.`);
    }
  }

  lines.push(
    '',
    '## Interpretation',
    '',
  );

  // Per-model interpretation
  for (const r of results) {
    const isStable = r.failRate < 0.05;
    const isRisky  = r.failRate >= 0.05 && r.failRate < 0.20;
    const status   = isStable ? 'stable' : isRisky ? 'marginal' : 'unstable';
    const timeouts = r.reasons.timeout_or_generate_error ?? 0;
    lines.push(
      `**${r.model}**: ${status} (${(r.failRate*100).toFixed(1)}% parse fail rate).` +
      (timeouts > 0 ? ` ${timeouts} timeout(s).` : '') +
      (r.emptyTagsCount > 0 ? ` ${r.emptyTagsCount} empty-tag result(s) (parse_ok but no tags returned).` : '') +
      '',
    );
  }

  // Comparison vs separate tag batch path
  lines.push(
    '',
    '## Comparison vs Separate Tag Batch Path',
    '',
    'Separate path (tag-batch-fallback-diagnostic, pre-fix baseline):',
    '',
    '| model | batchSize | fail rate (tag batch) | fail rate (combined) |',
    '|-------|-----------|-----------------------|----------------------|',
    '| gemma3:4b | 3 | 21.2% | see above |',
    '| qwen2.5:3b-instruct | 3 | 15.2% (post-fix) | see above |',
    '',
    'Combined path sends one `{context, tags}` JSON object per chunk vs the separate',
    'path\'s array-of-arrays over a batch. The simpler object shape is expected to',
    'produce fewer format failures on small models.',
  );

  lines.push(
    '',
    '## Verdict',
    '',
    `**${verdict.label}**`,
    '',
    verdict.detail,
    '',
    `*Generated: ${date}*`,
  );

  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(filepath, lines.join('\n') + '\n');
  return filename;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('[combined-parser-diag] Combined context+tags parser stability diagnostic');
console.log(`  models:     ${MODELS.join(', ')}`);
console.log(`  max chunks: ${isFinite(MAX_CHUNKS) ? MAX_CHUNKS : 'all'}`);
console.log(`  files:      ${SOURCE_FILES.length}`);
console.log(`  tmp dir:    ${TMP_DIR}`);
mkdirSync(TMP_DIR, { recursive: true });

console.log('\n[combined-parser-diag] Loading corpus...');
const { perFile, allNormal, totalRaw, totalMerged, totalNormal, totalEmpty, totalBeforeSample }
  = await loadCorpus();
const skippedCount = perFile.filter(f => f.status === 'missing').length;
console.log(`  normal chunks to test: ${allNormal.length}  empty-section skipped: ${totalEmpty}`);

if (allNormal.length === 0) {
  console.error('No normal chunks to test. Check CORPUS_ROOT / CORPUS_FILES.');
  process.exit(1);
}

const results = await runMatrix(allNormal);

const verdict = deriveVerdict(results);
console.log(`\n[combined-parser-diag] Verdict: ${verdict.label}`);
console.log(`  ${verdict.detail}`);

const corpus = {
  totalFiles: SOURCE_FILES.length, skipped: skippedCount,
  totalRaw, totalMerged, totalNormal, totalEmpty,
  totalBeforeSample,
  tested: allNormal.length,
};
const filename = writeReport({ corpus, results, verdict });
console.log(`\n[combined-parser-diag] Report: ${join(RESULTS_DIR, filename)}`);
console.log(`[combined-parser-diag] Raw outputs: ${TMP_DIR}/raw/`);
