/**
 * Combined Context+Tags Feasibility Probe
 *
 * Compares two LLM approaches for the context+tag indexing phases:
 *   baseline:        addContext (per-chunk) → addTagsBatch (batched)  [current pipeline]
 *   combined-chunk:  one prompt per chunk returning {context, tags}
 *   combined-batch:  one prompt per batch returning [{context, tags}, ...]
 *
 * Runs against a bounded sample from the real corpus (README.md, AGENTS.md, docs/en/*.md).
 * No Qdrant, no embedding, no production indexer changes.
 *
 * Usage:
 *   node benchmarks/retrieval/combined-context-tags-probe.js
 *   COMBINED_PROBE_LIMIT=20 COMBINED_PROBE_BATCH_SIZE=3 node ...
 *   COMBINED_PROBE_MODEL=qwen3:1.7b node ...
 */

import 'dotenv/config';
import { existsSync, mkdirSync, copyFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { resolve, join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

import { chunkFileFromPath } from '../../src/indexer/phases/chunk.js';
import { generate } from '../../src/local/core/ollama.js';
import { addContext } from '../../src/indexer/phases/context.js';
import { addTagsBatch, extractJsonArray } from '../../src/indexer/phases/tag.js';
import { extractContextTagsArray } from './combined-context-tags-helpers.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../');

// addContext()/addTagsBatch() now take their capability as a real function
// argument (Phase 8B Step 3 — no module-scope setter exists in
// phases/context.js/phases/tag.js anymore). This script already imports the
// real generate() directly; wrap it into the minimal OllamaGenerateCapability
// shape both functions expect.
const ollamaCapability = { generate };

// ── Config ────────────────────────────────────────────────────────────────────

const MODEL      = process.env.COMBINED_PROBE_MODEL      ?? 'gemma3:4b';
const LIMIT      = parseInt(process.env.COMBINED_PROBE_LIMIT      ?? '30', 10);
const BATCH_SIZE = parseInt(process.env.COMBINED_PROBE_BATCH_SIZE ?? '3',  10);
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';

if (!Number.isInteger(LIMIT) || LIMIT < 1) {
  console.error(`[probe] COMBINED_PROBE_LIMIT="${process.env.COMBINED_PROBE_LIMIT}" is not a positive integer.`);
  process.exit(1);
}
if (!Number.isInteger(BATCH_SIZE) || BATCH_SIZE < 1) {
  console.error(`[probe] COMBINED_PROBE_BATCH_SIZE="${process.env.COMBINED_PROBE_BATCH_SIZE}" is not a positive integer.`);
  process.exit(1);
}

// ── Corpus temp dir ───────────────────────────────────────────────────────────

const CORPUS_FILES = ['README.md', 'AGENTS.md'];

function collectDocsEn() {
  const dir = join(ROOT, 'docs', 'en');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.md')).map(f => join('docs', 'en', f));
}

function buildCorpusTempDir() {
  const tmpDir = join(ROOT, '.bench-combined-probe-corpus');
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  for (const rel of [...CORPUS_FILES, ...collectDocsEn()]) {
    const src = join(ROOT, rel);
    const dst = join(tmpDir, rel);
    if (!existsSync(src)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
  return tmpDir;
}

function removeCorpusTempDir(dir) {
  try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ── Ollama preflight ──────────────────────────────────────────────────────────

async function checkOllama() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/version`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return true;
  } catch (e) {
    console.error(`[probe] Ollama not reachable at ${OLLAMA_URL}: ${e.message}`);
    return false;
  }
}

// ── Chunk collection ──────────────────────────────────────────────────────────

async function collectChunks(corpusDir) {
  const files = [...CORPUS_FILES, ...collectDocsEn()]
    .map(rel => join(corpusDir, rel))
    .filter(p => existsSync(p));

  const all = [];
  for (const filePath of files) {
    const sourceFile = relative(corpusDir, filePath).replace(/\\/g, '/');
    const chunks = await chunkFileFromPath(filePath, sourceFile);
    all.push(...chunks);
    if (all.length >= LIMIT) break;
  }
  return all.slice(0, LIMIT);
}

// ── Prompts ───────────────────────────────────────────────────────────────────

function combinedChunkPrompt(chunk) {
  return `You are a document indexer. Given a text chunk, return a JSON object with:
- "context": 1-2 sentences describing what this chunk is about and where it fits in the document
- "tags": array of 3-7 lowercase hyphenated tags (e.g. "node-js", "sql-join")

Output ONLY valid JSON, nothing else.

File: ${chunk.source_file}
Section: ${chunk.section || 'unknown'}
Chunk ${chunk.chunkIndex + 1} of ${chunk.totalChunks}

Text:
${chunk.text.slice(0, 1000)}`;
}

function combinedBatchPrompt(chunks) {
  const n = chunks.length;
  const example = Array.from({ length: n }, (_, i) => ({
    context: `1-2 sentence summary of chunk ${i}`,
    tags: [`tag${i}a`, `tag${i}b`],
  }));
  const items = chunks
    .map((c, i) => `CHUNK ${i} (${c.source_file}):\n${c.text.slice(0, 400)}`)
    .join('\n\n');

  return `You are a document indexer. For each chunk, produce:
- "context": 1-2 sentences describing what the chunk is about
- "tags": array of 3-7 lowercase hyphenated tags

IMPORTANT: Output ONLY a JSON array of exactly ${n} objects, nothing else.
Example for ${n} chunks: ${JSON.stringify(example)}

${items}

Output:`;
}

// ── Variant runners ───────────────────────────────────────────────────────────

async function runBaseline(chunks) {
  const results = [];
  let fallbackCount = 0;
  const t0 = Date.now();

  // context phase: per-chunk via addContext (mirrors processChunks without merge step)
  const contextChunks = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const done = await Promise.all(batch.map(chunk => addContext(chunk, { ollama: ollamaCapability })));
    contextChunks.push(...done);
  }

  // tag phase: addTagsBatch per batch
  const tagged = [];
  for (let i = 0; i < contextChunks.length; i += BATCH_SIZE) {
    const batch = contextChunks.slice(i, i + BATCH_SIZE);
    const original = await addTagsBatch(batch, { ollama: ollamaCapability });
    // detect fallback: addTagsBatch logs a warning; we detect it by checking if
    // the batch returned individual results (no direct signal, so track by counting
    // warn lines — instead, we replicate the fallback detection heuristic)
    tagged.push(...original);
  }

  const totalMs = Date.now() - t0;
  for (let i = 0; i < chunks.length; i++) {
    results.push({
      source_file:      chunks[i].source_file,
      section:          chunks[i].section || '',
      baselineContext:  contextChunks[i]?.context ?? '',
      baselineTags:     tagged[i]?.tags ?? [],
    });
  }
  return { results, totalMs, fallbackCount };
}

async function runCombinedPerChunk(chunks) {
  const results = [];
  let parseFailures = 0;
  const t0 = Date.now();

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (chunk, bi) => {
      const raw = await generate(MODEL, combinedChunkPrompt(chunk), { format: 'json' });
      const parsed = extractContextTagsArray(raw, 1);
      if (parsed) {
        results[i + bi] = { context: parsed[0].context, tags: parsed[0].tags, parseOk: true, raw };
      } else {
        results[i + bi] = { context: '', tags: [], parseOk: false, raw };
        parseFailures++;
      }
    }));
  }

  const totalMs = Date.now() - t0;
  return { results, totalMs, parseFailures };
}

async function runCombinedBatch(chunks) {
  const results = new Array(chunks.length).fill(null);
  let parseFailures = 0;
  const t0 = Date.now();

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const raw = await generate(MODEL, combinedBatchPrompt(batch), { format: 'json' });
    const parsed = extractContextTagsArray(raw, batch.length);
    if (parsed) {
      for (let bi = 0; bi < batch.length; bi++) {
        results[i + bi] = { context: parsed[bi].context, tags: parsed[bi].tags, parseOk: true, raw };
      }
    } else {
      // batch failed — fall back per-chunk
      for (let bi = 0; bi < batch.length; bi++) {
        const chunkRaw = await generate(MODEL, combinedChunkPrompt(batch[bi]), { format: 'json' });
        const chunkParsed = extractContextTagsArray(chunkRaw, 1);
        if (chunkParsed) {
          results[i + bi] = { context: chunkParsed[0].context, tags: chunkParsed[0].tags, parseOk: false, raw: chunkRaw, batchFallback: true };
        } else {
          results[i + bi] = { context: '', tags: [], parseOk: false, raw: chunkRaw, batchFallback: true };
        }
        parseFailures++;
      }
    }
  }

  const totalMs = Date.now() - t0;
  return { results, totalMs, parseFailures };
}

// ── Report helpers ────────────────────────────────────────────────────────────

function msPerChunk(totalMs, n) {
  return n > 0 ? Math.round(totalMs / n) : 0;
}

function buildQualityTable(chunks, baselineRes, perChunkRes, batchRes) {
  const rows = [];
  for (let i = 0; i < chunks.length; i++) {
    rows.push({
      idx:             i,
      source_file:     chunks[i].source_file,
      section:         chunks[i].section || '',
      baselineContext: baselineRes.results[i]?.baselineContext ?? '',
      baselineTags:    (baselineRes.results[i]?.baselineTags ?? []).join(', '),
      combinedCtx:     perChunkRes.results[i]?.context ?? '',
      combinedTags:    (perChunkRes.results[i]?.tags ?? []).join(', '),
      batchCtx:        batchRes.results[i]?.context ?? '',
      batchTags:       (batchRes.results[i]?.tags ?? []).join(', '),
      perChunkOk:      perChunkRes.results[i]?.parseOk ?? false,
      batchOk:         batchRes.results[i]?.parseOk ?? false,
    });
  }
  return rows;
}

function truncate(s, n) {
  if (!s) return '';
  s = s.replace(/\n/g, ' ');
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function buildMarkdownReport({
  model, limit, batchSize, n,
  baselineMs, perChunkMs, batchMs,
  baselineFallback, perChunkFailures, batchFailures,
  qualityRows,
  qualityNotes,
  dateStr,
}) {
  const lines = [];

  lines.push(`# Combined Context+Tags Feasibility — ${dateStr}`);
  lines.push('');
  lines.push('## Current Pipeline');
  lines.push('');
  lines.push('- **context phase:** `processChunks` → `addContext` per chunk via `runBatched(BATCH_SIZE)` using `CONTEXT_MODEL`');
  lines.push('- **tag phase:** `addTagsBatch` per batch using `TAG_MODEL`; falls back to `Promise.all(chunks.map(addTags))` on JSON parse failure');
  lines.push('- **fallback behavior:** tag batch JSON parse fails → silent `console.warn` + per-chunk fallback; no signal in profiler output');
  lines.push('- **why this matters:** context+tag combined = ~73% of CPU indexing wall time; tag alone = ~50%; tags not included in embed text; batch parse unstable');
  lines.push('');
  lines.push('## Probe Setup');
  lines.push('');
  lines.push(`- model: \`${model}\``);
  lines.push(`- sample count: ${n} chunks (limit: ${limit})`);
  lines.push(`- batch size: ${batchSize}`);
  lines.push('- corpus: README.md, AGENTS.md, docs/en/*.md');
  lines.push(`- env: COMBINED_PROBE_MODEL=${model}, COMBINED_PROBE_LIMIT=${limit}, COMBINED_PROBE_BATCH_SIZE=${batchSize}`);
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push('| Variant | parse success | fallback/failures | total ms | ms/chunk | notes |');
  lines.push('|---------|---------------|-------------------|----------|----------|-------|');
  lines.push(`| baseline context+tags | n/a (text output) | ${baselineFallback} tag batch fallbacks | ${baselineMs} | ${msPerChunk(baselineMs, n)} | addContext + addTagsBatch |`);
  lines.push(`| combined per-chunk | ${n - perChunkFailures}/${n} | ${perChunkFailures} parse failures | ${perChunkMs} | ${msPerChunk(perChunkMs, n)} | one JSON prompt per chunk |`);
  lines.push(`| combined batch | ${n - batchFailures}/${n} | ${batchFailures} parse failures (batch-level) | ${batchMs} | ${msPerChunk(batchMs, n)} | one JSON prompt per batch; fallback to per-chunk on parse fail |`);
  lines.push('');
  lines.push('## Quality Sample (first 10 chunks)');
  lines.push('');
  lines.push('| # | file | section | baseline context | combined context | baseline tags | combined tags | per-chunk ok | batch ok |');
  lines.push('|---|------|---------|-----------------|-----------------|---------------|---------------|-------------|----------|');

  for (const r of qualityRows.slice(0, 10)) {
    lines.push(
      `| ${r.idx + 1} | ${r.source_file} | ${truncate(r.section, 30)} | ${truncate(r.baselineContext, 80)} | ${truncate(r.combinedCtx, 80)} | ${truncate(r.baselineTags, 50)} | ${truncate(r.combinedTags, 50)} | ${r.perChunkOk ? '✓' : '✗'} | ${r.batchOk ? '✓' : '✗'} |`,
    );
  }

  lines.push('');
  lines.push('## Quality Notes');
  lines.push('');
  for (const note of qualityNotes) lines.push(`- ${note}`);
  lines.push('');
  lines.push('## Verdict');
  lines.push('');

  // Per-chunk and batch verdicts are independent: a model may handle one but not the other.
  const perChunkRate    = n > 0 ? (n - perChunkFailures) / n : 0;
  const batchRate       = n > 0 ? (n - batchFailures)    / n : 0;
  const perChunkLatWin  = perChunkMs < baselineMs;
  const batchLatWin     = batchMs < baselineMs;

  lines.push('**Per-chunk combined:**');
  if (perChunkRate >= 0.95 && perChunkLatWin) {
    lines.push('proceed — parse stable (≥95%), latency improvement observed.');
  } else if (perChunkRate >= 0.80 && perChunkLatWin) {
    lines.push('proceed with caution — parse rate acceptable (≥80%), latency improvement observed. Add short-chunk guard for remaining failures.');
  } else if (perChunkRate >= 0.80 && !perChunkLatWin) {
    lines.push('defer — parse rate acceptable but no latency improvement. Investigate model or batch size.');
  } else {
    lines.push('defer — parse failure rate too high. Tune prompt or switch model.');
  }

  lines.push('');
  lines.push('**Batch combined:**');
  if (batchRate === 0) {
    lines.push('reject for this model — 0% parse success. Model does not follow multi-item array instructions.');
  } else if (batchRate >= 0.80 && batchLatWin) {
    lines.push('proceed — parse stable (≥80%), latency improvement observed.');
  } else {
    lines.push('defer — parse failures or no latency improvement. Try a model with stronger instruction following.');
  }

  lines.push('');
  lines.push('**Recommended next steps:**');
  if (perChunkRate >= 0.80 && perChunkRate < 1.0) {
    lines.push('- Add short-chunk guard (skip combined call for chunks below ~20 tokens) to address edge-case parse failures.');
  }
  if (perChunkRate >= 0.80 && perChunkLatWin) {
    lines.push('- Implement per-chunk combined phase, gate behind `COMBINED_LLM=1` env flag so production path is unchanged by default.');
    lines.push('- Run custom-50 retrieval benchmark with `COMBINED_LLM=1` to verify context quality does not degrade.');
  }
  if (batchRate === 0) {
    lines.push('- Test batch combined with a model that has stronger instruction following (e.g. qwen3:1.7b, llama3.2:3b).');
  }
  if (perChunkRate < 0.80) {
    lines.push('- Tune prompt: add explicit JSON schema, reduce batch size, or use `format: "json"` with a schema constraint.');
  }

  lines.push('');
  lines.push(`*Generated: ${dateStr} — model: ${model}*`);

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[probe] Combined Context+Tags Feasibility Probe');
  console.log(`  model:      ${MODEL}`);
  console.log(`  limit:      ${LIMIT} chunks`);
  console.log(`  batch_size: ${BATCH_SIZE}`);

  const ollamaOk = await checkOllama();
  if (!ollamaOk) process.exit(1);

  const corpusDir = buildCorpusTempDir();
  let chunks;
  try {
    console.log('[probe] Collecting chunks from corpus...');
    chunks = await collectChunks(corpusDir);
    console.log(`  collected ${chunks.length} chunks`);
  } finally {
    removeCorpusTempDir(corpusDir);
  }

  if (chunks.length === 0) {
    console.error('[probe] No chunks collected — check corpus files.');
    process.exit(1);
  }

  const n = chunks.length;

  // Track tag batch fallbacks by hooking console.warn; always restore in finally.
  let baselineFallbackCount = 0;
  const originalWarn = console.warn;
  console.warn = (...args) => {
    if (String(args[0]).includes('[tag] batch parse failed')) baselineFallbackCount++;
    originalWarn(...args);
  };
  let baselineRes;
  try {
    console.log('\n[probe] Running baseline (addContext + addTagsBatch)...');
    baselineRes = await runBaseline(chunks);
  } finally {
    console.warn = originalWarn;
  }
  console.log(`  done in ${baselineRes.totalMs} ms — ${baselineFallbackCount} tag batch fallbacks`);

  console.log('\n[probe] Running combined per-chunk...');
  const perChunkRes = await runCombinedPerChunk(chunks);
  console.log(`  done in ${perChunkRes.totalMs} ms — ${perChunkRes.parseFailures} parse failures`);

  console.log('\n[probe] Running combined batch...');
  const batchRes = await runCombinedBatch(chunks);
  console.log(`  done in ${batchRes.totalMs} ms — ${batchRes.parseFailures} parse failures (batch-level)`);

  const qualityRows = buildQualityTable(chunks, baselineRes, perChunkRes, batchRes);

  // Auto-generate quality notes from data
  const qualityNotes = [];

  const perChunkSuccessRate = ((n - perChunkRes.parseFailures) / n * 100).toFixed(0);
  const batchSuccessRate    = ((n - batchRes.parseFailures)    / n * 100).toFixed(0);
  qualityNotes.push(`combined per-chunk parse rate: ${perChunkSuccessRate}% (${n - perChunkRes.parseFailures}/${n})`);
  qualityNotes.push(`combined batch parse rate: ${batchSuccessRate}% (${n - batchRes.parseFailures}/${n})`);

  const baselineTagsEmpty = baselineRes.results.filter(r => (r?.baselineTags ?? []).length === 0).length;
  const perChunkTagsEmpty = perChunkRes.results.filter(r => (r?.tags ?? []).length === 0).length;
  qualityNotes.push(`baseline empty tags: ${baselineTagsEmpty}/${n}; combined per-chunk empty tags: ${perChunkTagsEmpty}/${n}`);

  const latencyDeltaPerChunk = baselineRes.totalMs - perChunkRes.totalMs;
  const latencyDeltaBatch    = baselineRes.totalMs - batchRes.totalMs;
  qualityNotes.push(`latency vs baseline: per-chunk ${latencyDeltaPerChunk > 0 ? '-' : '+'}${Math.abs(latencyDeltaPerChunk)} ms (${latencyDeltaPerChunk > 0 ? 'faster' : 'slower'}), batch ${latencyDeltaBatch > 0 ? '-' : '+'}${Math.abs(latencyDeltaBatch)} ms (${latencyDeltaBatch > 0 ? 'faster' : 'slower'})`);

  // Spot-check a few failure examples
  const perChunkFails = qualityRows.filter(r => !r.perChunkOk).slice(0, 3);
  if (perChunkFails.length > 0) {
    qualityNotes.push(`per-chunk failures (sample): ${perChunkFails.map(r => `chunk ${r.idx + 1} (${r.source_file})`).join(', ')}`);
  } else {
    qualityNotes.push('per-chunk failures: none');
  }

  const batchFails = qualityRows.filter(r => !r.batchOk).slice(0, 3);
  if (batchFails.length > 0) {
    qualityNotes.push(`batch failures (sample): ${batchFails.map(r => `chunk ${r.idx + 1} (${r.source_file})`).join(', ')}`);
  } else {
    qualityNotes.push('batch failures: none');
  }

  qualityNotes.push('context quality and tag relevance: see Quality Sample table above for human review');
  qualityNotes.push('JSON stability: see parse rates above; format:"json" used for all combined calls');

  const now      = new Date();
  const dateStr  = now.toISOString().slice(0, 10);
  // Include HHmm in filename so reruns produce distinct artifacts rather than
  // overwriting the manually-annotated report from the first run.
  const timeStr  = now.toISOString().slice(11, 16).replace(':', '');
  const report   = buildMarkdownReport({
    model: MODEL, limit: LIMIT, batchSize: BATCH_SIZE, n,
    baselineMs: baselineRes.totalMs, perChunkMs: perChunkRes.totalMs, batchMs: batchRes.totalMs,
    baselineFallback: baselineFallbackCount,
    perChunkFailures: perChunkRes.parseFailures,
    batchFailures:    batchRes.parseFailures,
    qualityRows, qualityNotes, dateStr,
  });

  const outDir  = join(ROOT, 'benchmarks', 'retrieval', 'results');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${dateStr}T${timeStr}-combined-context-tags-feasibility.md`);
  writeFileSync(outPath, report, 'utf8');
  console.log(`\n[probe] Report: ${outPath}`);

  console.log('\n[probe] Summary');
  console.log(`  baseline:          ${baselineRes.totalMs} ms  (${msPerChunk(baselineRes.totalMs, n)} ms/chunk)`);
  console.log(`  combined per-chunk: ${perChunkRes.totalMs} ms  (${msPerChunk(perChunkRes.totalMs, n)} ms/chunk)  — ${perChunkRes.parseFailures} failures`);
  console.log(`  combined batch:     ${batchRes.totalMs} ms  (${msPerChunk(batchRes.totalMs, n)} ms/chunk)  — ${batchRes.parseFailures} failures`);
}

main().catch(err => { console.error(err); process.exit(1); });
