// Live equivalence harness for dense-vector reuse in the link phase (Tier 2).
//
// Purpose: prove that reusing the phase-4 dense vector in buildLinks() does not
// change links, backlinks, or graph output vs the current behaviour of calling
// embedForSearch() independently in phase 5.
//
// Design constraint: dense reuse is NOT implemented yet. This script establishes
// the BASELINE capture only. The CANDIDATE section is documented as TODOs that
// activate once the production patch exists.
//
// What this script does today:
//   1. Index a small deterministic fixture corpus into a temporary Qdrant collection.
//   2. Scroll all points and read the graph file.
//   3. Normalize and serialize links/backlinks/graph keyed by source_file.
//   4. Save the baseline snapshot to results/link-equivalence-baseline-<stamp>.json.
//   5. Print the normalized state clearly so it can be diffed against a future
//      candidate run.
//
// What the CANDIDATE run will add (after dense-reuse patch):
//   Index the same corpus into a second temporary collection using the patched
//   indexer, snapshot identically, then diff the two snapshots. See TODO sections.
//
// Usage:
//   ONNX_EMBED=1 node benchmarks/retrieval/smoke-live-link-equivalence.js
//
// Requires: Qdrant reachable (QDRANT_URL in .env), ONNX model cached.
// NOT part of default CI or npm run smoke.

import 'dotenv/config';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs';
import { resolve, join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';

import { deleteCollection } from '../../src/core/qdrant.js';
import { loadConfig, saveConfig } from '../../src/core/config.js';

const ROOT        = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RESULTS_DIR = join(ROOT, 'benchmarks', 'retrieval', 'results');
const FIXTURES    = join(ROOT, 'benchmarks', 'retrieval', 'custom-50', 'fixtures', 'docs');

// All 6 fixture files from the custom-50 docs subset.
// The indexer will be run against a temp dir containing exactly these files,
// so FIXTURE_FILES and the actual indexed corpus are always in sync.
const FIXTURE_FILES = [
  join(FIXTURES, 'config-env.md'),
  join(FIXTURES, 'mcp-workflow.md'),
  join(FIXTURES, 'project-structure.md'),
  join(FIXTURES, 'benchmarking.md'),
  join(FIXTURES, 'multilingual.md'),
  join(FIXTURES, 'obsidian.md'),
];

const _stamp    = Date.now();
const COL_BASE  = `_equiv-baseline-${_stamp}`;
const GRAPH_BASE = join(ROOT, `graph.${COL_BASE}.json`);

let passed = 0;
let failed = 0;
let cleanupDone = false;

function ok(label, result) {
  if (result) { console.log(`  ✓ ${label}`); passed++; }
  else        { console.error(`  ✗ ${label}`); failed++; }
}

// ── tmp dir ──────────────────────────────────────────────────────────────────
function pickTmpRoot() {
  for (const base of [tmpdir(), join(ROOT, '.tmp')]) {
    try {
      mkdirSync(base, { recursive: true });
      const probe = join(base, `.probe-${_stamp}`);
      writeFileSync(probe, '');
      rmSync(probe);
      return base;
    } catch { /* try next */ }
  }
  throw new Error('No writable temp directory found.');
}

const CHUNKS_DIR  = join(pickTmpRoot(), `equiv-chunks-${_stamp}`);
const FIXTURE_DIR = join(pickTmpRoot(), `equiv-fixtures-${_stamp}`);

// ── cleanup ───────────────────────────────────────────────────────────────────
function cleanConfig(col) {
  try {
    const cfg = loadConfig();
    if (cfg.collections?.[col]) {
      delete cfg.collections[col];
      saveConfig(cfg);
    }
  } catch { /* ignore */ }
}

async function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  console.log('\n[cleanup]');
  for (const col of [COL_BASE]) {
    try { await deleteCollection(col); console.log(`  deleted: ${col}`); }
    catch (e) { console.warn(`  warn: could not delete ${col}: ${e.message}`); }
    cleanConfig(col);
    const gf = join(ROOT, `graph.${col}.json`);
    if (existsSync(gf)) { rmSync(gf); console.log(`  deleted: graph.${col}.json`); }
  }
  if (existsSync(CHUNKS_DIR)) {
    rmSync(CHUNKS_DIR, { recursive: true });
    console.log(`  deleted chunks dir`);
  }
  if (existsSync(FIXTURE_DIR)) {
    rmSync(FIXTURE_DIR, { recursive: true });
    console.log(`  deleted fixture dir`);
  }
}

// ── indexer runner ────────────────────────────────────────────────────────────
function runIndexer(targetDir, collection, extraEnv = {}) {
  const env = {
    ...process.env,
    COLLECTION:    collection,
    ONNX_EMBED:    '1',
    SOURCE_ROOT:   targetDir,
    CHUNKS_OUT_DIR: CHUNKS_DIR,
    LINK_MIN_SCORE: '0.70',   // slightly lower threshold → more links in small corpus
    ...extraEnv,
  };
  const result = process.platform === 'win32'
    ? spawnSync('cmd', ['/c', 'npm', 'run', 'index', targetDir], { env, cwd: ROOT, stdio: 'inherit' })
    : spawnSync('npm', ['run', 'index', targetDir], { env, cwd: ROOT, stdio: 'inherit' });
  return result.status ?? 1;
}

// ── snapshot helpers ──────────────────────────────────────────────────────────

// Scroll all points in a collection and return a Map<source_file, { links, backlinks }>.
// Normalizes: sorts links and backlinks arrays; strips UUIDs and collection names.
async function snapshotPayloads(collection) {
  const allPoints = [];
  let offset = null;
  while (true) {
    const body = { limit: 250, with_payload: ['source_file', 'links', 'backlinks'] };
    if (offset !== null) body.offset = offset;
    const res = await fetch(`${process.env.QDRANT_URL}/collections/${collection}/points/scroll`, {
      method:  'POST',
      headers: { 'api-key': process.env.QDRANT_KEY, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`scroll failed: ${await res.text()}`);
    const data = await res.json();
    allPoints.push(...(data.result?.points ?? []));
    offset = data.result?.next_page_offset ?? null;
    if (!data.result?.points?.length || offset === null) break;
  }

  // Aggregate per source_file: union links + backlinks across all chunks.
  const byFile = new Map();
  for (const pt of allPoints) {
    const sf = pt.payload?.source_file;
    if (!sf) continue;
    if (!byFile.has(sf)) byFile.set(sf, { links: new Set(), backlinks: new Set() });
    const entry = byFile.get(sf);
    for (const l of (pt.payload?.links ?? []))     entry.links.add(l);
    for (const b of (pt.payload?.backlinks ?? [])) entry.backlinks.add(b);
  }

  // Convert to sorted arrays for stable comparison.
  const result = {};
  for (const [sf, { links, backlinks }] of [...byFile.entries()].sort()) {
    result[sf] = {
      links:     [...links].sort(),
      backlinks: [...backlinks].sort(),
    };
  }
  return result;
}

// Read and normalize graph file: sort links/backlinks per node, sort node keys.
function snapshotGraph(graphFile) {
  if (!existsSync(graphFile)) return {};
  const raw = JSON.parse(readFileSync(graphFile, 'utf8'));
  const result = {};
  for (const sf of Object.keys(raw).sort()) {
    result[sf] = {
      links:     [...(raw[sf]?.links     ?? [])].sort(),
      backlinks: [...(raw[sf]?.backlinks ?? [])].sort(),
    };
  }
  return result;
}

// ── embed-text format note ─────────────────────────────────────────────────────
// IMPORTANT — recorded here for the candidate diff:
//
// Phase 4 (index.js:100):   embedText = `${chunk.context}\n\n${chunk.text}`
// Phase 5 (link.js:14):     embedForSearch(col, chunk.context + '\n' + chunk.text)
//
// The separator differs: '\n\n' (phase 4) vs '\n' (phase 5).
// For BGE-M3 / bge-m3-onnx these produce different token sequences and therefore
// slightly different dense vectors. The cosine similarity between them is typically
// ≥ 0.999 for short chunks, so link decisions should be identical in practice —
// but this must be verified empirically, not assumed.
//
// Before the dense-reuse patch lands, the embed-text format in phase 5 must be
// unified to '\n\n' to match phase 4. Otherwise the reuse changes both the
// optimization AND the query text simultaneously, making it impossible to isolate
// the cause of any delta.
//
// The CANDIDATE run should use unified '\n\n' in both phases, then reuse the
// phase-4 dense vector in phase 5 — both changes in one patch.
const EMBED_TEXT_NOTE = {
  phase4_separator: '\\n\\n',
  phase5_separator: '\\n',
  note: 'Separators differ. Candidate patch must unify to \\n\\n first, then reuse dense vector.',
};

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== smoke-live-link-equivalence — baseline capture ===');
  console.log(`collection   : ${COL_BASE}`);
  console.log(`fixture files: ${FIXTURE_FILES.length} (custom-50 docs subset)`);
  console.log(`fixture dir  : ${FIXTURE_DIR}`);
  console.log(`chunks dir   : ${CHUNKS_DIR}`);
  console.log('');
  console.log('[embed-text format]');
  console.log(`  phase 4  : context + "\\n\\n" + text`);
  console.log(`  phase 5  : context + "\\n" + text   ← DIFFERENT — must unify before reuse`);
  console.log('');

  // ── step 1: copy exactly FIXTURE_FILES into a temp dir ───────────────────
  // The indexer is run against this temp dir, not the source FIXTURES folder.
  // This guarantees the indexed corpus matches FIXTURE_FILES exactly — no
  // extra files sneak in if the fixtures directory grows in the future.
  console.log('[step 1] preparing fixture corpus...');
  mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const src of FIXTURE_FILES) {
    const dst = join(FIXTURE_DIR, src.split(/[\\/]/).pop());
    writeFileSync(dst, readFileSync(src));
  }
  console.log(`  copied ${FIXTURE_FILES.length} files to ${relative(ROOT, FIXTURE_DIR)}`);

  // ── step 2: index baseline ────────────────────────────────────────────────
  console.log('\n[step 2] indexing baseline collection...');
  const status = runIndexer(FIXTURE_DIR, COL_BASE);
  if (status !== 0) {
    console.error(`  ✗ indexer failed (exit ${status})`);
    await cleanup();
    process.exit(1);
  }
  console.log('  ✓ baseline indexed');

  // ── step 3: snapshot baseline ─────────────────────────────────────────────
  console.log('\n[step 3] snapshotting baseline...');
  const basePayloads = await snapshotPayloads(COL_BASE);
  const baseGraph    = snapshotGraph(GRAPH_BASE);

  const sourceFiles = Object.keys(basePayloads);
  ok('baseline has at least one source_file', sourceFiles.length >= 1);

  console.log(`\n  source_files in baseline: ${sourceFiles.length}`);
  for (const sf of sourceFiles) {
    const { links, backlinks } = basePayloads[sf];
    console.log(`    ${sf}: links=[${links.join(', ')}]  backlinks=[${backlinks.join(', ')}]`);
  }

  const graphNodes = Object.keys(baseGraph);
  console.log(`\n  graph nodes: ${graphNodes.length}`);
  for (const sf of graphNodes) {
    const { links, backlinks } = baseGraph[sf];
    console.log(`    ${sf}: links=[${links.join(', ')}]  backlinks=[${backlinks.join(', ')}]`);
  }

  // Consistency check: every file with links in payload should appear in graph.
  let payloadGraphConsistent = true;
  for (const sf of sourceFiles) {
    if (basePayloads[sf].links.length > 0 && !baseGraph[sf]) {
      console.error(`  ✗ graph missing node for ${sf} (has links in payload)`);
      payloadGraphConsistent = false;
    }
  }
  ok('payload links consistent with graph', payloadGraphConsistent);

  // ── step 4: save baseline snapshot ───────────────────────────────────────
  mkdirSync(RESULTS_DIR, { recursive: true });
  const snapshotPath = join(RESULTS_DIR, `link-equivalence-baseline-${_stamp}.json`);
  const snapshot = {
    captured:      new Date().toISOString(),
    collection:    COL_BASE,
    fixture_files: FIXTURE_FILES.map(f => relative(ROOT, f)),   // original source paths
    embed_text:    EMBED_TEXT_NOTE,
    payloads:      basePayloads,
    graph:         baseGraph,
    // TODO(candidate): add `candidate_payloads` and `candidate_graph` here after patch.
  };
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');
  ok('baseline snapshot written', existsSync(snapshotPath));
  console.log(`\n  snapshot saved: ${relative(ROOT, snapshotPath)}`);

  // ── step 5: candidate TODO block ─────────────────────────────────────────
  console.log('\n[step 5] CANDIDATE (not yet runnable — awaiting dense-reuse patch)');
  console.log('  TODO: index same fixtures into COL_CAND using patched indexer');
  console.log('  TODO: snapshot candidate payloads + graph');
  console.log('  TODO: diff(basePayloads, candPayloads) and diff(baseGraph, candGraph)');
  console.log('  TODO: PASS if both diffs are empty; FAIL with diff summary otherwise');
  console.log('');
  console.log('  Pre-conditions for candidate run:');
  console.log('    1. Unify embed-text format: phase 5 must use "\\n\\n" (same as phase 4).');
  console.log('    2. buildLinks() must accept optional precomputed dense vector param.');
  console.log('    3. index.js phase 5 must pass the phase-4 dense vector to buildLinks().');
  console.log('  See design report: results/2026-05-17-link-dense-reuse-equivalence-design.md');

  // ── cleanup + result ──────────────────────────────────────────────────────
  await cleanup();

  console.log(`\n${'─'.repeat(60)}`);
  if (failed === 0) {
    console.log(`smoke-live-link-equivalence (baseline): PASS — ${passed}/${passed} assertions`);
    console.log(`Next step: apply dense-reuse patch, then re-run to compare snapshots.`);
  } else {
    console.error(`smoke-live-link-equivalence (baseline): FAIL — ${failed} failure(s), ${passed} passed`);
    process.exit(1);
  }
}

process.on('exit', () => { if (!cleanupDone) console.warn('[warn] cleanup not completed'); });

main().catch(async err => {
  console.error('\nUnhandled error:', err);
  await cleanup();
  process.exit(1);
});
