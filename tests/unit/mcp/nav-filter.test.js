// Migrated from src/smoke/sections/48-nav-filter.js
// Pure — no Qdrant. Verifies skeleton_nav points never leak into search
// filters or tool aggregation counts.
import '../../helpers/setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withNavExcluded, isNavPoint, NAV_POINT_KIND } from '../../../src/mcp/tools/filters.js';
import { aggregateFiles } from '../../../src/mcp/tools/listFiles.js';
import { aggregateTags } from '../../../src/mcp/tools/listTags.js';
import { aggregateDirectories } from '../../../src/mcp/tools/listDirectories.js';
import { groupByFile } from '../../../src/mcp/tools/findByTag.js';

describe('withNavExcluded', () => {
  it('null filter → must_not nav exclusion', () => {
    const f = withNavExcluded(null);
    assert.equal(f.must_not?.length, 1);
    assert.equal(f.must_not[0].match.value, NAV_POINT_KIND);
  });

  it('existing must clauses are preserved and input is not mutated', () => {
    const base = { must: [{ key: 'source_file', match: { value: 'a.md' } }] };
    const merged = withNavExcluded(base);
    assert.equal(merged.must[0].key, 'source_file');
    assert.ok(merged.must_not.some(c => c.key === 'point_kind'));
    assert.equal(base.must_not, undefined, 'input filter was mutated');
  });

  it('existing must_not clauses are preserved', () => {
    const f = withNavExcluded({ must_not: [{ key: 'x', match: { value: 'y' } }] });
    assert.equal(f.must_not.length, 2);
  });

  it('is idempotent — no duplicate nav clause', () => {
    const once = withNavExcluded(null);
    const twice = withNavExcluded(once);
    const navClauses = twice.must_not.filter(
      c => c.key === 'point_kind' && c.match?.value === NAV_POINT_KIND,
    );
    assert.equal(navClauses.length, 1);
  });

  it('another point_kind clause does not block or get replaced by the nav exclusion', () => {
    const f = withNavExcluded({
      must_not: [{ key: 'point_kind', match: { value: 'retrieval_content' } }],
    });
    assert.ok(f.must_not.some(c => c.match?.value === NAV_POINT_KIND));
    assert.ok(f.must_not.some(c => c.match?.value === 'retrieval_content'));
  });
});

const navPoint = { payload: { source_file: 'a.md', point_kind: 'skeleton_nav' } };
const contentPoint = { payload: { source_file: 'a.md', point_kind: 'retrieval_content', chunk_index: 0, tags: ['t'] } };
const legacyPoint = { payload: { source_file: 'a.md', chunk_index: 0, section: 's', tags: ['t'] } };

describe('isNavPoint', () => {
  it('detects skeleton_nav points', () => {
    assert.equal(isNavPoint(navPoint), true);
  });

  it('passes retrieval_content points', () => {
    assert.equal(isNavPoint(contentPoint), false);
  });

  it('passes legacy points without point_kind', () => {
    assert.equal(isNavPoint(legacyPoint), false);
  });
});

describe('aggregations exclude nav points from counts', () => {
  const points = [legacyPoint, contentPoint, navPoint, navPoint];

  it('aggregateFiles counts only content chunks', () => {
    const files = aggregateFiles(points);
    assert.equal(files.length, 1);
    assert.equal(files[0].chunkCount, 2);
  });

  it('aggregateTags counts only content chunks', () => {
    const tags = aggregateTags(points);
    assert.equal(tags.length, 1);
    assert.equal(tags[0].chunkCount, 2);
  });

  it('aggregateDirectories counts only content chunks', () => {
    const dirs = aggregateDirectories(
      points.map(p => ({ payload: { ...p.payload, source_file: 'dir/a.md' } })),
    );
    assert.equal(dirs.length, 1);
    assert.equal(dirs[0].chunkCount, 2);
  });

  it('groupByFile counts only content chunks', () => {
    const grouped = groupByFile(points);
    assert.equal(grouped.get('a.md')?.chunkCount, 2);
  });
});
