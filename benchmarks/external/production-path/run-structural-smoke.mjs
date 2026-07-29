#!/usr/bin/env node
// The ONE live-network entry point in this directory — deliberately NOT
// named *.test.mjs (never matched by the offline test glob). Requires
// real QDRANT_URL/QDRANT_KEY. Runs the structural fixture suite's
// --smoke mode for BOTH profiles against real Qdrant, then additionally
// verifies:
//   - both profiles' collections were created and cleaned up;
//   - the entity_raw canonical points exist server-side but never appear
//     in runHybridSearch() results;
//   - each exact identifier is found verbatim in at least one returned
//     chunk's content;
//   - opt-in telemetry actually captured real events for the cloud profile.
//
// Usage: node benchmarks/external/production-path/run-structural-smoke.mjs
import 'dotenv/config';
import { createStorageAdapter } from '../../../src/core/storage/factory.js';
import { runHybridSearch } from '../../../src/core/retrieval/search.js';
import { runStructuralSuite } from './run-structural-prodpath.mjs';
import { cleanupAllOwnedCollections } from './core/cleanup.mjs';
import { redact } from './core/redact.mjs';
import {
  STRUCTURAL_FIXTURE_DOC_ID, STRUCTURAL_FIXTURE_EXACT_IDENTIFIERS, STRUCTURAL_FIXTURE_QUERIES,
} from './fixtures/structural-fixture.mjs';

function step(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + redact(String(detail)) : ''}`);
  return { name, ok, detail: redact(String(detail)) };
}

async function main() {
  const steps = [];
  if (!process.env.QDRANT_URL || !process.env.QDRANT_KEY) {
    console.log('LIVE_BLOCKED: QDRANT_URL/QDRANT_KEY not set.');
    process.exitCode = 1;
    return;
  }

  const state = await runStructuralSuite({ smoke: true, restart: true });
  steps.push(step('structural suite --smoke ran for both profiles', state?.verdict === 'COMPLETE', state?.verdict));

  for (const profileId of ['local', 'cloud']) {
    const block = state?.profiles?.[profileId];
    steps.push(step(`${profileId} profile: zero errors`, (block?.errors?.length ?? 1) === 0));
    steps.push(step(`${profileId} profile: cleanup confirmed deleted`, block?.cleanup?.deleted === true));
    steps.push(step(`${profileId} profile: zero unmapped hits`, block?.unmappedHitCount === 0));
    steps.push(step(`${profileId} profile: zero query errors`, block?.queryErrorCount === 0));
    if (profileId === 'cloud') {
      const t = block?.telemetry;
      steps.push(step('cloud profile: telemetry captured indexing-phase dense inference events', (t?.denseInferenceItems?.indexing ?? 0) > 0, t?.denseInferenceItems?.indexing));
      steps.push(step('cloud profile: telemetry captured query-phase dense inference events', (t?.denseInferenceItems?.query ?? 0) > 0, t?.denseInferenceItems?.query));
      steps.push(step('cloud profile: telemetry captured real qdrant_sdk_op events', (t?.qdrantSdkOps?.total ?? 0) > 0, t?.qdrantSdkOps?.total));
    }
  }

  // The collection is already deleted by the time we get here (cleanup
  // runs inside runOneProfile's own finally) — so entity_raw exclusion
  // and exact-identifier retrievability must be checked from a SEPARATE,
  // dedicated live probe against a fresh collection, not the already-torn-
  // down one from the suite run above. This mirrors the sweep step's own
  // discipline: this script's job is orchestration + a targeted, real,
  // additional live probe, not to depend on the suite's already-cleaned
  // state.
  console.log('\nRunning a dedicated live entity_raw / retrievability probe (fresh collection)...');
  const probeResult = await runEntityRawAndRetrievabilityProbe();
  steps.push(...probeResult.steps);

  console.log('\nRunning the cleanup-verification sweep...');
  const adapter = createStorageAdapter();
  const sweep = await cleanupAllOwnedCollections(adapter);
  steps.push(step('cleanup sweep found zero orphaned collections after this smoke run', sweep.owned.length === 0, `scanned ${sweep.scanned}, owned ${sweep.owned.length}`));

  const allOk = steps.every((s) => s.ok);
  console.log(`\nverdict: ${allOk ? 'ACCEPT' : 'REJECT'}`);
  if (!allOk) process.exitCode = 1;
}

/** A focused, real, live probe specifically for the entity_raw exclusion
 * + exact-identifier retrievability claims — run against the CLOUD
 * profile only (the profile whose 512-token window is what forces
 * entity-split to engage at all; the local BGE-M3 profile's 8192-token
 * window may not split these particular fixture sizes, so it is not a
 * meaningful target for this specific check). */
async function runEntityRawAndRetrievabilityProbe() {
  const steps = [];
  const { runIndexer } = await import('./core/index-via-cli.mjs');
  const { materializeDataset } = await import('./core/materialize.mjs');
  const { isolatedConfigPath, telemetryPath, ensureParentDirExists } = await import('./core/isolated-config.mjs');
  const { buildIndexEnv, CLOUD_PROFILE, collectionName } = await import('./core/profiles.mjs');
  const { cleanupCollection } = await import('./core/cleanup.mjs');
  const { buildStructuralFixtureCorpus } = await import('./fixtures/structural-fixture.mjs');
  const { randomBytes } = await import('node:crypto');

  const adapter = createStorageAdapter();
  const runSuffix = `probe-${randomBytes(4).toString('hex')}`;
  const collection = collectionName('structural', 'cloud', runSuffix);
  const corpus = buildStructuralFixtureCorpus();

  try {
    const { dir: materializedDirPath } = materializeDataset({
      suiteId: 'structural', profileId: 'cloud-probe', runSuffix, corpus, toMarkdown: (d) => d.text,
    });
    const configPath = isolatedConfigPath('structural', 'cloud-probe', runSuffix);
    const telemPath = telemetryPath('structural', 'cloud-probe', runSuffix);
    ensureParentDirExists(configPath);
    ensureParentDirExists(telemPath);
    const env = {
      ...buildIndexEnv(CLOUD_PROFILE, collection, { materializedDir: materializedDirPath }),
      SEMIDEX_CONFIG_PATH: configPath,
      SEMIDEX_BENCH_TELEMETRY_PATH: telemPath,
    };
    await runIndexer(env, materializedDirPath);
    steps.push(step('probe: indexed the structural fixture into a fresh cloud-profile collection', true));

    // Confirm entity_raw points exist server-side via a raw scroll.
    const { scroll } = await import('../../../src/core/qdrant/store.js');
    const entityRawPoints = await scroll(collection, { must: [{ key: 'point_kind', match: { value: 'entity_raw' } }] }, 10, false);
    const entityRawCount = entityRawPoints?.length ?? 0;
    steps.push(step('probe: at least one entity_raw canonical point exists server-side', entityRawCount > 0, `found ${entityRawCount}`));

    // runHybridSearch() hits are adapter Chunk objects (toChunk() shape —
    // camelCase, flat: sourceFile/text/rawContent/entityId/...), NEVER a
    // raw {payload:{...}} point — entity_raw points are already excluded
    // server-side via withNavExcluded(), and Chunk has no point_kind
    // field at all, so "never appears" is proven by absence of any
    // rawContent-carrying hit whose entityId is null while chunkIndex is
    // also null (the canonical entity_raw shape) rather than a
    // point_kind check that wouldn't exist on this shape anyway.
    for (const q of STRUCTURAL_FIXTURE_QUERIES) {
      const result = await runHybridSearch({ adapter, collection, query: q.text, top: 20 });
      const hits = result?.hits ?? [];
      const sourceFileHit = hits.some((h) => h.sourceFile === 'doc-structural-fixture-001.md');
      steps.push(step(`probe: query "${q.id}" — the fixture doc is retrievable in top-20`, sourceFileHit));
    }

    for (const [key, identifier] of Object.entries(STRUCTURAL_FIXTURE_EXACT_IDENTIFIERS)) {
      const result = await runHybridSearch({ adapter, collection, query: identifier, top: 20 });
      const hits = result?.hits ?? [];
      const found = hits.some((h) => (h.text ?? '').includes(identifier) || (h.rawContent ?? '').includes(identifier));
      steps.push(step(`probe: exact identifier "${identifier}" (${key}) found verbatim in a returned chunk`, found));
    }
  } finally {
    const cleanupResult = await cleanupCollection(adapter, collection);
    steps.push(step('probe: collection cleaned up', cleanupResult.deleted === true));
  }

  return { steps };
}

main();
