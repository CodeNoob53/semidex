import { scrollAllPoints } from '../../shared/core/qdrant.js';
import { isNavPoint } from './filters.js';

export const schema = {
  name: 'qdrant_list_directories',
  description: 'List directory prefixes in a collection with file and chunk counts. Use to explore collection structure before qdrant_list_files.',
  inputSchema: {
    type: 'object',
    properties: {
      collection:    { type: 'string',  description: 'Collection name' },
      source_prefix: { type: 'string',  description: 'Scope the directory listing to paths starting with this prefix' },
      depth:         { type: 'integer', description: 'Directory depth to aggregate (default 1, min 1, max 5)', default: 1, minimum: 1, maximum: 5 },
      limit:         { type: 'integer', description: 'Max directories to return (default 100)', default: 100 },
    },
    required: ['collection'],
  },
};

// Returns the directory prefix of a path at the given depth.
// e.g. depth=1: "a/b/c.md" → "a/"
//      depth=2: "a/b/c.md" → "a/b/"
export function dirPrefix(normalizedPath, depth) {
  const parts = normalizedPath.split('/');
  if (parts.length <= depth) {
    // file is at or shallower than requested depth — use its dirname
    return parts.slice(0, -1).join('/') + (parts.length > 1 ? '/' : '');
  }
  return parts.slice(0, depth).join('/') + '/';
}

// Pure aggregation — exported for smoke tests.
// Returns [{ dir, fileCount, chunkCount }] sorted by dir asc.
export function aggregateDirectories(points, sourcePrefix = null, depth = 1) {
  const normalizedPrefix = sourcePrefix ? sourcePrefix.replace(/\\/g, '/') : null;
  const dirFiles  = new Map(); // dir → Set of source_files
  const dirChunks = new Map(); // dir → chunk count

  for (const p of points) {
    if (isNavPoint(p)) continue;   // nav nodes must not inflate chunk counts (B2)
    const sf = (p.payload?.source_file ?? '').replace(/\\/g, '/');
    if (!sf) continue;
    if (normalizedPrefix && !sf.startsWith(normalizedPrefix)) continue;

    // Strip the scoping prefix before computing depth, then re-attach.
    const relative = normalizedPrefix ? sf.slice(normalizedPrefix.length) : sf;
    const rawDir   = dirPrefix(relative, depth);
    const dir      = normalizedPrefix ? normalizedPrefix + rawDir : rawDir;

    if (!dirFiles.has(dir)) {
      dirFiles.set(dir, new Set());
      dirChunks.set(dir, 0);
    }
    dirFiles.get(dir).add(sf);
    dirChunks.set(dir, dirChunks.get(dir) + 1);
  }

  return [...dirFiles.entries()]
    .map(([dir, files]) => ({
      dir: dir || '(root)',
      fileCount:  files.size,
      chunkCount: dirChunks.get(dir),
    }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

export async function handle({ collection, source_prefix, depth = 1, limit = 100 }) {
  depth = Math.max(1, Math.min(5, parseInt(depth) || 1));

  const points = await scrollAllPoints(collection, ['source_file', 'point_kind']);

  const dirs = aggregateDirectories(points, source_prefix ?? null, depth);
  const totalFound = dirs.length;

  if (totalFound === 0) {
    const prefixClause = source_prefix ? ` with prefix \`${source_prefix.replace(/\\/g, '/')}\`` : '';
    return `No directories found in collection \`${collection}\`${prefixClause}.`;
  }

  const showing = dirs.slice(0, limit);
  const lines = [`## Directories in \`${collection}\``];
  if (source_prefix) lines.push(`Source prefix: \`${source_prefix.replace(/\\/g, '/')}\``);
  lines.push(`Depth: ${depth}`);
  const truncNote = totalFound > limit ? `, showing ${limit}` : '';
  lines.push(`Found ${totalFound} director${totalFound === 1 ? 'y' : 'ies'}${truncNote}`);
  lines.push('');

  for (const { dir, fileCount, chunkCount } of showing) {
    lines.push(`- ${dir} — ${fileCount} file${fileCount === 1 ? '' : 's'}, ${chunkCount} chunk${chunkCount === 1 ? '' : 's'}`);
  }

  return lines.join('\n');
}
