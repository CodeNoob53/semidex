// chunkFromSkeleton() — skeleton nodes → chunk array, shape-compatible with
// legacy chunkFile(). Contract: impl spec §3.4, design §7/§11.
//
// Behavior:
//   - prose (chunk_text): consecutive prose nodes within one section are
//     accumulated and split by MAX_CHUNK_TOKENS via recursiveChunkText
//     (reused from chunk.js — not duplicated);
//   - tiny code (merge_with_parent): joins the prose stream inline as a
//     fenced snippet — searchable in the prose chunk, never its own point;
//   - table / code_block / checklist: ONE content node each, rawContent kept
//     whole; a placeholder line is appended to the surrounding prose stream
//     (design §11). Placeholders are never content (§7.3);
//   - section/file/collection/image/frontmatter: no retrieval output here
//     (nav layer is a later task); frontmatter contributes `meta`;
//   - every emitted chunk passes the isContentBearing gate — empty or
//     placeholder-only chunks are impossible by construction;
//   - chunkIndex / totalChunks assigned at the end (deleteTrailingChunks and
//     legacy MCP compatibility).
//
// node_id note: computed with collection='' at chunk time — the chunker does
// not know the collection (same as legacy). Cross-collection isolation for
// POINT ids stays in makePointId; node_id isolates by file + structure.

import { recursiveChunkText } from './chunk.js';
import { applyNodePolicy, isContentBearing, POINT_KINDS } from './node-policy.js';
import { makeNodeId } from '../../core/node-id.js';

const CHUNKING_MODEL = 'skeleton-v1';

function nodePathOf(sourceFile, n) {
  const base = n.parentStructuralPath ? `${n.parentStructuralPath}/` : '';
  return `${sourceFile}#${base}${n.nodeType}-${n.ordinalWithinParent}`;
}

function placeholderFor(sourceFile, n) {
  const label = n.nodeType === 'code_block' ? 'code block' : n.nodeType;
  const hint = String(n.text ?? '').trim().split('\n')[0].slice(0, 60);
  return `[${label} node: ${nodePathOf(sourceFile, n)}${hint ? ` — ${hint}` : ''}]`;
}

// ── Deterministic context (design §12, re-decided 2026-06-10) ───────────────
// Cost math on a real code-heavy corpus killed the original §12 plan: entity
// count alone (65) exceeded the legacy chunk count (49), so per-entity LLM
// context would COST MORE than legacy, not less. Instead, context is built
// deterministically from what the skeleton already knows:
//   prose  : heading path ("Тема › Розділ") — locational signal in the vector;
//   entity : heading path + node type + short nearby prose carryover from the
//            same section (placeholder lines stripped, capped at
//            SKELETON_CARRYOVER_CHARS, default 500).
// Result: 0 LLM calls per skeleton file (vs N in legacy). LLM context stays
// available as an explicit opt-in (SKELETON_CONTEXT=llm) for Stage-3 A/B runs.

const CARRYOVER_DEFAULT = 500;
const CARRYOVER_MAX     = 2000;

function carryoverLimit() {
  const v = parseInt(process.env.SKELETON_CARRYOVER_CHARS ?? '', 10);
  if (!Number.isFinite(v) || v <= 0) return CARRYOVER_DEFAULT;
  return Math.min(v, CARRYOVER_MAX);
}

function cleanedCarryover(text) {
  const limit = carryoverLimit();
  const t = String(text ?? '').trim();
  if (!t) return '';
  // Strip placeholder lines ([code block node: ...] / [table node: ...])
  const stripped = t.split('\n')
    .filter(l => !/^\[[^\]]*node: /.test(l.trim()))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.slice(0, limit);
}

function proseContext(headingPath) {
  return (headingPath ?? []).join(' › ');
}

function entityContext(headingPath, nodeType, neighborProse) {
  const where = (headingPath ?? []).join(' › ');
  const label = nodeType === 'code_block' ? 'code block' : nodeType;
  const near  = cleanedCarryover(neighborProse);
  return [where, label, near].filter(Boolean).join(' — ');
}

// Inline form for merged tiny code: keep it searchable inside prose.
function inlineTinyCode(n) {
  const body = String(n.text ?? '').trim();
  return body ? `\`${body.replace(/\s+/g, ' ')}\`` : '';
}

/**
 * @param {SkeletonNode[]} nodes — output of parseSkeleton()
 * @param {{ sourceFile: string, meta?: object, links?: string[] }} ctx
 * @returns {Chunk[]} legacy-shaped chunks with additive skeleton fields
 */
export function chunkFromSkeleton(nodes, ctx = {}) {
  const sourceFile = ctx.sourceFile ?? '';
  let meta = { ...(ctx.meta ?? {}) };
  const links = ctx.links ?? [];

  const out = [];

  // Prose accumulator, flushed on section change / structural node / end.
  let proseParts = [];
  let proseSection = '';          // heading text for the current prose run
  let proseHeadingPath = [];
  let proseParentPath = '';
  let proseOrdinal = new Map();   // sectionPath → next prose-chunk ordinal
  let lastProseIdx = -1;          // index in `out` of the last prose chunk of the CURRENT section

  const nextProseOrdinal = (parentPath) => {
    const n = (proseOrdinal.get(parentPath) ?? 0) + 1;
    proseOrdinal.set(parentPath, n);
    return n;
  };

  const flushProse = () => {
    if (!proseParts.length) return;
    const text = proseParts.join('\n\n').trim();
    proseParts = [];
    if (!text) return;

    for (const piece of recursiveChunkText(text)) {
      const pseudo = applyNodePolicy({ nodeType: 'paragraph', text: piece });
      if (!isContentBearing(pseudo)) continue;   // §7.3 gate at emission
      const ordinal = nextProseOrdinal(proseParentPath);
      out.push({
        text: piece,
        context: proseContext(proseHeadingPath),
        section: proseSection,
        source_file: sourceFile,
        meta, links,
        node_type: 'paragraph',
        node_id: makeNodeId({
          collection: '', sourceFile,
          structuralPath: proseParentPath ? `${proseParentPath}/paragraph` : 'paragraph',
          nodeType: 'paragraph', ordinalWithinParent: ordinal,
        }),
        node_path: `${sourceFile}#${proseParentPath ? proseParentPath + '/' : ''}paragraph-${ordinal}`,
        parent_id: proseParentPath
          ? makeNodeId({ collection: '', sourceFile, structuralPath: proseParentPath, nodeType: 'section', ordinalWithinParent: 1 })
          : null,
        heading_path: proseHeadingPath,
        raw_content: piece,
        point_kind: POINT_KINDS.RETRIEVAL,
        chunking_model: CHUNKING_MODEL,
      });
      lastProseIdx = out.length - 1;
    }
  };

  for (const rawNode of nodes) {
    const n = applyNodePolicy(rawNode);

    switch (n.policy) {
      case 'payload_metadata_only': {  // frontmatter
        meta = { ...meta, ...(n.meta ?? {}) };
        break;
      }

      case 'nav_summary': {            // section (file/collection don't occur here)
        flushProse();
        lastProseIdx = -1;             // placeholders never cross section boundaries
        proseSection = n.nodeType === 'section' ? n.text : proseSection;
        proseHeadingPath = n.headingPath ?? [];
        proseParentPath = n.structuralPath ?? '';
        break;
      }

      case 'merge_with_parent': {      // tiny code → inline into prose stream
        const inline = inlineTinyCode(n);
        if (inline) proseParts.push(inline);
        break;
      }

      case 'payload_raw_embed_context': {  // table / code_block / checklist
        // The structural node interrupts the prose run. The placeholder is
        // appended to the PRECEDING prose (reads naturally: "...directives:
        // [table node: ...]"), then the run is flushed and the entity emitted.
        // If there is no preceding prose, the placeholder-only run is gated
        // out by isContentBearing — placeholders are never content (§7.3/§11).
        const bearing = isContentBearing(n);
        const hadPrecedingProse = proseParts.length > 0;
        const neighborProse = hadPrecedingProse
          ? proseParts.join(' ')
          : (lastProseIdx >= 0 ? out[lastProseIdx].text : '');
        if (bearing && hadPrecedingProse) proseParts.push(placeholderFor(sourceFile, n));
        flushProse();
        if (!bearing) break;               // defensive — structural types pass

        out.push({
          text: n.rawContent,              // display/embedding input stays raw for MVP
          context: entityContext(n.headingPath, n.nodeType, neighborProse),
          section: proseSection,
          source_file: sourceFile,
          meta, links,
          node_type: n.nodeType,
          node_id: makeNodeId({
            collection: '', sourceFile,
            structuralPath: n.structuralPath,
            nodeType: n.nodeType,
            ordinalWithinParent: n.ordinalWithinParent,
          }),
          node_path: nodePathOf(sourceFile, n),
          parent_id: n.parentStructuralPath
            ? makeNodeId({ collection: '', sourceFile, structuralPath: n.parentStructuralPath, nodeType: 'section', ordinalWithinParent: 1 })
            : null,
          heading_path: n.headingPath ?? [],
          raw_content: n.rawContent,
          ...(n.lang !== undefined ? { lang: n.lang } : {}),
          point_kind: POINT_KINDS.RETRIEVAL,
          chunking_model: CHUNKING_MODEL,
        });

        // Exactly ONE placeholder per entity. Attachment order:
        //   1) preceding prose accumulator (handled above, before flush);
        //   2) last emitted prose chunk of this section (post-hoc append) —
        //      covers entity-after-entity runs where the accumulator is empty;
        //   3) following prose run (start-of-section entity);
        //   4) none available → entity stands alone, no placeholder.
        if (!hadPrecedingProse) {
          const ph = placeholderFor(sourceFile, n);
          if (lastProseIdx >= 0) {
            out[lastProseIdx].text += `\n\n${ph}`;
            out[lastProseIdx].raw_content = out[lastProseIdx].text;
          } else {
            proseParts.push(ph);
          }
        }
        break;
      }

      case 'future_processor': {       // image — skeleton-only in MVP
        break;
      }

      case 'chunk_text':
      default: {                       // paragraph / list / blockquote / unknown
        const t = String(n.text ?? '').trim();
        if (t) proseParts.push(t);
        break;
      }
    }
  }
  flushProse();

  // chunkIndex / totalChunks at the end (impl spec §3.4).
  return out.map((c, i) => ({ ...c, chunkIndex: i, totalChunks: out.length }));
}
