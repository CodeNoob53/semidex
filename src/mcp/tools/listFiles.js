import { scrollAllPoints } from '../../core/qdrant.js';

export const schema = {
  name: 'qdrant_list_files',
  description: 'List unique source files in a collection with chunk counts and first section. Use when you know a folder/topic area but not the exact source_file path.',
  inputSchema: {
    type: 'object',
    properties: {
      collection: { type: 'string',  description: 'Collection name' },
      prefix:     { type: 'string',  description: 'Only return files whose path starts with this prefix (forward-slash normalized)' },
      limit:      { type: 'integer', description: 'Max files to return (default 100)', default: 100 },
    },
    required: ['collection'],
  },
};

// Pure aggregation — exported for smoke tests.
export function aggregateFiles(points, prefix = null) {
  const normalizedPrefix = prefix ? prefix.replace(/\\/g, '/') : null;
  const fileMap = new Map(); // normalizedPath → { chunkCount, firstSection, minChunkIndex }

  for (const p of points) {
    const sf = (p.payload?.source_file ?? '').replace(/\\/g, '/');
    if (!sf) continue;
    if (normalizedPrefix && !sf.startsWith(normalizedPrefix)) continue;

    if (!fileMap.has(sf)) {
      fileMap.set(sf, { chunkCount: 0, firstSection: '', minChunkIndex: Infinity });
    }
    const entry = fileMap.get(sf);
    entry.chunkCount++;

    const ci = p.payload?.chunk_index ?? Infinity;
    if (ci < entry.minChunkIndex) {
      entry.minChunkIndex = ci;
      entry.firstSection = p.payload?.section || '';
    }
  }

  return [...fileMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([sf, { chunkCount, firstSection }]) => ({
      source_file: sf,
      chunkCount,
      firstSection: firstSection || 'intro',
    }));
}

export async function handle({ collection, prefix, limit = 100 }) {
  const points = await scrollAllPoints(
    collection,
    ['source_file', 'chunk_index', 'section'],
  );

  const files = aggregateFiles(points, prefix);
  const totalFound = files.length;

  if (totalFound === 0) {
    const prefixClause = prefix ? ` with prefix \`${prefix.replace(/\\/g, '/')}\`` : '';
    return `No files found in collection \`${collection}\`${prefixClause}.`;
  }

  const showing = files.slice(0, limit);
  const lines = [`## Files in \`${collection}\``];
  if (prefix) lines.push(`Prefix: \`${prefix.replace(/\\/g, '/')}\``);
  const truncNote = totalFound > limit ? `, showing ${limit}` : '';
  lines.push(`Found ${totalFound} file${totalFound === 1 ? '' : 's'}${truncNote}`);
  lines.push('');

  for (const { source_file, chunkCount, firstSection } of showing) {
    lines.push(`- ${source_file} — ${chunkCount} chunk${chunkCount === 1 ? '' : 's'}, first section: ${firstSection}`);
  }

  return lines.join('\n');
}
