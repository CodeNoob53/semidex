import { getSkeletonNodeById, getSkeletonNodeByPath } from '../../core/qdrant.js';

export const schema = {
  name: 'qdrant_get_skeleton_node',
  description:
    'Fetch a single skeleton nav node by node_id or node_path. ' +
    'Returns the node\'s metadata and its children list (paths only). ' +
    'Use qdrant_get_skeleton_children to resolve children into full nodes.',
  inputSchema: {
    type: 'object',
    properties: {
      collection: { type: 'string', description: 'Collection name' },
      node_id:    { type: 'string', description: 'Node ID (UUID). Use this when you already know the ID.' },
      node_path:  { type: 'string', description: 'Node path string (e.g. "col#dir/Topic 1"). Use this when navigating by path.' },
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
export function formatNode(node) {
  if (!node) return null;
  return {
    node_type:    node.node_type,
    node_id:      node.node_id,
    node_path:    node.node_path,
    parent_id:    node.parent_id ?? null,
    summary:      node.summary ?? '',
    source_file:  node.source_file ?? '',
    heading_path: node.heading_path ?? null,
    inventory:    node.inventory ?? null,
    children:     Array.isArray(node.children) ? node.children : [],
  };
}

export async function handle({ collection, node_id, node_path }) {
  const err = validateIdentifier({ node_id, node_path });
  if (err) return err;

  const node = node_id
    ? await getSkeletonNodeById(collection, node_id)
    : await getSkeletonNodeByPath(collection, node_path);

  if (!node) {
    const ref = node_id ? `node_id="${node_id}"` : `node_path="${node_path}"`;
    return `No skeleton node found in \`${collection}\` for ${ref}.`;
  }

  return JSON.stringify(formatNode(node), null, 2);
}
