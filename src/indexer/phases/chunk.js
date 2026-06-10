import { readFileSync } from 'fs';
import { extname } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import pdf2md from '@opendocsg/pdf2md';
import { heuristicTokenCount, getTokenCounter, resolveTokenCountMode } from '../../core/token-count.js';
import { envInt } from '../../core/env.js';

const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

const execFileAsync = promisify(execFile);

const MAX_TOKENS             = envInt('MAX_CHUNK_TOKENS',    512, 1, 100000, '[chunk] ');
const MIN_TOKENS             = envInt('MIN_CHUNK_TOKENS',    160, 0, 100000, '[chunk] ');
export const OVERLAP_SENTENCES = envInt('OVERLAP_SENTENCES',   2, 0, 100,    '[chunk] ');
const CHUNK_OVERLAP_TOKENS   = envInt('CHUNK_OVERLAP_TOKENS',  80, 0, 100000, '[chunk] ');

export function getChunkingConfig() {
  return { maxTokens: MAX_TOKENS, minTokens: MIN_TOKENS, overlapTokens: CHUNK_OVERLAP_TOKENS, overlapSentences: OVERLAP_SENTENCES };
}

// Sync heuristic used by the legacy sync chunking path. Aliased from
// token-count.js so both paths share the same implementation.
const countTokens = heuristicTokenCount;

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
  let src = text;
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

async function _splitLevelAsync(text, levels, countFn) {
  if (await countFn(text) <= MAX_TOKENS) return [text];
  if (levels.length === 0) return [text];

  const [level, ...rest] = levels;
  const units = level.split(text);
  if (units.length <= 1) return _splitLevelAsync(text, rest, countFn);

  const chunks = [];
  let current = [];
  let currentTokens = 0;

  for (const unit of units) {
    const ut = await countFn(unit);
    if (ut > MAX_TOKENS) {
      if (current.length > 0) {
        chunks.push(current.join(level.join));
        current = [];
        currentTokens = 0;
      }
      chunks.push(...await _splitLevelAsync(unit, rest, countFn));
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

async function recursiveChunkTextAsync(text, countFn, { stripPageMarkers = false } = {}) {
  let src = text;
  if (stripPageMarkers) src = src.replace(/--\s*\d+\s*of\s*\d+\s*--/g, '');
  src = src.replace(/\n{3,}/g, '\n\n').trim();
  if (!src) return [];
  return _splitLevelAsync(src, LEVELS, countFn);
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

/**
 * Async variant of chunkFile. Accepts a countFn for token-aware splitting.
 * Used by the production chunkFileFromPath real-tokenizer mode.
 * The sync chunkFile() is not modified.
 *
 * @param {string} filePath
 * @param {string} text
 * @param {string} sourceFile
 * @param {(text: string) => Promise<number>} countFn
 */
export async function chunkFileAsync(filePath, text, sourceFile, countFn = heuristicTokenCount) {
  const ext = extname(filePath).toLowerCase();
  const chunks = [];

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

const PANDOC_FORMATS = new Set(['.docx', '.odt', '.rtf', '.epub', '.html', '.htm']);
let tokenCounterLogShown = false;

// Returns true if the pdf2md Markdown output has enough heading lines to use the structured path.
export function hasPdfStructure(md) {
  return Boolean(md && (md.match(/^#{1,6} /gm) || []).length >= 3);
}

export async function chunkFileFromPath(filePath, sourceFile) {
  const ext = extname(filePath).toLowerCase();

  // Real BGE-M3 tokenization is the production default. TOKEN_COUNT=heuristic
  // is an explicit compatibility/performance fallback.
  const tokenCountMode = resolveTokenCountMode();
  let countFn = null;
  let useAsync = false;

  if (tokenCountMode === 'bge-m3') {
    countFn = await getTokenCounter({ mode: 'bge-m3' });
    useAsync = true;
    if (!tokenCounterLogShown) {
      process.stderr.write('[chunk] token counter: bge-m3 tokenizer\n');
      tokenCounterLogShown = true;
    }
  }

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
      return useAsync
        ? chunkFileAsync(mdPath, clean, sourceFile, countFn)
        : chunkFile(mdPath, clean, sourceFile);
    }

    console.warn(`  [chunk] pdf2md produced no structure for ${filePath}, falling back to plain-text`);
    const parser = new PDFParse({ url: filePath });
    try {
      const { text } = await parser.getText();
      if (useAsync) {
        const subChunks = await recursiveChunkTextAsync(text, countFn, { stripPageMarkers: true });
        const chunks = subChunks.map((t, i) => ({
          text: t, section: '', source_file: sourceFile, meta: {}, links: [],
          _split_boundary: i > 0, chunkIndex: i, totalChunks: subChunks.length,
        }));
        return finalizeChunksAsync(chunks, countFn);
      }
      const subChunks = recursiveChunkText(text, { stripPageMarkers: true });
      const chunks = subChunks.map((t, i) => ({
        text: t, section: '', source_file: sourceFile, meta: {}, links: [],
        _split_boundary: i > 0, chunkIndex: i, totalChunks: subChunks.length,
      }));
      return finalizeChunks(chunks);
    } finally {
      await parser.destroy();
    }
  }

  if (PANDOC_FORMATS.has(ext)) {
    let stdout;
    try {
      ({ stdout } = await execFileAsync('pandoc', [filePath, '-t', 'markdown', '--wrap=none'], { maxBuffer: 50 * 1024 * 1024 }));
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error(`pandoc is not installed or not on PATH — required to index ${ext} files. Install from https://pandoc.org/installing.html`);
      throw err;
    }
    const mdPath = filePath.replace(/\.[^.]+$/, '.md');
    const pandocText = stdout.replace(/\r\n?/g, '\n');
    return useAsync
      ? chunkFileAsync(mdPath, pandocText, sourceFile, countFn)
      : chunkFile(mdPath, pandocText, sourceFile);
  }

  const raw = readFileSync(filePath, 'utf8');
  const text = raw.replace(/\r\n?/g, '\n');
  return useAsync
    ? chunkFileAsync(filePath, text, sourceFile, countFn)
    : chunkFile(filePath, text, sourceFile);
}
