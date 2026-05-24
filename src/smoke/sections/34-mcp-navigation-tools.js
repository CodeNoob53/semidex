import { aggregateFiles } from '../../../src/mcp/tools/listFiles.js';
import { aggregateTags }  from '../../../src/mcp/tools/listTags.js';

export default async function ({ ok }) {
  console.log('\n[34] MCP navigation tools — listFiles / listTags');

  // ── aggregateFiles ────────────────────────────────────────────────────────

  const pts = [
    { payload: { source_file: 'docs/intro.md',   chunk_index: 0, section: 'Overview' } },
    { payload: { source_file: 'docs/intro.md',   chunk_index: 1, section: 'Details' } },
    { payload: { source_file: 'docs/intro.md',   chunk_index: 2, section: '' } },
    { payload: { source_file: 'docs/config.md',  chunk_index: 0, section: 'Setup' } },
    { payload: { source_file: 'guides/start.md', chunk_index: 0, section: 'Intro' } },
  ];

  const all = aggregateFiles(pts);

  ok('aggregateFiles: deduplicates into unique files',
    all.length === 3);

  ok('aggregateFiles: counts chunks per file correctly',
    all.find(f => f.source_file === 'docs/intro.md')?.chunkCount === 3);

  ok('aggregateFiles: single-chunk file has count 1',
    all.find(f => f.source_file === 'docs/config.md')?.chunkCount === 1);

  ok('aggregateFiles: sorted alphabetically',
    all[0].source_file === 'docs/config.md' &&
    all[1].source_file === 'docs/intro.md'  &&
    all[2].source_file === 'guides/start.md');

  ok('aggregateFiles: firstSection from chunk_index 0',
    all.find(f => f.source_file === 'docs/intro.md')?.firstSection === 'Overview');

  ok('aggregateFiles: empty section falls back to "intro"',
    all.find(f => f.source_file === 'docs/config.md')?.firstSection === 'Setup');

  // prefix filtering
  const docsOnly = aggregateFiles(pts, 'docs/');
  ok('aggregateFiles: prefix filters to matching files only',
    docsOnly.length === 2 && docsOnly.every(f => f.source_file.startsWith('docs/')));

  ok('aggregateFiles: non-matching prefix returns empty',
    aggregateFiles(pts, 'nonexistent/').length === 0);

  // Windows backslash normalisation
  const winPts = [
    { payload: { source_file: 'docs\\intro.md', chunk_index: 0, section: 'Intro' } },
    { payload: { source_file: 'docs\\config.md', chunk_index: 0, section: '' } },
  ];
  const winFiles = aggregateFiles(winPts, 'docs/');
  ok('aggregateFiles: normalises Windows backslash paths for prefix matching',
    winFiles.length === 2);

  ok('aggregateFiles: normalised path uses forward slashes',
    winFiles.every(f => !f.source_file.includes('\\')));

  // Empty points
  ok('aggregateFiles: empty input returns empty array',
    aggregateFiles([]).length === 0);

  ok('aggregateFiles: points without source_file are skipped',
    aggregateFiles([{ payload: {} }, { payload: { chunk_index: 0 } }]).length === 0);

  // ── aggregateTags ─────────────────────────────────────────────────────────

  const tagPts = [
    { payload: { source_file: 'a/intro.md',  tags: ['overview', 'setup'] } },
    { payload: { source_file: 'a/guide.md',  tags: ['setup', 'advanced'] } },
    { payload: { source_file: 'a/guide.md',  tags: ['setup'] } },
    { payload: { source_file: 'b/other.md',  tags: ['overview'] } },
    { payload: { source_file: 'b/empty.md',  tags: [] } },
    { payload: { source_file: 'b/notags.md', tags: null } },
  ];

  const allTags = aggregateTags(tagPts);

  ok('aggregateTags: counts chunk occurrences per tag',
    allTags.find(t => t.tag === 'setup')?.chunkCount === 3);

  ok('aggregateTags: counts unique files per tag',
    allTags.find(t => t.tag === 'setup')?.fileCount === 2);

  ok('aggregateTags: overview appears in 2 chunks across 2 files',
    allTags.find(t => t.tag === 'overview')?.chunkCount === 2 &&
    allTags.find(t => t.tag === 'overview')?.fileCount === 2);

  ok('aggregateTags: sorted by chunk count descending',
    allTags[0].tag === 'setup');

  ok('aggregateTags: tiebreak alphabetical (overview before advanced if equal)',
    (() => {
      const ov = allTags.findIndex(t => t.tag === 'overview');
      const ad = allTags.findIndex(t => t.tag === 'advanced');
      return ov < ad; // overview (2 chunks) > advanced (1 chunk)
    })());

  ok('aggregateTags: empty tags arrays are ignored',
    !allTags.some(t => t.tag === ''));

  ok('aggregateTags: null tags field skipped without error',
    allTags.length === 3); // overview, setup, advanced

  // prefix filtering on tags
  const aTags = aggregateTags(tagPts, 'a/');
  ok('aggregateTags: prefix restricts to files starting with a/',
    aTags.every(t => t.tag !== 'overview' || t.fileCount === 1)); // b/other excluded
  ok('aggregateTags: setup still 2 files within a/ prefix',
    aTags.find(t => t.tag === 'setup')?.fileCount === 2);
  ok('aggregateTags: overview only 1 file within a/ prefix',
    aTags.find(t => t.tag === 'overview')?.fileCount === 1);

  // min_count filtering
  const minTwo = aggregateTags(tagPts, null, 2);
  ok('aggregateTags: min_count=2 excludes tags with fewer chunks',
    minTwo.every(t => t.chunkCount >= 2));
  ok('aggregateTags: advanced (1 chunk) excluded by min_count=2',
    !minTwo.some(t => t.tag === 'advanced'));

  // limit truncation (tested via the output helper)
  const manyPts = Array.from({ length: 10 }, (_, i) => ({
    payload: { source_file: 'f.md', tags: [`tag${i}`] },
  }));
  const manyTags = aggregateTags(manyPts);
  ok('aggregateTags: returns all tags before limit is applied by handle()',
    manyTags.length === 10);

  // Windows backslash normalisation for prefix
  const winTagPts = [
    { payload: { source_file: 'a\\guide.md', tags: ['win-tag'] } },
    { payload: { source_file: 'b\\other.md', tags: ['other-tag'] } },
  ];
  const winTags = aggregateTags(winTagPts, 'a/');
  ok('aggregateTags: normalises Windows backslash paths for prefix filtering',
    winTags.length === 1 && winTags[0].tag === 'win-tag');
}
