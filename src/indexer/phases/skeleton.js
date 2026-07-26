// parseSkeleton() — Markdown → flat ordered array of typed structural nodes.
// Contract: docs/design/skeleton-first-chunking-impl-spec.md §3.1, design §5.
//
// Scope (impl spec §11 task 1): parsing + positioning ONLY. No policy
// decisions (node-policy.js), no chunking, no LLM, no Qdrant. Wired into
// chunkFileFromPath() unconditionally for Markdown — see chunk.js.
//
// Hard rules implemented here:
//   - One AST, built once (design §2). remark-parse + remark-gfm +
//     remark-frontmatter; the legacy regex parseMarkdown() is not touched.
//   - rawContent is ALWAYS an offset-slice of the original markdown
//     (impl spec §3.1) — never reconstructed from the AST, so tables keep
//     their alignment and code keeps its exact indentation.
//   - Nothing is lost: any unrecognized block becomes nodeType "unknown" with
//     a warning attached; a per-node failure indexes the raw text as a
//     paragraph-like unknown and continues (design §5.2). The caller decides
//     whether to forward warnings to the JSONL writer.
//   - Tables and code blocks are first-class whole nodes; lists/blockquotes
//     are kept whole; checklists (GFM task lists) are distinguished from
//     prose lists; image-only paragraphs become image nodes.

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ['yaml']);

// mdast types with a direct mapping (design §5.1). Everything else → unknown.
const DIRECT_TYPES = new Set([
  'heading', 'paragraph', 'table', 'code', 'list', 'blockquote', 'yaml', 'thematicBreak',
]);

// ── helpers ───────────────────────────────────────────────────────────────────

// Minimal mdast → plain text (no extra dependency).
function mdastToText(node) {
  if (node == null) return '';
  if (typeof node.value === 'string') return node.value;
  if (Array.isArray(node.children)) return node.children.map(mdastToText).join('');
  return '';
}

function slugify(text) {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'section';
}

function sliceRaw(markdown, node) {
  const s = node?.position?.start?.offset;
  const e = node?.position?.end?.offset;
  return (Number.isInteger(s) && Number.isInteger(e)) ? markdown.slice(s, e) : '';
}

function positionOf(node, order) {
  return {
    startLine: node?.position?.start?.line ?? null,
    endLine:   node?.position?.end?.line ?? null,
    order,
  };
}

// GFM task list detection: any listItem with a boolean `checked`.
function isChecklist(listNode) {
  return Array.isArray(listNode.children) &&
    listNode.children.some(item => typeof item.checked === 'boolean');
}

// Paragraph whose only meaningful children are images → image node (design §10).
function imageOnlyParagraph(par) {
  const kids = par.children ?? [];
  if (!kids.length) return null;
  const images = kids.filter(c => c.type === 'image' || c.type === 'imageReference');
  if (!images.length) return null;
  const rest = kids.filter(c =>
    c.type !== 'image' && c.type !== 'imageReference' &&
    !(c.type === 'text' && !c.value.trim()));
  return rest.length === 0 ? images : null;
}

// Frontmatter values: same simple "key: value" lines the legacy parser reads.
function parseFrontmatterMeta(yamlRaw) {
  const meta = {};
  for (const line of String(yamlRaw ?? '').split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) {
      const val = rest.join(':').trim().replace(/^\[|\]$/g, '');
      meta[key.trim()] = val.includes(',') ? val.split(',').map(s => s.trim()) : val;
    }
  }
  return meta;
}

// ── parseSkeleton ─────────────────────────────────────────────────────────────

/**
 * Parse Markdown into a flat, document-ordered array of structural nodes.
 *
 * @param {string} markdown
 * @param {{ sourceFile?: string }} [ctx]
 * @returns {SkeletonNode[]} — see impl spec §3.1 for the node shape.
 *
 * SkeletonNode:
 *   { mdastType, nodeType, rawContent, text, lang?, meta?,
 *     headingPath: string[], structuralPath, ordinalWithinParent,
 *     parentStructuralPath, position: {startLine,endLine,order}, warning }
 */
export function parseSkeleton(markdown, ctx = {}) {
  const sourceFile = ctx.sourceFile ?? '';
  const src = String(markdown ?? '');
  const tree = processor.parse(src);

  const nodes = [];
  let order = 0;

  // Heading state: stack of { depth, text, slug }.
  const headingStack = [];
  const headingPath = () => headingStack.map(h => h.text);
  const slugPath    = () => headingStack.map(h => h.slug).join('/');

  // ordinalWithinParent: 1-based, counted per (parentStructuralPath, nodeType).
  const ordinals = new Map();
  const nextOrdinal = (parentPath, nodeType) => {
    const key = `${parentPath}\x00${nodeType}`;
    const n = (ordinals.get(key) ?? 0) + 1;
    ordinals.set(key, n);
    return n;
  };

  const emit = (mdNode, nodeType, extra = {}) => {
    const parentPath = slugPath();
    const node = {
      mdastType: mdNode.type,
      nodeType,
      rawContent: sliceRaw(src, mdNode),
      text: extra.text ?? mdastToText(mdNode),
      headingPath: headingPath(),
      structuralPath: parentPath ? `${parentPath}/${nodeType}` : nodeType,
      ordinalWithinParent: nextOrdinal(parentPath, nodeType),
      parentStructuralPath: parentPath,
      position: positionOf(mdNode, order++),
      warning: extra.warning ?? null,
      ...(extra.lang !== undefined ? { lang: extra.lang } : {}),
      ...(extra.meta !== undefined ? { meta: extra.meta } : {}),
    };
    nodes.push(node);
    return node;
  };

  for (const child of tree.children ?? []) {
    try {
      switch (child.type) {
        case 'yaml': {
          emit(child, 'frontmatter', { text: '', meta: parseFrontmatterMeta(child.value) });
          break;
        }

        case 'heading': {
          const text = mdastToText(child).replace(/\*\*/g, '').trim();
          const depth = child.depth ?? 1;
          // Pop headings at the same or deeper level, then open this section.
          while (headingStack.length && headingStack.at(-1).depth >= depth) headingStack.pop();
          headingStack.push({ depth, text, slug: slugify(text) });
          // The section node itself: headingPath INCLUDES the new heading;
          // structuralPath is the section's own slug path (no "/section" suffix).
          const parentPath = headingStack.slice(0, -1).map(h => h.slug).join('/');
          nodes.push({
            mdastType: 'heading',
            nodeType: 'section',
            rawContent: sliceRaw(src, child),
            text,
            headingPath: headingPath(),
            structuralPath: slugPath(),
            ordinalWithinParent: nextOrdinal(parentPath, 'section'),
            parentStructuralPath: parentPath,
            position: positionOf(child, order++),
            warning: null,
          });
          break;
        }

        case 'paragraph': {
          const images = imageOnlyParagraph(child);
          if (images) {
            emit(child, 'image', {
              text: images.map(i => i.alt ?? i.title ?? i.url ?? '').filter(Boolean).join(' '),
              meta: { images: images.map(i => ({ url: i.url ?? null, alt: i.alt ?? null, title: i.title ?? null })) },
            });
          } else {
            emit(child, 'paragraph');
          }
          break;
        }

        case 'table': {
          emit(child, 'table');
          break;
        }

        case 'code': {
          emit(child, 'code_block', { text: child.value ?? '', lang: child.lang ?? null });
          break;
        }

        case 'list': {
          emit(child, isChecklist(child) ? 'checklist' : 'list');
          break;
        }

        case 'blockquote': {
          emit(child, 'blockquote');
          break;
        }

        case 'thematicBreak': {
          // Recognized separator, not content — dropped by design (§5.1).
          break;
        }

        default: {
          // Unknown block (html, math, definition, footnote, ...) — never lose
          // the text: index as unknown (paragraph policy) + attach a warning.
          emit(child, 'unknown', {
            warning: {
              kind: 'unknown_node',
              reason: `no mapping for mdast type '${child.type}'`,
            },
          });
        }
      }
    } catch (err) {
      // Per-node failure must not kill the file (design §5.2): keep the raw
      // text as an unknown node and continue.
      nodes.push({
        mdastType: child?.type ?? '(unknown)',
        nodeType: 'unknown',
        rawContent: sliceRaw(src, child),
        text: sliceRaw(src, child),
        headingPath: headingPath(),
        structuralPath: slugPath() ? `${slugPath()}/unknown` : 'unknown',
        ordinalWithinParent: nextOrdinal(slugPath(), 'unknown'),
        parentStructuralPath: slugPath(),
        position: positionOf(child, order++),
        warning: { kind: 'parse_error', reason: String(err?.message ?? err) },
      });
    }
  }

  return nodes;
}

/**
 * Collect warning events from parsed nodes, shaped for logSkeletonWarning().
 * Pure — the caller decides whether/where to write them.
 *
 * @param {SkeletonNode[]} nodes
 * @param {{ collection?: string, sourceFile?: string }} [ctx]
 */
export function collectSkeletonWarnings(nodes, ctx = {}) {
  const events = [];
  for (const n of nodes) {
    if (!n.warning) continue;
    events.push({
      collection:  ctx.collection ?? '',
      source_file: ctx.sourceFile ?? '',
      kind:        n.warning.kind,
      mdast_type:  n.mdastType,
      node_type:   n.nodeType,
      position:    { start_line: n.position?.startLine ?? null, end_line: n.position?.endLine ?? null },
      reason:      n.warning.reason,
      raw_excerpt: n.rawContent,
      chunking_model: 'skeleton-v1',
    });
  }
  return events;
}
