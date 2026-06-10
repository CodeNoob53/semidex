// Skeleton task-5 smoke: nav exclusion in search filters and tool aggregations.
// Pure — no Qdrant.

export default async function ({ ok }) {
  console.log('\n[48] nav filter — withNavExcluded + aggregation guards');

  const { withNavExcluded, isNavPoint, NAV_POINT_KIND } = await import('../../mcp/tools/filters.js');
  const { aggregateFiles } = await import('../../mcp/tools/listFiles.js');
  const { aggregateTags } = await import('../../mcp/tools/listTags.js');
  const { aggregateDirectories } = await import('../../mcp/tools/listDirectories.js');
  const { groupByFile } = await import('../../mcp/tools/findByTag.js');

  // ── withNavExcluded ──────────────────────────────────────────────────────────
  const fromNull = withNavExcluded(null);
  ok('null filter → must_not exclusion',
     fromNull.must_not?.length === 1 && fromNull.must_not[0].match.value === NAV_POINT_KIND);

  const base = { must: [{ key: 'source_file', match: { value: 'a.md' } }] };
  const merged = withNavExcluded(base);
  ok('existing must preserved', merged.must === base.must || merged.must[0].key === 'source_file');
  ok('exclusion appended', merged.must_not.some(c => c.key === 'point_kind'));
  ok('input not mutated', base.must_not === undefined);

  const withExisting = withNavExcluded({ must_not: [{ key: 'x', match: { value: 'y' } }] });
  ok('existing must_not preserved', withExisting.must_not.length === 2);
  ok('idempotent (no duplicate nav clause)',
     withNavExcluded(merged).must_not.filter(c => c.key === 'point_kind' && c.match?.value === NAV_POINT_KIND).length === 1);

  // Other point_kind must_not clause must NOT block adding the nav exclusion.
  const withOtherPointKind = withNavExcluded({
    must_not: [{ key: 'point_kind', match: { value: 'retrieval_content' } }],
  });
  ok('other point_kind clause does not block nav exclusion',
     withOtherPointKind.must_not.some(c => c.key === 'point_kind' && c.match?.value === NAV_POINT_KIND));
  ok('other point_kind clause preserved alongside nav exclusion',
     withOtherPointKind.must_not.some(c => c.match?.value === 'retrieval_content'));

  // ── isNavPoint ───────────────────────────────────────────────────────────────
  const nav     = { payload: { source_file: 'a.md', point_kind: 'skeleton_nav' } };
  const content = { payload: { source_file: 'a.md', point_kind: 'retrieval_content', chunk_index: 0, tags: ['t'] } };
  const legacy  = { payload: { source_file: 'a.md', chunk_index: 0, section: 's', tags: ['t'] } };
  ok('nav point detected', isNavPoint(nav));
  ok('retrieval point passes', !isNavPoint(content));
  ok('legacy point passes (no field)', !isNavPoint(legacy));

  // ── aggregations skip nav points (B2: counts must not inflate) ──────────────
  const points = [legacy, content, nav, nav];

  const files = aggregateFiles(points);
  ok('listFiles: nav excluded from chunkCount',
     files.length === 1 && files[0].chunkCount === 2);

  const tags = aggregateTags(points);
  ok('listTags: nav excluded from tag counts',
     tags.length === 1 && tags[0].chunkCount === 2);

  const dirs = aggregateDirectories(points.map(p => ({ payload: { ...p.payload, source_file: 'dir/a.md' } })));
  ok('listDirectories: nav excluded from counts',
     dirs.length === 1 && dirs[0].chunkCount === 2);

  const grouped = groupByFile(points);
  ok('findByTag: nav excluded from grouping',
     grouped.get('a.md')?.chunkCount === 2);
}
