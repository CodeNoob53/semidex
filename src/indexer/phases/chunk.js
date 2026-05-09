import { readFileSync } from 'fs';
import { extname } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

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
  const terminated = text.match(/[^.!?\n]+[.!?\n]+/g)?.map(s => s.trim()).filter(Boolean) ?? [];
  // Preserve any trailing text that lacks a sentence-ending punctuation.
  const joined = terminated.join('');
  const tail = text.slice(joined.length).trim();
  if (tail) terminated.push(tail);
  return terminated.length ? terminated : [text];
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

function chunkBySentences(text, prevSentences = []) {
  const sentences = splitSentences(text);
  const chunks = [];
  const overlap = OVERLAP_SENTENCES > 0 ? prevSentences.slice(-OVERLAP_SENTENCES) : [];
  let current = [...overlap];

  for (const sentence of sentences) {
    current.push(sentence);
    if (countTokens(current.join(' ')) >= MAX_TOKENS) {
      chunks.push(current.join(' '));
      current = OVERLAP_SENTENCES > 0 ? current.slice(-OVERLAP_SENTENCES) : [];
    }
  }
  // Always flush the remaining sentences, even if <= OVERLAP_SENTENCES in count.
  // Only skip if current is identical to the last emitted chunk's tail (OVERLAP_SENTENCES=0 guard).
  if (current.length > 0) {
    const candidate = current.join(' ');
    if (chunks.length === 0 || candidate !== chunks.at(-1)) chunks.push(candidate);
  }
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
    const buf = readFileSync(filePath);
    const { text } = await pdfParse(buf);
    return chunkFile(filePath, text, sourceFile);
  }

  if (PANDOC_FORMATS.has(ext)) {
    const { stdout } = await execFileAsync('pandoc', [filePath, '-t', 'markdown', '--wrap=none']);
    // Pass a synthetic .md path so chunkFile runs parseMarkdown on the pandoc output.
    return chunkFile(filePath.replace(/\.[^.]+$/, '.md'), stdout, sourceFile);
  }

  const text = readFileSync(filePath, 'utf8');
  return chunkFile(filePath, text, sourceFile);
}
