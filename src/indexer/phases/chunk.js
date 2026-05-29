import { readFileSync } from 'fs';
import { extname } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import pdf2md from '@opendocsg/pdf2md';

const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

const execFileAsync = promisify(execFile);

function envInt(name, defaultVal, min, max) {
  const v = parseInt(process.env[name] ?? '');
  if (!Number.isFinite(v) || v < min || v > max) {
    if (process.env[name] !== undefined)
      console.warn(`[chunk] ${name}="${process.env[name]}" is invalid — using default ${defaultVal}`);
    return defaultVal;
  }
  return v;
}

const MAX_TOKENS       = envInt('MAX_CHUNK_TOKENS',  400, 1, 100000);
const MIN_TOKENS       = envInt('MIN_CHUNK_TOKENS',   30, 0, 100000);
export const OVERLAP_SENTENCES = envInt('OVERLAP_SENTENCES',  2, 0, 100);

const countTokens = (text) => Math.ceil(text.length / 4);

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
// No overlap here; indexing overlap is applied after merge/split boundary decisions.
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

  for (const section of sections) {
    // Skip heading-only sections: no text means no retrievable content.
    if (!section.text || !section.text.trim()) continue;
    if (!section.heading && countTokens(section.text) < MIN_TOKENS) continue;

    // Section chunks are split cleanly here. Overlap is added later, after
    // merge/split boundary decisions, so merge never duplicates overlap text.
    if (countTokens(section.text) <= MAX_TOKENS) {
      chunks.push({ text: section.text, section: section.heading, source_file: sourceFile, meta, links, needsBoundaryCheck: false });
    } else {
      const subChunks = chunkBySentences(section.text, []);
      subChunks.forEach((t, i) => {
        chunks.push({ text: t, section: section.heading, source_file: sourceFile, meta, links, needsBoundaryCheck: i > 0 });
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
      chunks.push({ text: t, section: '', source_file: sourceFile, meta: {}, links: [], needsBoundaryCheck: i > 0 });
    });
  }

  return chunks.map((c, i) => ({ ...c, chunkIndex: i, totalChunks: chunks.length }));
}

const PANDOC_FORMATS = new Set(['.docx', '.odt', '.rtf', '.epub', '.html', '.htm']);

// Returns true if the pdf2md Markdown output has enough heading lines to use the structured path.
export function hasPdfStructure(md) {
  return Boolean(md && (md.match(/^#{1,6} /gm) || []).length >= 3);
}

export async function chunkFileFromPath(filePath, sourceFile) {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.pdf') {
    const data = readFileSync(filePath);
    let md = null;
    try {
      md = await pdf2md(data);
    } catch { /* fall through to plain-text */ }

    const hasStructure = hasPdfStructure(md);
    if (hasStructure) {
      const clean = md.replace(/<!-- PAGE_BREAK -->/g, '\n').replace(/\n{3,}/g, '\n\n');
      return chunkFile(filePath.replace(/\.pdf$/i, '.md'), clean, sourceFile);
    }

    console.warn(`  [chunk] pdf2md produced no structure for ${filePath}, falling back to plain-text`);
    const parser = new PDFParse({ url: filePath });
    try {
      const { text } = await parser.getText();
      const subChunks = recursiveChunkText(text, { stripPageMarkers: true });
      return subChunks.map((t, i) => ({
        text: t, section: '', source_file: sourceFile, meta: {}, links: [],
        needsBoundaryCheck: i > 0, chunkIndex: i, totalChunks: subChunks.length,
      }));
    } finally {
      await parser.destroy();
    }
  }

  if (PANDOC_FORMATS.has(ext)) {
    const { stdout } = await execFileAsync('pandoc', [filePath, '-t', 'markdown', '--wrap=none']);
    // Pass a synthetic .md path so chunkFile runs parseMarkdown on the pandoc output.
    return chunkFile(filePath.replace(/\.[^.]+$/, '.md'), stdout, sourceFile);
  }

  const text = readFileSync(filePath, 'utf8');
  return chunkFile(filePath, text, sourceFile);
}
