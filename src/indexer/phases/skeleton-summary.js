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

import { generate } from '../../core/ollama.js';

// Model window budget for summary prompts (env-tunable — every local model
// has a different practical window). Conservative default for gemma3-class.
export function summaryWindowTokens(env = process.env) {
  const v = parseInt(env.SUMMARY_WINDOW_TOKENS ?? '', 10);
  if (!Number.isFinite(v) || v < 500 || v > 1_000_000) return 8000;
  return v;
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

const SUMMARY_RULES =
  'Write 1-2 sentences describing what this content is about, in the SAME ' +
  'LANGUAGE as the content. Plain text only — no preamble, no markdown, no quotes.';

function sectionPrompt(heading, body) {
  return `${SUMMARY_RULES}\n\nSection heading: ${heading}\n\nContent:\n${body}`;
}
function rollupPrompt(label, lines) {
  return `${SUMMARY_RULES}\n\nThese are summaries of the parts of ${label}. ` +
    `Combine them into one overview.\n\n${lines.join('\n')}`;
}

async function summarizeWithRule(label, fullText, parts, { generateFn, model, budget }) {
  const src = chooseSource(fullText, parts, budget);
  if (src.mode === 'full')  return (await generateFn(model, sectionPrompt(label, fullText))).trim();
  if (src.mode === 'parts') return (await generateFn(model, rollupPrompt(label, parts))).trim();
  // batched: part summaries first, then final roll-up (one extra level is
  // enough in practice — each level compresses ~50-100×; see design §12.1).
  const partSummaries = [];
  for (const batch of src.batches) {
    partSummaries.push((await generateFn(model, rollupPrompt(`a part of ${label}`, batch))).trim());
  }
  return (await generateFn(model, rollupPrompt(label, partSummaries))).trim();
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
        summary = await summarizeWithRule(
          `section "${heading}"`, fullText,
          [lead, nav.summary].filter(Boolean), { generateFn, model, budget });
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
        summary = await summarizeWithRule(
          `the document "${nav.source_file}"`, fullText,
          sectionSummaries.length ? sectionSummaries : [nav.summary],
          { generateFn, model, budget });
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
  const budget = Math.max(500, Math.floor(windowTokens * 0.8));
  try {
    const summary = await summarizeWithRule(
      `the collection "${collection}"`, lines.join('\n'), lines,
      { generateFn, model, budget });
    return { summary, children };
  } catch (err) {
    process.stderr.write(`[skeleton-summary] collection summary failed (${err.message}) — keeping inventory\n`);
    return { summary: inventory, children };
  }
}
