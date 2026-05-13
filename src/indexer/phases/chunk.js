import { readFileSync } from 'fs';
import { extname } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';

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
const OVERLAP_SENTENCES = envInt('OVERLAP_SENTENCES',  2, 0, 100);

const countTokens = (text) => Math.ceil(text.length / 4);

function splitSentences(text) {
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
// No overlap — overlap is the responsibility of chunkBySentences used by chunkSections.
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

function chunkBySentences(text, prevSentences = []) {
  const sentences = splitSentences(text);
  const chunks = [];
  const overlap = OVERLAP_SENTENCES > 0 ? prevSentences.slice(-OVERLAP_SENTENCES) : [];
  let current = [...overlap];
  let pending = 0;

  for (const sentence of sentences) {
    current.push(sentence);
    pending++;
    if (countTokens(current.join(' ')) >= MAX_TOKENS) {
      chunks.push(current.join(' '));
      current = OVERLAP_SENTENCES > 0 ? current.slice(-OVERLAP_SENTENCES) : [];
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

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3}) (.+)/);
    if (headingMatch) {
      const headingText = headingMatch[2].replace(/\*\*/g, '').trim();
      if (isStructuralHeading(headingText)) {
        if (currentLines.length) {
          sections.push({ heading: currentHeading, text: currentLines.join('\n').trim() });
        }
        currentHeading = headingText;
        currentLines = [];
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
    if (!section.heading && (!section.text || countTokens(section.text) < MIN_TOKENS)) continue;
    const text = section.text || `(empty section: ${section.heading})`;

    // prevSentences resets per section so overlap never crosses heading boundaries.
    if (countTokens(text) <= MAX_TOKENS) {
      chunks.push({ text, section: section.heading, source_file: sourceFile, meta, links, needsBoundaryCheck: false });
    } else {
      const subChunks = chunkBySentences(text, []);
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
  } else if (ext === '.pdf') {
    const subChunks = recursiveChunkText(text, { stripPageMarkers: true });
    subChunks.forEach((t, i) => {
      chunks.push({ text: t, section: '', source_file: sourceFile, meta: {}, links: [], needsBoundaryCheck: i > 0 });
    });
  } else {
    const subChunks = chunkBySentences(text);
    subChunks.forEach((t, i) => {
      chunks.push({ text: t, section: '', source_file: sourceFile, meta: {}, links: [], needsBoundaryCheck: i > 0 });
    });
  }

  return chunks.map((c, i) => ({ ...c, chunkIndex: i, totalChunks: chunks.length }));
}

const PANDOC_FORMATS = new Set(['.docx', '.odt', '.rtf', '.epub', '.html', '.htm']);

export async function chunkFileFromPath(filePath, sourceFile) {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.pdf') {
    const parser = new PDFParse({ url: filePath });
    try {
      const { text } = await parser.getText();
      return chunkFile(filePath, text, sourceFile);
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
