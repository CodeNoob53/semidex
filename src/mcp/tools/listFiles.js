import { scrollAllPoints } from '../../shared/core/qdrant.js';
import { isNavPoint } from './filters.js';

export const schema = {
  name: 'qdrant_list_files',
  description: 'List unique source files in a collection with chunk counts and first section. Use when you know a folder/topic area but not the exact source_file path. Supports filtering by source_prefix or tags.',
  inputSchema: {
    type: 'object',
    properties: {
      collection:    { type: 'string',  description: 'Collection name' },
      source_prefix: { type: 'string',  description: 'Only return files whose path starts with this prefix (forward-slash normalized)' },
      tags:          { type: 'array', items: { type: 'string' }, description: 'Filter files by tag presence. Files must have at least one chunk carrying these tags.' },
      tag_match:     { type: 'string', enum: ['any', 'all'], description: '"any": file qualifies if any requested tag appears in any chunk (default). "all": all tags must appear across the file\'s chunks.', default: 'any' },
      limit:         { type: 'integer', description: 'Max files to return (default 100)', default: 100 },
      prefix:        { type: 'string',  description: 'Deprecated alias for source_prefix.' },
    },
    required: ['collection'],
  },
};

// Pure aggregation — exported for smoke tests.
export function aggregateFiles(points, sourcePrefix = null, tags = null, tagMatch = 'any') {
  const normalizedPrefix = sourcePrefix ? sourcePrefix.replace(/\\/g, '/') : null;
  const filterTags = tags && tags.length > 0 ? tags.map(t => t.toLowerCase()) : null;

  // fileMap: normalizedPath → { chunkCount, firstSection, minChunkIndex, tagHitCount, _tagSet }
  // tagHitCount = number of chunks that matched any requested tag (density metric).
  // _tagSet     = Set of requested tags seen anywhere in the file (used for tag_match="all").
  const fileMap = new Map();

  for (const p of points) {
    if (isNavPoint(p)) continue;   // nav nodes must not inflate chunkCount (B2)
    const sf = (p.payload?.source_file ?? '').replace(/\\/g, '/');
    if (!sf) continue;
    if (normalizedPrefix && !sf.startsWith(normalizedPrefix)) continue;

    if (!fileMap.has(sf)) {
      fileMap.set(sf, { chunkCount: 0, firstSection: '', minChunkIndex: Infinity, tagHitCount: 0, _tagSet: new Set() });
    }
    const entry = fileMap.get(sf);
    entry.chunkCount++;

    const ci = p.payload?.chunk_index ?? Infinity;
    if (ci < entry.minChunkIndex) {
      entry.minChunkIndex = ci;
      entry.firstSection = p.payload?.section || '';
    }

    if (filterTags) {
      const chunkTags = (p.payload?.tags ?? []).map(t => (t ?? '').toLowerCase());
      const chunkMatches = filterTags.some(ft => chunkTags.includes(ft));
      if (chunkMatches) entry.tagHitCount++;
      for (const ft of filterTags) {
        if (chunkTags.includes(ft)) entry._tagSet.add(ft);
      }
    }
  }

  let entries = [...fileMap.entries()].map(([sf, { chunkCount, firstSection, tagHitCount, _tagSet }]) => ({
    source_file: sf,
    chunkCount,
    firstSection: firstSection || 'intro',
    tagHitCount,
    _tagSet,
  }));

  if (filterTags) {
    if (tagMatch === 'all') {
      entries = entries.filter(e => filterTags.every(ft => e._tagSet.has(ft)));
    } else {
      entries = entries.filter(e => e.tagHitCount > 0);
    }
    entries.sort((a, b) => b.tagHitCount - a.tagHitCount || a.source_file.localeCompare(b.source_file));
  } else {
    entries.sort((a, b) => a.source_file.localeCompare(b.source_file));
  }

  return entries.map(({ source_file, chunkCount, firstSection, tagHitCount }) => ({
    source_file,
    chunkCount,
    firstSection,
    ...(filterTags ? { tagHitCount } : {}),
  }));
}

export async function handle({ collection, source_prefix, tags, tag_match = 'any', limit = 100, prefix }) {
  const deprecationWarning = prefix && !source_prefix
    ? 'Note: prefix is deprecated; use source_prefix for file paths.\n\n'
    : '';
  const effectiveSourcePrefix = source_prefix ?? prefix ?? null;

  const payloadFields = ['source_file', 'chunk_index', 'section', 'point_kind'];
  if (tags && tags.length > 0) payloadFields.push('tags');

  const points = await scrollAllPoints(collection, payloadFields);

  const files = aggregateFiles(points, effectiveSourcePrefix, tags ?? null, tag_match);
  const totalFound = files.length;

  if (totalFound === 0) {
    const clauses = [];
    if (effectiveSourcePrefix) clauses.push(`prefix \`${effectiveSourcePrefix.replace(/\\/g, '/')}\``);
    if (tags && tags.length)   clauses.push(`tags [${tags.map(t => `\`${t}\``).join(', ')}]`);
    const filterClause = clauses.length ? ` with ${clauses.join(', ')}` : '';
    return `${deprecationWarning}No files found in collection \`${collection}\`${filterClause}.`;
  }

  const showing = files.slice(0, limit);
  const lines = [`## Files in \`${collection}\``];
  if (effectiveSourcePrefix) lines.push(`Source prefix: \`${effectiveSourcePrefix.replace(/\\/g, '/')}\``);
  if (tags && tags.length) {
    lines.push(`Tags: ${tags.map(t => `\`${t}\``).join(', ')} (${tag_match})`);
  }
  const truncNote = totalFound > limit ? `, showing ${limit}` : '';
  lines.push(`Found ${totalFound} file${totalFound === 1 ? '' : 's'}${truncNote}`);
  lines.push('');

  for (const { source_file, chunkCount, firstSection, tagHitCount } of showing) {
    const tagNote = tags && tags.length ? `, ${tagHitCount} tag hit${tagHitCount === 1 ? '' : 's'}` : '';
    lines.push(`- ${source_file} — ${chunkCount} chunk${chunkCount === 1 ? '' : 's'}${tagNote}, first section: ${firstSection}`);
  }

  return deprecationWarning + lines.join('\n');
}
