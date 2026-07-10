// Source-level regression guards for src/core/qdrant/store.js's nav-point
// exclusion — no live Qdrant needed (network-backed store.js functions are
// checked for correct wiring here, not invoked; see
// tests/unit/core/storage/qdrant-adapter.test.js's header comment for the
// same "belongs to a live-smoke tier" rationale this file follows).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  fileURLToPath(new URL('../../../src/core/qdrant/store.js', import.meta.url)),
  'utf-8',
);

describe('fetchWindowChunks() excludes skeleton_nav points (Phase 3F regression)', () => {
  it('wraps its filter in withNavExcluded, same as every other content-facing scroll', () => {
    // Regression: fetchWindowChunks() (the admin file view's windowed
    // chunk fetch, also used by the MCP getChunk tool) built its Qdrant
    // filter with only a source_file + chunk_index range clause — no
    // point_kind exclusion at all, unlike listSourceFiles/search/
    // getFirstContentChunkByParent, which all route through
    // withNavExcluded(). A skeleton_nav point that happens to carry a
    // chunk_index in the requested range would have silently slipped into
    // "content" results.
    const start = src.indexOf('export async function fetchWindowChunks');
    const end = src.indexOf('\n}\n', start);
    const fn = src.slice(start, end);
    assert.match(fn, /withNavExcluded\(/, 'fetchWindowChunks must filter through withNavExcluded');
  });
});

describe('getFileChunks() — whole-file primitive for the admin UI file view (Phase 3F)', () => {
  it('is defined, exhaustively paginated, and excludes nav points both server- and client-side', () => {
    const start = src.indexOf('export async function getFileChunks');
    assert.ok(start > -1, 'getFileChunks must be defined');
    const end = src.indexOf('\n}\n', start);
    const fn = src.slice(start, end);
    assert.match(fn, /scrollAllFiltered\(/,
      'must paginate exhaustively (scrollAllFiltered), not a single-page scroll() — a file can have more chunks than one page');
    assert.match(fn, /withNavExcluded\(/, 'must filter nav points out server-side');
    assert.match(fn, /isNavPoint\(/, 'must also defensively filter nav points client-side, matching getFirstContentChunkByParent\'s belt-and-suspenders pattern');
    assert.match(fn, /source_file/, 'must filter by source_file');
    assert.match(fn, /sort\(/, 'must return chunks in chunk_index order');
  });
});

describe('countContentPoints() — exact nav-excluded count for the admin UI collection header (Phase 3G)', () => {
  it('is defined and counts through withNavExcluded, not the raw collection total', () => {
    // Code-review fix: Qdrant's getCollectionInfo().points_count is a raw
    // total that includes skeleton_nav points on any collection with
    // skeleton navigation on. The admin header's "N chunks" chip needs an
    // honest count of real content points only — this is that primitive.
    const start = src.indexOf('export async function countContentPoints');
    assert.ok(start > -1, 'countContentPoints must be defined');
    const end = src.indexOf('\n}\n', start);
    const fn = src.slice(start, end);
    assert.match(fn, /withNavExcluded\(/, 'must exclude nav points via the shared withNavExcluded filter, same as every other content-facing query');
    assert.match(fn, /client\.count\(/, 'must use Qdrant\'s server-side count endpoint, not scroll+length (cheap, no payload/vector transfer)');
    assert.match(fn, /exact:\s*true/, 'must request an exact count, not an approximate one');
  });
});
