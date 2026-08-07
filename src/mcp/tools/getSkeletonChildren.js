import { getSkeletonNodeById, getSkeletonNodeByPath, getSkeletonChildren as fetchChildren } from '../../shared/core/qdrant.js';

export const schema = {
  name: 'qdrant_get_skeleton_children',
  description:
    'Fetch the immediate children of a skeleton nav node, resolved to full node objects. ' +
    'Identify the parent by node_id or node_path. ' +
    'Returns an ordered list of children with their metadata and child counts.',
  inputSchema: {
    type: 'object',
    properties: {
      collection: { type: 'string', description: 'Collection name' },
      node_id:    { type: 'string', description: 'Parent node ID (UUID)' },
      node_path:  { type: 'string', description: 'Parent node path string' },
      limit:      { type: 'integer', description: 'Max children to return (default 50, max 200)', default: 50, minimum: 1, maximum: 200 },
    },
    required: ['collection'],
  },
};

// Pure input validation — exported for smoke tests.
export function validateIdentifier({ node_id, node_path }) {
  if (node_id && node_path) return 'Error: provide exactly one of node_id or node_path.';
  if (!node_id && !node_path) return 'Error: provide exactly one of node_id or node_path.';
  return null;
}

// Pure serialization — exported for smoke tests.
// totalChildPaths: total number of children the parent declares.
// children: resolved child payloads after limit.
export function formatChildren(parentNode, children, totalChildPaths) {
  const total = totalChildPaths ?? children.length;
  return {
    parent: {
      node_type: parentNode.node_type,
      node_id:   parentNode.node_id,
      node_path: parentNode.node_path,
    },
    children: children.map(c => ({
      node_type:   c.node_type,
      node_id:     c.node_id,
      node_path:   c.node_path,
      summary:     c.summary ?? '',
      source_file: c.source_file ?? '',
      child_count: Array.isArray(c.children) ? c.children.length : 0,
      // Compact adaptive metadata — orientation hints for the agent.
      ...(c.summary_kind  !== undefined ? { summary_kind:  c.summary_kind }  : {}),
      ...(c.key_topics    !== undefined ? { key_topics:    c.key_topics }    : {}),
      ...(c.notable_terms !== undefined ? { notable_terms: c.notable_terms } : {}),
    })),
    total_children:    total,
    returned_children: children.length,
    truncated:         total > children.length,
  };
}

export async function handle({ collection, node_id, node_path, limit = 50 }) {
  const err = validateIdentifier({ node_id, node_path });
  if (err) return err;
  limit = Math.max(1, Math.min(200, parseInt(limit) || 50));

  const parent = node_id
    ? await getSkeletonNodeById(collection, node_id)
    : await getSkeletonNodeByPath(collection, node_path);

  if (!parent) {
    const ref = node_id ? `node_id="${node_id}"` : `node_path="${node_path}"`;
    return `No skeleton node found in \`${collection}\` for ${ref}.`;
  }

  const childPaths = Array.isArray(parent.children) ? parent.children : [];
  if (childPaths.length === 0) {
    return JSON.stringify(formatChildren(parent, [], 0), null, 2);
  }

  const children = await fetchChildren(collection, childPaths, limit);
  return JSON.stringify(formatChildren(parent, children, childPaths.length), null, 2);
}
