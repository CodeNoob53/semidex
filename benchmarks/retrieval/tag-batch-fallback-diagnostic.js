/**
 * Tag batch fallback diagnostic.
 *
 * Probes why addTagsBatch() falls back to per-chunk calls on a given corpus.
 * Runs real production chunking + empty-section routing, then calls the same
 * batch prompt used in production for each (model, batchSize) combination.
 * Collects per-batch parse result, failure reason, and chunk metadata.
 *
 * Required env:
 *   CORPUS_ROOT  — absolute path to directory containing source files
 *   CORPUS_FILES — comma-separated relative paths under CORPUS_ROOT
 *
 * Optional env:
 *   TAG_MODEL       — single model (default: gemma3:4b)
 *   TAG_MODELS      — comma-separated model list for matrix; overrides TAG_MODEL
 *   TAG_BATCH_SIZES — comma-separated sizes to probe (default: 3,2,1)
 *   QDRANT_URL, QDRANT_KEY — not used; kept for .env compatibility
 *
 * Outputs:
 *   .tmp/tag-batch-fallback-<stamp>/raw/<model>/<size>/<idx>.txt — raw LLM output
 *   benchmarks/retrieval/results/YYYY-MM-DDTHHMM-tag-batch-fallback-diagnostic.md
 *
 * Raw outputs are NOT committed (covered by .gitignore on .tmp/).
 * Report contains no private file paths or raw chunk content.
 */

import 'dotenv/config';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { resolve, join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

import { generate }         from '../../src/local/core/ollama.js';
import { chunkFileFromPath } from '../../src/shared/indexer/phases/chunk.js';
import { partitionChunks }   from '../../src/shared/indexer/phases/empty-section.js';
import { extractJsonArray }  from '../../src/shared/indexer/phases/tag.js';

const ROOT        = resolve(dirname(fileURLToPath(import.meta.url)), '../../');
const RESULTS_DIR = join(ROOT, 'benchmarks', 'retrieval', 'results');
const STAMP       = Date.now();
const TMP_DIR     = join(ROOT, '.tmp', `tag-batch-fallback-${STAMP}`);

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

const MODELS = (process.env.TAG_MODELS || process.env.TAG_MODEL || 'gemma3:4b')
  .split(',').map(m => m.trim()).filter(Boolean);

const BATCH_SIZES = (process.env.TAG_BATCH_SIZES || '3,2,1')
  .split(',').map(n => parseInt(n.trim(), 10)).filter(n => n > 0);

// ── Failure classification ────────────────────────────────────────────────────
//
// Classification is done on what the production parser (extractJsonArray) sees
// after its own fence-stripping. If a fenced response would have parsed correctly
// after stripping, production would have succeeded — so it cannot be the failure
// cause here. We always classify based on the stripped content.

function classifyFailure(raw, expectedLength) {
  if (!raw || raw.trim().length === 0)
    return 'empty_or_refusal';

  // Ends mid-array — likely truncated before close bracket
  if (raw.trimEnd().endsWith(',') || raw.trimEnd().endsWith('['))
    return 'truncated';

  // Strip fence the same way production does, then classify on what remains
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  let parsed = null;
  try { parsed = JSON.parse(stripped); } catch { /* keep null */ }

  if (parsed === null)
    return 'non_json';

  if (Array.isArray(parsed)) {
    if (parsed.length !== expectedLength) return 'wrong_length';
    if (!parsed.every(Array.isArray))     return 'wrong_shape';
    return 'unknown'; // extractJsonArray rejected it despite valid-looking structure
  }

  // Object wrapper (e.g. {"tags": [[...]]}) — extractJsonArray tries to recover
  // these; if it still failed the inner arrays didn't satisfy the length check
  if (typeof parsed === 'object') return 'wrong_shape';

  return 'unknown';
}

// ── Chunk metadata helpers ────────────────────────────────────────────────────

const LIST_MARKER_RE = /^(\s*[-*+]|\s*\d+\.)\s/m;

function chunkMeta(chunks) {
  const chars = chunks.map(c => (c.text ?? '').length);
  const listHeavy = chunks.filter(c => {
    const lines = (c.text ?? '').split('\n');
    const listLines = lines.filter(l => LIST_MARKER_RE.test(l)).length;
    return listLines / Math.max(lines.length, 1) > 0.4;
  }).length;
  return {
    count:         chunks.length,
    totalChars:    chars.reduce((a, b) => a + b, 0),
    maxChars:      Math.max(...chars),
    meanChars:     Math.round(chars.reduce((a, b) => a + b, 0) / chars.length),
    listHeavyCount: listHeavy,
  };
}

// ── Tag batch probe ───────────────────────────────────────────────────────────
// Both prompts mirror src/indexer/phases/tag.js exactly.
// If production prompts change, update here to match.

function buildSinglePrompt(chunk) {
  return `You are a document tagger. Generate 3-7 concise tags for this text chunk. Tags should describe the topic, technology, or concept. Use lowercase, hyphens for spaces (e.g. "node-js", "sql-join", "normalization"). Output only a comma-separated list of tags, nothing else.

File: ${chunk.source_file}
Section: ${chunk.section || 'unknown'}
Context: ${chunk.context || ''}

Text:
${chunk.text.slice(0, 800)}`;
}

function buildBatchPrompt(chunks) {
  const n = chunks.length;
  const example = Array.from({ length: n }, (_, i) => [`tag${i}a`, `tag${i}b`]);
  const items = chunks.map((c, i) => `CHUNK ${i}:\n${c.text.slice(0, 400)}`).join('\n\n');
  return `You are a document tagger. Generate 3-7 lowercase hyphenated tags for each chunk.
IMPORTANT: Output ONLY a JSON array of ${n} arrays, nothing else. No explanation, no markdown.
Example output for ${n} chunks: ${JSON.stringify(example)}

${items}

Output:`;
}

async function probeOneBatch(chunks, model, rawDir, batchIdx) {
  const t0   = Date.now();
  const meta = chunkMeta(chunks);

  // Production addTagsBatch() exits early for length=1, skipping the JSON batch
  // prompt entirely and calling addTags() (single comma-list prompt) instead.
  // Mimic that here so batchSize=1 results are production-equivalent.
  if (chunks.length === 1) {
    try {
      await generate(model, buildSinglePrompt(chunks[0]));
      return { ok: true, reason: 'ok', latencyMs: Date.now() - t0, meta, rawPath: null };
    } catch (e) {
      return { ok: false, reason: 'generate_error', latencyMs: Date.now() - t0, meta, rawPath: null };
    }
  }

  const prompt = buildBatchPrompt(chunks);
  let raw = '';
  let ok  = false;
  let reason = 'unknown';
  let rawPath = null;

  try {
    raw = await generate(model, prompt, { format: 'json' });
    const parsed = extractJsonArray(raw, chunks.length);
    if (parsed) {
      ok = true;
    } else {
      reason = classifyFailure(raw, chunks.length);
      // Save raw output to .tmp for debugging — NOT committed
      rawPath = join(rawDir, `batch-${String(batchIdx).padStart(4, '0')}.txt`);
      writeFileSync(rawPath, raw);
    }
  } catch (e) {
    reason = 'generate_error';
    rawPath = join(rawDir, `batch-${String(batchIdx).padStart(4, '0')}-error.txt`);
    writeFileSync(rawPath, e.message + '\n---\n' + raw);
  }

  return { ok, reason, latencyMs: Date.now() - t0, meta, rawPath };
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
    const raw     = await chunkFileFromPath(abs, rel);
    const merged  = raw;
    const { normal, empty } = partitionChunks(merged);
    totalRaw    += raw.length;
    totalMerged += merged.length;
    totalNormal += normal.length;
    totalEmpty  += empty.length;
    perFile.push({ rel, status: 'ok', raw: raw.length, merged: merged.length,
                   normal: normal.length, empty: empty.length, chunks: normal });
    console.log(`  [corpus] ${basename(rel).padEnd(30)} raw=${raw.length} merged=${merged.length} normal=${normal.length} empty=${empty.length}`);
  }

  const allNormal = perFile.flatMap(f => f.chunks);
  return { perFile, allNormal, totalRaw, totalMerged, totalNormal, totalEmpty };
}

// ── Matrix runner ─────────────────────────────────────────────────────────────

async function runMatrix(allNormal, totalEmpty) {
  const results = [];

  for (const model of MODELS) {
    for (const batchSize of BATCH_SIZES) {
      console.log(`\n[diag] model=${model}  batchSize=${batchSize}`);
      const rawDir = join(TMP_DIR, 'raw', model.replace(/[:/]/g, '_'), String(batchSize));
      mkdirSync(rawDir, { recursive: true });

      const batches = [];
      for (let i = 0; i < allNormal.length; i += batchSize) {
        batches.push(allNormal.slice(i, i + batchSize));
      }

      let passed = 0, failed = 0;
      const reasons = {};
      const latencies = [];
      const failedMetas = [];

      for (let idx = 0; idx < batches.length; idx++) {
        const batch = batches[idx];
        process.stdout.write(`  batch ${idx + 1}/${batches.length}... `);
        const r = await probeOneBatch(batch, model, rawDir, idx);
        latencies.push(r.latencyMs);
        if (r.ok) {
          passed++;
          process.stdout.write(`ok (${r.latencyMs}ms)\n`);
        } else {
          failed++;
          reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
          failedMetas.push({ ...r.meta, reason: r.reason });
          process.stdout.write(`FAIL ${r.reason} (${r.latencyMs}ms)\n`);
        }
      }

      const latSorted = [...latencies].sort((a, b) => a - b);
      const p50 = latSorted[Math.floor(latSorted.length * 0.5)] ?? 0;
      const mean = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
      const failRate = batches.length > 0 ? failed / batches.length : 0;

      console.log(`  passed=${passed} failed=${failed} failRate=${(failRate * 100).toFixed(1)}% mean=${mean}ms p50=${p50}ms`);
      results.push({ model, batchSize, total: batches.length, passed, failed,
                     failRate, mean, p50, reasons, failedMetas });
    }
  }

  return results;
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

function deriveVerdict(results, totalNormal, totalEmpty) {
  const defaultSize = BATCH_SIZES[0];

  // For each model, check if a smaller (but >1) batch size substantially reduces
  // failures compared to the same model at default size.
  // batchSize=1 is excluded: it uses the single-chunk path, so a low fail rate
  // there says nothing about the batch JSON prompt reliability.
  for (const model of MODELS) {
    const defResult = results.find(r => r.model === model && r.batchSize === defaultSize);
    if (!defResult || defResult.failRate < 0.05) continue; // default already fine

    for (const r of results) {
      if (r.model !== model) continue;
      if (r.batchSize >= defaultSize) continue;
      if (r.batchSize === 1) continue; // single-chunk path, not batch-prompt comparable
      if (r.failRate < 0.05) {
        const labelSize = r.batchSize === 2 ? 'PROCEED_TAG_BATCH_SIZE_2'
          : `PROCEED_TAG_BATCH_SIZE_${r.batchSize}`;
        return {
          label: labelSize,
          detail: `${model} at batchSize=${r.batchSize} reduces fail rate from ` +
            `${(defResult.failRate*100).toFixed(1)}% to ${(r.failRate*100).toFixed(1)}%. ` +
            `Reducing LLM_BATCH_SIZE from ${defaultSize} to ${r.batchSize} is the recommended short-term fix.`,
        };
      }
    }
  }

  // Check if parser fix would cover the dominant failure class at default batch size
  const defResults = results.filter(r => r.batchSize === defaultSize);
  const fixableReasons = new Set(['wrong_shape', 'wrong_length']);
  const promptReasons  = new Set(['non_json', 'empty_or_refusal', 'truncated']);
  let fixableCount = 0, promptCount = 0, totalFailed = 0;
  for (const r of defResults) {
    for (const [reason, count] of Object.entries(r.reasons)) {
      totalFailed += count;
      if (fixableReasons.has(reason)) fixableCount += count;
      if (promptReasons.has(reason))  promptCount  += count;
    }
  }

  if (totalFailed === 0) {
    return { label: 'NO_FALLBACKS', detail: 'No tag batch fallbacks observed at any tested batch size.' };
  }

  if (fixableCount / totalFailed > 0.5) {
    return {
      label: 'PARSER_FIX_FIRST',
      detail: `${fixableCount}/${totalFailed} failures (${(fixableCount/totalFailed*100).toFixed(0)}%) are ` +
        'wrong_shape / wrong_length — JSON parsed but structure did not match expected array-of-arrays. ' +
        'Improving extractJsonArray recovery logic may fix these before reducing batch size.',
    };
  }

  if (promptCount / totalFailed > 0.5) {
    return {
      label: 'PROMPT_FIX_FIRST',
      detail: `${promptCount}/${totalFailed} failures (${(promptCount/totalFailed*100).toFixed(0)}%) are ` +
        'non_json / truncated / refusal — model does not follow the prompt reliably. ' +
        'Prompt engineering or model switch recommended.',
    };
  }

  // Still high failures with batch=1?
  const size1 = results.find(r => r.batchSize === 1);
  if (size1 && size1.failRate > 0.15) {
    return {
      label: 'TAG_GEN_0_FOR_LARGE_CORPUS',
      detail: `Even batchSize=1 has ${(size1.failRate*100).toFixed(1)}% failure rate. ` +
        'Tag generation cost is not justified. Use TAG_GEN=0 for automated pipelines.',
    };
  }

  // Check overall latency penalty vs. value
  const defSize3 = results.find(r => r.batchSize === defaultSize && r.model === MODELS[0]);
  if (defSize3 && defSize3.failRate > 0.10) {
    return {
      label: 'KEEP_TAG_GEN_OPTIONAL',
      detail: `Failure rate ${(defSize3.failRate*100).toFixed(1)}% at batchSize=${defaultSize} with ${defSize3.model}. ` +
        'Consider keeping TAG_GEN=0 as default for pipelines and TAG_GEN=1 only for interactive use.',
    };
  }

  return {
    label: 'KEEP_TAG_GEN_OPTIONAL',
    detail: 'No single fix clearly dominates. Monitor failure reasons and consider TAG_GEN=0 for large automated runs.',
  };
}

function allReasonCounts(results, batchSize) {
  const counts = {};
  for (const r of results.filter(r => r.batchSize === batchSize)) {
    for (const [reason, count] of Object.entries(r.reasons)) {
      counts[reason] = (counts[reason] ?? 0) + count;
    }
  }
  return counts;
}

function writeReport({ corpus, results, verdict }) {
  const { date, time } = formatDate();
  const filename = `${date}T${time}-tag-batch-fallback-diagnostic.md`;
  const filepath  = join(RESULTS_DIR, filename);

  const lines = [
    `# Tag Batch Fallback Diagnostic — ${date}`,
    '',
    '## Purpose',
    '',
    'Diagnose why tag batch phase still falls back to per-chunk calls after the',
    'empty-section fix. Corpus = private files; report contains no file paths or',
    'raw chunk content.',
    '',
    '## Corpus Summary',
    '',
    '| Metric | Count |',
    '|--------|-------|',
    `| Files | ${corpus.totalFiles} (${corpus.skipped} skipped) |`,
    `| Raw chunks | ${corpus.totalRaw} |`,
    `| Merged chunks | ${corpus.totalMerged} |`,
    `| Normal chunks (probed) | ${corpus.totalNormal} |`,
    `| Empty-section skipped | ${corpus.totalEmpty} |`,
    '',
    '## Matrix: model × batchSize',
    '',
    '| model | batchSize | batches | failures | failRate | meanMs | p50Ms |',
    '|-------|-----------|---------|----------|----------|--------|-------|',
    ...results.map(r =>
      `| ${r.model} | ${r.batchSize} | ${r.total} | ${r.failed} | ${(r.failRate*100).toFixed(1)}% | ${r.mean} | ${r.p50} |`
    ),
  ];

  // Reason breakdown for each batch size
  for (const batchSize of BATCH_SIZES) {
    const counts = allReasonCounts(results, batchSize);
    const total  = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    lines.push(
      '',
      `## Failure Reasons — batchSize=${batchSize}`,
      '',
      '| reason | count | share |',
      '|--------|-------|-------|',
      ...Object.entries(counts)
        .sort(([,a],[,b]) => b - a)
        .map(([r, n]) => `| ${r} | ${n} | ${(n/total*100).toFixed(0)}% |`),
    );
  }

  // Batch metadata for failures at default size
  const defaultSize = BATCH_SIZES[0];
  const defFailedMetas = results
    .filter(r => r.batchSize === defaultSize)
    .flatMap(r => r.failedMetas);
  if (defFailedMetas.length > 0) {
    const listHeavy = defFailedMetas.filter(m => m.listHeavyCount > 0).length;
    const meanChars = Math.round(defFailedMetas.reduce((a, m) => a + m.meanChars, 0) / defFailedMetas.length);
    const maxChars  = Math.max(...defFailedMetas.map(m => m.maxChars));
    lines.push(
      '',
      `## Failed Batch Metadata — batchSize=${defaultSize}`,
      '',
      '| Metric | Value |',
      '|--------|-------|',
      `| Failed batches | ${defFailedMetas.length} |`,
      `| With list-heavy chunks | ${listHeavy} (${(listHeavy/defFailedMetas.length*100).toFixed(0)}%) |`,
      `| Mean chunk chars (failed batches) | ${meanChars} |`,
      `| Max chunk chars (failed batches) | ${maxChars} |`,
    );
  }

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

console.log('[tag-batch-diag] Tag batch fallback diagnostic');
console.log(`  models:       ${MODELS.join(', ')}`);
console.log(`  batch sizes:  ${BATCH_SIZES.join(', ')}`);
console.log(`  files:        ${SOURCE_FILES.length}`);
console.log(`  tmp dir:      ${TMP_DIR}`);
mkdirSync(TMP_DIR, { recursive: true });

console.log('\n[tag-batch-diag] Loading corpus...');
const { perFile, allNormal, totalRaw, totalMerged, totalNormal, totalEmpty } = await loadCorpus();
const skippedCount = perFile.filter(f => f.status === 'missing').length;
console.log(`  normal chunks to probe: ${allNormal.length}  empty-section skipped: ${totalEmpty}`);

if (allNormal.length === 0) {
  console.error('No normal chunks to probe. Check CORPUS_ROOT / CORPUS_FILES.');
  process.exit(1);
}

const results = await runMatrix(allNormal, totalEmpty);

const verdict = deriveVerdict(results, totalNormal, totalEmpty);
console.log(`\n[tag-batch-diag] Verdict: ${verdict.label}`);
console.log(`  ${verdict.detail}`);

const corpus = {
  totalFiles: SOURCE_FILES.length, skipped: skippedCount,
  totalRaw, totalMerged, totalNormal, totalEmpty,
};
const filename = writeReport({ corpus, results, verdict });
console.log(`\n[tag-batch-diag] Report: ${join(RESULTS_DIR, filename)}`);
console.log(`[tag-batch-diag] Raw outputs: ${TMP_DIR}/raw/`);
