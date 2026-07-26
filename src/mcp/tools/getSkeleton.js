import { getCollectionSkeletonNode, getSkeletonChildren } from '../../core/qdrant.js';

export const schema = {
  name: 'qdrant_get_skeleton',
  description:
    'Return the top-level skeleton of a collection: the collection-level nav node and its immediate children. ' +
    'Use this to understand the high-level structure of a collection before drilling into specific nodes.',
  inputSchema: {
    type: 'object',
    properties: {
      collection: { type: 'string', description: 'Collection name' },
    },
    required: ['collection'],
  },
};

// Pure rendering — exported for smoke tests.
export function formatSkeleton(collectionNode, children) {
  if (!collectionNode) {
    return null;
  }
  return {
    node_type:   collectionNode.node_type,
    node_id:     collectionNode.node_id,
    node_path:   collectionNode.node_path,
    summary:     collectionNode.summary ?? '',
    inventory:   collectionNode.inventory ?? null,
    // Adaptive metadata on collection node when present.
    ...(collectionNode.summary_kind    !== undefined ? { summary_kind:    collectionNode.summary_kind }    : {}),
    ...(collectionNode.summary_version !== undefined ? { summary_version: collectionNode.summary_version } : {}),
    ...(collectionNode.key_topics      !== undefined ? { key_topics:      collectionNode.key_topics }      : {}),
    ...(collectionNode.notable_terms   !== undefined ? { notable_terms:   collectionNode.notable_terms }   : {}),
    child_count: Array.isArray(collectionNode.children) ? collectionNode.children.length : 0,
    children:    children.map(c => ({
      node_type:   c.node_type,
      node_id:     c.node_id,
      node_path:   c.node_path,
      summary:     c.summary ?? '',
      child_count: Array.isArray(c.children) ? c.children.length : 0,
      // Orientation hint per child.
      ...(c.summary_kind !== undefined ? { summary_kind: c.summary_kind } : {}),
    })),
  };
}

export async function handle({ collection }) {
  const collectionNode = await getCollectionSkeletonNode(collection);
  if (!collectionNode) {
    return `No skeleton found for collection \`${collection}\`. The collection may predate skeleton-first indexing — reindex it to get skeleton navigation.`;
  }

  const childPaths = Array.isArray(collectionNode.children) ? collectionNode.children : [];
  const children   = await getSkeletonChildren(collection, childPaths);

  const result = formatSkeleton(collectionNode, children);
  return JSON.stringify(result, null, 2);
}
