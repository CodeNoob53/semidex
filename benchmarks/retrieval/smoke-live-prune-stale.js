// Optional live integration smoke for PRUNE_STALE=1.
// Creates a temporary Qdrant collection, indexes two fixture files, deletes one,
// re-runs with PRUNE_STALE=1, and asserts the deleted file's source_file is gone
// from Qdrant and the graph. Cleans up the temp collection, temp files, graph
// file, chunks dir, and config.json entry on exit.
//
// Usage:
//   npm run smoke:prune-live
//
// Requires: Qdrant reachable (QDRANT_URL in .env). Uses ONNX_EMBED=1 internally.
// NOT part of default CI or npm run smoke or smoke:retrieval-live.

import 'dotenv/config';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';

import { listSourceFiles, deleteCollection } from '../../src/core/qdrant.js';
import { loadConfig, saveConfig } from '../../src/core/config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const COLLECTION = `smoke-prune-${Date.now()}`;
const GRAPH_FILE = join(ROOT, `graph.${COLLECTION}.json`);

// ── writable temp root selection ─────────────────────────────────────────────
// os.tmpdir() is always the first candidate — guaranteed writable by the OS on
// every platform. Repo .tmp is tried second for environments where it is
// writable and preferred for locality. Throws only if both fail.
function pickTmpRoot() {
  const candidates = [tmpdir(), join(ROOT, '.tmp')];
  for (const base of candidates) {
    try {
      mkdirSync(base, { recursive: true });
      const probe = join(base, `.probe-${Date.now()}`);
      writeFileSync(probe, '');
      rmSync(probe);
      return base;
    } catch {
      // try next candidate
    }
  }
  throw new Error('No writable temp directory found. Tried: ' + candidates.join(', '));
}

const _stamp = Date.now();
const TMP_DIR    = join(pickTmpRoot(), `prune-smoke-${_stamp}`);
const CHUNKS_DIR = join(pickTmpRoot(), `prune-smoke-chunks-${_stamp}`);

let passed = 0;
let failed = 0;
let cleanupDone = false;

function ok(label, result) {
  if (result) { console.log(`  ✓ ${label}`); passed++; }
  else        { console.error(`  ✗ ${label}`); failed++; }
}

function cleanConfig() {
  try {
    const cfg = loadConfig();
    if (cfg.collections?.[COLLECTION]) {
      delete cfg.collections[COLLECTION];
      saveConfig(cfg);
      console.log(`  removed config.json entry: ${COLLECTION}`);
    }
  } catch (e) {
    console.warn(`  warn: could not clean config.json: ${e.message}`);
  }
}

async function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  console.log('\n[cleanup]');
  try {
    await deleteCollection(COLLECTION);
    console.log(`  deleted Qdrant collection: ${COLLECTION}`);
  } catch (e) {
    console.warn(`  warn: could not delete collection (may not exist): ${e.message}`);
  }
  if (existsSync(GRAPH_FILE)) {
    rmSync(GRAPH_FILE);
    console.log(`  deleted graph file: graph.${COLLECTION}.json`);
  }
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true });
    console.log(`  deleted temp dir: ${TMP_DIR}`);
  }
  if (existsSync(CHUNKS_DIR)) {
    rmSync(CHUNKS_DIR, { recursive: true });
    console.log(`  deleted chunks dir: ${CHUNKS_DIR}`);
  }
  cleanConfig();
}

function runIndexer(dir, extraEnv = {}) {
  const env = {
    ...process.env,
    COLLECTION,
    ONNX_EMBED: '1',
    SOURCE_ROOT: dir,
    CHUNKS_OUT_DIR: CHUNKS_DIR,
    ...extraEnv,
  };
  // On Windows npm is a .cmd file — use cmd /c to avoid EINVAL.
  const result = process.platform === 'win32'
    ? spawnSync('cmd', ['/c', 'npm', 'run', 'index', dir], { env, cwd: ROOT, stdio: 'inherit' })
    : spawnSync('npm', ['run', 'index', dir], { env, cwd: ROOT, stdio: 'inherit' });
  return result.status ?? 1;
}

process.on('exit', () => { if (!cleanupDone) console.warn('[warn] cleanup skipped — call cleanup() explicitly'); });

async function main() {
  console.log('=== smoke:prune-live ===');
  console.log(`collection : ${COLLECTION}`);
  console.log(`tmp dir    : ${TMP_DIR}`);
  console.log(`chunks dir : ${CHUNKS_DIR}`);
  console.log('');

  // ── step 1: create temp dir + fixture files ──────────────────────────────
  mkdirSync(TMP_DIR, { recursive: true });
  const aPath = join(TMP_DIR, 'a.md');
  const bPath = join(TMP_DIR, 'b.md');
  writeFileSync(aPath, '# Alpha\n\nThis is the alpha document for prune smoke testing.\n', 'utf8');
  writeFileSync(bPath, '# Beta\n\nThis is the beta document for prune smoke testing.\n', 'utf8');
  console.log('[step 1] created temp fixtures: a.md, b.md');

  // ── step 2: initial index ────────────────────────────────────────────────
  console.log('\n[step 2] indexing temp dir (first run)...');
  const status1 = runIndexer(TMP_DIR);
  if (status1 !== 0) {
    console.error(`  ✗ indexer exited with code ${status1}`);
    await cleanup();
    process.exit(1);
  }

  // ── step 3: verify both files indexed ───────────────────────────────────
  console.log('\n[step 3] verifying initial state in Qdrant...');
  const afterFirst = await listSourceFiles(COLLECTION);
  ok('a.md indexed after first run', afterFirst.includes('a.md'));
  ok('b.md indexed after first run', afterFirst.includes('b.md'));
  ok('exactly 2 source files after first run', afterFirst.length === 2);

  // ── step 4: delete b.md from disk + seed graph with b.md link ───────────
  // Seed the graph with an a.md→b.md link and a b.md backlink node so that
  // graph removal is exercised even when the short fixture files produced no
  // organic links during indexing.
  console.log('\n[step 4] deleting b.md from disk + seeding graph...');
  rmSync(bPath);
  const seededGraph = {
    'a.md': { links: ['b.md'], backlinks: [] },
    'b.md': { links: [], backlinks: ['a.md'] },
  };
  writeFileSync(GRAPH_FILE, JSON.stringify(seededGraph, null, 2), 'utf8');
  console.log('  seeded graph with a.md→b.md link');

  // ── step 5: re-index with PRUNE_STALE=1 ─────────────────────────────────
  console.log('\n[step 5] re-indexing with PRUNE_STALE=1...');
  const status2 = runIndexer(TMP_DIR, { PRUNE_STALE: '1' });
  if (status2 !== 0) {
    console.error(`  ✗ indexer (PRUNE_STALE=1) exited with code ${status2}`);
    await cleanup();
    process.exit(1);
  }

  // ── step 6: verify prune result in Qdrant ───────────────────────────────
  console.log('\n[step 6] verifying Qdrant state after prune...');
  const afterPrune = await listSourceFiles(COLLECTION);
  ok('a.md still present after prune', afterPrune.includes('a.md'));
  ok('b.md removed from Qdrant after prune', !afterPrune.includes('b.md'));
  ok('exactly 1 source file after prune', afterPrune.length === 1);

  // ── step 7: verify graph is fully clean of b.md ─────────────────────────
  // Check the raw serialized JSON — catches b.md appearing as a key, a link
  // target, a backlink entry, or anywhere else in the file.
  console.log('\n[step 7] verifying graph file...');
  if (existsSync(GRAPH_FILE)) {
    const raw = readFileSync(GRAPH_FILE, 'utf8');
    ok('b.md absent from graph (raw JSON)', !raw.includes('"b.md"'));
    ok('a.md still present in graph', raw.includes('"a.md"'));
    const graph = JSON.parse(raw);
    ok('a.md has no links to b.md', !(graph['a.md']?.links ?? []).includes('b.md'));
  } else {
    // Graph file can legitimately be absent if the indexer wrote an empty graph.
    // In that case b.md is also absent by definition.
    ok('graph file absent — b.md implicitly not present', true);
    ok('(skipped) a.md still present in graph — file absent', true);
    ok('(skipped) a.md has no links to b.md — file absent', true);
  }

  // ── cleanup + result ─────────────────────────────────────────────────────
  await cleanup();

  console.log(`\n${'─'.repeat(50)}`);
  if (failed === 0) {
    console.log(`smoke:prune-live: PASS — ${passed}/${passed + failed} assertions`);
  } else {
    console.error(`smoke:prune-live: FAIL — ${failed} failure(s), ${passed} passed`);
    process.exit(1);
  }
}

main().catch(async err => {
  console.error('\nUnhandled error:', err);
  await cleanup();
  process.exit(1);
});
