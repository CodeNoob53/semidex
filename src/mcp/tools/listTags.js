import { scrollAllPoints } from '../../shared/core/qdrant.js';
import { isNavPoint } from './filters.js';

export const schema = {
  name: 'qdrant_list_tags',
  description: 'List available tags in a collection with chunk and file counts. Use before qdrant_find_by_tag when valid tags are unknown. Prefer tag_prefix or contains over no filter on large collections.',
  inputSchema: {
    type: 'object',
    properties: {
      collection:    { type: 'string',  description: 'Collection name' },
      source_prefix: { type: 'string',  description: 'Only count tags from files whose source_file starts with this prefix' },
      tag_prefix:    { type: 'string',  description: 'Only return tags whose name starts with this prefix' },
      contains:      { type: 'string',  description: 'Only return tags whose name contains this substring' },
      min_count:     { type: 'integer', description: 'Minimum chunk count for a tag to appear (default 1)', default: 1 },
      limit:         { type: 'integer', description: 'Max tags to return (default 100)', default: 100 },
      prefix:        { type: 'string',  description: 'Deprecated alias for source_prefix.' },
    },
    required: ['collection'],
  },
};

// Pure aggregation — exported for smoke tests.
export function aggregateTags(points, sourcePrefix = null, minCount = 1, tagPrefix = null, contains = null) {
  const normalizedSourcePrefix = sourcePrefix ? sourcePrefix.replace(/\\/g, '/') : null;
  const normalizedTagPrefix    = tagPrefix ? tagPrefix.toLowerCase() : null;
  const normalizedContains     = contains  ? contains.toLowerCase()  : null;

  const tagChunks = new Map();  // tag → chunk count
  const tagFiles  = new Map();  // tag → Set of source_files

  for (const p of points) {
    if (isNavPoint(p)) continue;   // nav nodes carry no content tags (B2)
    const sf   = (p.payload?.source_file ?? '').replace(/\\/g, '/');
    const tags = p.payload?.tags;
    if (!Array.isArray(tags) || tags.length === 0) continue;
    if (normalizedSourcePrefix && !sf.startsWith(normalizedSourcePrefix)) continue;

    for (const tag of tags) {
      if (!tag || typeof tag !== 'string') continue;
      const tagLower = tag.toLowerCase();
      if (normalizedTagPrefix && !tagLower.startsWith(normalizedTagPrefix)) continue;
      if (normalizedContains  && !tagLower.includes(normalizedContains))   continue;
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

export async function handle({ collection, source_prefix, tag_prefix, contains, min_count = 1, limit = 100, prefix }) {
  const deprecationWarning = prefix && !source_prefix
    ? 'Note: prefix is deprecated; use source_prefix for file paths or tag_prefix for tag names.\n\n'
    : '';
  const effectiveSourcePrefix = source_prefix ?? prefix ?? null;

  const points = await scrollAllPoints(collection, ['source_file', 'tags', 'point_kind']);

  const tags = aggregateTags(points, effectiveSourcePrefix, min_count, tag_prefix ?? null, contains ?? null);
  const totalFound = tags.length;

  if (totalFound === 0) {
    const clauses = [];
    if (effectiveSourcePrefix) clauses.push(`source_prefix \`${effectiveSourcePrefix.replace(/\\/g, '/')}\``);
    if (tag_prefix)            clauses.push(`tag_prefix \`${tag_prefix}\``);
    if (contains)              clauses.push(`contains \`${contains}\``);
    if (min_count > 1)         clauses.push(`min_count=${min_count}`);
    const filterClause = clauses.length ? ` with ${clauses.join(', ')}` : '';
    return `${deprecationWarning}No tags found in collection \`${collection}\`${filterClause}.`;
  }

  const showing = tags.slice(0, limit);
  const lines = [`## Tags in \`${collection}\``];
  if (effectiveSourcePrefix) lines.push(`Source prefix: \`${effectiveSourcePrefix.replace(/\\/g, '/')}\``);
  if (tag_prefix)            lines.push(`Tag prefix: \`${tag_prefix}\``);
  if (contains)              lines.push(`Contains: \`${contains}\``);
  const truncNote = totalFound > limit ? `, showing ${limit}` : '';
  lines.push(`Found ${totalFound} tag${totalFound === 1 ? '' : 's'}${truncNote}`);
  lines.push('');

  for (const { tag, chunkCount, fileCount } of showing) {
    lines.push(`- ${tag} — ${chunkCount} chunk${chunkCount === 1 ? '' : 's'}, ${fileCount} file${fileCount === 1 ? '' : 's'}`);
  }

  return deprecationWarning + lines.join('\n');
}
