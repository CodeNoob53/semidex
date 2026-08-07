// Optional live integration smoke for PRUNE_STALE=1.
// Creates a temporary Qdrant collection, indexes two fixture files, deletes one,
// re-runs with PRUNE_STALE=1, and asserts the deleted source_file is gone from
// Qdrant. Cleans up the temp collection, temp files, and config.json entry.
//
// Usage:
//   npm run smoke:prune-live
//
// Requires: Qdrant reachable (QDRANT_URL in .env). Uses ONNX_EMBED=1 internally.
// NOT part of default CI or npm run smoke or smoke:retrieval-live.

import 'dotenv/config';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';

import { listSourceFiles, deleteCollection } from '../../src/shared/core/qdrant.js';
import { loadConfig, saveConfig } from '../../src/shared/core/config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const COLLECTION = `smoke-prune-${Date.now()}`;

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

const stamp = Date.now();
const TMP_DIR = join(pickTmpRoot(), `prune-smoke-${stamp}`);

let passed = 0;
let failed = 0;
let cleanupDone = false;

function ok(label, result) {
  if (result) {
    console.log(`  OK ${label}`);
    passed++;
  } else {
    console.error(`  FAIL ${label}`);
    failed++;
  }
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
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true });
    console.log(`  deleted temp dir: ${TMP_DIR}`);
  }
  cleanConfig();
}

function runIndexer(dir, extraEnv = {}) {
  const env = {
    ...process.env,
    COLLECTION,
    ONNX_EMBED: '1',
    SOURCE_ROOT: dir,
    ...extraEnv,
  };

  const result = process.platform === 'win32'
    ? spawnSync('cmd', ['/c', 'npm', 'run', 'index', dir], { env, cwd: ROOT, stdio: 'inherit' })
    : spawnSync('npm', ['run', 'index', dir], { env, cwd: ROOT, stdio: 'inherit' });
  return result.status ?? 1;
}

process.on('exit', () => {
  if (!cleanupDone) console.warn('[warn] cleanup skipped - call cleanup() explicitly');
});

async function main() {
  console.log('=== smoke:prune-live ===');
  console.log(`collection : ${COLLECTION}`);
  console.log(`tmp dir    : ${TMP_DIR}`);

  mkdirSync(TMP_DIR, { recursive: true });
  const aPath = join(TMP_DIR, 'a.md');
  const bPath = join(TMP_DIR, 'b.md');
  writeFileSync(aPath, '# Alpha\n\nThis is the alpha document for prune smoke testing.\n', 'utf8');
  writeFileSync(bPath, '# Beta\n\nThis is the beta document for prune smoke testing.\n', 'utf8');
  console.log('\n[step 1] created temp fixtures: a.md, b.md');

  console.log('\n[step 2] indexing temp dir (first run)...');
  const status1 = runIndexer(TMP_DIR);
  if (status1 !== 0) {
    console.error(`  FAIL indexer exited with code ${status1}`);
    await cleanup();
    process.exit(1);
  }

  console.log('\n[step 3] verifying initial Qdrant state...');
  const afterFirst = await listSourceFiles(COLLECTION);
  ok('a.md indexed after first run', afterFirst.includes('a.md'));
  ok('b.md indexed after first run', afterFirst.includes('b.md'));
  ok('exactly 2 source files after first run', afterFirst.length === 2);

  console.log('\n[step 4] deleting b.md from disk...');
  rmSync(bPath);

  console.log('\n[step 5] re-indexing with PRUNE_STALE=1...');
  const status2 = runIndexer(TMP_DIR, { PRUNE_STALE: '1' });
  if (status2 !== 0) {
    console.error(`  FAIL indexer (PRUNE_STALE=1) exited with code ${status2}`);
    await cleanup();
    process.exit(1);
  }

  console.log('\n[step 6] verifying Qdrant state after prune...');
  const afterPrune = await listSourceFiles(COLLECTION);
  ok('a.md still present after prune', afterPrune.includes('a.md'));
  ok('b.md removed from Qdrant after prune', !afterPrune.includes('b.md'));
  ok('exactly 1 source file after prune', afterPrune.length === 1);

  await cleanup();

  console.log('\n' + '-'.repeat(50));
  if (failed === 0) {
    console.log(`smoke:prune-live: PASS - ${passed}/${passed + failed} assertions`);
  } else {
    console.error(`smoke:prune-live: FAIL - ${failed} failure(s), ${passed} passed`);
    process.exit(1);
  }
}

main().catch(async err => {
  console.error('\nUnhandled error:', err);
  await cleanup();
  process.exit(1);
});
