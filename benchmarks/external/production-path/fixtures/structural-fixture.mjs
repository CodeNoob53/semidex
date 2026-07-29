// Internal structural retrieval fixture — NOT an external benchmark.
// Verifies Qdrant Cloud's 512-token window + the entity_raw/fragment
// topology (src/indexer/phases/entity-split.js) preserve retrievability
// for oversized table/code_block/checklist entities, through the real
// indexer + runHybridSearch() production path.
//
// Extends benchmarks/spikes/qdrant-cloud-inference-accept.mjs's own
// buildFixtureMarkdown() shape (prose -> ## heading -> structural node ->
// repeat) to three node types instead of one: an oversized table (the
// proven 40-row pattern), an oversized fenced code block WITH one
// deliberately >2000-char minified line (stresses entity-split's
// character-boundary splitOversizedUnitIntoPieces path, distinct from the
// table's per-row split), and an oversized checklist (every item must
// carry `- [ ] ` — a plain bulleted list is classified `list`, not
// `checklist`, by src/indexer/phases/skeleton.js's isChecklist()).

export const STRUCTURAL_FIXTURE_DOC_ID = 'structural-fixture-001';

// One exact, unique identifier per structural node — each gives a
// targeted retrievability probe distinct from generic semantic search.
export const STRUCTURAL_FIXTURE_EXACT_IDENTIFIERS = Object.freeze({
  table: 'ORDER-88213-XR',
  codeBlock: 'sku_final_v9_do_not_delete',
  checklist: 'RELEASE-CHECKLIST-Q3-REV2',
});

export const STRUCTURAL_FIXTURE_QUERIES = Object.freeze([
  { id: 'q-table', text: 'What is ORDER-88213-XR?', relevantDocIds: [STRUCTURAL_FIXTURE_DOC_ID] },
  { id: 'q-code', text: 'Where is sku_final_v9_do_not_delete referenced in the code?', relevantDocIds: [STRUCTURAL_FIXTURE_DOC_ID] },
  { id: 'q-checklist', text: 'What items are on the RELEASE-CHECKLIST-Q3-REV2?', relevantDocIds: [STRUCTURAL_FIXTURE_DOC_ID] },
]);

function buildOversizedTable() {
  const rows = [];
  for (let i = 1; i <= 40; i++) {
    rows.push(`| item-${i} | some descriptive value number ${i} | ${i % 2 === 0 ? 'enabled' : 'disabled'} |`);
  }
  return [
    '| Key | Description | Status |',
    '|---|---|---|',
    ...rows,
  ].join('\n');
}

function buildOversizedCodeBlock() {
  const lines = ['```js'];
  for (let i = 1; i <= 60; i++) {
    lines.push(`function step${i}(input) { return input * ${i} + 1; } // normal line ${i}`);
  }
  // One deliberately long, minified single line (>2000 chars) — the "hard
  // case" a table's per-row split doesn't cover: an entity-split unit
  // that cannot itself be broken at a natural row/item boundary and must
  // fall back to character-boundary splitting.
  const minified = `var sku_final_v9_do_not_delete=(function(){${'var x=1;'.repeat(280)}return x;})();`;
  lines.push(minified);
  lines.push('```');
  return lines.join('\n');
}

function buildOversizedChecklist() {
  const items = [];
  for (let i = 1; i <= 45; i++) {
    items.push(`- [ ] Task ${i}: complete step ${i} of the RELEASE-CHECKLIST-Q3-REV2 release process, verifying subsystem ${i} passes its own smoke suite before sign-off.`);
  }
  return items.join('\n');
}

/** Builds the fixture document's full Markdown content — one file, three
 * oversized structural nodes, prose (with the exact identifier) on both
 * sides of each. */
export function buildStructuralFixtureMarkdown() {
  return [
    '# Structural Retrieval Fixture',
    '',
    'This document is an internal fixture verifying that oversized structural entities remain retrievable after entity-split. It is not a natural-language document and not an external benchmark.',
    '',
    '## Order Reference Table',
    '',
    `Order ORDER-88213-XR is documented in the following configuration table, which is intentionally large enough to exceed a small dense model's token window as one whole entity.`,
    '',
    buildOversizedTable(),
    '',
    'Closing remarks after the table, confirming prose on both sides of the table entity survives indexing intact.',
    '',
    '## Build Script Reference',
    '',
    `The build script below defines sku_final_v9_do_not_delete, a symbol referenced by the release pipeline. The code block below is intentionally large, including one very long minified line that cannot be split at a natural line boundary.`,
    '',
    buildOversizedCodeBlock(),
    '',
    'Closing remarks after the code block, confirming prose on both sides of the code_block entity survives indexing intact.',
    '',
    '## Release Checklist',
    '',
    `The RELEASE-CHECKLIST-Q3-REV2 enumerates every step required before this release ships. The checklist below is intentionally large enough to exceed a small dense model's token window as one whole entity.`,
    '',
    buildOversizedChecklist(),
    '',
    'Closing remarks after the checklist, confirming prose on both sides of the checklist entity survives indexing intact.',
    '',
  ].join('\n');
}

/** A handful of small, unrelated distractor documents — kept minimal
 * (this suite is explicitly internal/non-degenerate-metrics-only, not a
 * realistic-difficulty benchmark) so computeMetrics() isn't degenerate
 * on a 1-document corpus. */
export function buildDistractorDocuments() {
  return new Map([
    ['distractor-1', { text: '# Weather Report\n\nToday is sunny with a light breeze from the west.' }],
    ['distractor-2', { text: '# Recipe: Tomato Soup\n\nSimmer tomatoes, onion, and garlic for twenty minutes.' }],
    ['distractor-3', { text: '# History Note\n\nThe printing press was invented in the fifteenth century.' }],
  ]);
}

/** Full corpus for this suite: the one fixture doc + a few distractors. */
export function buildStructuralFixtureCorpus() {
  const corpus = new Map([[STRUCTURAL_FIXTURE_DOC_ID, { text: buildStructuralFixtureMarkdown() }]]);
  for (const [docId, doc] of buildDistractorDocuments()) corpus.set(docId, doc);
  return corpus;
}

export function buildStructuralFixtureQueriesMap() {
  return new Map(STRUCTURAL_FIXTURE_QUERIES.map((q) => [q.id, q.text]));
}

export function buildStructuralFixtureQrels() {
  return new Map(STRUCTURAL_FIXTURE_QUERIES.map((q) => [q.id, new Map(q.relevantDocIds.map((docId) => [docId, 1]))]));
}
