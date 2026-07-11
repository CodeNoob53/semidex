// ── shared structural entity renderer (Phase 3D / Phase 3T) ────────────────
// Renders structural chunks (table/code_block) as the document objects they
// actually represent — a real HTML table, highlighted code — with a
// Rendered/Raw switch that always falls back to byte-exact raw text on any
// parse/highlight failure. search.js and file-view.js both call
// renderChunkContent() instead of each owning their own table/code branches,
// so presentation stays identical between search results, file view, and
// section view.
//
// Explicitly NOT in scope here: document stitching, placeholder resolution,
// Ask API, image rendering, full-node retrieval via /node — this module only
// ever reads chunk.rawContent/chunk.text/chunk.lang, already present on the
// Chunk object handed to it. No network calls happen in this file.
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import shell from 'highlight.js/lib/languages/shell';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import markdown from 'highlight.js/lib/languages/markdown';
import java from 'highlight.js/lib/languages/java';
import csharp from 'highlight.js/lib/languages/csharp';
import cpp from 'highlight.js/lib/languages/cpp';
import c from 'highlight.js/lib/languages/c';

// Curated grammar set only — never the full highlight.js/lib/common or
// auto-registered "all languages" bundle, which would balloon the shipped JS
// bundle with dozens of grammars this admin UI never needs. Each entry name
// is a highlight.js canonical language id; ALIASES below maps common
// alternate spellings (chunk.lang values from fenced-code info strings, e.g.
// "```js") onto these same ids.
const REGISTRY = {
  javascript, typescript, python, bash, shell, json, yaml, sql,
  xml, css, markdown, java, csharp, cpp, c,
};
for (const [name, grammar] of Object.entries(REGISTRY)) {
  hljs.registerLanguage(name, grammar);
}

const ALIASES = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
  py: 'python',
  sh: 'bash', shell: 'shell', zsh: 'bash', console: 'bash',
  yml: 'yaml',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  cs: 'csharp',
  'c++': 'cpp', cc: 'cpp', hpp: 'cpp',
  h: 'c',
  md: 'markdown',
};

// Resolves a fenced-code-block `lang` value to a REGISTERED highlight.js
// language id, or null if it doesn't map to anything in the curated set.
// Never passes the raw, untrusted `lang` string into hljs itself — only ever
// this module's own fixed REGISTRY/ALIASES keys, so a malicious `lang` value
// (e.g. a prototype-pollution-style key or an attempt to reference an
// unregistered/未 grammar) can never become a dynamic import or a class name
// hljs wasn't told to trust.
function resolveLanguage(lang) {
  if (!lang || typeof lang !== 'string') return null;
  const normalized = lang.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(REGISTRY, normalized) && hljs.getLanguage(normalized)) return normalized;
  if (Object.prototype.hasOwnProperty.call(ALIASES, normalized)) {
    const resolved = ALIASES[normalized];
    return hljs.getLanguage(resolved) ? resolved : null;
  }
  return null;
}

const AUTODETECT_SUBSET = Object.keys(REGISTRY);

const gfmProcessor = unified().use(remarkParse).use(remarkGfm);

export const STRUCTURAL_RENDER_TYPES = new Set(['table', 'code_block']);

// Strips one leading and one trailing fenced-code delimiter line (``` or ~~~,
// optionally followed by an info string) from raw fenced-code source, if
// present — code_block chunks store the fence as part of rawContent (the
// indexer's skeleton phase captures the whole node verbatim), but the
// highlighted/rendered view should show only the code itself.
function stripCodeFence(raw) {
  const lines = String(raw ?? '').split('\n');
  if (lines.length >= 2 && /^(`{3,}|~{3,})/.test(lines[0].trim())) {
    const fenceChar = lines[0].trim()[0];
    const fenceLen = lines[0].trim().match(new RegExp(`^${fenceChar}+`))[0].length;
    const closeRe = new RegExp(`^${fenceChar}{${fenceLen},}\\s*$`);
    let end = lines.length;
    for (let i = lines.length - 1; i >= 1; i--) {
      if (closeRe.test(lines[i].trim())) { end = i; break; }
    }
    return lines.slice(1, end).join('\n');
  }
  return raw ?? '';
}

// Recursively concatenates the plain-text content of an inline mdast node
// (text/inlineCode/emphasis/strong/etc.) — deliberately never emits markup
// for any inline construct (a bold/italic/link/image inside a table cell
// renders as its plain text only), matching requirement 3's "plain text is
// the MVP; do not render arbitrary markdown/HTML inside cells."
function inlineText(node) {
  if (!node) return '';
  if (typeof node.value === 'string') return node.value;
  if (Array.isArray(node.children)) return node.children.map(inlineText).join('');
  return '';
}

function parseGfmTable(raw) {
  const tree = gfmProcessor.parse(String(raw ?? ''));
  const table = tree.children.find(n => n.type === 'table');
  if (!table) return null;
  const align = Array.isArray(table.align) ? table.align : [];
  const rows = (table.children ?? []).map(row =>
    (row.children ?? []).map(cell => inlineText(cell)));
  if (!rows.length) return null;
  return { align, rows };
}

// Builds a real <table>/<thead>/<tbody> from a parsed { align, rows } shape,
// via DOM APIs + textContent only — no cell value is ever assigned through
// innerHTML, so a cell containing e.g. "<img src=x onerror=...>" (plain text
// at this point, since inlineText() above never emitted markup) renders as
// inert text, never a live element.
function buildTableElement(doc, { align, rows }) {
  const wrapper = doc.createElement('div');
  wrapper.className = 'structural-table-wrapper';
  const table = doc.createElement('table');
  table.className = 'structural-table';

  const [headerRow, ...bodyRows] = rows;
  const thead = doc.createElement('thead');
  const headerTr = doc.createElement('tr');
  headerRow.forEach((text, i) => {
    const th = doc.createElement('th');
    th.textContent = text;
    const a = align[i];
    if (a) th.style.textAlign = a;
    headerTr.appendChild(th);
  });
  thead.appendChild(headerTr);

  const tbody = doc.createElement('tbody');
  for (const row of bodyRows) {
    const tr = doc.createElement('tr');
    row.forEach((text, i) => {
      const td = doc.createElement('td');
      td.textContent = text;
      const a = align[i];
      if (a) td.style.textAlign = a;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }

  table.appendChild(thead);
  table.appendChild(tbody);
  wrapper.appendChild(table);
  return wrapper;
}

// Highlights `code` against a single resolved language id. Returns
// { html, language, guessed } or null on failure — the returned `html` is
// always highlight.js's OWN generated markup for this exact plain-text
// input (never the raw lang/code string interpolated directly), so it's safe
// to assign via innerHTML at the call site.
function highlightCode(code, explicitLang) {
  const resolved = resolveLanguage(explicitLang);
  if (resolved) {
    try {
      const result = hljs.highlight(code, { language: resolved, ignoreIllegals: true });
      return { html: result.value, language: resolved, guessed: false };
    } catch {
      // fall through to autodetect/plaintext below
    }
  }
  try {
    const auto = hljs.highlightAuto(code, AUTODETECT_SUBSET);
    if (auto.language && auto.relevance > 0) {
      return { html: auto.value, language: auto.language, guessed: true };
    }
  } catch {
    // fall through to plaintext
  }
  return null;
}

function buildCodeElement(doc, code, explicitLang) {
  const wrapper = doc.createElement('div');
  wrapper.className = 'structural-code-wrapper';

  const badge = doc.createElement('span');
  badge.className = 'structural-code-lang-badge';

  const pre = doc.createElement('pre');
  const codeEl = doc.createElement('code');

  const highlighted = highlightCode(code, explicitLang);
  if (highlighted) {
    codeEl.className = `hljs language-${highlighted.language}`;
    // highlighted.html was generated by hljs.highlight()/highlightAuto()
    // itself from the plain `code` string above — never a direct
    // interpolation of user-provided lang/code into HTML.
    codeEl.innerHTML = highlighted.html;
    badge.textContent = highlighted.guessed ? `guessed: ${highlighted.language}` : highlighted.language;
    badge.classList.add(highlighted.guessed ? 'structural-code-lang-guessed' : 'structural-code-lang-explicit');
  } else {
    codeEl.textContent = code;
    badge.textContent = 'plaintext';
    badge.classList.add('structural-code-lang-guessed');
  }

  pre.appendChild(codeEl);
  wrapper.appendChild(badge);
  wrapper.appendChild(pre);
  return { wrapper, ok: Boolean(highlighted) };
}

// Builds the compact segmented Rendered/Raw control. `onSwitch` is called
// with 'rendered' | 'raw' — no network request happens on either branch,
// both are pure DOM swaps between two already-built subtrees.
function buildToggle(doc, initialMode, onSwitch) {
  const toggle = doc.createElement('div');
  toggle.className = 'structural-toggle';
  toggle.setAttribute('role', 'group');
  toggle.setAttribute('aria-label', 'Rendered or raw view');

  const renderedBtn = doc.createElement('button');
  renderedBtn.type = 'button';
  renderedBtn.className = 'structural-toggle-btn';
  renderedBtn.textContent = 'Rendered';

  const rawBtn = doc.createElement('button');
  rawBtn.type = 'button';
  rawBtn.className = 'structural-toggle-btn';
  rawBtn.textContent = 'Raw';

  function setActive(mode) {
    renderedBtn.classList.toggle('active', mode === 'rendered');
    renderedBtn.setAttribute('aria-pressed', String(mode === 'rendered'));
    rawBtn.classList.toggle('active', mode === 'raw');
    rawBtn.setAttribute('aria-pressed', String(mode === 'raw'));
  }
  setActive(initialMode);

  renderedBtn.addEventListener('click', () => { setActive('rendered'); onSwitch('rendered'); });
  rawBtn.addEventListener('click', () => { setActive('raw'); onSwitch('raw'); });

  toggle.appendChild(renderedBtn);
  toggle.appendChild(rawBtn);
  return toggle;
}

// Renders `chunk`'s content into `container` (an existing <pre class=
// "chunk-text"> or equivalent element — this function may replace it in
// place with a richer subtree, it does not wrap it in a new decorative
// card). Prose and any node type outside STRUCTURAL_RENDER_TYPES render
// exactly as before: plain text via textContent, no toggle control.
//
// const raw = chunk.rawContent ?? chunk.text ?? '' is the only source of
// truth for content — this module never fetches /node or calls
// qdrant_get_node; whatever the chunk object already carries is all it uses.
export function renderChunkContent(container, chunk, options = {}) {
  const raw = chunk?.rawContent ?? chunk?.text ?? '';
  const nodeType = chunk?.nodeType;
  const doc = container.ownerDocument ?? globalThis.document;

  if (!STRUCTURAL_RENDER_TYPES.has(nodeType)) {
    container.textContent = raw;
    return;
  }

  let rendered = null;
  let renderedOk = false;

  if (nodeType === 'table') {
    try {
      const parsed = parseGfmTable(raw);
      if (parsed) {
        rendered = buildTableElement(doc, parsed);
        renderedOk = true;
      }
    } catch {
      renderedOk = false;
    }
  } else if (nodeType === 'code_block') {
    const code = stripCodeFence(raw);
    const built = buildCodeElement(doc, code, chunk?.lang);
    rendered = built.wrapper;
    // Code always has SOME rendering (plaintext fallback inside
    // buildCodeElement itself) — "renderedOk" here means "highlighting
    // succeeded", not "something is on screen"; either way rendered mode is
    // safe to show by default, since even the plaintext fallback is a valid
    // Rendered-mode view, just without syntax colors.
    renderedOk = true;
  }

  const contentSlot = doc.createElement('div');
  contentSlot.className = 'structural-content-slot';

  const rawPre = doc.createElement('pre');
  rawPre.className = 'structural-raw chunk-text';
  rawPre.textContent = raw;

  function showRendered() {
    contentSlot.replaceChildren(rendered);
  }
  function showRaw() {
    contentSlot.replaceChildren(rawPre);
  }

  const root = doc.createElement('div');
  root.className = 'structural-render-root';

  if (rendered) {
    const toggle = buildToggle(doc, renderedOk ? 'rendered' : 'raw', (mode) => {
      if (mode === 'rendered') showRendered(); else showRaw();
    });
    root.appendChild(toggle);
    root.appendChild(contentSlot);
    if (renderedOk) showRendered(); else showRaw();
  } else {
    // Parse failure (table): no toggle at all, raw only — "fall back to raw
    // mode (no throw) on parse failure" per requirement 3.
    root.appendChild(rawPre);
  }

  container.replaceWith(root);
  root.dataset.forNodeType = nodeType;
}

export { resolveLanguage as __resolveLanguageForTests, stripCodeFence as __stripCodeFenceForTests, parseGfmTable as __parseGfmTableForTests };
