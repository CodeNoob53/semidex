// Live regression smoke for source_file disambiguation behavior.
//
// Requires: live Qdrant with bench-retrieval-custom-raw indexed.
// ONNX_EMBED=1 is set automatically — no env prefix needed.
// NOT part of default CI or npm run smoke.
// Usage:
//   node benchmarks/retrieval/custom-raw/smoke-live-source-filter.js
//   npm run smoke:source-filter-live
//
// Fails with exit code 1 if:
//   - Qdrant or collection is unreachable
//   - unfiltered search does not surface both raw-config-dump.txt and
//     raw-mixed-incident-log.txt in the same result set
//   - config-filtered search does not resolve to qdrant_timeout_ms / 10000
//     or leaks incident-log content
//   - incident-filtered search does not resolve to "Qdrant timeout after 5000ms"
//     or leaks config content

process.env.ONNX_EMBED ??= '1';

await import('dotenv/config');

const { listCollections } =
  await import('../../../src/shared/core/qdrant.js');
const { handle } =
  await import('../../../src/mcp/tools/search.js');

const COLLECTION = 'bench-retrieval-custom-raw';
const QUERY      = 'What is the Qdrant timeout?';
const TOP        = 5;
const WINDOW     = 1;
const FORMAT     = 'compact';

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
  console.log('=== semidex live source_file disambiguation smoke ===');
  console.log(`Collection : ${COLLECTION}`);
  console.log(`Query      : ${QUERY}`);
  console.log(`Pattern    : top=${TOP}, window=${WINDOW}, window_format="${FORMAT}"`);
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

  // ── A: Unfiltered ─────────────────────────────────────────────────────────
  console.log('\n[A] Unfiltered search — expect both sources');
  const outA = await handle({ query: QUERY, collection: COLLECTION, top: TOP, window: WINDOW, window_format: FORMAT });

  check('A: includes raw-config-dump.txt',       outA.includes('raw-config-dump.txt'));
  check('A: includes raw-mixed-incident-log.txt', outA.includes('raw-mixed-incident-log.txt'));
  check('A: includes qdrant_timeout_ms',          outA.includes('qdrant_timeout_ms'));
  check('A: includes "Qdrant timeout after 5000ms"', outA.includes('Qdrant timeout after 5000ms'));

  // ── B: Config-filtered ────────────────────────────────────────────────────
  console.log('\n[B] Config-filtered — expect configured timeout 10000, no incident content');
  const outB = await handle({ query: QUERY, collection: COLLECTION, top: TOP, window: WINDOW, window_format: FORMAT, source_file: 'raw-config-dump.txt' });

  check('B: includes raw-config-dump.txt',             outB.includes('raw-config-dump.txt'));
  check('B: includes qdrant_timeout_ms',               outB.includes('qdrant_timeout_ms'));
  check('B: includes 10000',                           outB.includes('10000'));
  check('B: does NOT include raw-mixed-incident-log',  !outB.includes('raw-mixed-incident-log.txt'));
  check('B: does NOT include "Qdrant timeout after 5000ms"', !outB.includes('Qdrant timeout after 5000ms'));

  // ── C: Incident-filtered ──────────────────────────────────────────────────
  console.log('\n[C] Incident-filtered — expect observed timeout 5000ms, no config content');
  const outC = await handle({ query: QUERY, collection: COLLECTION, top: TOP, window: WINDOW, window_format: FORMAT, source_file: 'raw-mixed-incident-log.txt' });

  check('C: includes raw-mixed-incident-log.txt',      outC.includes('raw-mixed-incident-log.txt'));
  check('C: includes "Qdrant timeout after 5000ms"',   outC.includes('Qdrant timeout after 5000ms'));
  check('C: includes 5000ms',                          outC.includes('5000ms'));
  check('C: does NOT include raw-config-dump.txt',     !outC.includes('raw-config-dump.txt'));
  check('C: does NOT include qdrant_timeout_ms',       !outC.includes('qdrant_timeout_ms'));

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  const status = failed === 0 ? 'PASS' : 'FAIL';
  console.log(`Source filter smoke: ${status} — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error(`\nUnhandled error: ${e.message}`);
  process.exit(1);
});
