import { scrollAllPoints } from '../../core/qdrant.js';

export const schema = {
  name: 'qdrant_list_tags',
  description: 'List available tags in a collection with chunk and file counts. Use before qdrant_find_by_tag when valid tags are unknown.',
  inputSchema: {
    type: 'object',
    properties: {
      collection: { type: 'string',  description: 'Collection name' },
      prefix:     { type: 'string',  description: 'Only count tags from files whose source_file starts with this prefix' },
      min_count:  { type: 'integer', description: 'Minimum chunk count for a tag to appear (default 1)', default: 1 },
      limit:      { type: 'integer', description: 'Max tags to return (default 100)', default: 100 },
    },
    required: ['collection'],
  },
};

// Pure aggregation — exported for smoke tests.
export function aggregateTags(points, prefix = null, minCount = 1) {
  const normalizedPrefix = prefix ? prefix.replace(/\\/g, '/') : null;
  const tagChunks = new Map();  // tag → chunk count
  const tagFiles  = new Map();  // tag → Set of source_files

  for (const p of points) {
    const sf   = (p.payload?.source_file ?? '').replace(/\\/g, '/');
    const tags = p.payload?.tags;
    if (!Array.isArray(tags) || tags.length === 0) continue;
    if (normalizedPrefix && !sf.startsWith(normalizedPrefix)) continue;

    for (const tag of tags) {
      if (!tag || typeof tag !== 'string') continue;
      tagChunks.set(tag, (tagChunks.get(tag) ?? 0) + 1);
      if (!tagFiles.has(tag)) tagFiles.set(tag, new Set());
      tagFiles.get(tag).add(sf);
    }
  }

  return [...tagChunks.entries()]
    .map(([tag, chunkCount]) => ({
      tag,
      chunkCount,
      fileCount: tagFiles.get(tag)?.size ?? 0,
    }))
    .filter(t => t.chunkCount >= minCount)
    .sort((a, b) => b.chunkCount - a.chunkCount || a.tag.localeCompare(b.tag));
}

export async function handle({ collection, prefix, min_count = 1, limit = 100 }) {
  const points = await scrollAllPoints(
    collection,
    ['source_file', 'tags'],
  );

  const tags = aggregateTags(points, prefix, min_count);
  const totalFound = tags.length;

  if (totalFound === 0) {
    const prefixClause = prefix ? ` with prefix \`${prefix.replace(/\\/g, '/')}\`` : '';
    const minClause = min_count > 1 ? ` (min_count=${min_count})` : '';
    return `No tags found in collection \`${collection}\`${prefixClause}${minClause}.`;
  }

  const showing = tags.slice(0, limit);
  const lines = [`## Tags in \`${collection}\``];
  if (prefix) lines.push(`Prefix: \`${prefix.replace(/\\/g, '/')}\``);
  const truncNote = totalFound > limit ? `, showing ${limit}` : '';
  lines.push(`Found ${totalFound} tag${totalFound === 1 ? '' : 's'}${truncNote}`);
  lines.push('');

  for (const { tag, chunkCount, fileCount } of showing) {
    lines.push(`- ${tag} — ${chunkCount} chunk${chunkCount === 1 ? '' : 's'}, ${fileCount} file${fileCount === 1 ? '' : 's'}`);
  }

  return lines.join('\n');
}
