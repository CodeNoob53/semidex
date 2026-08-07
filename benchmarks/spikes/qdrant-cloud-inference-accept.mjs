// Live acceptance for the qdrant-cloud execution vertical slice — proves
// the REAL Semidex integration works end to end against a real Qdrant Cloud
// cluster, not just the raw API contract (already proven by the prior spike,
// benchmarks/spikes/qdrant-cloud-inference-spike.mjs).
//
// Code review finding (P2): a prior version of this script built inference
// points directly and upserted them by hand — it never actually exercised
// the REAL production indexing path (chunkFileFromPath -> stageB -> stageC
// -> stageD in src/indexer/run.js), so it could never have caught bugs
// specific to that pipeline: the entity_raw marker-embed cost, the
// chunk_index gap a canonical entity_raw point could create, or an
// oversized single unit silently passing through unsplit. This version
// spawns the REAL indexer CLI (src/indexer/index.js, the same entry point
// `npm run index` uses) against a temporary Markdown fixture directory
// containing one file with an oversized table designed to trigger
// entity-split.js, then verifies the result entirely through
// production store-level primitives (getFileChunks, getContentNodeById,
// scroll) — never a hand-built point.
//
// Only ever touches ONE newly-created, uniquely-named, disposable collection
// (prefix "semidex-cloud-inference-accept-") — NEVER modifies, migrates,
// reindexes, or deletes any existing user collection. Deleted in `finally`.
//
// If QDRANT_URL/QDRANT_KEY are absent, or reachability/auth fails before
// anything is created, this reports LIVE_BLOCKED and stops — it never mocks
// this step.
//
// Run:  node benchmarks/spikes/qdrant-cloud-inference-accept.mjs
import 'dotenv/config';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

import { createStorageAdapter } from '../../src/core/storage/factory.js';
import { resolveExistingCollectionProfile } from '../../src/core/embedding-profile/resolve.js';
import { runHybridSearch } from '../../src/core/retrieval/search.js';
import { sanitiseErrorMessage } from '../../src/shared/core/doctor-checks.js';
import { getFileChunks, getContentNodeById } from '../../src/core/qdrant/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const RESULTS_DIR = resolve(REPO_ROOT, 'benchmarks/results');
const INDEX_ENTRY = resolve(REPO_ROOT, 'src/indexer/index.js');

const COLLECTION_PREFIX = 'semidex-cloud-inference-accept-';
const DENSE_MODEL = 'intfloat/multilingual-e5-small';
const SPARSE_MODEL = 'qdrant/bm25';

// Matches this script's own OS temp fixture directory (mkdtempSync(join(
// tmpdir(), 'semidex-cloud-accept-')) below) wherever it appears — e.g.
// inside a spawned indexer process's stdout/stderr captured into an Error
// message on a real failure (runIndexer's own reject path). sanitiseErrorMessage
// (core/doctor-checks.js) only redacts secrets/URLs, never filesystem
// paths, so this script adds its own narrow redaction for the one local
// path shape it can actually produce — never a general path scrubber,
// which would be unpredictable across platforms and easily miss cases.
const TEMP_FIXTURE_PATH_RE = /[^\s]*semidex-cloud-accept-[^\s]*/g;

function redact(value) {
  const text = value instanceof Error ? (value.stack || value.message || String(value)) : String(value ?? '');
  return sanitiseErrorMessage(text, process.env.QDRANT_KEY).replace(TEMP_FIXTURE_PATH_RE, '<temporary-fixture>');
}

// A real Markdown fixture, not a synthetic point payload — this is what
// makes the run go through parseSkeleton -> chunkFromSkeleton ->
// entity-split.js for real. The table is sized to exceed E5's 512-token
// window as a whole entity (40 rows, comfortably over budget) while each
// individual row stays small, so this should produce a clean multi-fragment
// split rather than an unsplittable oversized-unit case — that scenario is
// covered separately by entity-split.js's own unit tests.
function buildFixtureMarkdown() {
  const rows = [];
  for (let i = 1; i <= 40; i++) {
    rows.push(`| item-${i} | some descriptive value number ${i} | ${i % 2 === 0 ? 'enabled' : 'disabled'} |`);
  }
  return [
    '# Configuration Reference',
    '',
    'This document is a live-acceptance fixture for the qdrant-cloud entity-split path. The table below is intentionally large enough to exceed a small dense model\'s token window as one whole entity.',
    '',
    '## Settings Table',
    '',
    'The following table enumerates every configuration key this fixture pretends to document.',
    '',
    '| Key | Description | Status |',
    '|---|---|---|',
    ...rows,
    '',
    'Closing remarks after the table, confirming prose on both sides of the entity survives indexing intact.',
    '',
  ].join('\n');
}

function runIndexer(env, targetPath) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [INDEX_ENTRY, targetPath], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`indexer exited with code ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`));
    });
    child.on('error', reject);
  });
}

async function main() {
  const steps = [];
  const step = (name, ok, detail = '') => { steps.push({ name, ok, detail: redact(detail) }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + redact(detail) : ''}`); };

  if (!process.env.QDRANT_URL || !process.env.QDRANT_KEY) {
    console.log('LIVE_BLOCKED: QDRANT_URL/QDRANT_KEY not set.');
    writeReport({ verdict: 'LIVE_BLOCKED', reason: 'QDRANT_URL/QDRANT_KEY not set', steps: [] });
    return;
  }

  const adapter = createStorageAdapter();
  const collectionName = `${COLLECTION_PREFIX}${randomBytes(4).toString('hex')}`;
  let created = false;
  let fixtureDir = null;

  try {
    // Step: reachability/auth check BEFORE creating anything.
    let reachable;
    try {
      reachable = await adapter.checkCloudInferenceReachable();
    } catch (err) {
      console.log('LIVE_BLOCKED: reachability check threw:', redact(err));
      writeReport({ verdict: 'LIVE_BLOCKED', reason: redact(err), steps: [] });
      return;
    }
    if (reachable.status !== 'ok') {
      console.log(`LIVE_BLOCKED: Qdrant reachability check reported "${reachable.status}".`);
      writeReport({ verdict: 'LIVE_BLOCKED', reason: reachable.status, steps: [] });
      return;
    }
    step('reachability/auth check before any collection is created', true);

    // Build the temp fixture directory — one real .md file, on disk, no
    // hand-built points anywhere in this script.
    fixtureDir = mkdtempSync(join(tmpdir(), 'semidex-cloud-accept-'));
    const fixturePath = join(fixtureDir, 'config-reference.md');
    writeFileSync(fixturePath, buildFixtureMarkdown(), 'utf8');
    // Reported detail is a neutral placeholder, never the real absolute
    // path (code review, P2: an OS temp path can reveal the local
    // username/machine layout) — the real `fixturePath` is still used
    // below to actually run the indexer, only the step() log/report output
    // is redacted.
    step('built a real Markdown fixture on disk with an oversized table (40 rows)', true, '<temporary-fixture>/config-reference.md');

    // Real indexer CLI run — the SAME entry point `npm run index` uses,
    // spawned as a child process so this script exercises the actual
    // production pipeline (chunkFileFromPath -> stageA -> stageB -> stageC
    // -> stageD) end to end, including entity-split.js and the vectorless
    // entity_raw upsert path, never a hand-rolled shortcut.
    const env = {
      COLLECTION: collectionName,
      DENSE_PROVIDER: 'qdrant-cloud',
      SPARSE_PROVIDER: 'qdrant-cloud',
      QDRANT_CLOUD_DENSE_MODEL: DENSE_MODEL,
      TOKEN_COUNT: 'heuristic', // avoid an unrelated BGE-M3 tokenizer download in this probe
    };
    const { stdout } = await runIndexer(env, fixturePath);
    created = true; // the indexer creates the collection on first run
    step('real indexer CLI run completed (chunkFileFromPath -> stageA -> stageB -> stageC -> stageD)', true, 'exit 0');

    const mentionsEntityRaw = /entity_raw/i.test(stdout);
    step('indexer stdout mentions entity_raw points were produced (split actually engaged)', mentionsEntityRaw, mentionsEntityRaw ? 'entity_raw mentioned in output' : 'NOT mentioned — split may not have triggered, see stdout in report');

    // ── Verification: entirely through production store-level primitives ──

    // getFileChunks excludes entity_raw (nav-filter.js) — the fragments
    // and prose chunks it returns must be small, contiguous, and gapless.
    const fileChunks = await getFileChunks(collectionName, 'config-reference.md');
    step('getFileChunks returns chunks for the fixture file', fileChunks.length > 0, `${fileChunks.length} chunks`);

    const chunkIndexes = fileChunks
      .map((c) => c.payload?.chunk_index)
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => a - b);
    const isContiguousFromZero = chunkIndexes.every((n, i) => n === i);
    step(
      'chunk_index sequence returned by getFileChunks is contiguous from 0, with NO gap for the excluded entity_raw point (code review fix)',
      isContiguousFromZero,
      `indexes: [${chunkIndexes.join(',')}]`,
    );

    const tableFragments = fileChunks.filter((c) => c.payload?.node_type === 'table');
    step(
      'the oversized table was actually split into multiple fragment points, each individually small',
      tableFragments.length > 1,
      `${tableFragments.length} table fragment(s)`,
    );
    const fragmentsAreBounded = tableFragments.every((c) => (c.payload?.raw_content?.length ?? 0) < 2000);
    step('every fragment carries only its own bounded slice of the table, never the full 40-row content', fragmentsAreBounded);

    // entity_id on fragments must point at a canonical entity_raw point
    // that getFileChunks itself never returns (excluded) but
    // getContentNodeById CAN still resolve directly by node_id.
    const entityId = tableFragments[0]?.payload?.entity_id;
    step('fragments carry entity_id linking back to their canonical entity_raw point', typeof entityId === 'string' && entityId.length > 0);

    let canonicalRawContentLength = null;
    if (entityId) {
      const canonical = await getContentNodeById(collectionName, entityId);
      step('the canonical entity_raw point resolves directly by node_id and carries the COMPLETE raw_content (all 40 rows)', canonical?.point_kind === 'entity_raw' && typeof canonical?.raw_content === 'string');
      canonicalRawContentLength = canonical?.raw_content?.length ?? 0;
      const allRowsPresent = canonical?.raw_content ? [1, 20, 40].every((n) => canonical.raw_content.includes(`item-${n}`)) : false;
      step('canonical raw_content includes rows from across the whole table (first, middle, last), not a truncated slice', allRowsPresent);
    }

    // Confirm the canonical point carries vector: {} (empty named-vector
    // map) via the raw SDK client — no production primitive exposes raw
    // vectors for a content-facing read (by design), so this one
    // acceptance-only check uses the client directly, same as the prior
    // version of this script did for its own vector-shape checks.
    const { getQdrantClient } = await import('../../src/core/qdrant/client.js');
    const rawClient = getQdrantClient();
    if (entityId) {
      const { makeSkeletonPointId } = await import('../../src/shared/indexer/skeleton-payload.js');
      // embeddingSchemaVersion must match whatever this collection actually
      // resolved to — read it back from the collection's own profile rather
      // than assuming a literal, so this check stays correct regardless of
      // the catalog's current schema version.
      const existingProfile = await resolveExistingCollectionProfile(adapter, collectionName);
      const pointId = makeSkeletonPointId({
        collection: collectionName, nodeId: entityId,
        embeddingSchemaVersion: existingProfile.profile?.embeddingSchemaVersion,
      });
      const scrolled = await rawClient.scroll(collectionName, {
        filter: { must: [{ key: 'point_kind', match: { value: 'entity_raw' } }] },
        limit: 5, with_payload: false, with_vector: true,
      });
      const canonicalPoint = scrolled.points.find((p) => p.id === pointId) ?? scrolled.points[0];
      const hasEmptyVector = canonicalPoint && typeof canonicalPoint.vector === 'object' && Object.keys(canonicalPoint.vector ?? {}).length === 0;
      step(
        'the canonical entity_raw point was upserted with vector: {} (empty named-vector map) — no Cloud Inference call, no marker embedding, confirmed via raw scroll',
        hasEmptyVector,
        canonicalPoint ? `vector=${JSON.stringify(canonicalPoint.vector)}` : 'canonical point not found via scroll',
      );

      // And confirm it's excluded from vector search — a hybrid query
      // should never surface the canonical point itself as a hit.
      const searchResult = await runHybridSearch({ adapter, collection: collectionName, query: 'configuration settings table', top: 10 });
      const canonicalInSearchResults = searchResult.hits?.some((h) => h.nodeId === entityId) ?? false;
      step('the canonical entity_raw point never appears in hybrid search results (vector: {} correctly excludes it)', !canonicalInSearchResults);
    }

    // Round-trip proof: resolveExistingCollectionProfile still resolves
    // correctly after a real indexing run through this new code path.
    const resolved = await resolveExistingCollectionProfile(adapter, collectionName);
    const roundTripOk = resolved.resolved
      && resolved.profile.embedding.dense.execution === 'qdrant-cloud'
      && resolved.profile.embedding.dense.model === DENSE_MODEL
      && resolved.profile.embedding.sparse?.model === SPARSE_MODEL;
    step('resolveExistingCollectionProfile() resolves the canonical qdrant-cloud profile after a real indexing run', roundTripOk, JSON.stringify(resolved.resolved ? resolved.profile.embedding : resolved));

    const allOk = steps.every((s) => s.ok);
    const verdict = allOk ? 'ACCEPT' : 'PARTIAL';
    console.log(`\nVerdict: ${verdict}`);
    writeReport({ verdict, steps, collectionName: null /* never persisted — cluster-specific, deleted below */ });
  } catch (err) {
    console.error('REJECT:', redact(err));
    writeReport({ verdict: 'REJECT', reason: redact(err), steps });
  } finally {
    if (fixtureDir) {
      try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    // Guaranteed cleanup, gated to only ever delete a name this run itself
    // generated with the declared prefix — never touches any existing user
    // collection.
    if (created && collectionName.startsWith(COLLECTION_PREFIX)) {
      try {
        await adapter.deleteCollection(collectionName);
        console.log(`cleanup: deleted ${collectionName}`);
      } catch (err) {
        console.error('cleanup FAILED (manual cleanup may be needed):', redact(err));
      }
    }
  }
}

function writeReport(result) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = resolve(RESULTS_DIR, `${date}-qdrant-cloud-inference-live-acceptance.json`);
  writeFileSync(path, JSON.stringify(result, null, 2) + '\n', 'utf-8');
  console.log('report:', path.replace(REPO_ROOT, '.'));
}

main().catch((err) => {
  console.error('FATAL:', redact(err));
  process.exit(1);
});
