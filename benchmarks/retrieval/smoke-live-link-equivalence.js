// Live equivalence harness for dense-vector reuse in the link phase (Tier 2).
//
// Purpose: prove that reusing the phase-4 dense vector in buildLinks() does not
// change links, backlinks, or graph output vs the current behaviour of calling
// embedForSearch() independently in phase 5.
//
// Modes:
//   capture  (default) — index fixture corpus, snapshot, save JSON, exit.
//   diff     — load two previously saved JSON snapshots and compare them.
//
// Usage:
//   ONNX_EMBED=1 node benchmarks/retrieval/smoke-live-link-equivalence.js
//   node benchmarks/retrieval/smoke-live-link-equivalence.js diff <before.json> <after.json>
//
// Requires: Qdrant reachable (QDRANT_URL in .env), ONNX model cached (capture mode).
// NOT part of default CI or npm run smoke.

import 'dotenv/config';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs';
import { resolve, join, dirname, relative, basename } from 'path';
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

const _stamp     = Date.now();
const COL_BASE   = `_equiv-baseline-${_stamp}`;
const GRAPH_BASE = join(ROOT, `graph.${COL_BASE}.json`);

let passed = 0;
let failed = 0;
let cleanupDone = false;

function ok(label, result) {
  if (result) { console.log(`  ✓ ${label}`); passed++; }
  else        { console.error(`  ✗ ${label}`); failed++; }
}

// ── tmp dir ───────────────────────────────────────────────────────────────────
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
    COLLECTION:     collection,
    ONNX_EMBED:     '1',
    SOURCE_ROOT:    targetDir,
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

// Paginated scroll — raw fetch so we can control offset continuation.
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
    for (const l of (pt.payload?.links     ?? [])) entry.links.add(l);
    for (const b of (pt.payload?.backlinks ?? [])) entry.backlinks.add(b);
  }

  // Normalized: sorted arrays, sorted keys.
  const result = {};
  for (const [sf, { links, backlinks }] of [...byFile.entries()].sort()) {
    result[sf] = { links: [...links].sort(), backlinks: [...backlinks].sort() };
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

// ── diff mode ─────────────────────────────────────────────────────────────────

// Compare two normalized payload maps. Returns array of delta objects.
function diffPayloads(before, after) {
  const deltas = [];
  const allFiles = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const sf of [...allFiles].sort()) {
    const b = before[sf] ?? { links: [], backlinks: [] };
    const a = after[sf]  ?? { links: [], backlinks: [] };
    const bLinks = JSON.stringify(b.links);
    const aLinks = JSON.stringify(a.links);
    const bBack  = JSON.stringify(b.backlinks);
    const aBack  = JSON.stringify(a.backlinks);
    if (bLinks !== aLinks) deltas.push({ sf, field: 'links',     before: b.links,     after: a.links });
    if (bBack  !== aBack)  deltas.push({ sf, field: 'backlinks', before: b.backlinks, after: a.backlinks });
  }
  return deltas;
}

// Compare two normalized graph maps. Returns array of delta objects.
function diffGraph(before, after) {
  const deltas = [];
  const allNodes = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const sf of [...allNodes].sort()) {
    const b = before[sf] ?? { links: [], backlinks: [] };
    const a = after[sf]  ?? { links: [], backlinks: [] };
    if (JSON.stringify(b.links)     !== JSON.stringify(a.links))
      deltas.push({ sf, field: 'graph.links',     before: b.links,     after: a.links });
    if (JSON.stringify(b.backlinks) !== JSON.stringify(a.backlinks))
      deltas.push({ sf, field: 'graph.backlinks', before: b.backlinks, after: a.backlinks });
  }
  return deltas;
}

function runDiff(beforePath, afterPath) {
  console.log('=== smoke-live-link-equivalence — diff mode ===');
  console.log(`before : ${beforePath}`);
  console.log(`after  : ${afterPath}`);
  console.log('');

  if (!existsSync(beforePath)) { console.error(`  ✗ before snapshot not found: ${beforePath}`); process.exit(1); }
  if (!existsSync(afterPath))  { console.error(`  ✗ after snapshot not found: ${afterPath}`);  process.exit(1); }

  const before = JSON.parse(readFileSync(beforePath, 'utf8'));
  const after  = JSON.parse(readFileSync(afterPath,  'utf8'));

  console.log(`before captured : ${before.captured}  (embed_text phase5: ${before.embed_text?.phase5_separator ?? 'unknown'})`);
  console.log(`after  captured : ${after.captured}   (embed_text phase5: ${after.embed_text?.phase5_separator  ?? 'unknown'})`);
  console.log('');

  const payloadDeltas = diffPayloads(before.payloads ?? {}, after.payloads ?? {});
  const graphDeltas   = diffGraph(before.graph ?? {}, after.graph ?? {});

  if (payloadDeltas.length === 0) {
    console.log('  ✓ payload links/backlinks: identical');
    passed++;
  } else {
    console.error(`  ✗ payload links/backlinks: ${payloadDeltas.length} difference(s)`);
    for (const d of payloadDeltas) {
      console.error(`      ${d.sf}  [${d.field}]`);
      console.error(`        before: ${JSON.stringify(d.before)}`);
      console.error(`        after : ${JSON.stringify(d.after)}`);
    }
    failed++;
  }

  if (graphDeltas.length === 0) {
    console.log('  ✓ graph links/backlinks: identical');
    passed++;
  } else {
    console.error(`  ✗ graph links/backlinks: ${graphDeltas.length} difference(s)`);
    for (const d of graphDeltas) {
      console.error(`      ${d.sf}  [${d.field}]`);
      console.error(`        before: ${JSON.stringify(d.before)}`);
      console.error(`        after : ${JSON.stringify(d.after)}`);
    }
    failed++;
  }

  console.log(`\n${'─'.repeat(60)}`);
  if (failed === 0) {
    console.log(`DIFF RESULT: PASS — snapshots are equivalent (${passed}/${passed} checks)`);
  } else {
    console.error(`DIFF RESULT: FAIL — ${failed} check(s) failed`);
    process.exit(1);
  }
}

// ── capture mode ──────────────────────────────────────────────────────────────

const EMBED_TEXT_NOTE = {
  phase4_separator: '\\n\\n',
  phase5_separator: '\\n\\n',  // updated to reflect Patch A — both now use \n\n
  note: 'Patch A applied: phase 5 now uses \\n\\n, matching phase 4. Pre-conditions B+C (dense reuse) still pending.',
};

async function runCapture() {
  console.log('=== smoke-live-link-equivalence — capture ===');
  console.log(`collection   : ${COL_BASE}`);
  console.log(`fixture files: ${FIXTURE_FILES.length} (custom-50 docs subset)`);
  console.log(`fixture dir  : ${FIXTURE_DIR}`);
  console.log(`chunks dir   : ${CHUNKS_DIR}`);
  console.log('');
  console.log('[embed-text format — Patch A applied]');
  console.log(`  phase 4  : context + "\\n\\n" + text`);
  console.log(`  phase 5  : context + "\\n\\n" + text   ✓ unified`);
  console.log('');

  // ── step 1: copy FIXTURE_FILES into a temp dir ────────────────────────────
  console.log('[step 1] preparing fixture corpus...');
  mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const src of FIXTURE_FILES) {
    const dst = join(FIXTURE_DIR, basename(src));
    writeFileSync(dst, readFileSync(src));
  }
  console.log(`  copied ${FIXTURE_FILES.length} files to ${relative(ROOT, FIXTURE_DIR)}`);

  // ── step 2: index ─────────────────────────────────────────────────────────
  console.log('\n[step 2] indexing collection...');
  const status = runIndexer(FIXTURE_DIR, COL_BASE);
  if (status !== 0) {
    console.error(`  ✗ indexer failed (exit ${status})`);
    await cleanup();
    process.exit(1);
  }
  console.log('  ✓ indexed');

  // ── step 3: snapshot ──────────────────────────────────────────────────────
  console.log('\n[step 3] snapshotting...');
  const payloads = await snapshotPayloads(COL_BASE);
  const graph    = snapshotGraph(GRAPH_BASE);

  const sourceFiles = Object.keys(payloads);
  ok('has at least one source_file', sourceFiles.length >= 1);

  console.log(`\n  source_files: ${sourceFiles.length}`);
  for (const sf of sourceFiles) {
    const { links, backlinks } = payloads[sf];
    console.log(`    ${sf}: links=[${links.join(', ')}]  backlinks=[${backlinks.join(', ')}]`);
  }

  const graphNodes = Object.keys(graph);
  console.log(`\n  graph nodes: ${graphNodes.length}`);
  for (const sf of graphNodes) {
    const { links, backlinks } = graph[sf];
    console.log(`    ${sf}: links=[${links.join(', ')}]  backlinks=[${backlinks.join(', ')}]`);
  }

  let payloadGraphConsistent = true;
  for (const sf of sourceFiles) {
    if (payloads[sf].links.length > 0 && !graph[sf]) {
      console.error(`  ✗ graph missing node for ${sf} (has links in payload)`);
      payloadGraphConsistent = false;
    }
  }
  ok('payload links consistent with graph', payloadGraphConsistent);

  // ── step 4: save snapshot ─────────────────────────────────────────────────
  mkdirSync(RESULTS_DIR, { recursive: true });
  const snapshotPath = join(RESULTS_DIR, `link-equivalence-snapshot-${_stamp}.json`);
  writeFileSync(snapshotPath, JSON.stringify({
    captured:      new Date().toISOString(),
    collection:    COL_BASE,
    fixture_files: FIXTURE_FILES.map(f => relative(ROOT, f)),
    embed_text:    EMBED_TEXT_NOTE,
    payloads,
    graph,
  }, null, 2), 'utf8');
  ok('snapshot written', existsSync(snapshotPath));
  console.log(`\n  snapshot saved: ${relative(ROOT, snapshotPath)}`);
  console.log(`\n  To diff against another snapshot:`);
  console.log(`    node benchmarks/retrieval/smoke-live-link-equivalence.js diff <before.json> ${relative(ROOT, snapshotPath)}`);

  // ── step 5: candidate TODO block ─────────────────────────────────────────
  console.log('\n[step 5] CANDIDATE (not yet runnable — awaiting Pre-conditions B+C)');
  console.log('  Pre-conditions B+C for dense-reuse patch:');
  console.log('    B. buildLinks() must accept optional precomputed dense vector param.');
  console.log('    C. index.js phase 5 must zip taggedChunks with phase-4 dense vectors');
  console.log('       (use chunksWithDense = taggedChunks.map((c,i) => ({chunk:c, dense:pts[i].dense})),');
  console.log('       NOT a callback index inside runBatched — that resets per batch).');
  console.log('  See design report: results/2026-05-17-link-dense-reuse-equivalence-design.md');

  await cleanup();

  console.log(`\n${'─'.repeat(60)}`);
  if (failed === 0) {
    console.log(`smoke-live-link-equivalence (capture): PASS — ${passed}/${passed} assertions`);
  } else {
    console.error(`smoke-live-link-equivalence (capture): FAIL — ${failed} failure(s), ${passed} passed`);
    process.exit(1);
  }
}

// ── entry point ───────────────────────────────────────────────────────────────
// only warn about incomplete cleanup in capture mode — diff mode creates no temp state
process.on('exit', () => { if (!cleanupDone) console.warn('[warn] cleanup not completed'); });

const args = process.argv.slice(2);
if (args[0] === 'diff') {
  if (!args[1] || !args[2]) {
    console.error('Usage: node smoke-live-link-equivalence.js diff <before.json> <after.json>');
    process.exit(1);
  }
  cleanupDone = true;  // diff mode creates no temp collections or files
  runDiff(resolve(args[1]), resolve(args[2]));
} else {
  runCapture().catch(async err => {
    console.error('\nUnhandled error:', err);
    await cleanup();
    process.exit(1);
  });
}
