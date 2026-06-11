// Semantic nav summaries — Stage 2 core (design §12.1, the "pre-paid context"
// concept). Opt-in via SKELETON_SUMMARY=llm.
//
// The concept this implements: an agent entering a collection reads READY
// summaries instead of walking the tree and synthesising one — the cost is
// paid ONCE at index time (cached by file_hash through the normal reindex
// skip), then every agent reads it for free.
//
// Adaptive source rule (design §12.1, fixed 2026-06-10): at every level take
// the RICHEST source that fits the model window:
//   section    : full section content if it fits, else lead chunk + inventory;
//   file       : full file content if it fits, else section summaries,
//                else hierarchical reduction (batch → part summaries → final);
//   collection : file summaries (always), same batching rule when huge.
//
// generateFn is injectable for tests; defaults to Ollama generate() with
// CONTEXT_MODEL. All prompts instruct the model to answer in the content's
// own language, 1-2 sentences, no preamble.

import { generate, getModelContextLength } from '../../core/ollama.js';

// Model window budget for summary prompts. When SUMMARY_WINDOW_TOKENS is not
// set we derive it at runtime from the model's actual context_length via
// /api/show — so switching models never silently truncates prompts.
// The env override stays available for offline tests and CI (no Ollama).
export function summaryWindowTokens(env = process.env) {
  const v = parseInt(env.SUMMARY_WINDOW_TOKENS ?? '', 10);
  if (!Number.isFinite(v) || v < 500 || v > 1_000_000) return 8000;
  return v;
}

// Next power of 2 >= n, clamped to [min, max].
function nextPow2Clamped(n, min, max) {
  let p = min;
  while (p < n && p < max) p *= 2;
  return Math.min(p, max);
}

/**
 * Resolve the num_ctx to use for an entire indexing run.
 *
 * Strategy: find the largest prompt we'll ever send (maxPromptTokens), add
 * 15% headroom, round up to the next power of 2, clamp to [4096, modelMax].
 * Ollama then loads the model ONCE for the whole run — no mid-run reloads.
 *
 * When SUMMARY_WINDOW_TOKENS is set explicitly we trust it as-is (CI/offline).
 * When maxPromptTokens is 0/unknown we fall back to the model's full context.
 *
 * @param {string} model
 * @param {number} maxPromptTokens — largest prompt (tokens) across all files in this run
 * @param {NodeJS.ProcessEnv} env
 */
export async function resolveRunNumCtx(model, maxPromptTokens = 0, env = process.env) {
  const envVal = parseInt(env.SUMMARY_WINDOW_TOKENS ?? '', 10);
  if (Number.isFinite(envVal) && envVal >= 500) return envVal;
  const modelMax = await getModelContextLength(model);
  if (!maxPromptTokens || maxPromptTokens <= 0) return modelMax;
  const needed = Math.ceil(maxPromptTokens * 1.15);
  return nextPow2Clamped(needed, 4096, modelMax);
}

// Kept for backwards-compat (smoke tests inject generateFn without maxPromptTokens).
export async function resolveNumCtx(model, env = process.env) {
  return resolveRunNumCtx(model, 0, env);
}

// Heuristic token estimate — same chars/4 convention as length-bucket.js.
export function estTokens(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

/**
 * Pick the summary source for a target given the window budget (pure).
 *
 * @param {string} fullText — richest source (full section/file content)
 * @param {string[]} parts — compressed fallback parts (e.g. section summaries)
 * @param {number} budget — token budget for the prompt input
 * @returns {{ mode: 'full' } | { mode: 'parts' } | { mode: 'batched', batches: string[][] }}
 */
export function chooseSource(fullText, parts, budget) {
  if (estTokens(fullText) <= budget) return { mode: 'full' };
  const partsTokens = parts.reduce((s, p) => s + estTokens(p), 0);
  if (partsTokens <= budget) return { mode: 'parts' };
  // Hierarchical reduction: split parts into window-sized batches.
  const batches = [];
  let cur = [], curTokens = 0;
  for (const p of parts) {
    const t = estTokens(p);
    if (curTokens + t > budget && cur.length > 0) { batches.push(cur); cur = []; curTokens = 0; }
    cur.push(p); curTokens += t;
  }
  if (cur.length) batches.push(cur);
  return { mode: 'batched', batches };
}

// Build per-call generation options. num_ctx is resolved once per run and
// passed explicitly so Ollama allocates the full model window (not 4096).
// num_predict caps output to stop runaway loops; sanitizer rejects truncated junk.
function genOptions(numCtx) {
  return { temperature: 0, num_predict: 160, num_ctx: numCtx };
}

// gemma3:4b calibration (live run 2026-06-11, 12 files: 7 clean / 3
// conversational / 2 degenerate): small models follow TRAILING instructions
// far better than leading ones — so every prompt is content-first,
// rules-last, ending with an explicit "SUMMARY:" cue.
const SUMMARY_RULES =
  'TASK: Summarize the content above.\n' +
  'RULES: 1-2 sentences, at most 50 words, in the SAME LANGUAGE as the ' +
  'content. Plain text only — no markdown, no lists, no quotes, no preamble ' +
  'like "Here is" or "Okay". Start directly with the summary.\n' +
  'SUMMARY:';

function sectionPrompt(label, body) {
  return `Content of ${label}:\n\n${body}\n\n${SUMMARY_RULES}`;
}
// Roll-up framing matters: "these are summaries, combine them" made gemma
// ANALYZE the notes as foreign text (conversational mode). State the job as
// describing the whole, and forbid commenting on the notes.
function rollupPrompt(label, lines) {
  return `Notes describing the parts of ${label}:\n\n${lines.join('\n')}\n\n` +
    `TASK: Based only on these notes, summarize ${label} as a whole.\n` +
    'RULES: 1-2 sentences, at most 50 words, in the SAME LANGUAGE as the ' +
    'notes. Plain text only — no markdown, no lists, no quotes, no preamble. ' +
    'Do NOT analyze or comment on the notes themselves.\n' +
    'SUMMARY:';
}

const MAX_SUMMARY_CHARS = 600;
// Conversational openers (en + uk) — a real summary never starts like this.
// "This document describes…" stays allowed: that IS a valid summary style.
const PREAMBLE_RE = new RegExp(
  '^(okay|ok[,!\\s]|sure|certainly|of course|great[,!]|here(’|\')?s\\b|here is\\b|' +
  'let me\\b|let(’|\')?s\\b|i(’|\')?ll\\b|i can\\b|as an ai|' +
  'ось |звичайно|гаразд|добре[,!]|давай)', 'i');

/**
 * Validate + normalize raw LLM output. Returns the clean one-line summary,
 * or null when the output must be REJECTED (caller keeps the inventory
 * summary — a broken generation never lands in a nav point).
 *
 * Rejection classes map 1:1 to the live-run failure modes:
 *   conversational preamble / markdown answer → broken-prompt class;
 *   over-length or low unique-word ratio      → degenerate-loop class.
 */
export function sanitizeSummary(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/^summary\s*:\s*/i, '');
  s = s.replace(/^["'«]+|["'»]+$/g, '').trim();
  if (!s) return null;
  if (PREAMBLE_RE.test(s)) return null;                   // conversational mode
  if (/^#{1,6}\s|\*\*|^\s*[-*>]\s/m.test(s)) return null; // markdown answer
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > MAX_SUMMARY_CHARS) return null;          // blow-up / truncated loop
  const words = s.toLowerCase().split(/\s+/);
  if (words.length >= 25 && new Set(words).size / words.length < 0.4) {
    return null;                                          // degenerate repetition
  }
  return s;
}

async function summarizeWithRule(label, fullText, parts, { generateFn, model, budget, numCtx }) {
  const src = chooseSource(fullText, parts, budget);
  const gen = (prompt) => generateFn(model, prompt, { options: genOptions(numCtx) });
  if (src.mode === 'full')  return (await gen(sectionPrompt(label, fullText))).trim();
  if (src.mode === 'parts') return (await gen(rollupPrompt(label, parts))).trim();
  // batched: part summaries first, then final roll-up (one extra level is
  // enough in practice — each level compresses ~50-100×; see design §12.1).
  const partSummaries = [];
  for (const batch of src.batches) {
    partSummaries.push((await gen(rollupPrompt(`a part of ${label}`, batch))).trim());
  }
  return (await gen(rollupPrompt(label, partSummaries))).trim();
}

/**
 * Replace inventory summaries on nav points with semantic LLM summaries.
 * The inventory string is preserved in `inventory` (still useful as a cheap
 * structural hint in drill-down responses). Per-node failures keep the
 * inventory summary — a flaky LLM must never break indexing.
 *
 * @param {Object[]} navPoints — from buildFileSkeleton (file + section nodes)
 * @param {Object[]} chunks — chunkFromSkeleton output (content source)
 * @param {{ generateFn?: Function, model?: string, windowTokens?: number }} [opts]
 * @returns {Promise<Object[]>} new array; input not mutated
 */
export async function generateNavSummaries(navPoints, chunks, opts = {}) {
  const generateFn   = opts.generateFn ?? generate;
  const model        = opts.model ?? (process.env.CONTEXT_MODEL || 'gemma3:4b');
  const windowTokens = opts.windowTokens ?? summaryWindowTokens(process.env);
  // Resolve once: the model's real context window, then pass as num_ctx on
  // every generate() call so Ollama allocates the full window (not 4096).
  const numCtx = opts.numCtx ?? await resolveNumCtx(model, process.env);
  // Reserve a margin for the prompt scaffolding + output.
  const budget = Math.max(500, Math.floor(windowTokens * 0.8));

  const out = [];
  const sectionSummaries = []; // collected for the file roll-up fallback

  // Sections first (file node needs their summaries as fallback source).
  for (const nav of navPoints.filter(n => n.node_type === 'section')) {
    const own = chunks.filter(c => c.parent_id === nav.node_id);
    const fullText = own.map(c => c.text).join('\n\n');
    const lead = own.find(c => c.node_type === 'paragraph')?.text ?? '';
    const heading = nav.heading_path?.at(-1) ?? nav.node_path;
    let summary = nav.summary; // inventory fallback
    try {
      if (fullText.trim()) {
        const clean = sanitizeSummary(await summarizeWithRule(
          `section "${heading}"`, fullText,
          [lead, nav.summary].filter(Boolean), { generateFn, model, budget, numCtx }));
        if (clean) summary = clean;
        else process.stderr.write(`[skeleton-summary] section "${heading}" output rejected by sanitizer — keeping inventory\n`);
      }
    } catch (err) {
      process.stderr.write(`[skeleton-summary] section "${heading}" failed (${err.message}) — keeping inventory\n`);
    }
    sectionSummaries.push(`- ${heading}: ${summary}`);
    out.push({ ...nav, inventory: nav.summary, summary });
  }

  // File node: full content if it fits, else section summaries (already semantic).
  for (const nav of navPoints.filter(n => n.node_type === 'file')) {
    const fullText = chunks.map(c => c.text).join('\n\n');
    let summary = nav.summary;
    try {
      if (fullText.trim()) {
        const clean = sanitizeSummary(await summarizeWithRule(
          `the document "${nav.source_file}"`, fullText,
          sectionSummaries.length ? sectionSummaries : [nav.summary],
          { generateFn, model, budget, numCtx }));
        if (clean) summary = clean;
        else process.stderr.write(`[skeleton-summary] file "${nav.source_file}" output rejected by sanitizer — keeping inventory\n`);
      }
    } catch (err) {
      process.stderr.write(`[skeleton-summary] file "${nav.source_file}" failed (${err.message}) — keeping inventory\n`);
    }
    out.push({ ...nav, inventory: nav.summary, summary });
  }

  // Preserve original order (file first, as buildFileSkeleton emits it).
  const byId = new Map(out.map(n => [n.node_id, n]));
  return navPoints.map(n => byId.get(n.node_id) ?? n);
}

/**
 * Build the collection-level nav point from file summaries (design §9, §12.1:
 * collection ← file summaries, always; incremental — regenerate whenever any
 * file in the collection was (re)indexed).
 *
 * @param {string} collection
 * @param {Array<{ source_file: string, summary: string }>} fileNodes
 * @param {{ generateFn?: Function, model?: string, windowTokens?: number, llm?: boolean }} [opts]
 * @returns {Promise<{ summary: string, children: string[] }>}
 */
export async function buildCollectionSummary(collection, fileNodes, opts = {}) {
  const children = fileNodes.map(f => `${f.source_file}#file`);
  const lines = fileNodes.map(f => `- ${f.source_file}: ${f.summary}`);
  const inventory = `${collection} — ${fileNodes.length} file${fileNodes.length === 1 ? '' : 's'}`;

  if (!opts.llm || fileNodes.length === 0) {
    return { summary: inventory, children };
  }
  const generateFn   = opts.generateFn ?? generate;
  const model        = opts.model ?? (process.env.CONTEXT_MODEL || 'gemma3:4b');
  const windowTokens = opts.windowTokens ?? summaryWindowTokens(process.env);
  const numCtx = opts.numCtx ?? await resolveNumCtx(model, process.env);
  const budget = Math.max(500, Math.floor(windowTokens * 0.8));
  try {
    const clean = sanitizeSummary(await summarizeWithRule(
      `the collection "${collection}"`, lines.join('\n'), lines,
      { generateFn, model, budget, numCtx }));
    if (!clean) {
      process.stderr.write('[skeleton-summary] collection summary rejected by sanitizer — keeping inventory\n');
      return { summary: inventory, children };
    }
    return { summary: clean, children };
  } catch (err) {
    process.stderr.write(`[skeleton-summary] collection summary failed (${err.message}) — keeping inventory\n`);
    return { summary: inventory, children };
  }
}
