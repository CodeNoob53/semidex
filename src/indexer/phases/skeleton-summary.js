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
// Adaptive tier policy (2026-06-25):
//   small  (<  SUMMARY_SMALL_TOKENS  tokens): 1-sentence plain summary
//   medium (<  SUMMARY_MEDIUM_TOKENS tokens): 2-3 sentence plain summary
//   large  (>= SUMMARY_MEDIUM_TOKENS tokens): structured JSON block:
//                                             summary, key_topics, notable_terms,
//                                             child_overview (for file nodes)
//   rollup (collection/file from parts)     : plain roll-up, same as before
//
// summary_kind field stamps which tier was used:
//   'inventory'      — no LLM, structural count string
//   'llm_short'      — small tier
//   'llm_medium'     — medium tier
//   'llm_structured' — large tier
//   'rollup'         — collection/file roll-up from parts
//
// generateFn is injectable for tests; defaults to Ollama generate() with
// CONTEXT_MODEL. All prompts instruct the model to answer in the content's
// own language, 1-2 sentences, no preamble.

import { generate, getModelContextLength, isThinkingModel } from '../../core/ollama.js';
import { franc } from 'franc-min';

export const SUMMARY_VERSION = 2;

// Token thresholds for tier selection (overridable via env for tests/tuning).
// Small: 1-sentence plain; Medium: 2-3 sentence plain; Large: full structured JSON.
export function summaryTierThresholds(env = process.env) {
  const small  = parseInt(env.SUMMARY_SMALL_TOKENS  ?? '', 10);
  const medium = parseInt(env.SUMMARY_MEDIUM_TOKENS ?? '', 10);
  return {
    small:  Number.isFinite(small)  && small  > 0 ? small  : 300,
    medium: Number.isFinite(medium) && medium > 0 ? medium : 1500,
  };
}

// Caps to prevent token blow-up in structured fields.
const MAX_KEY_TOPICS     = 6;
const MAX_NOTABLE_TERMS  = 8;
const MAX_CHILD_OVERVIEW = 10;
const MAX_SUMMARY_CHARS  = 600;
const MAX_FIELD_CHARS    = 120;  // per key_topics / notable_terms item

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

// Heuristic token estimate, script-aware. ASCII ≈ 4 chars/token, but BPE
// tokenizers cut Cyrillic ~2× finer (≈2 chars/token) — the flat chars/4
// convention underestimated Ukrainian files 2-3×, so oversized prompts
// "fit" the budget, overflowed the real window, and Ollama silently cut the
// TRAILING rules → degenerate outputs on exactly the biggest files.
export function estTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let cyr = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x0400 && c <= 0x04ff) cyr++;
  }
  const charsPerToken = 4 - 2 * (cyr / s.length); // 4 (latin) → 2 (cyrillic)
  return Math.ceil(s.length / charsPerToken);
}

/**
 * Pick the summary source for a target given the window budget (pure).
 */
export function chooseSource(fullText, parts, budget) {
  if (estTokens(fullText) <= budget) return { mode: 'full' };
  const partsTokens = parts.reduce((s, p) => s + estTokens(p), 0);
  if (partsTokens <= budget) return { mode: 'parts' };
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

/**
 * Choose summary tier based on content token count.
 * Returns 'short' | 'medium' | 'structured'.
 */
export function chooseTier(tokenCount, env = process.env) {
  const { small, medium } = summaryTierThresholds(env);
  if (tokenCount < small)  return 'short';
  if (tokenCount < medium) return 'medium';
  return 'structured';
}

// Build per-call generation options.
function genOptions(numCtx, thinking = false) {
  const opts = { temperature: 0, num_ctx: numCtx };
  if (!thinking) opts.num_predict = 160;
  return opts;
}

// Structured tier needs a longer output budget.
function genOptionsStructured(numCtx, thinking = false) {
  const opts = { temperature: 0, num_ctx: numCtx };
  if (!thinking) opts.num_predict = 400;
  return opts;
}

const LANG_NAMES = {
  ukr: 'Ukrainian', rus: 'Russian', eng: 'English', deu: 'German',
  pol: 'Polish', fra: 'French', spa: 'Spanish', ita: 'Italian',
  por: 'Portuguese', nld: 'Dutch', ces: 'Czech', ron: 'Romanian',
  hun: 'Hungarian', tur: 'Turkish', swe: 'Swedish', dan: 'Danish',
  fin: 'Finnish', ell: 'Greek', heb: 'Hebrew', arb: 'Arabic',
  hin: 'Hindi', jpn: 'Japanese', kor: 'Korean', cmn: 'Chinese',
  vie: 'Vietnamese', ind: 'Indonesian',
};
const LANG_ONLY = Object.keys(LANG_NAMES);

const LANG_ALIASES = {
  uk: 'ukr', en: 'eng', ru: 'rus', de: 'deu', pl: 'pol', fr: 'fra',
  es: 'spa', it: 'ita', pt: 'por', nl: 'nld', cs: 'ces', ro: 'ron',
  hu: 'hun', tr: 'tur', sv: 'swe', da: 'dan', fi: 'fin', el: 'ell',
  he: 'heb', ar: 'arb', hi: 'hin', ja: 'jpn', ko: 'kor', zh: 'cmn',
  vi: 'vie', id: 'ind',
};

export function resolveForcedLang(env = process.env) {
  const v = String(env.SUMMARY_LANG ?? '').trim();
  if (!v || v.toLowerCase() === 'auto') return null;
  const key = v.toLowerCase();
  const iso3 = LANG_ALIASES[key] ?? key;
  if (LANG_NAMES[iso3]) return LANG_NAMES[iso3];
  return v[0].toUpperCase() + v.slice(1);
}

function langHint(text, env = process.env) {
  const forced = resolveForcedLang(env);
  if (forced) return forced;
  const sample = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .slice(0, 4000);
  if (sample.trim().length < 100) return null;
  const code = franc(sample, { only: LANG_ONLY });
  return LANG_NAMES[code] ?? null;
}

function langRule(lang, what) {
  return lang
    ? `Write in ${lang} — the language of the ${what}.`
    : `Write in the SAME LANGUAGE as the ${what}.`;
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function shortRules(lang) {
  return 'TASK: Summarize the content above in exactly 1 sentence.\n' +
    `RULES: At most 30 words. ${langRule(lang, 'content')} ` +
    'Plain text only — no markdown, no lists, no quotes, no preamble ' +
    'like "Here is" or "Okay". Start directly with the summary.\n' +
    'SUMMARY:';
}

function mediumRules(lang) {
  return 'TASK: Summarize the content above.\n' +
    `RULES: 2-3 sentences, at most 60 words. ${langRule(lang, 'content')} ` +
    'Plain text only — no markdown, no lists, no quotes, no preamble. ' +
    'Start directly with the summary.\n' +
    'SUMMARY:';
}

function structuredRules(lang, includeChildOverview) {
  const childLine = includeChildOverview
    ? '  "child_overview": ["one-line description per main sub-section, max 10 items"]\n'
    : '';
  return 'TASK: Analyze the content above and output a JSON object.\n' +
    `RULES: ${langRule(lang, 'content')} ` +
    'Output ONLY valid JSON, no text before or after. Use this exact shape:\n' +
    '{\n' +
    '  "summary": "2-3 sentences describing the main topic and purpose, max 80 words",\n' +
    '  "key_topics": ["up to 6 main topics covered, each max 5 words"],\n' +
    '  "notable_terms": ["up to 8 exact identifiers, commands, or terms a reader would search for"]\n' +
    (childLine ? ',\n' + childLine : '') +
    '}\n' +
    'Do not invent facts. Do not include markdown. Output ONLY the JSON object.\n' +
    'JSON:';
}

function rollupRules(lang) {
  return `TASK: Based only on these notes, summarize the whole as 1-2 sentences.\n` +
    `RULES: At most 50 words. ${langRule(lang, 'notes')} ` +
    'Plain text only — no markdown, no lists, no quotes, no preamble. ' +
    'Do NOT analyze or comment on the notes themselves.\n' +
    'SUMMARY:';
}

function shortPrompt(label, body) {
  return `Content of ${label}:\n\n${body}\n\n${shortRules(langHint(body))}`;
}

function mediumPrompt(label, body) {
  return `Content of ${label}:\n\n${body}\n\n${mediumRules(langHint(body))}`;
}

function structuredPrompt(label, body, includeChildOverview) {
  return `Content of ${label}:\n\n${body}\n\n${structuredRules(langHint(body), includeChildOverview)}`;
}

function rollupPrompt(label, lines) {
  const joined = lines.join('\n');
  return `Notes describing the parts of ${label}:\n\n${joined}\n\n${rollupRules(langHint(joined))}`;
}

// ── Sanitizers ────────────────────────────────────────────────────────────────

const PREAMBLE_RE =
  /^(okay|ok[,!\s]|sure|certainly|of course|great[,!]|here[‘’]?s\b|here is\b|let me\b|let[‘’]?s\b|i[‘’]?ll\b|i can\b|as an ai|ось |звичайно|гаразд[,!]|давай)/i;

export function sanitizeSummary(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/^summary\s*:\s*/i, '');
  s = s.replace(/^["'«]+|["'»]+$/g, '').trim();
  if (!s) return null;
  if (PREAMBLE_RE.test(s)) return null;
  if (/^#{1,6}\s|\*\*|^\s*[-*>]\s/m.test(s)) return null;
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length < 20) return null;
  if (s.length > MAX_SUMMARY_CHARS) return null;
  const words = s.toLowerCase().split(/\s+/);
  if (words.length >= 25 && new Set(words).size / words.length < 0.4) return null;
  return s;
}

/**
 * Parse and validate structured JSON output from LLM.
 * Returns { summary, key_topics, notable_terms, child_overview? } or null on failure.
 */
export function sanitizeStructured(raw) {
  if (typeof raw !== 'string') return null;
  // Strip markdown code fences if model wrapped the JSON.
  let s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  // Strip "JSON:" prefix if model echoed the cue.
  s = s.replace(/^json\s*:\s*/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const summary = sanitizeSummary(String(parsed.summary ?? ''));
  if (!summary) return null;

  const clampArr = (arr, max, maxChars) => {
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(x => typeof x === 'string' && x.trim())
      .map(x => x.trim().slice(0, maxChars))
      .slice(0, max);
  };

  const result = {
    summary,
    key_topics:    clampArr(parsed.key_topics,    MAX_KEY_TOPICS,    MAX_FIELD_CHARS),
    notable_terms: clampArr(parsed.notable_terms, MAX_NOTABLE_TERMS, MAX_FIELD_CHARS),
  };
  if (Array.isArray(parsed.child_overview)) {
    result.child_overview = clampArr(parsed.child_overview, MAX_CHILD_OVERVIEW, MAX_FIELD_CHARS);
  }
  return result;
}

// ── Core generation helpers ───────────────────────────────────────────────────

async function generateShort(label, fullText, parts, ctx) {
  const { generateFn, model, budget, numCtx, thinking } = ctx;
  const src = chooseSource(fullText, parts, budget);
  const gen = (prompt) => generateFn(model, prompt, { options: genOptions(numCtx, thinking) });
  if (src.mode === 'full')  return (await gen(shortPrompt(label, fullText))).trim();
  if (src.mode === 'parts') return (await gen(rollupPrompt(label, parts))).trim();
  const partSummaries = [];
  for (const batch of src.batches) {
    partSummaries.push((await gen(rollupPrompt(`a part of ${label}`, batch))).trim());
  }
  return (await gen(rollupPrompt(label, partSummaries))).trim();
}

async function generateMedium(label, fullText, parts, ctx) {
  const { generateFn, model, budget, numCtx, thinking } = ctx;
  const src = chooseSource(fullText, parts, budget);
  const gen = (prompt) => generateFn(model, prompt, { options: genOptions(numCtx, thinking) });
  if (src.mode === 'full')  return (await gen(mediumPrompt(label, fullText))).trim();
  if (src.mode === 'parts') return (await gen(rollupPrompt(label, parts))).trim();
  const partSummaries = [];
  for (const batch of src.batches) {
    partSummaries.push((await gen(rollupPrompt(`a part of ${label}`, batch))).trim());
  }
  return (await gen(rollupPrompt(label, partSummaries))).trim();
}

async function generateStructured(label, fullText, parts, includeChildOverview, ctx) {
  const { generateFn, model, budget, numCtx, thinking } = ctx;
  const src = chooseSource(fullText, parts, budget);
  const gen = (prompt) => generateFn(model, prompt, { options: genOptionsStructured(numCtx, thinking) });
  if (src.mode === 'full') {
    return (await gen(structuredPrompt(label, fullText, includeChildOverview))).trim();
  }
  // For parts/batched: fall back to rollup (structured prompt on parts is unreliable).
  const genShort = (prompt) => generateFn(model, prompt, { options: genOptions(numCtx, thinking) });
  if (src.mode === 'parts') return (await genShort(rollupPrompt(label, parts))).trim();
  const partSummaries = [];
  for (const batch of src.batches) {
    partSummaries.push((await genShort(rollupPrompt(`a part of ${label}`, batch))).trim());
  }
  return (await genShort(rollupPrompt(label, partSummaries))).trim();
}

/**
 * Generate summary for a node using adaptive tier policy.
 * Returns { summary, summary_kind, key_topics?, notable_terms?, child_overview? }
 * or null on complete failure (caller falls back to inventory).
 *
 * @param {string} label — human label for the node (for prompts and logs)
 * @param {string} fullText — full content text
 * @param {string[]} parts — compressed fallback parts
 * @param {boolean} isFile — true for file nodes (enables child_overview)
 * @param {object} ctx — { generateFn, model, budget, numCtx, thinking }
 * @param {NodeJS.ProcessEnv} env
 */
export async function generateAdaptiveSummary(label, fullText, parts, isFile, ctx, env = process.env) {
  const tokens = estTokens(fullText || parts.join('\n'));
  const tier   = chooseTier(tokens, env);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (tier === 'short') {
        const raw   = await generateShort(label, fullText, parts, ctx);
        const clean = sanitizeSummary(raw);
        if (clean) return { summary: clean, summary_kind: 'llm_short' };
      } else if (tier === 'medium') {
        const raw   = await generateMedium(label, fullText, parts, ctx);
        const clean = sanitizeSummary(raw);
        if (clean) return { summary: clean, summary_kind: 'llm_medium' };
      } else {
        // structured — only when fullText fits (parts path falls back to rollup plain text)
        const src = chooseSource(fullText, parts, ctx.budget);
        if (src.mode === 'full') {
          const raw    = await generateStructured(label, fullText, parts, isFile, ctx);
          const parsed = sanitizeStructured(raw);
          if (parsed) {
            return {
              summary:       parsed.summary,
              summary_kind:  'llm_structured',
              key_topics:    parsed.key_topics.length    ? parsed.key_topics    : undefined,
              notable_terms: parsed.notable_terms.length ? parsed.notable_terms : undefined,
              child_overview: isFile && parsed.child_overview?.length
                ? parsed.child_overview : undefined,
            };
          }
          // structured parse failed — fall back to medium for retry
          const rawMed  = await generateMedium(label, fullText, parts, ctx);
          const cleanMed = sanitizeSummary(rawMed);
          if (cleanMed) return { summary: cleanMed, summary_kind: 'llm_medium' };
        } else {
          // Content too large for single prompt — rollup path
          const raw   = await generateStructured(label, fullText, parts, false, ctx);
          const clean = sanitizeSummary(raw);
          if (clean) return { summary: clean, summary_kind: 'rollup' };
        }
      }
    } catch (err) {
      process.stderr.write(`[skeleton-summary] "${label}" attempt ${attempt + 1} error: ${err.message}\n`);
    }
    if (attempt === 0) {
      process.stderr.write(`[skeleton-summary] "${label}" attempt 1 rejected — retrying\n`);
    }
  }
  return null;
}

async function generateRollup(label, lines, ctx) {
  const { generateFn, model, budget, numCtx, thinking } = ctx;
  const src = chooseSource(lines.join('\n'), lines, budget);
  const gen = (prompt) => generateFn(model, prompt, { options: genOptions(numCtx, thinking) });
  if (src.mode !== 'batched') return (await gen(rollupPrompt(label, lines))).trim();
  const partSummaries = [];
  for (const batch of src.batches) {
    partSummaries.push((await gen(rollupPrompt(`a part of ${label}`, batch))).trim());
  }
  return (await gen(rollupPrompt(label, partSummaries))).trim();
}

async function generateRollupWithRetry(label, lines, ctx) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw   = await generateRollup(label, lines, ctx);
      const clean = sanitizeSummary(raw);
      if (clean) return clean;
    } catch (err) {
      process.stderr.write(`[skeleton-summary] rollup "${label}" attempt ${attempt + 1} error: ${err.message}\n`);
    }
    if (attempt === 0) {
      process.stderr.write(`[skeleton-summary] rollup "${label}" attempt 1 rejected — retrying\n`);
    }
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Replace inventory summaries on nav points with adaptive LLM summaries.
 * The inventory string is preserved in `inventory`. Per-node failures keep the
 * inventory summary — a flaky LLM must never break indexing.
 *
 * New fields added to nav points (additive, backward-compatible):
 *   summary_kind:    'llm_short' | 'llm_medium' | 'llm_structured' | 'rollup'
 *   summary_version: SUMMARY_VERSION
 *   key_topics:      string[] (structured only)
 *   notable_terms:   string[] (structured only)
 *   child_overview:  string[] (structured file nodes only)
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
  const numCtx = opts.numCtx ?? await resolveNumCtx(model, process.env);
  const thinking = opts.thinking ?? (opts.generateFn ? false : await isThinkingModel(model));
  const budget = Math.max(500, Math.floor(windowTokens * 0.8));
  const ctx = { generateFn, model, budget, numCtx, thinking };

  const out = [];
  const sectionSummaries = [];

  // Sections first (file node needs their summaries as fallback source).
  for (const nav of navPoints.filter(n => n.node_type === 'section')) {
    const own = chunks.filter(c => c.parent_id === nav.node_id);
    const fullText = own.map(c => c.text).join('\n\n');
    const heading = nav.heading_path?.at(-1) ?? nav.node_path;
    let extra = {};
    let summary = nav.summary;
    try {
      if (fullText.trim()) {
        const result = await generateAdaptiveSummary(
          `section "${heading}"`, fullText,
          own.map(c => c.text).filter(Boolean), false, ctx);
        if (result) {
          summary = result.summary;
          extra = {
            summary_kind:    result.summary_kind,
            summary_version: SUMMARY_VERSION,
            ...(result.key_topics    ? { key_topics:    result.key_topics }    : {}),
            ...(result.notable_terms ? { notable_terms: result.notable_terms } : {}),
          };
        } else {
          process.stderr.write(`[skeleton-summary] section "${heading}" rejected after retry — keeping inventory\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`[skeleton-summary] section "${heading}" failed (${err.message}) — keeping inventory\n`);
    }
    sectionSummaries.push(`- ${heading}: ${summary}`);
    out.push({ ...nav, inventory: nav.summary, summary, ...extra });
  }

  // File node: full content if it fits, else section summaries (already semantic).
  for (const nav of navPoints.filter(n => n.node_type === 'file')) {
    const fullText = chunks.map(c => c.text).join('\n\n');
    let extra = {};
    let summary = nav.summary;
    try {
      if (fullText.trim()) {
        const result = await generateAdaptiveSummary(
          `the document "${nav.source_file}"`, fullText,
          sectionSummaries.length ? sectionSummaries : [nav.summary], true, ctx);
        if (result) {
          summary = result.summary;
          extra = {
            summary_kind:    result.summary_kind,
            summary_version: SUMMARY_VERSION,
            ...(result.key_topics     ? { key_topics:     result.key_topics }     : {}),
            ...(result.notable_terms  ? { notable_terms:  result.notable_terms }  : {}),
            ...(result.child_overview ? { child_overview: result.child_overview } : {}),
          };
        } else {
          process.stderr.write(`[skeleton-summary] file "${nav.source_file}" rejected after retry — keeping inventory\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`[skeleton-summary] file "${nav.source_file}" failed (${err.message}) — keeping inventory\n`);
    }
    out.push({ ...nav, inventory: nav.summary, summary, ...extra });
  }

  const byId = new Map(out.map(n => [n.node_id, n]));
  return navPoints.map(n => byId.get(n.node_id) ?? n);
}

/**
 * Build the collection-level nav point from file summaries.
 *
 * @param {string} collection
 * @param {Array<{ source_file: string, summary: string }>} fileNodes
 * @param {{ generateFn?: Function, model?: string, windowTokens?: number, llm?: boolean }} [opts]
 * @returns {Promise<{ summary: string, summary_kind: string, children: string[] }>}
 */
export async function buildCollectionSummary(collection, fileNodes, opts = {}) {
  const children  = fileNodes.map(f => `${f.source_file}#file`);
  const lines     = fileNodes.map(f => `- ${f.source_file}: ${f.summary}`);
  const inventory = `${collection} — ${fileNodes.length} file${fileNodes.length === 1 ? '' : 's'}`;

  if (!opts.llm || fileNodes.length === 0) {
    return { summary: inventory, summary_kind: 'inventory', children };
  }
  const generateFn   = opts.generateFn ?? generate;
  const model        = opts.model ?? (process.env.CONTEXT_MODEL || 'gemma3:4b');
  const windowTokens = opts.windowTokens ?? summaryWindowTokens(process.env);
  const numCtx = opts.numCtx ?? await resolveNumCtx(model, process.env);
  const thinking = opts.thinking ?? (opts.generateFn ? false : await isThinkingModel(model));
  const budget = Math.max(500, Math.floor(windowTokens * 0.8));
  const ctx = { generateFn, model, budget, numCtx, thinking };
  try {
    const clean = await generateRollupWithRetry(`the collection "${collection}"`, lines, ctx);
    if (!clean) {
      process.stderr.write('[skeleton-summary] collection summary rejected after retry — keeping inventory\n');
      return { summary: inventory, summary_kind: 'inventory', children };
    }
    return { summary: clean, summary_kind: 'rollup', summary_version: SUMMARY_VERSION, children };
  } catch (err) {
    process.stderr.write(`[skeleton-summary] collection summary failed (${err.message}) — keeping inventory\n`);
    return { summary: inventory, summary_kind: 'inventory', children };
  }
}
