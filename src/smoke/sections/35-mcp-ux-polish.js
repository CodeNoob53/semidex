import { aggregateDirectories, dirPrefix } from '../../../src/mcp/tools/listDirectories.js';
import { groupByFile }                     from '../../../src/mcp/tools/findByTag.js';
import { formatChunkHeading }              from '../../../src/mcp/tools/getChunk.js';

export default async function ({ ok }) {
  console.log('\n[35] MCP UX polish — listDirectories / findByTag grouping / getChunk heading');

  // ── dirPrefix helper ──────────────────────────────────────────────────────

  ok('dirPrefix depth=1: top-level dir',
    dirPrefix('genres/metal/heavy.md', 1) === 'genres/');

  ok('dirPrefix depth=2: two-level dir',
    dirPrefix('genres/metal/heavy.md', 2) === 'genres/metal/');

  ok('dirPrefix depth=3: deeper than file depth uses dirname',
    dirPrefix('genres/heavy.md', 3) === 'genres/');

  ok('dirPrefix: file at root (no slash) returns empty string',
    dirPrefix('readme.md', 1) === '');

  ok('dirPrefix depth=1: two-part path',
    dirPrefix('reference/file.md', 1) === 'reference/');

  // root-level files map to "(root)" in aggregateDirectories output
  const rootPts = [
    { payload: { source_file: 'README.md' } },
    { payload: { source_file: 'AGENTS.md' } },
    { payload: { source_file: 'docs/intro.md' } },
  ];
  const rootDirs = aggregateDirectories(rootPts, null, 1);
  ok('aggregateDirectories: root-level files produce "(root)" dir entry',
    rootDirs.some(d => d.dir === '(root)'));
  ok('aggregateDirectories: (root) has correct file count',
    rootDirs.find(d => d.dir === '(root)')?.fileCount === 2);
  ok('aggregateDirectories: subdirectory still present alongside (root)',
    rootDirs.some(d => d.dir === 'docs/'));

  // ── aggregateDirectories ──────────────────────────────────────────────────

  const pts = [
    { payload: { source_file: 'genres/metal/heavy.md' } },
    { payload: { source_file: 'genres/metal/doom.md' } },
    { payload: { source_file: 'genres/pop/indie.md' } },
    { payload: { source_file: 'reference/promo/social.md' } },
    { payload: { source_file: 'reference/promo/social.md' } }, // second chunk same file
    { payload: { source_file: 'templates/release.md' } },
    { payload: {} },                                            // no source_file, skipped
  ];

  const depth1 = aggregateDirectories(pts, null, 1);

  ok('aggregateDirectories depth=1: finds 3 top-level dirs',
    depth1.length === 3);

  ok('aggregateDirectories depth=1: genres/ present',
    depth1.some(d => d.dir === 'genres/'));

  ok('aggregateDirectories depth=1: reference/ present',
    depth1.some(d => d.dir === 'reference/'));

  ok('aggregateDirectories depth=1: templates/ present',
    depth1.some(d => d.dir === 'templates/'));

  ok('aggregateDirectories depth=1: sorted alphabetically',
    depth1[0].dir === 'genres/' && depth1[1].dir === 'reference/' && depth1[2].dir === 'templates/');

  ok('aggregateDirectories depth=1: genres/ has 3 files',
    depth1.find(d => d.dir === 'genres/')?.fileCount === 3);

  ok('aggregateDirectories depth=1: genres/ chunk count = 3',
    depth1.find(d => d.dir === 'genres/')?.chunkCount === 3);

  ok('aggregateDirectories depth=1: reference/ has 1 file (same file, 2 chunks)',
    depth1.find(d => d.dir === 'reference/')?.fileCount === 1);

  ok('aggregateDirectories depth=1: reference/ chunk count = 2',
    depth1.find(d => d.dir === 'reference/')?.chunkCount === 2);

  // depth=2
  const depth2 = aggregateDirectories(pts, null, 2);

  ok('aggregateDirectories depth=2: genres/metal/ present',
    depth2.some(d => d.dir === 'genres/metal/'));

  ok('aggregateDirectories depth=2: genres/pop/ present',
    depth2.some(d => d.dir === 'genres/pop/'));

  ok('aggregateDirectories depth=2: genres/metal/ has 2 files',
    depth2.find(d => d.dir === 'genres/metal/')?.fileCount === 2);

  // source_prefix scoping
  const scoped = aggregateDirectories(pts, 'genres/', 1);

  ok('aggregateDirectories source_prefix: only genres/ subdirs returned',
    scoped.every(d => d.dir.startsWith('genres/')));

  ok('aggregateDirectories source_prefix: genres/metal/ present in scoped',
    scoped.some(d => d.dir === 'genres/metal/'));

  ok('aggregateDirectories source_prefix: reference/ not in scoped',
    !scoped.some(d => d.dir === 'reference/'));

  // empty result
  ok('aggregateDirectories: non-matching prefix returns empty',
    aggregateDirectories(pts, 'nonexistent/', 1).length === 0);

  ok('aggregateDirectories: empty points returns empty',
    aggregateDirectories([], null, 1).length === 0);

  // Windows backslash normalisation
  const winPts = [
    { payload: { source_file: 'genres\\metal\\heavy.md' } },
    { payload: { source_file: 'reference\\promo\\social.md' } },
  ];
  const winDirs = aggregateDirectories(winPts, null, 1);
  ok('aggregateDirectories: normalises Windows backslash paths',
    winDirs.some(d => d.dir === 'genres/') && winDirs.some(d => d.dir === 'reference/'));

  ok('aggregateDirectories: normalised dirs use forward slashes',
    winDirs.every(d => !d.dir.includes('\\')));

  // source_prefix with Windows backslash
  const winScoped = aggregateDirectories(winPts, 'genres/', 1);
  ok('aggregateDirectories: source_prefix works with Windows backslash source_files',
    winScoped.length === 1 && winScoped[0].dir === 'genres/metal/');

  // ── findByTag: groupByFile ────────────────────────────────────────────────

  const taggedPts = [
    { payload: { source_file: 'ref/a.md', section: 'Planning', tags: ['release'] } },
    { payload: { source_file: 'ref/a.md', section: 'Checklist', tags: ['release'] } },
    { payload: { source_file: 'ref/a.md', section: 'Planning', tags: ['release'] } }, // dup section
    { payload: { source_file: 'skills/b.md', section: 'Workflow', tags: ['release'] } },
    { payload: { source_file: 'skills/b.md', section: '', tags: ['release'] } },       // empty section → intro
  ];

  const byFile = groupByFile(taggedPts);

  ok('groupByFile: two distinct files',
    byFile.size === 2);

  ok('groupByFile: ref/a.md has 3 chunks',
    byFile.get('ref/a.md')?.chunkCount === 3);

  ok('groupByFile: ref/a.md sections deduplicated',
    byFile.get('ref/a.md')?.sections.length === 2); // Planning, Checklist

  ok('groupByFile: skills/b.md has 2 chunks',
    byFile.get('skills/b.md')?.chunkCount === 2);

  ok('groupByFile: empty section becomes "intro"',
    byFile.get('skills/b.md')?.sections.includes('intro'));

  // ── formatChunkHeading ────────────────────────────────────────────────────

  const h0 = formatChunkHeading(0, 20, 'Overview');
  ok('formatChunkHeading: starts with ###',
    h0.startsWith('###'));

  ok('formatChunkHeading: contains chunk_index: 0',
    h0.includes('chunk_index: 0'));

  ok('formatChunkHeading: contains display: 1/20',
    h0.includes('display: 1/20'));

  ok('formatChunkHeading: contains section name',
    h0.includes('Overview'));

  const h4 = formatChunkHeading(4, 20, 'Details');
  ok('formatChunkHeading: chunk_index 4 → display 5/20',
    h4.includes('chunk_index: 4') && h4.includes('display: 5/20'));

  const hEmpty = formatChunkHeading(0, 5, '');
  ok('formatChunkHeading: empty section falls back to intro',
    hEmpty.includes('intro'));

  const hNull = formatChunkHeading(2, 10, null);
  ok('formatChunkHeading: null section falls back to intro',
    hNull.includes('intro'));
}
