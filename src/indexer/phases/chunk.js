import { readFileSync } from 'fs';
import { extname } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const MAX_TOKENS = parseInt(process.env.MAX_CHUNK_TOKENS || '400');
const MIN_TOKENS = parseInt(process.env.MIN_CHUNK_TOKENS || '30');
const OVERLAP_SENTENCES = parseInt(process.env.OVERLAP_SENTENCES || '2');

const countTokens = (text) => Math.ceil(text.length / 4);

const splitSentences = (text) =>
  text.match(/[^.!?\n]+[.!?\n]+/g)?.map(s => s.trim()).filter(Boolean) ?? [text];

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
  let current = [...prevSentences.slice(-OVERLAP_SENTENCES)];

  for (const sentence of sentences) {
    current.push(sentence);
    if (countTokens(current.join(' ')) >= MAX_TOKENS) {
      chunks.push(current.join(' '));
      current = current.slice(-OVERLAP_SENTENCES);
    }
  }
  if (current.length > OVERLAP_SENTENCES) chunks.push(current.join(' '));
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
  let prevSentences = [];

  for (const section of sections) {
    if (!section.heading && (!section.text || countTokens(section.text) < MIN_TOKENS)) continue;
    const text = section.text || `(empty section: ${section.heading})`;

    if (countTokens(text) <= MAX_TOKENS) {
      chunks.push({ text, section: section.heading, source_file: sourceFile, meta, links, needsBoundaryCheck: false });
      prevSentences = splitSentences(text);
    } else {
      const subChunks = chunkBySentences(text, prevSentences);
      subChunks.forEach((t, i) => {
        chunks.push({ text: t, section: section.heading, source_file: sourceFile, meta, links, needsBoundaryCheck: i > 0 });
      });
      prevSentences = splitSentences(subChunks.at(-1) || '');
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

export async function chunkFileFromPath(filePath, sourceFile) {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.docx') {
    const { stdout } = await execFileAsync('pandoc', [filePath, '-t', 'markdown', '--wrap=none']);
    return chunkFile(filePath, stdout, sourceFile);
  }

  const text = readFileSync(filePath, 'utf8');
  return chunkFile(filePath, text, sourceFile);
}
