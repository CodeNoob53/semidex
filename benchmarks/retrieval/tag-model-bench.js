/**
 * Tag Model Benchmark — separate path: qwen2.5:3b-instruct vs gemma3:4b as TAG_MODEL
 *
 * Tests three scenarios:
 *   A (baseline):    CONTEXT_MODEL=gemma3:4b   TAG_MODEL=gemma3:4b
 *   B (same-model):  CONTEXT_MODEL=qwen2.5:3b-instruct  TAG_MODEL=qwen2.5:3b-instruct
 *   C (split-model): CONTEXT_MODEL=gemma3:4b   TAG_MODEL=qwen2.5:3b-instruct
 *
 * For each scenario: mirrors addTagsBatch batch path against a fixed chunk sample, measures
 * latency, parse success/fallback rate, and tag quality.
 *
 * No Qdrant. No embedding. No production indexer changes.
 *
 * Usage:
 *   node benchmarks/retrieval/tag-model-bench.js
 *   TAG_BENCH_LIMIT=20 TAG_BENCH_BATCH_SIZE=3 node benchmarks/retrieval/tag-model-bench.js
 *   TAG_BENCH_SCENARIOS=A,B  node ...   (run subset; default: A,B,C)
 */

import 'dotenv/config';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import { resolve, join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

import { chunkFileFromPath } from '../../src/indexer/phases/chunk.js';
import { extractJsonArray } from '../../src/indexer/phases/tag.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../');

// ── Config ────────────────────────────────────────────────────────────────────

const LIMIT      = parseInt(process.env.TAG_BENCH_LIMIT      ?? '40', 10);
const BATCH_SIZE = parseInt(process.env.TAG_BENCH_BATCH_SIZE ?? '3',  10);
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';

const SCENARIO_FILTER = process.env.TAG_BENCH_SCENARIOS
  ? new Set(process.env.TAG_BENCH_SCENARIOS.split(',').map(s => s.trim().toUpperCase()))
  : null;

if (!Number.isInteger(LIMIT) || LIMIT < 1) {
  console.error(`[tag-bench] TAG_BENCH_LIMIT must be a positive integer`); process.exit(1);
}
if (!Number.isInteger(BATCH_SIZE) || BATCH_SIZE < 1) {
  console.error(`[tag-bench] TAG_BENCH_BATCH_SIZE must be a positive integer`); process.exit(1);
}

const SCENARIOS = [
  { id: 'A', label: 'baseline gemma',        contextModel: 'gemma3:4b',            tagModel: 'gemma3:4b' },
  { id: 'B', label: 'same-model qwen',        contextModel: 'qwen2.5:3b-instruct',  tagModel: 'qwen2.5:3b-instruct' },
  { id: 'C', label: 'split-model qwen-tags',  contextModel: 'gemma3:4b',            tagModel: 'qwen2.5:3b-instruct' },
].filter(s => !SCENARIO_FILTER || SCENARIO_FILTER.has(s.id));

// ── Corpus temp dir ───────────────────────────────────────────────────────────

const CORPUS_FILES = ['README.md', 'AGENTS.md'];

function collectDocsEn() {
  const dir = join(ROOT, 'docs', 'en');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.md')).map(f => join('docs', 'en', f));
}

// ── Corpus chunk collection ────────────────────────────────────────────────────

async function collectChunks(limit) {
  const files = [...CORPUS_FILES, ...collectDocsEn()].map(rel => join(ROOT, rel)).filter(existsSync);
  const chunks = [];
  for (const f of files) {
    if (chunks.length >= limit) break;
    const sourceFile = relative(ROOT, f).replace(/\\/g, '/');
    const raw = await chunkFileFromPath(f, sourceFile);
    for (const c of raw) {
      if (chunks.length >= limit) break;
      chunks.push(c);
    }
  }
  return chunks;
}

// ── Ollama reachability check ─────────────────────────────────────────────────

async function checkOllama() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    return { ok: true, version: d.version };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function checkModel(model) {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const models = (d.models ?? []).map(m => m.name);
    return models.includes(model);
  } catch { return null; /* unknown */ }
}

// ── Tag quality analysis ───────────────────────────────────────────────────────

function analyseTagQuality(chunks) {
  let validCount = 0, emptyCount = 0, tooFewCount = 0, tooManyCount = 0;
  const samples = [];

  for (const c of chunks) {
    const tags = c.tags ?? [];
    if (tags.length === 0) { emptyCount++; continue; }
    const valid = tags.every(t => /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(t) || /^[a-z0-9]$/.test(t));
    if (valid) validCount++; else tooFewCount++;
    if (tags.length < 3) tooFewCount++;
    if (tags.length > 7) tooManyCount++;
    if (samples.length < 3) {
      samples.push({ source: c.source_file, section: c.section ?? '—', tags: tags.slice(0, 8) });
    }
  }

  return { validCount, emptyCount, tooFewCount, tooManyCount, samples, total: chunks.length };
}

// ── Run one scenario ──────────────────────────────────────────────────────────

async function runScenario(scenario, rawChunks) {
  const { id, label, contextModel, tagModel } = scenario;
  console.log(`\n[${id}] ${label}`);
  console.log(`    context: ${contextModel}   tag: ${tagModel}`);

  // Both context and tag module-level MODEL constants are fixed at import time.
  // We call generate() directly with the scenario's model strings so each
  // scenario uses the right model regardless of env at startup.

  // ── Context phase ─────────────────────────────────────────────────────────
  console.log(`    [1] running context phase (${rawChunks.length} chunks)...`);
  const ctxStart = Date.now();
  const contextChunks = [];

  const { generate } = await import('../../src/core/ollama.js');

  for (const chunk of rawChunks) {
    const prompt = `You are a document indexer assistant. For the following text chunk, provide a 1-2 sentence context description that explains what this chunk is about and how it fits in the broader document. This context will be prepended to the chunk for embedding to improve retrieval.

File: ${chunk.source_file}
Section: ${chunk.section || 'unknown'}
Chunk ${(chunk.chunkIndex ?? 0) + 1} of ${chunk.totalChunks ?? 1}

Text:
${chunk.text.slice(0, 800)}

Context:`;
    try {
      const ctx = await generate(contextModel, prompt);
      contextChunks.push({ ...chunk, context: ctx.trim() });
    } catch {
      contextChunks.push({ ...chunk, context: '' });
    }
  }
  const ctxMs = Date.now() - ctxStart;
  console.log(`    context done: ${ctxMs} ms (${(rawChunks.length / (ctxMs / 1000)).toFixed(1)} chunks/s)`);

  // ── Tag phase — inline addTagsBatch logic with explicit model + fallback counting ─
  console.log(`    [2] running tag phase (${contextChunks.length} chunks, batch=${BATCH_SIZE})...`);
  const tagStart = Date.now();
  let batchCount = 0, fallbackCount = 0;
  const taggedChunks = [];

  for (let i = 0; i < contextChunks.length; i += BATCH_SIZE) {
    const batch = contextChunks.slice(i, i + BATCH_SIZE);
    batchCount++;

    if (batch.length === 1) {
      // Single-chunk path — always per-chunk call, not a batch failure
      const c = batch[0];
      const singlePrompt = `You are a document tagger. Generate 3-7 concise tags for this text chunk. Tags should describe the topic, technology, or concept. Use lowercase, hyphens for spaces. Output only a comma-separated list of tags, nothing else.\n\nFile: ${c.source_file}\nSection: ${c.section || 'unknown'}\nContext: ${c.context || ''}\n\nText:\n${c.text.slice(0, 800)}`;
      try {
        const raw = await generate(tagModel, singlePrompt);
        const tags = raw.split(',').map(t => t.trim().toLowerCase().replace(/\s+/g, '-')).filter(t => t.length > 1 && t.length < 40);
        taggedChunks.push({ ...c, tags });
      } catch {
        taggedChunks.push({ ...c, tags: [] });
      }
      continue;
    }

    const n = batch.length;
    const example = Array.from({ length: n }, (_, idx) => [`tag${idx}a`, `tag${idx}b`]);
    const items = batch.map((c, idx) => `CHUNK ${idx}:\n${c.text.slice(0, 400)}`).join('\n\n');
    const batchPrompt = `You are a document tagger. Generate 3-7 lowercase hyphenated tags for each chunk.\nIMPORTANT: Output ONLY a JSON array of ${n} arrays, nothing else. No explanation, no markdown.\nExample output for ${n} chunks: ${JSON.stringify(example)}\n\n${items}\n\nOutput:`;

    let result = null;
    try {
      const raw = await generate(tagModel, batchPrompt, { format: 'json' });
      result = extractJsonArray(raw, n);
    } catch { /* fall through */ }

    if (!result) {
      fallbackCount++;
      // Per-chunk fallback
      for (const c of batch) {
        const singlePrompt = `You are a document tagger. Generate 3-7 concise tags for this text chunk. Tags should describe the topic, technology, or concept. Use lowercase, hyphens for spaces (e.g. "node-js", "sql-join", "normalization"). Output only a comma-separated list of tags, nothing else.\n\nFile: ${c.source_file}\nSection: ${c.section || 'unknown'}\nContext: ${c.context || ''}\n\nText:\n${c.text.slice(0, 800)}`;
        try {
          const raw = await generate(tagModel, singlePrompt);
          const tags = raw.split(',').map(t => t.trim().toLowerCase().replace(/\s+/g, '-')).filter(t => t.length > 1 && t.length < 40);
          taggedChunks.push({ ...c, tags });
        } catch {
          taggedChunks.push({ ...c, tags: [] });
        }
      }
    } else {
      for (let j = 0; j < batch.length; j++) {
        const generated = (result[j] || [])
          .map(t => String(t).trim().toLowerCase().replace(/\s+/g, '-'))
          .filter(t => t.length > 1 && t.length < 40);
        taggedChunks.push({ ...batch[j], tags: [...new Set(generated)] });
      }
    }
  }

  const tagMs = Date.now() - tagStart;
  const fallbackRate = batchCount > 0 ? ((fallbackCount / batchCount) * 100).toFixed(1) : '0.0';
  console.log(`    tag done: ${tagMs} ms — ${fallbackCount}/${batchCount} batches fell back (${fallbackRate}%)`);

  const quality = analyseTagQuality(taggedChunks);

  return {
    id, label, contextModel, tagModel,
    ctxMs, tagMs, totalMs: ctxMs + tagMs,
    chunks: rawChunks.length,
    batchCount, fallbackCount, fallbackRate: parseFloat(fallbackRate),
    quality,
    taggedChunks,
  };
}

// ── Markdown report ───────────────────────────────────────────────────────────

function writeReport(outPath, dateStr, results, config) {
  const lines = [];
  lines.push(`# Tag Model Benchmark — Separate Path: qwen2.5:3b-instruct vs gemma3:4b`);
  lines.push('');
  lines.push(`Date: ${dateStr}`);
  lines.push(`Corpus: README.md, AGENTS.md, docs/en/*.md (semidex self-docs)`);
  lines.push(`Chunk sample: ${config.limit} chunks, batch size: ${config.batchSize}`);
  lines.push(`Ollama URL: ${OLLAMA_URL}`);
  lines.push('');

  // ── Executive summary ──────────────────────────────────────────────────────
  lines.push('## Executive Summary');
  lines.push('');

  const A = results.find(r => r.id === 'A');
  const B = results.find(r => r.id === 'B');
  const C = results.find(r => r.id === 'C');

  if (A && B && C) {
    const aFallPct = A.fallbackRate;
    const bFallPct = B.fallbackRate;
    const cFallPct = C.fallbackRate;
    const fallbackComparison = bFallPct < aFallPct ? 'lower' : bFallPct === aFallPct ? 'equal' : 'higher';
    lines.push(`Three scenarios were measured on a ${config.limit}-chunk sample from the semidex self-docs corpus.`);
    lines.push('');
    lines.push(`- **Scenario A (baseline gemma)**: ${A.fallbackCount}/${A.batchCount} batch fallbacks (${aFallPct}%), tag phase ${A.tagMs} ms`);
    lines.push(`- **Scenario B (same-model qwen)**: ${B.fallbackCount}/${B.batchCount} batch fallbacks (${bFallPct}%), tag phase ${B.tagMs} ms`);
    lines.push(`- **Scenario C (split-model qwen-tags)**: ${C.fallbackCount}/${C.batchCount} batch fallbacks (${cFallPct}%), tag phase ${C.tagMs} ms`);
    lines.push('');
    lines.push(`qwen2.5:3b fallback rate was **${fallbackComparison}** than gemma3:4b on this sample.`);
    lines.push('');
    lines.push('**Important:** Default hybrid RRF retrieval is tag-agnostic. Tag quality differences affect');
    lines.push('`qdrant_find_by_tag`, `qdrant_search(tags=[...])` filters, and deterministic reranker tag boosts only.');
    lines.push('Context model differences (Scenario B vs A) would affect retrieval quality via the embedding');
    lines.push('prefix — but this benchmark does not run a retrieval quality evaluation (custom-50 indexing');
    lines.push('does not use context/tags). See recommendation section for guidance.');
  } else {
    lines.push(`Scenarios run: ${results.map(r => r.id).join(', ')}`);
  }
  lines.push('');

  // ── Method ─────────────────────────────────────────────────────────────────
  lines.push('## Method');
  lines.push('');
  lines.push('Each scenario:');
  lines.push(`1. Collects ${config.limit} chunks from the semidex self-docs corpus (chunking phase only)`);
  lines.push(`2. Runs context generation per chunk using the scenario's CONTEXT_MODEL`);
  lines.push(`3. Runs tag generation in batches of ${config.batchSize} using the scenario's TAG_MODEL`);
  lines.push('4. Counts batch parse failures (triggering per-chunk fallback)');
  lines.push('5. Measures wall-clock time for context phase and tag phase separately');
  lines.push('');
  lines.push('**What this does NOT measure:**');
  lines.push('- Retrieval quality (custom-50 benchmark indexes without context/tags — embedding-only)');
  lines.push('- Full production indexing (no Qdrant upsert, no embedding, no linking)');
  lines.push('- Resource contention under concurrent load (single sequential Ollama calls)');
  lines.push('- Model warm-up time (first Ollama call includes model load; subsequent calls do not)');
  lines.push('');

  // ── Scenario matrix ────────────────────────────────────────────────────────
  lines.push('## Scenario Matrix');
  lines.push('');
  lines.push('| ID | Label | CONTEXT_MODEL | TAG_MODEL | Notes |');
  lines.push('|----|-------|---------------|-----------|-------|');
  lines.push('| A | baseline gemma | gemma3:4b | gemma3:4b | Current production default |');
  lines.push('| B | same-model qwen | qwen2.5:3b-instruct | qwen2.5:3b-instruct | Both phases use qwen; context quality changes |');
  lines.push('| C | split-model qwen-tags | gemma3:4b | qwen2.5:3b-instruct | Context unchanged; only tag model changes; resource-contention risk |');
  lines.push('');

  // ── Indexing performance results ───────────────────────────────────────────
  lines.push('## Indexing Performance Results');
  lines.push('');
  lines.push(`Corpus: ${config.limit} chunks, LLM_BATCH_SIZE=${config.batchSize}`);
  lines.push('');
  lines.push('| Scenario | Context model | Tag model | Context ms | Tag ms | Total ms | Chunks/s (tag) |');
  lines.push('|----------|---------------|-----------|-----------|--------|----------|----------------|');
  for (const r of results) {
    const cps = r.chunks > 0 && r.tagMs > 0 ? (r.chunks / (r.tagMs / 1000)).toFixed(2) : '—';
    lines.push(`| ${r.id}: ${r.label} | ${r.contextModel} | ${r.tagModel} | ${r.ctxMs} | ${r.tagMs} | ${r.totalMs} | ${cps} |`);
  }
  lines.push('');
  lines.push('Note: Context ms includes model warm-up for the first scenario\'s first call.');
  lines.push('Scenario B context ms includes qwen warm-up; Scenario C context ms may be lower if gemma is still warm.');
  lines.push('');

  // ── Tag parse / fallback results ───────────────────────────────────────────
  lines.push('## Tag Parse / Fallback Results');
  lines.push('');
  lines.push('| Scenario | Tag model | Batches attempted | Fallbacks | Fallback rate | Individual calls (fallback) |');
  lines.push('|----------|-----------|-------------------|-----------|---------------|-----------------------------|');
  for (const r of results) {
    const individualCalls = r.fallbackCount * config.batchSize;
    lines.push(`| ${r.id}: ${r.label} | ${r.tagModel} | ${r.batchCount} | ${r.fallbackCount} | ${r.fallbackRate}% | ~${individualCalls} |`);
  }
  lines.push('');
  lines.push('**Fallback definition:** The benchmark script mirrors `addTagsBatch` batch prompt/parser:');
  lines.push('`generate()` with `format:"json"`, then `extractJsonArray(raw, n)`. A fallback occurs when');
  lines.push('the parsed result is null — the batch response could not be decoded into an array of n tag');
  lines.push(`arrays. Each fallback triggers n individual per-chunk calls (one per chunk in the batch of ${config.batchSize}).`);
  lines.push('');
  lines.push('**Caveat:** The script is an inline reimplementation, not a direct call to `addTagsBatch`.');
  lines.push('The batch prompt matches production exactly. The per-chunk fallback prompt also matches');
  lines.push('production `addTagsWithModel` (File/Section/Context/Text fields). Fallback *counts* are');
  lines.push('therefore representative; fallback *tag content* for the per-chunk path is production-equivalent.');
  lines.push('');

  // ── Tag quality sample ─────────────────────────────────────────────────────
  lines.push('## Tag Quality Sample');
  lines.push('');
  lines.push('Sample of 3 chunks per scenario — tags shown as generated.');
  lines.push('');
  for (const r of results) {
    lines.push(`### ${r.id}: ${r.label} (TAG_MODEL=${r.tagModel})`);
    lines.push('');
    lines.push(`Valid-format tags: ${r.quality.validCount}/${r.quality.total} chunks`);
    lines.push(`Empty tags: ${r.quality.emptyCount}, Too few (<3): ${r.quality.tooFewCount}, Too many (>7): ${r.quality.tooManyCount}`);
    lines.push('');
    if (r.quality.samples.length) {
      lines.push('| Source | Section | Tags |');
      lines.push('|--------|---------|------|');
      for (const s of r.quality.samples) {
        lines.push(`| ${s.source} | ${s.section} | ${s.tags.join(', ')} |`);
      }
    } else {
      lines.push('(no sample available)');
    }
    lines.push('');
  }

  // ── Retrieval metrics ──────────────────────────────────────────────────────
  lines.push('## Retrieval Metrics');
  lines.push('');
  lines.push('**Not measured in this benchmark.**');
  lines.push('');
  lines.push('The custom-50 retrieval benchmark (`run-v3.js`) indexes fixture documents using');
  lines.push('`embedForIndex` directly — it does not run the context or tag phases. This means');
  lines.push('no retrieval quality difference can be attributed to TAG_MODEL changes in custom-50.');
  lines.push('');
  lines.push('Context model differences (Scenario B: qwen context vs Scenario A: gemma context)');
  lines.push('**would** affect retrieval quality in production indexing, because context is');
  lines.push('prepended to the embedding text (`context\\n\\nchunk_text`). A retrieval quality');
  lines.push('comparison between gemma and qwen as CONTEXT_MODEL would require:');
  lines.push('1. Full production reindex of custom-50 with each CONTEXT_MODEL setting');
  lines.push('2. Running `npm run bench:custom50 BENCH_SKIP_INDEX=1` against each indexed collection');
  lines.push('3. Comparing MRR@10 / nDCG@10 / chunkRecall across collections');
  lines.push('');
  lines.push('This is a separate task from tag model evaluation and is not covered here.');
  lines.push('');

  // ── Resource contention discussion ─────────────────────────────────────────
  lines.push('## Resource Contention Discussion');
  lines.push('');
  lines.push('### Scenario C: split-model (gemma context + qwen tags)');
  lines.push('');
  lines.push('When CONTEXT_MODEL ≠ TAG_MODEL, Ollama must serve two different models in the same');
  lines.push('indexing run. The context and tag phases are sequential (not concurrent), so Ollama');
  lines.push('does not run both simultaneously. However:');
  lines.push('');
  lines.push('- **Model swap latency**: If Ollama cannot hold both models in VRAM/RAM simultaneously,');
  lines.push('  it unloads gemma3:4b after the context phase and loads qwen2.5:3b-instruct for tagging.');
  lines.push('  This swap adds a one-time load penalty at the start of the tag phase.');
  lines.push('- **Memory pressure**: gemma3:4b (~3.3 GB) + qwen2.5:3b-instruct (~1.9 GB) = ~5.2 GB');
  lines.push('  combined. Systems with ≤ 8 GB VRAM may not hold both in GPU memory simultaneously,');
  lines.push('  forcing CPU inference for the second model or unload/reload cycles.');
  lines.push('- **Context phase warm-up**: In Scenario C, the context phase uses gemma (already warm');
  lines.push('  from baseline benchmarks). The tag phase must load qwen for the first time, adding');
  lines.push('  model load latency to the first batch call — visible in total tag ms.');
  lines.push('- **Consecutive-file indexing**: In a real multi-file run, the phase interleaving is:');
  lines.push('  `[file1 context] → [file1 tags] → [file2 context] → [file2 tags] → ...`');
  lines.push('  Each file alternates between gemma and qwen, potentially causing repeated swap cycles.');
  lines.push('');
  lines.push('### Recommendation for split-model');
  lines.push('');
  lines.push('Do not use split-model (C) unless:');
  lines.push('- Both models fit simultaneously in VRAM with no swap penalty');
  lines.push('- The tag fallback/latency improvement is clearly visible in the benchmark results above');
  lines.push('- The total indexing time for Scenario C is not worse than Scenario A');
  lines.push('');
  lines.push('The measured timing comparison in the table above provides the primary evidence.');
  lines.push('');

  // ── Recommendation ─────────────────────────────────────────────────────────
  lines.push('## Recommendation');
  lines.push('');

  if (A && B && C) {
    const aFall = A.fallbackRate;
    const bFall = B.fallbackRate;
    const cFall = C.fallbackRate;
    const cSlower = C.tagMs > A.tagMs * 1.1;
    const bSlower = B.tagMs > A.tagMs * 1.1;

    lines.push('### Decision frame');
    lines.push('');
    lines.push('| Criterion | A (gemma baseline) | B (qwen same-model) | C (qwen tag-only) |');
    lines.push('|-----------|-------------------|---------------------|-------------------|');
    lines.push(`| Tag fallback rate | ${aFall}% | ${bFall}% | ${cFall}% |`);
    lines.push(`| Tag phase ms | ${A.tagMs} | ${B.tagMs} | ${C.tagMs} |`);
    lines.push(`| Context unchanged from A | — | No (qwen context) | Yes (gemma context) |`);
    lines.push(`| Resource contention risk | None | None | Model swap overhead |`);
    lines.push('');

    const bBetterFallback = bFall < aFall;
    const cBetterFallback = cFall < aFall;
    const bNotSlower = !bSlower;
    const cNotSlower = !cSlower;

    if (bBetterFallback && bNotSlower) {
      lines.push('**qwen2.5:3b-instruct as same-model (Scenario B): Promising, pending context quality evaluation.**');
      lines.push('');
      lines.push(`Fallback rate improved from ${aFall}% (gemma) to ${bFall}% (qwen). Tag phase is not slower.`);
      lines.push('However, Scenario B changes CONTEXT_MODEL which affects embedding prefix quality.');
      lines.push('Before recommending B as a default, run a full custom-50 retrieval benchmark with');
      lines.push(`qwen2.5:3b-instruct as CONTEXT_MODEL to confirm MRR@10 / nDCG@10 do not regress.`);
    } else if (!bBetterFallback) {
      lines.push('**qwen2.5:3b-instruct as same-model (Scenario B): Not recommended based on this sample.**');
      lines.push('');
      lines.push(`Fallback rate did not improve (A: ${aFall}%, B: ${bFall}%). No tag-phase benefit observed.`);
      lines.push('Changing CONTEXT_MODEL carries retrieval quality risk without a measurable tagging gain.');
    } else {
      lines.push('**qwen2.5:3b-instruct as same-model (Scenario B): Not recommended — tag phase slower.**');
      lines.push('');
      lines.push(`Tag phase regressed (A: ${A.tagMs} ms, B: ${B.tagMs} ms). Not justified.`);
    }
    lines.push('');

    if (cBetterFallback && cNotSlower) {
      lines.push('**qwen2.5:3b-instruct as TAG_MODEL only (Scenario C): Viable if swap penalty is acceptable.**');
      lines.push('');
      lines.push(`Fallback rate improved from ${aFall}% to ${cFall}%. Context model unchanged (no retrieval risk).`);
      lines.push('Check whether Scenario C total ms is acceptable for your indexing budget.');
      lines.push('The split-model setup is only appropriate when both models fit in available memory without swap.');
    } else if (!cBetterFallback) {
      lines.push('**qwen2.5:3b-instruct as TAG_MODEL only (Scenario C): Not recommended based on this sample.**');
      lines.push('');
      lines.push(`Fallback rate did not improve (A: ${aFall}%, C: ${cFall}%). The resource-contention overhead`);
      lines.push('of loading two models is not justified without a parsing benefit.');
    } else {
      lines.push('**qwen2.5:3b-instruct as TAG_MODEL only (Scenario C): Not recommended — tag phase slower.**');
      lines.push('');
      lines.push(`Tag phase regressed (A: ${A.tagMs} ms, C: ${C.tagMs} ms). Split-model overhead is not justified.`);
    }
    lines.push('');
    lines.push('### Current default recommendation');
    lines.push('');
    lines.push('- Keep `gemma3:4b` as default for both CONTEXT_MODEL and TAG_MODEL.');
    lines.push('- For large automated runs where tag filters are not needed: use `TAG_GEN=0`.');
    lines.push('- For combined-mode (opt-in): `COMBINED_LLM=1 CONTEXT_MODEL=qwen2.5:3b-instruct`');
    lines.push('  is supported by earlier combined-mode benchmarks (ADR 0004).');
    lines.push('- A full retrieval quality benchmark (custom-50 reindex with qwen CONTEXT_MODEL)');
    lines.push('  is required before changing the CONTEXT_MODEL default.');
  } else {
    lines.push('(Partial scenario run — full recommendation requires all three scenarios.)');
  }
  lines.push('');

  // ── Evidence ───────────────────────────────────────────────────────────────
  lines.push('## Evidence');
  lines.push('');
  lines.push('- `src/indexer/phases/tag.js` — `addTagsBatch`, `extractJsonArray`, fallback path');
  lines.push('- `src/indexer/phases/context.js` — `addContext`, per-chunk context generation');
  lines.push('- [`benchmarks/retrieval/results/2026-05-20-tag-usefulness-audit.md`](2026-05-20-tag-usefulness-audit.md)');
  lines.push('- [ADR 0004: Combined LLM Context+Tags Mode Opt-In](../../../docs/adr/0004-combined-llm-opt-in.md)');
  lines.push('');
  lines.push(`*Generated: ${dateStr} by benchmarks/retrieval/tag-model-bench.js*`);

  writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const dateStr = new Date().toISOString().slice(0, 10);
  console.log('[tag-model-bench] Tag Model Benchmark — separate path');
  console.log(`  scenarios:  ${SCENARIOS.map(s => s.id).join(', ')} (${SCENARIOS.length} total)`);
  console.log(`  chunk limit: ${LIMIT}`);
  console.log(`  batch size:  ${BATCH_SIZE}`);
  console.log(`  ollama url:  ${OLLAMA_URL}`);

  // Ollama check
  const ollamaStatus = await checkOllama();
  if (!ollamaStatus.ok) {
    console.error(`\n[tag-model-bench] ERROR: Ollama unreachable at ${OLLAMA_URL}: ${ollamaStatus.error}`);
    console.error('  Start Ollama with: ollama serve');
    process.exit(1);
  }
  console.log(`  ollama:     v${ollamaStatus.version} — reachable`);

  // Model check
  const modelsNeeded = [...new Set(SCENARIOS.flatMap(s => [s.contextModel, s.tagModel]))];
  for (const model of modelsNeeded) {
    const pulled = await checkModel(model);
    if (pulled === false) {
      console.error(`\n[tag-model-bench] ERROR: Model "${model}" not pulled. Run: ollama pull ${model}`);
      process.exit(1);
    }
    if (pulled === null) {
      console.warn(`  model check: ${model} — unknown (could not list models)`);
    } else {
      console.log(`  model check: ${model} — ok`);
    }
  }

  // Collect chunks once — all scenarios use the same raw chunks
  console.log(`\n[tag-model-bench] Collecting ${LIMIT} chunks from corpus...`);
  const rawChunks = await collectChunks(LIMIT);
  console.log(`  collected ${rawChunks.length} chunks`);

  if (rawChunks.length === 0) {
    console.error('[tag-model-bench] No chunks collected. Check corpus files exist.');
    process.exit(1);
  }

  // Run scenarios
  const results = [];
  for (const scenario of SCENARIOS) {
    const result = await runScenario(scenario, rawChunks);
    results.push(result);
  }

  // Write report
  const resultsDir = join(ROOT, 'benchmarks', 'retrieval', 'results');
  mkdirSync(resultsDir, { recursive: true });
  const outPath = join(resultsDir, `${dateStr}-tag-model-qwen25-separate-path.md`);

  writeReport(outPath, dateStr, results, { limit: rawChunks.length, batchSize: BATCH_SIZE });
  console.log(`\n[tag-model-bench] Report: ${outPath}`);

  // Console summary
  console.log('\n[tag-model-bench] Summary');
  console.log('  Scenario | Fallbacks/Batches | Fallback% | Tag ms');
  for (const r of results) {
    console.log(`  ${r.id}: ${r.label.padEnd(24)} | ${String(r.fallbackCount).padStart(2)}/${String(r.batchCount).padStart(2)} | ${String(r.fallbackRate).padStart(5)}% | ${r.tagMs} ms`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
