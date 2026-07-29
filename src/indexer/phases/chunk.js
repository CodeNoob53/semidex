import { readFileSync } from 'fs';
import { extname } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import pdf2md from '@opendocsg/pdf2md';
import { heuristicTokenCount, getTokenCounter, resolveTokenCountMode } from '../../core/token-count.js';
import { envInt } from '../../core/env.js';
import { splitOversizedUnitIntoPieces, canonicalWhitespace } from './token-budget-split.js';

const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

const execFileAsync = promisify(execFile);

// let (not const): MAX_CHUNK_TOKENS/MIN_CHUNK_TOKENS/CHUNK_OVERLAP_TOKENS/
// OVERLAP_SENTENCES are next_index_job settings (core/settings/
// definitions.js) — a fresh indexer process reads its current effective
// value once at startup via applyChunkingSettings() below, called by
// indexer/index.js right after it constructs its own SettingsService and
// before any file is chunked. This mirrors the file's own existing
// once-at-module-load resolution timing exactly (a single indexer run
// never needs the value to change mid-run), while letting a settings.json
// write actually take effect on the NEXT indexer invocation without
// requiring a source change or restart of any other process — the
// "consumed, not copied" requirement for a settings source of truth.
// Every internal use of these four names throughout this file (chunking
// algorithm internals below) is unaffected — they still read the same
// module-scoped bindings, which just become live instead of frozen at
// import time.
let MAX_TOKENS             = envInt('MAX_CHUNK_TOKENS',    512, 1, 100000, '[chunk] ');
let MIN_TOKENS              = envInt('MIN_CHUNK_TOKENS',    160, 0, 100000, '[chunk] ');
export let OVERLAP_SENTENCES = envInt('OVERLAP_SENTENCES',   2, 0, 100,    '[chunk] ');
let CHUNK_OVERLAP_TOKENS    = envInt('CHUNK_OVERLAP_TOKENS',  80, 0, 100000, '[chunk] ');

/**
 * Re-resolves the four chunking knobs above from a SettingsService instead
 * of the raw process.env reads captured at import time. Call once, at
 * indexer process startup, before chunking any file — never mid-run.
 * @param {Object} settingsService
 */
export function applyChunkingSettings(settingsService) {
  MAX_TOKENS = settingsService.getActiveValue('MAX_CHUNK_TOKENS');
  MIN_TOKENS = settingsService.getActiveValue('MIN_CHUNK_TOKENS');
  OVERLAP_SENTENCES = settingsService.getActiveValue('OVERLAP_SENTENCES');
  CHUNK_OVERLAP_TOKENS = settingsService.getActiveValue('CHUNK_OVERLAP_TOKENS');
}

export function getChunkingConfig() {
  return { maxTokens: MAX_TOKENS, minTokens: MIN_TOKENS, overlapTokens: CHUNK_OVERLAP_TOKENS, overlapSentences: OVERLAP_SENTENCES };
}

/**
 * Resolves a real per-profile embedding budget ({ maxInputTokens,
 * countTokens }, from resolveEmbeddingBudget, qdrant-cloud-catalog.js) into
 * the effective ceiling/floor/overlap this module's budget-aware chunking
 * functions use. Returns `null` (a sentinel, not a same-shaped default
 * object) when `budget` is null/absent — every call site branches
 * explicitly on this, taking the UNCHANGED, pre-existing unbudgeted code
 * path rather than a "same function, default-parameterized" path, which is
 * what makes the Local/no-budget path provably byte-identical to today.
 *
 * effectiveMax never exceeds the user-configured MAX_CHUNK_TOKENS — a
 * cloud model with a WIDER context window than configured must never
 * silently grow chunks past what the operator configured; only a model
 * window NARROWER than configured tightens the ceiling. minTokens/
 * overlapTokens scale down proportionally only when the ceiling itself
 * was tightened (shrink < 1); they never scale up.
 */
export function effectiveBudgetFor(budget) {
  if (!budget) return null;
  const maxTokens = Math.min(MAX_TOKENS, budget.maxInputTokens);
  const shrink = maxTokens < MAX_TOKENS ? maxTokens / MAX_TOKENS : 1;
  return {
    countFn: budget.countTokens,
    maxTokens,
    minTokens: Math.min(MIN_TOKENS, Math.floor(MIN_TOKENS * shrink)),
    overlapTokens: Math.min(CHUNK_OVERLAP_TOKENS, Math.floor(CHUNK_OVERLAP_TOKENS * shrink)),
  };
}

// Sync heuristic used by the legacy sync chunking path. Aliased from
// token-count.js so both paths share the same implementation.
const countTokens = heuristicTokenCount;

// Normalize line endings before any structural parsing. CRLF input previously
// broke frontmatter (/^---\n/) and setext-heading (/^=+$/) detection — meta
// tags were silently lost on Windows-authored files (code review 2026-06-10,
// finding #1). Covered by smoke section 45.
export function normalizeEol(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

export function splitSentences(text) {
  const parts = text.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) ?? [];
  const result = parts.map(s => s.trim()).filter(Boolean);
  return result.length ? result : [text];
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) {
      const val = rest.join(':').trim().replace(/^\[|\]$/g, '');
      meta[key.trim()] = val.includes(',')
        ? val.split(',').map(s => s.trim())
        : val;
    }
  }
  return { meta, body: match[2] };
}

function parseWikilinks(text) {
  return [...text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)]
    .map(m => m[1].trim());
}

// Recursive text chunker: paragraph → sentence → word.
// Each level tries to pack units up to MAX_TOKENS before falling to the next level.
// No overlap here; indexing overlap is applied after deterministic chunk finalization.
// stripPageMarkers: strip "-- N of M --" markers emitted by pdf-parse.
export function recursiveChunkText(text, { stripPageMarkers = false } = {}) {
  let src = normalizeEol(text);
  if (stripPageMarkers) src = src.replace(/--\s*\d+\s*of\s*\d+\s*--/g, '');
  src = src.replace(/\n{3,}/g, '\n\n').trim();
  if (!src) return [];
  return _splitLevel(src, LEVELS);
}

// Splitting levels in priority order.
const LEVELS = [
  { split: t => t.split(/\n\n+/).map(p => p.trim()).filter(Boolean), join: '\n\n' },
  { split: t => splitSentences(t),                                   join: ' '   },
  { split: t => t.split(/\s+/).filter(Boolean),                      join: ' '   },
];

function _splitLevel(text, levels) {
  if (countTokens(text) <= MAX_TOKENS) return [text];
  if (levels.length === 0) return [text]; // can't split further — return as-is

  const [level, ...rest] = levels;
  const units = level.split(text);

  // If this level can't actually split the text, fall to next level immediately.
  if (units.length <= 1) return _splitLevel(text, rest);

  const chunks = [];
  let current = [];
  let currentTokens = 0;

  for (const unit of units) {
    const ut = countTokens(unit);
    if (ut > MAX_TOKENS) {
      // Unit is itself oversized — flush current accumulator then recurse deeper.
      if (current.length > 0) {
        chunks.push(current.join(level.join));
        current = [];
        currentTokens = 0;
      }
      chunks.push(..._splitLevel(unit, rest));
    } else if (currentTokens + ut > MAX_TOKENS && current.length > 0) {
      chunks.push(current.join(level.join));
      current = [unit];
      currentTokens = ut;
    } else {
      current.push(unit);
      currentTokens += ut;
    }
  }
  if (current.length > 0) chunks.push(current.join(level.join));
  return chunks;
}

function chunkBySentences(text) {
  const sentences = splitSentences(text);
  const chunks = [];
  let current = [];
  let pending = 0;

  for (const sentence of sentences) {
    current.push(sentence);
    pending++;
    if (countTokens(current.join(' ')) >= MAX_TOKENS) {
      chunks.push(current.join(' '));
      current = [];
      pending = 0;
    }
  }
  if (pending > 0) chunks.push(current.join(' '));
  return chunks;
}

function sameChunkScope(chunkA, chunkB) {
  const groupA = chunkA?._split_group;
  const groupB = chunkB?._split_group;
  return (
    chunkA?.source_file === chunkB?.source_file &&
    (chunkA?.section || '') === (chunkB?.section || '') &&
    (groupA === undefined || groupB === undefined || groupA === groupB)
  );
}

function mergePair(chunkA, chunkB) {
  return {
    ...chunkA,
    text: `${chunkA.text}\n${chunkB.text}`,
    _split_boundary: false,
  };
}

function markSplitBoundaries(chunks) {
  return chunks.map((chunk, idx) => ({
    ...chunk,
    _split_boundary: idx > 0 && sameChunkScope(chunks[idx - 1], chunk),
  }));
}

function overlapPrefixFrom(text) {
  if (OVERLAP_SENTENCES <= 0) return '';
  return splitSentences(text).slice(-OVERLAP_SENTENCES).join(' ').trim();
}

function addSplitOverlap(chunks) {
  return chunks.map((chunk, idx) => {
    if (idx === 0 || !chunk._split_boundary) {
      return { ...chunk, _split_boundary: false };
    }

    const prev = chunks[idx - 1];
    if (!sameChunkScope(prev, chunk)) {
      return { ...chunk, _split_boundary: false };
    }

    const prefix = overlapPrefixFrom(prev.text);
    if (!prefix || chunk.text.startsWith(prefix)) {
      return { ...chunk, _split_boundary: false };
    }

    return {
      ...chunk,
      text: `${prefix} ${chunk.text}`,
      _split_boundary: false,
    };
  });
}

function reindexChunks(chunks) {
  return chunks.map((c, i) => {
    const { _split_group, _split_boundary, ...chunk } = c;
    return { ...chunk, chunkIndex: i, totalChunks: chunks.length };
  });
}

// ── word-boundary-safe token suffix ───────────────────────────────────────
// Binary search for the shortest suffix with count <= maxTokens, then snap the
// start position forward to the next /\s/ if it lands mid-word.
// Returns '' if the text is entirely one unsplittable run (no whitespace after cut).

async function safeLastTokens(text, maxTokens, countFn) {
  if (!text || maxTokens <= 0) return '';
  const full = await countFn(text);
  if (full <= maxTokens) return text;

  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await countFn(text.slice(mid)) <= maxTokens) hi = mid;
    else lo = mid + 1;
  }

  // Snap forward if cut is mid-word (prev char and cur char are both non-space).
  if (lo > 0 && lo < text.length && /\S/.test(text[lo - 1]) && /\S/.test(text[lo])) {
    const ws = text.slice(lo).search(/\s/);
    if (ws === -1) return '';   // no whitespace after cut — unsplittable run
    lo = lo + ws + 1;
  }

  return lo < text.length ? text.slice(lo).trim() : '';
}

// ── async dynamic-budget overlap ───────────────────────────────────────────
// Dynamic rule: body is split to MAX first. Overlap is taken only from the
// remaining budget: available = MAX - bodyTokens; cap = min(OVERLAP_CAP, available).
// If CHUNK_OVERLAP_TOKENS === 0 fall back to sentence-based addSplitOverlap.

async function addSplitOverlapAsync(chunks, countFn) {
  if (CHUNK_OVERLAP_TOKENS <= 0) return addSplitOverlap(chunks);

  const result = [];
  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx];

    if (idx === 0 || !chunk._split_boundary) {
      result.push({ ...chunk, _split_boundary: false });
      continue;
    }

    const prev = chunks[idx - 1];
    if (!sameChunkScope(prev, chunk)) {
      result.push({ ...chunk, _split_boundary: false });
      continue;
    }

    const bodyTokens = await countFn(chunk.text);
    const available = MAX_TOKENS - bodyTokens;

    if (available <= 0) {
      // Body already fills MAX — skip overlap.
      result.push({ ...chunk, _split_boundary: false });
      continue;
    }

    const cap = Math.min(CHUNK_OVERLAP_TOKENS, available);
    const overlap = await safeLastTokens(prev.text, cap, countFn);

    if (!overlap || chunk.text.startsWith(overlap)) {
      result.push({ ...chunk, _split_boundary: false });
      continue;
    }

    result.push({ ...chunk, text: `${overlap} ${chunk.text}`, _split_boundary: false });
  }
  return result;
}

// ── budget-aware overlap: re-measures the ACTUAL joined string ────────────
// addSplitOverlapAsync (above) caps the overlap by separately-measured
// token counts of `overlap` and `chunk.text`, then joins them without
// re-checking — subword tokenization is not strictly additive across a
// join boundary, so the joined result can exceed maxTokens even when both
// halves individually fit. This variant re-measures the actual candidate
// string and shrinks/omits the overlap if it doesn't fit, never emitting a
// chunk whose final text exceeds maxTokens.
async function addSplitOverlapAsyncBudgeted(chunks, countFn, { maxTokens, overlapTokens }) {
  if (overlapTokens <= 0) return chunks.map((c) => ({ ...c, _split_boundary: false }));

  const result = [];
  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx];

    if (idx === 0 || !chunk._split_boundary) {
      result.push({ ...chunk, _split_boundary: false });
      continue;
    }

    const prev = chunks[idx - 1];
    if (!sameChunkScope(prev, chunk)) {
      result.push({ ...chunk, _split_boundary: false });
      continue;
    }

    const bodyTokens = await countFn(chunk.text);
    const available = maxTokens - bodyTokens;

    if (available <= 0) {
      result.push({ ...chunk, _split_boundary: false });
      continue;
    }

    let cap = Math.min(overlapTokens, available);
    let overlap = '';
    // Shrink the cap until the ACTUAL joined string fits, or until no
    // non-empty overlap can fit at all (emit the chunk unmodified).
    while (cap > 0) {
      const candidate = await safeLastTokens(prev.text, cap, countFn);
      if (!candidate || chunk.text.startsWith(candidate)) { overlap = ''; break; }
      const joined = `${candidate} ${chunk.text}`;
      if (await countFn(joined) <= maxTokens) { overlap = candidate; break; }
      cap = (await countFn(candidate)) - 1; // shrink and retry
    }

    if (!overlap) {
      result.push({ ...chunk, _split_boundary: false });
      continue;
    }

    result.push({ ...chunk, text: `${overlap} ${chunk.text}`, _split_boundary: false });
  }
  return result;
}

export function mergeShortChunks(chunks, countFn = countTokens) {
  if (MIN_TOKENS <= 0 || chunks.length <= 1) return chunks.map(c => ({ ...c }));

  const merged = [];
  for (let i = 0; i < chunks.length; i++) {
    let current = { ...chunks[i] };
    let currentTokens = countFn(current.text);

    while (
      currentTokens < MIN_TOKENS &&
      i + 1 < chunks.length &&
      sameChunkScope(current, chunks[i + 1])
    ) {
      current = mergePair(current, chunks[i + 1]);
      i++;
      currentTokens = countFn(current.text);
    }

    if (currentTokens < MIN_TOKENS && merged.length > 0 && sameChunkScope(merged.at(-1), current)) {
      merged[merged.length - 1] = mergePair(merged.at(-1), current);
    } else {
      merged.push(current);
    }
  }

  return merged;
}

async function mergeShortChunksAsync(chunks, countFn) {
  if (MIN_TOKENS <= 0 || chunks.length <= 1) return chunks.map(c => ({ ...c }));

  const merged = [];
  for (let i = 0; i < chunks.length; i++) {
    let current = { ...chunks[i] };
    let currentTokens = await countFn(current.text);

    while (
      currentTokens < MIN_TOKENS &&
      i + 1 < chunks.length &&
      sameChunkScope(current, chunks[i + 1])
    ) {
      current = mergePair(current, chunks[i + 1]);
      i++;
      currentTokens = await countFn(current.text);
    }

    if (currentTokens < MIN_TOKENS && merged.length > 0 && sameChunkScope(merged.at(-1), current)) {
      merged[merged.length - 1] = mergePair(merged.at(-1), current);
    } else {
      merged.push(current);
    }
  }

  return merged;
}

// ── budget-aware merge: never merge past maxTokens to satisfy minTokens ───
// mergeShortChunksAsync (above) merges based only on the UNDERSIZED side
// (currentTokens < minTokens), never checking whether the merged RESULT
// stays under maxTokens. This variant measures the candidate merged text
// first and only commits the merge if it fits — an under-minTokens chunk
// that can't merge further without breaking the ceiling is emitted as-is,
// which is the correct, intentional outcome (never overshoot the ceiling
// to satisfy the floor).
async function mergeShortChunksAsyncBudgeted(chunks, countFn, { minTokens, maxTokens }) {
  if (minTokens <= 0 || chunks.length <= 1) return chunks.map((c) => ({ ...c }));

  const merged = [];
  for (let i = 0; i < chunks.length; i++) {
    let current = { ...chunks[i] };
    let currentTokens = await countFn(current.text);

    while (i + 1 < chunks.length && sameChunkScope(current, chunks[i + 1])) {
      if (currentTokens >= minTokens) break;
      const candidate = mergePair(current, chunks[i + 1]);
      const candidateTokens = await countFn(candidate.text);
      if (candidateTokens > maxTokens) break; // merging would overshoot the ceiling — stop
      current = candidate;
      currentTokens = candidateTokens;
      i++;
    }

    if (currentTokens < minTokens && merged.length > 0 && sameChunkScope(merged.at(-1), current)) {
      const candidate = mergePair(merged.at(-1), current);
      const candidateTokens = await countFn(candidate.text);
      if (candidateTokens <= maxTokens) {
        merged[merged.length - 1] = candidate;
        continue;
      }
    }
    merged.push(current);
  }

  return merged;
}

export function finalizeChunks(chunks, countFn = countTokens) {
  const merged = mergeShortChunks(chunks, countFn);
  return reindexChunks(addSplitOverlap(markSplitBoundaries(merged)));
}

async function finalizeChunksAsync(chunks, countFn) {
  const merged = await mergeShortChunksAsync(chunks, countFn);
  const marked = markSplitBoundaries(merged);
  const overlapped = await addSplitOverlapAsync(marked, countFn);
  return reindexChunks(overlapped);
}

// Budget-aware finalize: chains the *Budgeted merge/overlap variants, then
// enforces a hard final invariant — every chunk must fit maxTokens. Given
// the fixes in mergeShortChunksAsyncBudgeted/addSplitOverlapAsyncBudgeted/
// chunkBySentencesAsyncBudgeted/chunkSectionsAsyncBudgeted, this should be
// structurally unreachable; it throws loudly rather than silently shipping
// an oversized chunk to the embedder if it is somehow reached.
async function finalizeChunksAsyncBudgeted(chunks, countFn, { minTokens, maxTokens, overlapTokens }) {
  const merged = await mergeShortChunksAsyncBudgeted(chunks, countFn, { minTokens, maxTokens });
  const marked = markSplitBoundaries(merged);
  const overlapped = await addSplitOverlapAsyncBudgeted(marked, countFn, { maxTokens, overlapTokens });
  const final = reindexChunks(overlapped);
  for (const chunk of final) {
    const tokens = await countFn(chunk.text);
    if (tokens > maxTokens) {
      throw new Error(`[chunk] budget invariant violated: chunk ${chunk.chunkIndex} has ${tokens} tokens, exceeding maxTokens=${maxTokens} (source_file: ${chunk.source_file})`);
    }
  }
  return final;
}

// heuristic: is this a real section title or just body text styled as heading?
function isStructuralHeading(text) {
  if (!text || text.length === 0) return false;
  if (text.length > 120) return false;
  if (/[.!?]$/.test(text.trim())) return false;
  return true;
}

function parseMarkdown(text) {
  const { meta, body } = parseFrontmatter(text);
  const lines = body.split('\n');
  const sections = [];
  let currentHeading = '';
  let currentLines = [];

  function flushSection(newHeading) {
    if (currentLines.length) {
      sections.push({ heading: currentHeading, text: currentLines.join('\n').trim() });
    }
    currentHeading = newHeading;
    currentLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] ?? '';

    // Setext headings: a non-empty line followed by ===+ (h1) or ---+ (h2).
    // The underline must be at least 2 chars and contain only = or -.
    // Skip if the candidate line looks like a frontmatter delimiter (---).
    const isSetextH1 = /^=+$/.test(next) && next.length >= 2 && line.trim().length > 0;
    const isSetextH2 = /^-+$/.test(next) && next.length >= 2 && line.trim().length > 0;

    if (isSetextH1 || isSetextH2) {
      const headingText = line.replace(/\*\*/g, '').trim();
      if (isStructuralHeading(headingText)) {
        flushSection(headingText);
        i++; // consume the underline row
        continue;
      }
    }

    const headingMatch = line.match(/^(#{1,6}) (.+)/);
    if (headingMatch) {
      const headingText = headingMatch[2].replace(/\*\*/g, '').trim();
      if (isStructuralHeading(headingText)) {
        flushSection(headingText);
      } else {
        currentLines.push(line);
      }
    } else {
      currentLines.push(line);
    }
  }
  if (currentLines.length) {
    sections.push({ heading: currentHeading, text: currentLines.join('\n').trim() });
  }

  return { meta, sections };
}

function chunkSections(sections, sourceFile, meta = {}, links = []) {
  const chunks = [];

  for (let group = 0; group < sections.length; group++) {
    const section = sections[group];
    // Skip heading-only sections: no text means no retrievable content.
    if (!section.text || !section.text.trim()) continue;
    if (!section.heading && countTokens(section.text) < MIN_TOKENS) continue;

    // Section chunks are split cleanly here. Short-fragment merge and overlap
    // happen in finalizeChunks(), after all section-local split boundaries exist.
    if (countTokens(section.text) <= MAX_TOKENS) {
      chunks.push({ text: section.text, section: section.heading, source_file: sourceFile, meta, links, _split_boundary: false, _split_group: group });
    } else {
      const subChunks = chunkBySentences(section.text, []);
      subChunks.forEach((t, i) => {
        chunks.push({ text: t, section: section.heading, source_file: sourceFile, meta, links, _split_boundary: i > 0, _split_group: group });
      });
    }
  }
  return chunks;
}

export function chunkFile(filePath, text, sourceFile) {
  text = normalizeEol(text);
  const ext = extname(filePath).toLowerCase();
  const chunks = [];

  if (ext === '.md') {
    const { meta, sections } = parseMarkdown(text);
    const links = parseWikilinks(text);
    chunks.push(...chunkSections(sections, sourceFile, meta, links));
  } else {
    const subChunks = chunkBySentences(text);
    subChunks.forEach((t, i) => {
      chunks.push({ text: t, section: '', source_file: sourceFile, meta: {}, links: [], _split_boundary: i > 0 });
    });
  }

  return finalizeChunks(chunks);
}

// ── async token-aware chunking helpers ────────────────────────────────────
// Used by the production indexer. The sync chunkFile helper remains heuristic
// for legacy callers and benchmarks until they explicitly migrate.

async function _splitLevelAsync(text, levels, countFn, maxTokens = MAX_TOKENS) {
  if (await countFn(text) <= maxTokens) return [text];
  if (levels.length === 0) return [text];

  const [level, ...rest] = levels;
  const units = level.split(text);
  if (units.length <= 1) return _splitLevelAsync(text, rest, countFn, maxTokens);

  const chunks = [];
  let current = [];
  let currentTokens = 0;

  for (const unit of units) {
    const ut = await countFn(unit);
    if (ut > maxTokens) {
      if (current.length > 0) {
        chunks.push(current.join(level.join));
        current = [];
        currentTokens = 0;
      }
      chunks.push(...await _splitLevelAsync(unit, rest, countFn, maxTokens));
    } else if (currentTokens + ut > maxTokens && current.length > 0) {
      chunks.push(current.join(level.join));
      current = [unit];
      currentTokens = ut;
    } else {
      current.push(unit);
      currentTokens += ut;
    }
  }
  if (current.length > 0) chunks.push(current.join(level.join));
  return chunks;
}

async function recursiveChunkTextAsync(text, countFn, { stripPageMarkers = false } = {}, maxTokens = MAX_TOKENS) {
  let src = normalizeEol(text);
  if (stripPageMarkers) src = src.replace(/--\s*\d+\s*of\s*\d+\s*--/g, '');
  src = src.replace(/\n{3,}/g, '\n\n').trim();
  if (!src) return [];
  return _splitLevelAsync(src, LEVELS, countFn, maxTokens);
}

/**
 * Profile-aware entry point for prose text chunking — used by
 * skeleton-chunk.js's flushProse() (Markdown path). Splits `text` so every
 * returned piece fits the resolved budget using the real per-profile
 * tokenizer, falling back to character-boundary splitting
 * (splitOversizedUnitIntoPieces) for any piece still oversized after
 * word-level splitting (LEVELS' last level has no further fallback of its
 * own). When `budget` is null (client/local execution profile), delegates
 * to the unchanged, unmodified recursiveChunkText() — byte-identical to
 * pre-existing behavior, by construction.
 * @param {string} text
 * @param {{maxInputTokens: number, countTokens: (text: string) => number|Promise<number>}|null} budget
 * @param {{stripPageMarkers?: boolean}} [opts]
 * @returns {Promise<string[]>}
 */
export async function recursiveChunkTextForBudget(text, budget, opts = {}) {
  const eff = effectiveBudgetFor(budget);
  if (!eff) return recursiveChunkText(text, opts);
  const pieces = await recursiveChunkTextAsync(text, eff.countFn, opts, eff.maxTokens);
  const final = [];
  for (const piece of pieces) {
    if ((await eff.countFn(piece)) <= eff.maxTokens) { final.push(piece); continue; }
    final.push(...await splitOversizedUnitIntoPieces(piece, (p) => p, { countTokens: eff.countFn, maxInputTokens: eff.maxTokens }));
  }
  return final;
}

async function chunkBySentencesAsync(text, countFn) {
  const sentences = splitSentences(text);
  const chunks = [];
  let current = [];
  let pending = 0;

  for (const sentence of sentences) {
    current.push(sentence);
    pending++;
    if (await countFn(current.join(' ')) >= MAX_TOKENS) {
      chunks.push(current.join(' '));
      current = [];
      pending = 0;
    }
  }
  if (pending > 0) chunks.push(current.join(' '));
  return chunks;
}

// ── budget-aware sentence chunking: never ships an oversized chunk ────────
// chunkBySentencesAsync (above) appends each sentence to `current` FIRST,
// then checks the accumulated join against MAX_TOKENS — so a single
// oversized sentence (or a short run of sentences that only crosses the
// ceiling once fully accumulated) is pushed as a chunk exceeding budget,
// with no fallback split. This variant checks the CANDIDATE before
// committing, and any single sentence still oversized alone is split
// further: word-level first (_splitLevelAsync with only the word LEVEL),
// then — since word-level is the LAST level and a single no-space token
// (e.g. a long URL/identifier) can still be oversized after it —
// character-boundary split via splitOversizedUnitIntoPieces. Every
// resulting piece is guaranteed to fit maxTokens.
const WORD_LEVEL = [LEVELS[2]];

async function chunkBySentencesAsyncBudgeted(text, countFn, maxTokens) {
  const sentences = splitSentences(text);
  const chunks = [];
  let current = [];

  const flush = () => {
    if (current.length) {
      chunks.push(current.join(' '));
      current = [];
    }
  };

  for (const sentence of sentences) {
    const sentenceTokens = await countFn(sentence);
    if (sentenceTokens > maxTokens) {
      flush();
      const wordPieces = await _splitLevelAsync(sentence, WORD_LEVEL, countFn, maxTokens);
      for (const piece of wordPieces) {
        if ((await countFn(piece)) <= maxTokens) { chunks.push(piece); continue; }
        chunks.push(...await splitOversizedUnitIntoPieces(piece, (p) => p, { countTokens: countFn, maxInputTokens: maxTokens }));
      }
      continue;
    }
    const candidate = [...current, sentence].join(' ');
    if ((await countFn(candidate)) > maxTokens && current.length > 0) {
      flush();
    }
    current.push(sentence);
  }
  flush();
  return chunks;
}

async function chunkSectionsAsync(sections, sourceFile, meta = {}, links = [], countFn) {
  const chunks = [];

  for (let group = 0; group < sections.length; group++) {
    const section = sections[group];
    if (!section.text || !section.text.trim()) continue;
    if (!section.heading && await countFn(section.text) < MIN_TOKENS) continue;

    if (await countFn(section.text) <= MAX_TOKENS) {
      chunks.push({ text: section.text, section: section.heading, source_file: sourceFile, meta, links, _split_boundary: false, _split_group: group });
    } else {
      const subChunks = await _splitLevelAsync(section.text, LEVELS, countFn);
      subChunks.forEach((t, i) => {
        chunks.push({ text: t, section: section.heading, source_file: sourceFile, meta, links, _split_boundary: i > 0, _split_group: group });
      });
    }
  }
  return chunks;
}

// ── budget-aware section chunking: closes the same last-level gap as
// chunkBySentencesAsyncBudgeted ─────────────────────────────────────────
// _splitLevelAsync bottoms out at word-level (LEVELS' last entry) and
// returns a still-oversized single "word" unchanged (e.g. a long URL/
// identifier with no internal whitespace) — chunkSectionsAsync's oversized
// branch calls _splitLevelAsync directly with no further fallback for that
// case. This variant adds the same guaranteed-fitting character-boundary
// last resort used everywhere else in this module.
async function chunkSectionsAsyncBudgeted(sections, sourceFile, meta = {}, links = [], countFn, { maxTokens, minTokens }) {
  const chunks = [];

  for (let group = 0; group < sections.length; group++) {
    const section = sections[group];
    if (!section.text || !section.text.trim()) continue;
    if (!section.heading && await countFn(section.text) < minTokens) continue;

    if (await countFn(section.text) <= maxTokens) {
      chunks.push({ text: section.text, section: section.heading, source_file: sourceFile, meta, links, _split_boundary: false, _split_group: group });
      continue;
    }
    const subChunks = await _splitLevelAsync(section.text, LEVELS, countFn, maxTokens);
    let i = 0;
    for (const t of subChunks) {
      if ((await countFn(t)) <= maxTokens) {
        chunks.push({ text: t, section: section.heading, source_file: sourceFile, meta, links, _split_boundary: i > 0, _split_group: group });
        i++;
        continue;
      }
      const pieces = await splitOversizedUnitIntoPieces(t, (p) => p, { countTokens: countFn, maxInputTokens: maxTokens });
      for (const piece of pieces) {
        chunks.push({ text: piece, section: section.heading, source_file: sourceFile, meta, links, _split_boundary: i > 0, _split_group: group });
        i++;
      }
    }
  }
  return chunks;
}

/**
 * Async variant of chunkFile. Accepts a countFn for token-aware splitting.
 * Used by the production chunkFileFromPath real-tokenizer mode.
 * The sync chunkFile() is not modified.
 *
 * `budget` (optional, default null): a real per-profile embedding budget
 * ({ maxInputTokens, countTokens }, resolveEmbeddingBudget,
 * qdrant-cloud-catalog.js). When null, this function's body is IDENTICAL
 * to its pre-budget-awareness form — it calls the original, unmodified
 * chunkSectionsAsync/chunkBySentencesAsync/finalizeChunksAsync — so the
 * Local/no-budget path is byte-identical to today by construction, not
 * merely by intent. When non-null, it calls the *Budgeted sibling
 * functions instead, which additionally guarantee every chunk fits the
 * resolved budget (never silently exceeding it after merge/overlap, and
 * never shipping an oversized chunk with no further split attempted).
 *
 * @param {string} filePath
 * @param {string} text
 * @param {string} sourceFile
 * @param {(text: string) => Promise<number>} countFn
 * @param {{maxInputTokens: number, countTokens: (text: string) => number|Promise<number>}|null} [budget]
 */
export async function chunkFileAsync(filePath, text, sourceFile, countFn = heuristicTokenCount, budget = null) {
  text = normalizeEol(text);
  const ext = extname(filePath).toLowerCase();
  const chunks = [];
  const eff = effectiveBudgetFor(budget);

  if (!eff) {
    if (ext === '.md') {
      const { meta, sections } = parseMarkdown(text);
      const links = parseWikilinks(text);
      chunks.push(...await chunkSectionsAsync(sections, sourceFile, meta, links, countFn));
    } else {
      const subChunks = await chunkBySentencesAsync(text, countFn);
      subChunks.forEach((t, i) => {
        chunks.push({ text: t, section: '', source_file: sourceFile, meta: {}, links: [], _split_boundary: i > 0 });
      });
    }
    return finalizeChunksAsync(chunks, countFn);
  }

  if (ext === '.md') {
    const { meta, sections } = parseMarkdown(text);
    const links = parseWikilinks(text);
    chunks.push(...await chunkSectionsAsyncBudgeted(sections, sourceFile, meta, links, eff.countFn, eff));
  } else {
    const subChunks = await chunkBySentencesAsyncBudgeted(text, eff.countFn, eff.maxTokens);
    subChunks.forEach((t, i) => {
      chunks.push({ text: t, section: '', source_file: sourceFile, meta: {}, links: [], _split_boundary: i > 0 });
    });
  }
  return finalizeChunksAsyncBudgeted(chunks, eff.countFn, eff);
}

/**
 * Budget-aware entry point for already-extracted plain text (the PDF
 * plain-text-fallback branch, which bypasses chunkFileAsync entirely since
 * it never has a synthetic .md-shaped path). Peer of
 * recursiveChunkTextForBudget/chunkFileAsync, operating on plain text
 * rather than a file path. When `budget` is null or `useAsync` is false,
 * mirrors the exact pre-existing inline logic (recursiveChunkText/
 * finalizeChunks, or recursiveChunkTextAsync/finalizeChunksAsync) —
 * unchanged behavior by construction.
 * @param {string} text — already-extracted plain text
 * @param {string} sourceFile
 * @param {(text: string) => Promise<number>|number} countFn
 * @param {{maxInputTokens: number, countTokens: Function}|null} budget
 * @param {boolean} useAsync
 * @param {{stripPageMarkers?: boolean}} [opts]
 */
export async function chunkExtractedTextForBudget(text, sourceFile, countFn, budget, useAsync, opts = { stripPageMarkers: true }) {
  if (!useAsync) {
    const subChunks = recursiveChunkText(text, opts);
    const chunks = subChunks.map((t, i) => ({
      text: t, section: '', source_file: sourceFile, meta: {}, links: [],
      _split_boundary: i > 0, chunkIndex: i, totalChunks: subChunks.length,
    }));
    return finalizeChunks(chunks);
  }
  const eff = effectiveBudgetFor(budget);
  const subChunks = eff
    ? await recursiveChunkTextForBudget(text, budget, opts)
    : await recursiveChunkTextAsync(text, countFn, opts);
  const chunks = subChunks.map((t, i) => ({
    text: t, section: '', source_file: sourceFile, meta: {}, links: [],
    _split_boundary: i > 0, chunkIndex: i, totalChunks: subChunks.length,
  }));
  return eff
    ? finalizeChunksAsyncBudgeted(chunks, eff.countFn, eff)
    : finalizeChunksAsync(chunks, countFn);
}

const PANDOC_FORMATS = new Set(['.docx', '.odt', '.rtf', '.epub', '.html', '.htm']);
let tokenCounterLogShown = false;

// Returns true if the pdf2md Markdown output has enough heading lines to use the structured path.
export function hasPdfStructure(md) {
  return Boolean(md && (md.match(/^#{1,6} /gm) || []).length >= 3);
}

// budget (Markdown/skeleton path only): { maxInputTokens, countTokens }
// resolved by the caller from the collection's embedding profile
// (resolveEmbeddingBudget, qdrant-cloud-catalog.js) — null for a
// client-execution profile, which preserves whole-entity chunking exactly
// as before oversized-entity splitting existed. Non-Markdown paths ignore
// this parameter entirely (no structural entity splitting outside the
// skeleton chunker).
//
// Return shape (all paths): { chunks, navPoints, entityRawPoints }.
//   chunks — the retrieval chunk_index sequence (Markdown: prose + entity/
//     fragment chunks from chunkFromSkeleton; non-Markdown: the legacy
//     chunker's flat output, unchanged shape).
//   navPoints — skeleton_nav points (Markdown only; [] otherwise).
//   entityRawPoints — canonical entity_raw points for split entities
//     (Markdown only, and only when at least one entity was actually split;
//     [] otherwise) — deliberately excluded from `chunks`' own chunk_index
//     sequence, see chunkFromSkeleton's own return-shape doc comment.
// Replaces the previous non-enumerable `__navPoints` side-channel on a
// plain chunk array — an explicit structured return is preferable for a
// core indexing contract, even though it means every caller (run.js,
// smoke tests) must be updated for the new shape.
export async function chunkFileFromPath(filePath, sourceFile, budget = null) {
  const ext = extname(filePath).toLowerCase();

  // Real BGE-M3 tokenization is the production default. TOKEN_COUNT=heuristic
  // is an explicit compatibility/performance fallback. The active profile's
  // budget takes priority over TOKEN_COUNT: a non-null budget (cloud
  // profile) always forces the async, budget-aware leg regardless of the
  // TOKEN_COUNT setting — TOKEN_COUNT=heuristic must never silently defeat
  // budget-aware splitting under a Cloud profile. TOKEN_COUNT still fully
  // controls behavior for a budget===null (Local) profile, unchanged.
  const tokenCountMode = resolveTokenCountMode();
  let countFn = null;
  let useAsync = false;

  if (budget !== null) {
    countFn = budget.countTokens;
    useAsync = true;
  } else if (tokenCountMode === 'bge-m3') {
    countFn = await getTokenCounter({ mode: 'bge-m3' });
    useAsync = true;
    if (!tokenCounterLogShown) {
      process.stderr.write('[chunk] token counter: bge-m3 tokenizer\n');
      tokenCounterLogShown = true;
    }
  }

  // ── Skeleton-first path — mandatory for Markdown. Skeleton-first chunking
  // is the Semidex architecture, not an optional mode: every real .md file
  // parses through the AST skeleton pipeline unconditionally. Lazy imports
  // keep remark out of the non-Markdown paths below, which still use the
  // legacy chunker (see the scope note at each of those branches).
  if (ext === '.md') {
    const [skeletonMod, chunkMod, warnMod, indexMod] = await Promise.all([
      import('./skeleton.js'),
      import('./skeleton-chunk.js'),
      import('../skeleton-warnings.js'),
      import('./skeleton-index.js'),
    ]);
    const raw = readFileSync(filePath, 'utf8');
    const skel = skeletonMod.parseSkeleton(raw, { sourceFile });
    const events = skeletonMod.collectSkeletonWarnings(skel, {
      collection: process.env.COLLECTION ?? '', sourceFile,
    });
    for (const e of events) warnMod.logSkeletonWarning(e);
    // Tasks 4+6 (impl spec §11): inspect artifact + nav points for upsert.
    // The point_kind search filter is live (task 5), so nav upsert is allowed.
    const { navPoints, json } = indexMod.buildFileSkeleton(skel, { sourceFile });
    indexMod.writeFileSkeletonArtifact(json, {
      collection: process.env.COLLECTION ?? '', sourceFile,
    });
    // Wikilinks parity with the legacy path (audit finding 2026-06-10):
    // legacy chunkFile() extracts [[wikilinks]]; the skeleton path must too.
    const { chunks, entityRawPoints } = await chunkMod.chunkFromSkeleton(skel, { sourceFile, links: parseWikilinks(raw), budget });
    return { chunks, navPoints, entityRawPoints };
  }

  // PDF: deliberately still routed through the legacy chunker below, even
  // when pdf2md recovers heading structure and rewrites to a synthetic .md
  // path — this is a documented scope boundary (no synthetic-skeleton-root
  // representation exists for non-Markdown input), not an oversight or
  // leftover legacy branch. Only real .md files are mandatory-skeleton.
  if (ext === '.pdf') {
    const data = readFileSync(filePath);
    let md = null;
    try {
      md = await pdf2md(data);
    } catch { /* fall through to plain-text */ }

    const hasStructure = hasPdfStructure(md);
    if (hasStructure) {
      const clean = md.replace(/<!-- PAGE_BREAK -->/g, '\n').replace(/\n{3,}/g, '\n\n');
      const mdPath = filePath.replace(/\.pdf$/i, '.md');
      const chunks = await (useAsync
        ? chunkFileAsync(mdPath, clean, sourceFile, countFn, budget)
        : chunkFile(mdPath, clean, sourceFile));
      return { chunks, navPoints: [], entityRawPoints: [] };
    }

    console.warn(`  [chunk] pdf2md produced no structure for ${filePath}, falling back to plain-text`);
    const parser = new PDFParse({ url: filePath });
    try {
      const { text } = await parser.getText();
      const chunks = await chunkExtractedTextForBudget(text, sourceFile, countFn, budget, useAsync, { stripPageMarkers: true });
      return { chunks, navPoints: [], entityRawPoints: [] };
    } finally {
      await parser.destroy();
    }
  }

  // Pandoc-converted formats (.docx/.odt/.rtf/.epub/.html/.htm): same scope
  // boundary as PDF above — routed through the legacy chunker, not the
  // skeleton pipeline, even though pandoc's output is itself Markdown text.
  if (PANDOC_FORMATS.has(ext)) {
    let stdout;
    try {
      // windowsHide: true (no-op on non-Windows) — this runs once per
      // .docx/.odt/.rtf/.epub/.html/.htm file in a job, inside the already-
      // windowsHide'd indexer child process (registry.js). A child process
      // spawned from a hidden parent still gets its own console window on
      // Windows unless it's also told to hide it — without this, indexing
      // a folder with several such files flashed one console per file.
      ({ stdout } = await execFileAsync('pandoc', [filePath, '-t', 'markdown', '--wrap=none'], {
        maxBuffer: 50 * 1024 * 1024, windowsHide: true,
      }));
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error(`pandoc is not installed or not on PATH — required to index ${ext} files. Install from https://pandoc.org/installing.html`);
      throw err;
    }
    const mdPath = filePath.replace(/\.[^.]+$/, '.md');
    const pandocText = stdout.replace(/\r\n?/g, '\n');
    const chunks = await (useAsync
      ? chunkFileAsync(mdPath, pandocText, sourceFile, countFn, budget)
      : chunkFile(mdPath, pandocText, sourceFile));
    return { chunks, navPoints: [], entityRawPoints: [] };
  }

  // Plain text / any other extension: same scope boundary — legacy
  // sentence-based chunking, not skeleton. See the .pdf branch's comment
  // above for why this is deliberate, not deferred cleanup.
  const raw = readFileSync(filePath, 'utf8');
  const chunks = await (useAsync
    ? chunkFileAsync(filePath, raw, sourceFile, countFn, budget)
    : chunkFile(filePath, raw, sourceFile));
  return { chunks, navPoints: [], entityRawPoints: [] };
}
