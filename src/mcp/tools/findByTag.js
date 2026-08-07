import { scroll } from '../../shared/core/qdrant.js';
import { withNavExcluded, isNavPoint } from './filters.js';

export const schema = {
  name: 'qdrant_find_by_tag',
  description: 'Find all chunks matching one or more tags, grouped and sorted by file density.',
  inputSchema: {
    type: 'object',
    properties: {
      collection: { type: 'string',  description: 'Collection name' },
      tag:        { type: 'string',  description: 'Single tag to search for (kept for backward compatibility)' },
      tags:       { type: 'array', items: { type: 'string' }, description: 'One or more tags. If provided, overrides tag.' },
      match:      { type: 'string', enum: ['any', 'all'], description: '"any": chunks matching any of the tags (default). "all": chunks carrying all tags.', default: 'any' },
      limit:      { type: 'integer', description: 'Max chunks to fetch before grouping (default 200)', default: 200 },
    },
    required: ['collection'],
  },
};

// Pure helper — exported for smoke tests.
// groups: Map<source_file, { sections: string[], chunkCount: number }>
export function groupByFile(points) {
  const byFile = new Map();
  for (const p of points) {
    if (isNavPoint(p)) continue;   // nav nodes never count as content
    const sf = p.payload?.source_file ?? '(unknown)';
    if (!byFile.has(sf)) byFile.set(sf, { sections: [], chunkCount: 0 });
    const entry = byFile.get(sf);
    entry.chunkCount++;
    const sec = p.payload?.section || 'intro';
    if (!entry.sections.includes(sec)) entry.sections.push(sec);
  }
  return byFile;
}

export async function handle({ collection, tag, tags, match = 'any', limit = 200 }) {
  const effectiveTags = tags && tags.length > 0 ? tags : (tag ? [tag] : []);
  if (!effectiveTags.length) return 'No tag(s) specified.';

  let filter;
  if (match === 'all') {
    filter = { must: effectiveTags.map(t => ({ key: 'tags', match: { value: t } })) };
  } else {
    filter = effectiveTags.length === 1
      ? { must: [{ key: 'tags', match: { value: effectiveTags[0] } }] }
      : { should: effectiveTags.map(t => ({ key: 'tags', match: { value: t } })) };
  }

  const raw = await scroll(collection, withNavExcluded(filter), limit + 1);
  const truncated = raw.length > limit;
  const points = truncated ? raw.slice(0, limit) : raw;

  if (!points.length) {
    const tagLabel = effectiveTags.length === 1
      ? `tag "${effectiveTags[0]}"`
      : `tags [${effectiveTags.join(', ')}] (${match})`;
    return `No chunks found with ${tagLabel}.`;
  }

  const byFile = groupByFile(points);

  // Sort by chunk count desc, then file path asc
  const sorted = [...byFile.entries()].sort(
    (a, b) => b[1].chunkCount - a[1].chunkCount || a[0].localeCompare(b[0])
  );

  const totalChunks = points.length;
  const tagLabel = effectiveTags.length === 1
    ? `\`${effectiveTags[0]}\``
    : `[${effectiveTags.map(t => `\`${t}\``).join(', ')}] (${match})`;

  const truncationNote = truncated ? ` (showing first ${limit} — increase \`limit\` to see more)` : '';
  const lines = [
    `## Chunks tagged ${tagLabel}`,
    `Found ${totalChunks} chunk${totalChunks === 1 ? '' : 's'} across ${sorted.length} file${sorted.length === 1 ? '' : 's'}${truncationNote}`,
    '',
  ];

  for (const [file, { chunkCount, sections }] of sorted) {
    lines.push(`- ${file} — ${chunkCount} chunk${chunkCount === 1 ? '' : 's'}; sections: ${sections.join(', ')}`);
  }

  return lines.join('\n');
}
