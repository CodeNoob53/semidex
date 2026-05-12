// Live regression smoke for agent answer-policy evidence contracts.
//
// Requires: live Qdrant with bench-retrieval-custom-raw indexed.
// ONNX_EMBED=1 is set automatically — no env prefix needed.
// NOT part of default CI or npm run smoke.
// Usage:
//   node benchmarks/retrieval/custom-raw/smoke-live-answer-policy.js
//   npm run smoke:answer-policy-live
//
// Each case validates the *evidence conditions* that force the correct agent decision.
// No LLM calls — correctness is asserted on retrieved chunk content only.
//
// Cases:
//   A. CLARIFICATION_REQUIRED   — ambiguous unfiltered timeout query returns both valid contexts
//   B. ANSWER_CONFIG_VALUE       — config-scoped query isolates configured 10000 value
//   C. ANSWER_INCIDENT_VALUE     — incident-scoped query isolates observed 5000ms value
//   D. SCOPE_MISMATCH_REFUSAL_REQUIRED — staging query returns no staging evidence
//   E. ANSWER_OBSERVED_PROD_SERVICE_VALUE — prod-svc query surfaces qdrant-prod-svc + 5000ms

process.env.ONNX_EMBED ??= '1';

await import('dotenv/config');

const { listCollections } =
  await import('../../../src/core/qdrant.js');
const { handle } =
  await import('../../../src/mcp/tools/search.js');

const COLLECTION = 'bench-retrieval-custom-raw';
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

function verdict(label) {
  console.log(`  → verdict: ${label}`);
}

async function search(query, extra = {}) {
  return handle({ query, collection: COLLECTION, top: TOP, window: WINDOW, window_format: FORMAT, ...extra });
}

async function main() {
  console.log('=== semidex live answer-policy evidence smoke ===');
  console.log(`Collection : ${COLLECTION}`);
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

  // ── A: Ambiguous timeout — CLARIFICATION_REQUIRED ─────────────────────────
  // Both valid meanings appear in returned evidence; agent must surface both
  // and ask for clarification rather than answering from rank-1 alone.
  console.log('\n[A] Ambiguous unfiltered timeout — CLARIFICATION_REQUIRED');
  const outA = await search('What is the Qdrant timeout?');

  check('A: includes raw-config-dump.txt',             outA.includes('raw-config-dump.txt'));
  check('A: includes raw-mixed-incident-log.txt',       outA.includes('raw-mixed-incident-log.txt'));
  check('A: includes qdrant_timeout_ms',               outA.includes('qdrant_timeout_ms'));
  check('A: includes 10000',                           outA.includes('10000'));
  check('A: includes "Qdrant timeout after 5000ms"',   outA.includes('Qdrant timeout after 5000ms'));
  verdict('CLARIFICATION_REQUIRED — both configured (10000) and observed (5000ms) values present');

  // ── B: Config-scoped timeout — ANSWER_CONFIG_VALUE ────────────────────────
  // Explicit prod-config scope; agent should answer with 10000, not the incident value.
  console.log('\n[B] Config-scoped timeout — ANSWER_CONFIG_VALUE');
  const outB = await search(
    'What is the Qdrant timeout in the prod config?',
    { source_file: 'raw-config-dump.txt' }
  );

  check('B: includes raw-config-dump.txt',                  outB.includes('raw-config-dump.txt'));
  check('B: includes qdrant_timeout_ms',                    outB.includes('qdrant_timeout_ms'));
  check('B: includes 10000',                                outB.includes('10000'));
  check('B: does NOT include raw-mixed-incident-log.txt',   !outB.includes('raw-mixed-incident-log.txt'));
  check('B: does NOT include "Qdrant timeout after 5000ms"', !outB.includes('Qdrant timeout after 5000ms'));
  verdict('ANSWER_CONFIG_VALUE — evidence is config-only; answer: qdrant_timeout_ms = 10000');

  // ── C: Incident-scoped timeout — ANSWER_INCIDENT_VALUE ───────────────────
  // Explicit incident-log scope; agent should answer with 5000ms, not configured value.
  console.log('\n[C] Incident-scoped timeout — ANSWER_INCIDENT_VALUE');
  const outC = await search(
    'What timeout happened in the incident log?',
    { source_file: 'raw-mixed-incident-log.txt' }
  );

  check('C: includes raw-mixed-incident-log.txt',      outC.includes('raw-mixed-incident-log.txt'));
  check('C: includes "Qdrant timeout after 5000ms"',   outC.includes('Qdrant timeout after 5000ms'));
  check('C: includes 5000ms',                          outC.includes('5000ms'));
  check('C: does NOT include raw-config-dump.txt',     !outC.includes('raw-config-dump.txt'));
  check('C: does NOT include qdrant_timeout_ms',       !outC.includes('qdrant_timeout_ms'));
  verdict('ANSWER_INCIDENT_VALUE — evidence is incident-only; answer: Qdrant timeout after 5000ms');

  // ── D: Staging scope sentinel — SCOPE_MISMATCH_REFUSAL_REQUIRED ──────────
  // Query asks about staging cluster. Corpus contains only prod evidence.
  // Agent must detect scope mismatch and refuse rather than answer from prod data.
  // Assertion: no staging-specific terms appear in retrieved chunks.
  console.log('\n[D] Staging scope sentinel — SCOPE_MISMATCH_REFUSAL_REQUIRED');
  const outD = await search('What is the Qdrant timeout for the staging cluster?');

  // The corpus has no staging content — no chunk should surface these terms.
  check('D: does NOT include "staging"',              !outD.toLowerCase().includes('staging'));
  check('D: does NOT include "qdrant-staging"',       !outD.toLowerCase().includes('qdrant-staging'));
  // Prod evidence will be retrieved (it is the closest match); agent must notice the mismatch.
  // We assert prod evidence IS present so the mismatch is detectable.
  check('D: prod evidence IS present (mismatch detectable)', outD.includes('raw-config-dump.txt') || outD.includes('raw-mixed-incident-log.txt'));
  verdict('SCOPE_MISMATCH_REFUSAL_REQUIRED — query scope "staging" absent from all evidence; agent must refuse');

  // ── E: Prod service scope — ANSWER_OBSERVED_PROD_SERVICE_VALUE ───────────
  // Query names qdrant-prod-svc explicitly. Incident log contains the connection line.
  // Agent should answer: timeout observed during qdrant-prod-svc connection.
  console.log('\n[E] Prod-service timeout — ANSWER_OBSERVED_PROD_SERVICE_VALUE');
  const outE = await search('What timeout did qdrant-prod-svc hit?');

  check('E: includes qdrant-prod-svc',                 outE.includes('qdrant-prod-svc'));
  check('E: includes raw-mixed-incident-log.txt',       outE.includes('raw-mixed-incident-log.txt'));
  check('E: includes "Qdrant timeout after 5000ms"',   outE.includes('Qdrant timeout after 5000ms'));
  verdict('ANSWER_OBSERVED_PROD_SERVICE_VALUE — evidence names qdrant-prod-svc and observed 5000ms');

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  const status = failed === 0 ? 'PASS' : 'FAIL';
  console.log(`Answer-policy smoke: ${status} — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error(`\nUnhandled error: ${e.message}`);
  process.exit(1);
});
