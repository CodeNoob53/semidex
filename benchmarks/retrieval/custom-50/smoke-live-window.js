// Live regression smoke for the getStoredMeta compact-window case.
//
// Requires: live Qdrant with bench-retrieval-custom-50 indexed.
// ONNX_EMBED=1 is set automatically — no env prefix needed.
// NOT part of default CI or npm run smoke.
// Usage:
//   node benchmarks/retrieval/custom-50/smoke-live-window.js
//   npm run smoke:window-live
//
// Fails with exit code 1 if:
//   - Qdrant or collection is unreachable
//   - qdrant.md#5 / Payload Indexes does not appear in top-3
//   - window_chunks for that result do not include a neighbor with is_match=false
//     from qdrant.md / getStoredMeta
//   - the compact snippet does not identify the neighbor as the getStoredMeta section
//     (i.e., the 150-char window must contain "getStoredMeta" and "discriminator")
//   - the full neighbor text (fetched to verify corpus content) is missing any of the
//     six discriminator field names

// Set ONNX_EMBED before any module that reads it at load time.
process.env.ONNX_EMBED ??= '1';

// dotenv must load before qdrant.js reads QDRANT_URL/QDRANT_KEY.
await import('dotenv/config');

const { listCollections, hybridSearch, fetchWindowChunks } =
  await import('../../../src/shared/core/qdrant.js');
const { assembleWindowChunks } =
  await import('../../../src/mcp/tools/search.js');
const { embedForSearch } =
  await import('../../../src/shared/core/embeddings.js');
const { createStorageAdapter } =
  await import('../../../src/core/storage/factory.js');
const { resolveExistingCollectionProfile } =
  await import('../../../src/core/embedding-profile/resolve.js');

const COLLECTION    = 'bench-retrieval-custom-50';
const QUERY         = 'getStoredMeta які поля читає з Qdrant payload';
const TOP           = 3;
const WINDOW        = 1;
const WINDOW_FORMAT = 'compact';

const EXPECTED_MATCH_SOURCE     = 'qdrant.md';
const EXPECTED_MATCH_SECTION    = 'Payload Indexes';
const EXPECTED_NEIGHBOR_SECTION = 'getStoredMeta';

// Tokens that must appear in the compact snippet (first 150 chars of the live chunk).
// The live chunk leads with the function signature and description — the field list
// appears later in the text, past the 150-char compact window. We assert on what
// the snippet does prove: that this is the getStoredMeta chunk and it names
// "discriminator fields".
const SNIPPET_TOKENS = ['getStoredMeta', 'discriminator'];

// Six field names that must appear somewhere in the full neighbor chunk text.
// Verified against the full text (not the compact snippet) to catch corpus regressions
// even when the field list falls outside the 150-char compact window.
const SIX_FIELDS = [
  'file_hash',
  'dense_provider',
  'dense_model',
  'sparse_provider',
  'embedding_schema_version',
  'vector_size',
];

let passed = 0;
let failed = 0;

function check(label, result, detail = '') {
  if (result) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

async function main() {
  console.log('=== semidex live window smoke ===');
  console.log(`Collection : ${COLLECTION}`);
  console.log(`Query      : ${QUERY}`);
  console.log(`Pattern    : top=${TOP}, window=${WINDOW}, window_format="${WINDOW_FORMAT}"`);
  console.log('');

  // ── Prereq: Qdrant reachable and collection present ───────────────────────
  console.log('[prereq] Qdrant connectivity');
  let collections;
  try {
    collections = await listCollections();
  } catch (e) {
    console.error(`  ✗ Qdrant unreachable: ${e.message}`);
    process.exit(1);
  }
  check('Qdrant reachable', true);
  check(
    `collection ${COLLECTION} exists`,
    collections.includes(COLLECTION),
    `available: ${collections.join(', ')}`
  );
  if (failed > 0) process.exit(1);

  // ── Resolve embedding profile ───────────────────────────────────────────────
  // embedForSearch requires a resolved profile object, not a bare collection
  // name (src/core/embeddings.js). This is a live smoke against an
  // already-indexed collection, so read its own recorded profile — never
  // re-derive from current env.
  console.log('\n[profile] Resolving embedding profile');
  const storageAdapter = createStorageAdapter();
  const profileResolution = await resolveExistingCollectionProfile(storageAdapter, COLLECTION);
  if (!profileResolution.resolved) {
    console.error(
      `  ✗ Cannot resolve embedding profile for "${COLLECTION}" (reason: ${profileResolution.reason}). ` +
      `The collection may be legacy/unmigrated — this smoke requires a collection with a valid native profile.`
    );
    process.exit(1);
  }
  const PROFILE = profileResolution.profile;
  check('embedding profile resolved', true);

  // ── Search ────────────────────────────────────────────────────────────────
  console.log('\n[search] Running hybrid search');
  const { dense, sparse } = await embedForSearch(PROFILE, QUERY);
  const results = await hybridSearch(COLLECTION, dense, sparse, TOP);

  check('search returned results', results.length > 0, `got ${results.length}`);
  if (failed > 0) process.exit(1);

  // ── Find qdrant.md / Payload Indexes in top-3 ────────────────────────────
  console.log('\n[rank check] Looking for qdrant.md / Payload Indexes in results');
  const matchResult = results.find(
    r => r.payload.source_file === EXPECTED_MATCH_SOURCE &&
         (r.payload.section || '').includes(EXPECTED_MATCH_SECTION)
  );

  check(
    `qdrant.md / "${EXPECTED_MATCH_SECTION}" in top-${TOP}`,
    !!matchResult,
    matchResult
      ? `chunk_index=${matchResult.payload.chunk_index}, score=${matchResult.score?.toFixed(3)}`
      : `ranks: ${results.map(r => `${r.payload.source_file}#${r.payload.chunk_index}`).join(', ')}`
  );
  if (failed > 0) process.exit(1);

  const chunkIndex = matchResult.payload.chunk_index;
  console.log(`  matched chunk_index: ${chunkIndex}, score: ${matchResult.score?.toFixed(3)}`);

  // ── Fetch window and assemble compact chunks ──────────────────────────────
  console.log('\n[window] Fetching window chunks');
  const wPoints = await fetchWindowChunks(COLLECTION, EXPECTED_MATCH_SOURCE, chunkIndex, WINDOW);
  const windowChunks = assembleWindowChunks(wPoints, chunkIndex, WINDOW_FORMAT);

  check('window_chunks returned', windowChunks.length > 0, `got ${windowChunks.length}`);
  check(
    'matched chunk present with is_match=true',
    windowChunks.some(w => w.is_match === true && w.chunk_index === chunkIndex)
  );

  // ── Find getStoredMeta neighbor ───────────────────────────────────────────
  console.log('\n[neighbor] Checking getStoredMeta neighbor chunk');
  const neighbor = windowChunks.find(
    w => w.is_match === false &&
         w.source_file === EXPECTED_MATCH_SOURCE &&
         (w.section || '').includes(EXPECTED_NEIGHBOR_SECTION)
  );

  check(
    `neighbor qdrant.md / "${EXPECTED_NEIGHBOR_SECTION}" present`,
    !!neighbor,
    neighbor
      ? `chunk_index=${neighbor.chunk_index}`
      : `neighbors: ${windowChunks.filter(w => !w.is_match).map(w => `${w.source_file}#${w.chunk_index} "${w.section}"`).join(', ') || 'none'}`
  );
  if (!neighbor) {
    console.error('\nFATAL: neighbor chunk not found — cannot check field names');
    process.exit(1);
  }

  check('neighbor is_match=false', neighbor.is_match === false);
  check('neighbor has text_snippet (compact)', typeof neighbor.text_snippet === 'string');
  check('neighbor has no .text field (compact)', !Object.prototype.hasOwnProperty.call(neighbor, 'text'));

  // ── Compact snippet identity tokens ───────────────────────────────────────
  // The live chunk leads with the function signature; the field list falls past
  // the 150-char compact window. Assert what the snippet does prove: that the
  // neighbor is identifiably the getStoredMeta section.
  console.log('\n[snippet] Checking compact snippet identity tokens');
  console.log(`  snippet (${neighbor.text_snippet?.length} chars): ${neighbor.text_snippet}`);
  console.log('');
  for (const token of SNIPPET_TOKENS) {
    check(`snippet contains "${token}"`, neighbor.text_snippet?.includes(token));
  }

  // ── Six field names in full neighbor text ─────────────────────────────────
  // Fetch the full text of the neighbor chunk to verify corpus content.
  // This catches regressions where field names are removed from the fixture,
  // even though compact format cannot surface them within 150 chars.
  console.log('\n[fields] Checking six discriminator fields in full neighbor text');
  const neighborFullPoints = await fetchWindowChunks(
    COLLECTION, EXPECTED_MATCH_SOURCE, neighbor.chunk_index, 0
  );
  const neighborFullText = neighborFullPoints[0]?.payload?.text ?? '';
  console.log(`  full text length: ${neighborFullText.length} chars`);
  console.log('');
  for (const field of SIX_FIELDS) {
    check(`full text contains "${field}"`, neighborFullText.includes(field));
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  const status = failed === 0 ? 'PASS' : 'FAIL';
  console.log(`Live window smoke: ${status} — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error(`\nUnhandled error: ${e.message}`);
  process.exit(1);
});
