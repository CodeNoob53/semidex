import { getContentNodeById, getContentNodeByPath, getAnyNodeById, getAnyNodeByPath } from '../../core/qdrant.js';

export const schema = {
  name: 'qdrant_get_node',
  description:
    'Resolve a skeleton structural node (table, code_block, checklist, image, paragraph, etc.) ' +
    'by node_id or node_path. Returns metadata and a bounded content preview. ' +
    'Use this when search or skeleton tools surface a placeholder like ' +
    '[table node: ...] or [code_block node: ...]. ' +
    'Does not return skeleton nav nodes — use qdrant_get_skeleton_node for those.',
  inputSchema: {
    type: 'object',
    properties: {
      collection:    { type: 'string',  description: 'Collection name' },
      node_id:       { type: 'string',  description: 'Node ID (UUID). Use this when you already know the ID.' },
      node_path:     { type: 'string',  description: 'Node path string (e.g. "dir/file.md#section/code_block-3"). Use this when navigating by path.' },
      preview_chars: { type: 'integer', description: 'Max chars of raw content to return (default 2000, min 200, max 8000)', default: 2000, minimum: 200, maximum: 8000 },
    },
    required: ['collection'],
  },
};

const PREVIEW_DEFAULT = 2000;
const PREVIEW_MIN     = 200;
const PREVIEW_MAX     = 8000;

export function clampPreviewChars(value) {
  if (value === undefined || value === null || value === '') return PREVIEW_DEFAULT;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return PREVIEW_DEFAULT;
  return Math.max(PREVIEW_MIN, Math.min(PREVIEW_MAX, parsed));
}

// Pure input validation — exported for smoke tests.
export function validateIdentifier({ node_id, node_path }) {
  if (node_id && node_path) return 'Error: provide exactly one of node_id or node_path.';
  if (!node_id && !node_path) return 'Error: provide exactly one of node_id or node_path.';
  return null;
}

// Pure formatter — exported for smoke tests.
export function formatNode(payload, collection, previewChars) {
  const limit = clampPreviewChars(previewChars);

  // Reject nav nodes — caller should use qdrant_get_skeleton_node instead.
  if (payload.point_kind === 'skeleton_nav') {
    return { found: false, collection, reason: 'nav_node_not_content' };
  }

  const raw = payload.raw_content ?? payload.rawContent ?? payload.text ?? '';
  const rawChars = typeof raw === 'string' ? raw.length : 0;
  const preview  = typeof raw === 'string' ? raw.slice(0, limit) : '';

  const result = {
    found:        true,
    collection,
    node_type:    payload.node_type    ?? null,
    node_id:      payload.node_id      ?? null,
    node_path:    payload.node_path    ?? null,
    parent_id:    payload.parent_id    ?? null,
    source_file:  payload.source_file  ?? null,
    heading_path: Array.isArray(payload.heading_path) ? payload.heading_path : (payload.heading_path ?? null),
    chunk_index:  payload.chunk_index  ?? null,
    section:      payload.section      ?? null,
    lang:         payload.lang         ?? null,
    summary:      payload.summary      ?? null,
    context:      payload.context      ?? null,
    preview,
    preview_chars:  limit,
    raw_chars:      rawChars,
    truncated:      rawChars > preview.length,
    raw_available:  rawChars > 0,
  };

  return result;
}

// A split-entity fragment (entity-split.js) carries entity_id pointing at
// its canonical entity_raw point — that canonical point holds the COMPLETE
// raw_content this tool is meant to return, while the fragment itself only
// carries a bounded piece. qdrant_get_node always resolves to the canonical
// entity, regardless of which fragment's (or the entity's own) node_id/
// node_path the caller happened to look up. Exported with an injectable
// lookup function for direct unit testing without a live Qdrant instance.
//
// @param {Object|null} content — result of getContentNodeById/ByPath
// @param {string} collection
// @param {(collection: string, nodeId: string) => Promise<Object|null>} getContentNodeByIdFn
// @returns {Promise<Object|null>} the canonical payload if content was a
//   fragment and its canonical entity was found; otherwise content unchanged
export async function resolveCanonicalEntity(content, collection, getContentNodeByIdFn) {
  if (!content?.entity_id) return content;
  const canonical = await getContentNodeByIdFn(collection, content.entity_id);
  return canonical ?? content;
}

export async function handle({ collection, node_id, node_path, preview_chars }) {
  const err = validateIdentifier({ node_id, node_path });
  if (err) return err;

  const previewChars = clampPreviewChars(preview_chars);

  // Try fetching a content (non-nav) node first.
  let content = node_id
    ? await getContentNodeById(collection, node_id)
    : await getContentNodeByPath(collection, node_path);

  content = await resolveCanonicalEntity(content, collection, getContentNodeById);

  if (content) {
    return JSON.stringify(formatNode(content, collection, previewChars), null, 2);
  }

  // Nothing found as content — check if a nav node exists at this identifier.
  const any = node_id
    ? await getAnyNodeById(collection, node_id)
    : await getAnyNodeByPath(collection, node_path);

  if (any?.point_kind === 'skeleton_nav') {
    return JSON.stringify({ found: false, collection, reason: 'nav_node_not_content' }, null, 2);
  }

  return JSON.stringify({ found: false, collection, reason: 'not_found' }, null, 2);
}
