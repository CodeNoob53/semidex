/**
 * Duplicate Qdrant point repair — Safe Repair v2 (default) and legacy mode.
 *
 * Default mode (reindex-first / safe):
 *   For each affected source_file:
 *   1. Reindex the file — with deterministic IDs, this upserts the correct
 *      current points in place.
 *   2. Verify Qdrant has >0 points for that source_file after reindex.
 *   3. Delete only the orphan old-ID duplicates (non-deterministic point IDs
 *      that were not overwritten by the reindex).
 *   A file can never become absent: it is always reindexed before any deletes.
 *
 * Legacy mode (opt-in only, DUPLICATE_REPAIR_MODE=legacy-delete-first):
 *   Deletes all points for a source_file THEN reindexes.
 *   This matches the v1 behaviour. There is a window where the file is absent
 *   from Qdrant between the delete and the reindex. Do NOT use for new repairs.
 *
 * Required env:
 *   QDRANT_URL, QDRANT_KEY (via .env)
 *   COLLECTION            — target collection name
 *   SOURCE_ROOT           — must match the root used during original indexing
 *
 * Optional env:
 *   DUPLICATE_REPAIR_APPLY=1        — enable apply mode (default: dry-run)
 *   DUPLICATE_REPAIR_MODE=legacy-delete-first — use old unsafe delete-first flow
 *   DUPLICATE_REPAIR_LIMIT=N        — max number of source files to repair
 *   DUPLICATE_REPAIR_REPORT_PATH=   — override report output path
 *   SCROLL_LIMIT=250                — scroll page size
 *   TAG_GEN, ONNX_EMBED, CONTEXT_MODEL, etc. passed through to indexer
 *
 * Privacy contract:
 *   All reports use SHA-1 hashes of source_file paths, never raw paths.
 *   No raw tags, context, or chunk text is written to any report file.
 *   Raw paths are logged to stderr only during an apply run (local only).
 *
 * Safety contract:
 *   - Dry-run by default: no deletes, no reindexing.
 *   - Apply mode requires DUPLICATE_REPAIR_APPLY=1.
 *   - Apply mode requires SOURCE_ROOT and verifies it exists.
 *   - All affected files validated on disk before any mutation begins.
 *   - Ollama/indexer preflight runs before any mutation.
 *   - If preflight fails, abort before touching any data.
 *   - Resolved file paths must stay inside SOURCE_ROOT (path traversal guard).
 *   - Sequential only: one file at a time.
 *   - On first failure: stop, report, do not continue.
 *   - A file is never left with 0 points by safe mode — orphan delete only
 *     runs after a successful reindex is verified.
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, join, relative, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── env ──────────────────────────────────────────────────────────────────────

const QDRANT_URL   = process.env.QDRANT_URL;
const QDRANT_KEY   = process.env.QDRANT_KEY;
const COLLECTION   = process.env.COLLECTION;
const SOURCE_ROOT  = process.env.SOURCE_ROOT;
const APPLY        = process.env.DUPLICATE_REPAIR_APPLY === '1';
const LEGACY_MODE  = process.env.DUPLICATE_REPAIR_MODE === 'legacy-delete-first';
const LIMIT        = process.env.DUPLICATE_REPAIR_LIMIT
  ? parseInt(process.env.DUPLICATE_REPAIR_LIMIT, 10)
  : Infinity;
const SCROLL_LIMIT = parseInt(process.env.SCROLL_LIMIT || '250', 10);
const REPORT_PATH  = process.env.DUPLICATE_REPAIR_REPORT_PATH || null;

// Env vars that must be forwarded to the indexer subprocess
const INDEXER_PASSTHROUGH = [
  'TAG_GEN', 'ONNX_EMBED', 'CONTEXT_MODEL', 'TAG_MODEL',
  'ONNX_EXECUTION_PROVIDER', 'OLLAMA_URL', 'LINK_COLLECTIONS',
  'LINK_TOP', 'LINK_MIN_SCORE', 'MAX_CHUNK_TOKENS', 'LLM_BATCH_SIZE',
];

// ── pure helpers (exported for smoke tests) ───────────────────────────────────

export function hashPath(p) {
  return createHash('sha1').update(p ?? '').digest('hex').slice(0, 16);
}

/**
 * Strip filesystem paths from an error string before writing it to a report.
 * Covers: Windows absolute (C:\... or C:/...), UNC (\\server\...), POSIX (/seg/seg).
 * http(s):// and other scheme:// URLs are preserved — only bare FS paths are redacted.
 */
export function sanitizeErrorForReport(msg) {
  if (msg == null) return '';
  // Protect scheme://... URLs by replacing them with placeholders so later
  // path regexes cannot match the slashes inside them.
  const urls = [];
  let s = String(msg).replace(/\w+:\/\/[^\s"'\n]*/g, m => {
    urls.push(m);
    return `\x00URL${urls.length - 1}\x00`;
  });
  s = s
    // UNC: two or more leading backslashes followed by non-whitespace
    .replace(/[\\]{2,}[^\s"'\n]+/g, '<path>')
    // Windows absolute: drive letter + colon + forward or back slash, up to quote/newline
    // Match greedily including spaces — paths with spaces (C:\Program Files\...) are common
    .replace(/[A-Za-z]:[/\\][^"'\n]*/g, '<path>')
    // POSIX absolute: at least two /segment groups (e.g. /usr/local/bin)
    .replace(/(\/[^/\s"'\n][^\s"'\n]*){2,}/g, '<path>')
    // Residual: backslash-separated word sequences left after Windows path partial match
    .replace(/(?:\w+\\){2,}\w+[^\s"'\n]*/g, '<path>');
  // Restore protected URLs
  s = s.replace(/\x00URL(\d+)\x00/g, (_, i) => urls[+i]);
  return s.slice(0, 300);
}

export function nowStamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * Resolve sourceFile against sourceRoot and verify the result stays inside it.
 * Uses resolve() so SOURCE_ROOT=. works correctly.
 * Returns the absolute path or throws if the path escapes the root.
 */
export function safeResolveFile(sourceRoot, sourceFile) {
  const root = resolve(sourceRoot);
  const abs  = resolve(root, sourceFile);
  const rel  = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path traversal rejected: '${sourceFile}' resolves outside SOURCE_ROOT`);
  }
  return abs;
}

/**
 * Compute the expected deterministic point ID for a chunk using the same
 * algorithm as src/core/point-id.js (RFC 4122 v5 SHA-1 UUID).
 *
 * This is duplicated here (not imported) to keep the repair script self-contained
 * and to avoid coupling to internal module paths.
 *
 * Pure function — no I/O.
 */
export function computeDeterministicId({ collection, sourceFile, chunkIndex, embeddingSchemaVersion }) {
  const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
  const hex = NAMESPACE.replace(/-/g, '');
  const nsBuf = Buffer.allocUnsafe(16);
  for (let i = 0; i < 16; i++) nsBuf[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);

  const normalizedFile = sourceFile.replace(/\\/g, '/');
  const name = `${collection}\x00${normalizedFile}\x00${chunkIndex}\x00${embeddingSchemaVersion}`;
  const hash = createHash('sha1').update(nsBuf).update(Buffer.from(name, 'utf8')).digest();

  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant RFC 4122

  const h = hash.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

/**
 * Build a cleanup plan for one source_file's duplicate groups.
 *
 * For each (source_file, chunk_index) group with >1 point:
 *   - Compute the expected deterministic ID for that chunk.
 *   - If that ID is present among the actual point IDs → it is the keeper;
 *     all other IDs in the group are orphans to delete.
 *   - If the deterministic ID is NOT present → we cannot safely select a keeper;
 *     mark the group as `missingDeterministicId`.
 *
 * Returns { orphanIds, missingDeterministicIdGroups }.
 * Pure function — no I/O.
 */
export function buildCleanupPlan(dupGroupsForFile, collection, embeddingSchemaVersion) {
  const orphanIds = [];
  const missingDeterministicIdGroups = [];

  for (const [key, entries] of dupGroupsForFile) {
    const sourceFile = entries[0].sourceFile;
    const chunkIndex = entries[0].payload?.chunk_index ?? '?';

    const deterministicId = computeDeterministicId({
      collection,
      sourceFile,
      chunkIndex,
      embeddingSchemaVersion,
    });

    const actualIds = entries.map(e => e.id);
    const hasDeterministicId = actualIds.includes(deterministicId);

    if (!hasDeterministicId) {
      missingDeterministicIdGroups.push({ key, chunkIndex, actualIds });
      continue;
    }

    // Keep the deterministic ID; delete all others
    for (const id of actualIds) {
      if (id !== deterministicId) orphanIds.push(id);
    }
  }

  return { orphanIds, missingDeterministicIdGroups };
}

/**
 * Build duplicate groups from a flat points array.
 * Groups by raw source_file from payload so deleteBySourceFile() gets the exact
 * value Qdrant has — sanitizing here would cause mismatches on delete/reindex.
 * Returns { dupGroups, affectedFiles, totalExtraPoints }.
 * Pure function — no I/O.
 */
export function buildDuplicateGroups(points) {
  const groups = new Map();
  for (const pt of points) {
    const sf  = pt.payload?.source_file ?? '';
    const ci  = pt.payload?.chunk_index ?? '?';
    // Key uses raw source_file so grouping matches Qdrant exactly
    const key = `${sf}\x00${ci}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id: pt.id, sourceFile: sf, payload: pt.payload ?? {} });
  }

  const dupGroups = [...groups.entries()]
    .filter(([, v]) => v.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  // affectedFiles: raw source_file values — used directly in delete/reindex
  const affectedFiles = [...new Set(dupGroups.map(([, entries]) => entries[0].sourceFile))];

  // Extra points = for each group, count - 1 (the "excess" over the canonical one)
  const totalExtraPoints = dupGroups.reduce((s, [, v]) => s + (v.length - 1), 0);

  return { dupGroups, affectedFiles, totalExtraPoints };
}

/**
 * Build a privacy-safe dry-run summary object from duplicate analysis results.
 * Pure function — no I/O, no raw paths.
 */
export function buildDryRunSummary({ collection, dupGroups, affectedFiles, totalExtraPoints, totalPoints, sourceRootExists, missingFiles }) {
  return {
    collection,
    totalPoints,
    duplicateGroups: dupGroups.length,
    affectedSourceFiles: affectedFiles.length,
    estimatedExtraPoints: totalExtraPoints,
    sourceRootExists,
    missingFilesCount: missingFiles.length,
    affectedFileHashes: affectedFiles.map(hashPath),
    missingFileHashes: missingFiles.map(hashPath),
  };
}

// ── Qdrant I/O ────────────────────────────────────────────────────────────────

const qdrantHeaders = { 'api-key': QDRANT_KEY, 'Content-Type': 'application/json' };

const PAYLOAD_FIELDS = ['source_file', 'chunk_index', 'embedding_schema_version'];

async function scrollAll() {
  const points = [];
  let offset = null;
  let page = 0;
  while (true) {
    const body = { limit: SCROLL_LIMIT, with_payload: PAYLOAD_FIELDS, with_vectors: false };
    if (offset !== null) body.offset = offset;
    const r = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/scroll`, {
      method: 'POST', headers: qdrantHeaders, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Scroll failed (page ${page}): ${await r.text()}`);
    const data = await r.json();
    const batch = data.result?.points ?? [];
    points.push(...batch);
    offset = data.result?.next_page_offset ?? null;
    page++;
    process.stderr.write(`\r  scrolled ${points.length} points (page ${page})...`);
    if (offset === null) break;
  }
  process.stderr.write('\n');
  return points;
}

async function scrollBySourceFile(collection, sourceFile) {
  const points = [];
  let offset = null;
  while (true) {
    const body = {
      limit: SCROLL_LIMIT,
      with_payload: false,
      with_vectors: false,
      filter: { must: [{ key: 'source_file', match: { value: sourceFile } }] },
    };
    if (offset !== null) body.offset = offset;
    const r = await fetch(`${QDRANT_URL}/collections/${collection}/points/scroll`, {
      method: 'POST', headers: qdrantHeaders, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Scroll by source_file failed: ${await r.text()}`);
    const data = await r.json();
    points.push(...(data.result?.points ?? []));
    offset = data.result?.next_page_offset ?? null;
    if (offset === null) break;
  }
  return points;
}

async function deletePointsByIds(collection, ids) {
  if (ids.length === 0) return;
  const r = await fetch(`${QDRANT_URL}/collections/${collection}/points/delete`, {
    method: 'POST',
    headers: qdrantHeaders,
    body: JSON.stringify({ points: ids }),
  });
  if (!r.ok) throw new Error(`Qdrant delete by IDs failed: ${await r.text()}`);
}

async function deleteBySourceFile(collection, sourceFile) {
  const r = await fetch(`${QDRANT_URL}/collections/${collection}/points/delete`, {
    method: 'POST',
    headers: qdrantHeaders,
    body: JSON.stringify({
      filter: { must: [{ key: 'source_file', match: { value: sourceFile } }] },
    }),
  });
  if (!r.ok) throw new Error(`Qdrant delete failed for '${hashPath(sourceFile)}': ${await r.text()}`);
}

/**
 * Resolve which Ollama model names the indexer will actually need, mirroring
 * src/indexer/index.js lines 71-77. Pure function — no I/O, exported for tests.
 *
 * Rules (same as indexer):
 *   COMBINED_LLM=1 → TAG_MODEL is ignored; only CONTEXT_MODEL is used for both.
 *   TAG_GEN=0      → tag generation skipped; TAG_MODEL not needed.
 *   Otherwise      → both CONTEXT_MODEL and TAG_MODEL are needed independently.
 *
 * Returns a deduplicated string[] of model names to check for availability.
 */
export function resolveOllamaModelsToCheck(env = {}) {
  const contextModel = env.CONTEXT_MODEL || 'gemma3:4b';
  const combinedLlm  = env.COMBINED_LLM === '1';
  const genTags      = env.TAG_GEN !== '0';
  const tagModel     = (combinedLlm || !genTags) ? contextModel : (env.TAG_MODEL || contextModel);
  return [...new Set([contextModel, tagModel])];
}

// ── indexer subprocess ────────────────────────────────────────────────────────

function buildIndexerEnv(sourceRoot, { forceReindex = false, skipPreDelete = false } = {}) {
  const env = { ...process.env, COLLECTION, SOURCE_ROOT: sourceRoot };
  for (const k of INDEXER_PASSTHROUGH) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  if (forceReindex)  env.FORCE_REINDEX  = '1';
  if (skipPreDelete) env.SKIP_PRE_DELETE = '1';
  return env;
}

function reindexFile(absFilePath, sourceRoot) {
  // FORCE_REINDEX=1: bypass unchanged-skip so deterministic IDs are always upserted.
  // SKIP_PRE_DELETE=1: skip the indexer's own pre-delete so the file stays in Qdrant
  //   if anything fails between here and the final upsert. Orphan old-ID cleanup is
  //   done by the repair script itself after verifying the reindex succeeded.
  const env = buildIndexerEnv(sourceRoot, { forceReindex: true, skipPreDelete: true });
  execFileSync(process.execPath, ['src/indexer/index.js', absFilePath], {
    env,
    cwd: resolve(__dirname, '..', '..'),
    stdio: 'inherit',
  });
}

/**
 * Direct HTTP Ollama preflight — mirrors the model-selection logic in
 * src/indexer/index.js so we check exactly the models the indexer will need:
 *   - COMBINED_LLM=1 → indexer uses CONTEXT_MODEL for both context and tags;
 *     TAG_MODEL is ignored, so we only check CONTEXT_MODEL.
 *   - TAG_GEN=0 → tag generation is skipped; TAG_MODEL is not needed.
 *   - Otherwise → check both CONTEXT_MODEL and TAG_MODEL independently.
 * Throws with a [preflight]-prefixed message on failure.
 */
async function checkOllamaReachable() {
  const base  = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
  const needed = resolveOllamaModelsToCheck(process.env);

  try {
    const r = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (err) {
    const hint = /localhost/i.test(base)
      ? ' (on Windows try OLLAMA_URL=http://127.0.0.1:11434)'
      : '';
    throw new Error(`[preflight] Ollama unreachable at ${base}${hint}: ${err.message}`);
  }

  let available;
  try {
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    available = new Set((data.models ?? []).map(m => m.name));
  } catch (err) {
    throw new Error(`[preflight] Could not list Ollama models: ${err.message}`);
  }

  const missing = needed.filter(m => !available.has(m));
  if (missing.length > 0) {
    throw new Error(`[preflight] Required Ollama model(s) not pulled: ${missing.join(', ')}`);
  }
}

// ── report writing ────────────────────────────────────────────────────────────

function defaultReportPath(stamp, suffix) {
  const dir = resolve(__dirname, 'results');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${stamp}-duplicate-point-repair-${COLLECTION}-${suffix}.md`);
}

function writeDryRunReport(stamp, summary) {
  const path = REPORT_PATH
    ? REPORT_PATH.replace('{suffix}', 'dry-run')
    : defaultReportPath(stamp, 'dry-run');

  const lines = [
    `# Duplicate Point Repair — Dry-Run — \`${summary.collection}\``,
    '',
    `*Generated: ${stamp}*`,
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Total points scanned | ${summary.totalPoints} |`,
    `| Duplicate groups | ${summary.duplicateGroups} |`,
    `| Affected source files | ${summary.affectedSourceFiles} |`,
    `| Estimated extra points | ${summary.estimatedExtraPoints} |`,
    `| SOURCE_ROOT exists | ${summary.sourceRootExists} |`,
    `| Files missing from disk | ${summary.missingFilesCount} |`,
    '',
    '## Affected file hashes (SHA-1 prefix, no raw paths)',
    '',
    summary.affectedFileHashes.length > 0
      ? summary.affectedFileHashes.map(h => `- \`${h}\``).join('\n')
      : '_none_',
    '',
    ...(summary.missingFilesCount > 0 ? [
      '## Files missing from disk (hashes only)',
      '',
      summary.missingFileHashes.map(h => `- \`${h}\``).join('\n'),
      '',
      '> These files exist in Qdrant but cannot be found under SOURCE_ROOT.',
      '> They will be skipped during apply. Delete their points manually if needed.',
      '',
    ] : []),
    '---',
    '',
    '*No points were deleted. No files were reindexed.*',
    '*Run with `DUPLICATE_REPAIR_APPLY=1` to apply.*',
  ];

  writeFileSync(path, lines.join('\n'), 'utf8');
  return path;
}

function writeApplyReport(stamp, { mode, before, after, repaired, skipped, failed, failureDetails, recoveryRequired }) {
  const path = REPORT_PATH
    ? REPORT_PATH.replace('{suffix}', 'apply')
    : defaultReportPath(stamp, 'apply');

  const modeLabel = mode === 'safe' ? 'Safe (reindex-first)' : 'Legacy (delete-first — DEPRECATED)';

  const lines = [
    `# Duplicate Point Repair — Apply — \`${COLLECTION}\``,
    '',
    `*Generated: ${stamp}*`,
    `*Mode: ${modeLabel}*`,
    '',
    '## Results',
    '',
    '| Metric | Before | After |',
    '|--------|--------|-------|',
    `| Duplicate groups | ${before.dupGroups} | ${after.dupGroups} |`,
    `| Affected source files | ${before.affectedFiles} | ${after.affectedFiles} |`,
    '',
    '| Outcome | Count |',
    '|---------|-------|',
    `| Repaired | ${repaired} |`,
    `| Skipped (file missing) | ${skipped} |`,
    `| Failed | ${failed} |`,
    '',
    ...(failureDetails.length > 0 ? [
      '## Failures',
      '',
      failureDetails.map(f => `- file hash \`${f.hash}\`: ${f.reason}`).join('\n'),
      '',
    ] : []),
    ...(recoveryRequired ? [
      '## Recovery required',
      '',
      '> One or more files failed during repair. In safe mode the file was NOT',
      '> deleted before failure, so no files should be absent from Qdrant.',
      '> Verify with the diagnostic script and reindex the affected file hashes',
      '> manually if needed.',
      '',
    ] : []),
    '---',
    '',
    '*Report contains no raw paths, tags, context, or chunk text.*',
  ];

  writeFileSync(path, lines.join('\n'), 'utf8');
  return path;
}

// ── main ──────────────────────────────────────────────────────────────────────
// Only run when invoked directly; skip when imported by smoke tests or other modules.

const isMain = process.argv[1] &&
  fileURLToPath(import.meta.url).replace(/\\/g, '/') ===
  resolve(process.argv[1]).replace(/\\/g, '/');

if (isMain) (async () => {
  // ── basic preflight ────────────────────────────────────────────────────────

  if (!COLLECTION) {
    console.error('[repair] COLLECTION is required');
    process.exit(1);
  }
  if (!QDRANT_URL) {
    console.error('[repair] QDRANT_URL is required (set in .env)');
    process.exit(1);
  }

  if (APPLY) {
    if (!SOURCE_ROOT) {
      console.error('[repair] SOURCE_ROOT is required in apply mode');
      process.exit(1);
    }
    if (!existsSync(SOURCE_ROOT)) {
      console.error(`[repair] SOURCE_ROOT does not exist: ${SOURCE_ROOT}`);
      process.exit(1);
    }
  }

  const repairMode = LEGACY_MODE ? 'legacy' : 'safe';
  const mode = APPLY ? `APPLY (${repairMode})` : 'DRY-RUN';
  console.log(`[repair] Duplicate point repair — collection: ${COLLECTION} — mode: ${mode}`);
  if (APPLY) {
    console.log(`[repair] SOURCE_ROOT: ${SOURCE_ROOT}`);
    if (LEGACY_MODE) {
      console.warn('[repair] WARNING: legacy-delete-first mode enabled. Files can become temporarily absent.');
    }
  }
  if (isFinite(LIMIT)) console.log(`[repair] DUPLICATE_REPAIR_LIMIT: ${LIMIT}`);

  // ── scroll & analyse ───────────────────────────────────────────────────────

  console.log(`[repair] Scrolling all points (page size ${SCROLL_LIMIT})...`);
  const all = await scrollAll();
  console.log(`[repair] Total points: ${all.length}`);

  const { dupGroups, affectedFiles, totalExtraPoints } = buildDuplicateGroups(all);

  console.log(`[repair] Duplicate groups:    ${dupGroups.length}`);
  console.log(`[repair] Affected files:      ${affectedFiles.length}`);
  console.log(`[repair] Estimated extra pts: ${totalExtraPoints}`);

  if (dupGroups.length === 0) {
    console.log('[repair] No duplicates found. Collection is clean.');
    process.exit(0);
  }

  const sourceRootExists = SOURCE_ROOT ? existsSync(SOURCE_ROOT) : false;

  const missingFiles = [];
  if (SOURCE_ROOT && sourceRootExists) {
    for (const sf of affectedFiles) {
      try {
        const abs = safeResolveFile(SOURCE_ROOT, sf);
        if (!existsSync(abs)) missingFiles.push(sf);
      } catch {
        missingFiles.push(sf);
      }
    }
  }

  if (missingFiles.length > 0) {
    console.log(`[repair] Files missing from disk: ${missingFiles.length} (will be skipped in apply)`);
  }

  // ── dry-run path ───────────────────────────────────────────────────────────

  if (!APPLY) {
    const summary = buildDryRunSummary({
      collection: COLLECTION,
      dupGroups,
      affectedFiles,
      totalExtraPoints,
      totalPoints: all.length,
      sourceRootExists,
      missingFiles,
    });

    const stamp = nowStamp();
    const reportPath = writeDryRunReport(stamp, summary);

    console.log('\n[repair] DRY-RUN SUMMARY');
    console.log(`  Collection:           ${COLLECTION}`);
    console.log(`  Total points:         ${all.length}`);
    console.log(`  Duplicate groups:     ${dupGroups.length}`);
    console.log(`  Affected files:       ${affectedFiles.length}`);
    console.log(`  Estimated extra pts:  ${totalExtraPoints}`);
    console.log(`  SOURCE_ROOT exists:   ${sourceRootExists}`);
    console.log(`  Missing from disk:    ${missingFiles.length}`);
    console.log(`\n[repair] Report: ${reportPath}`);
    console.log('[repair] Run with DUPLICATE_REPAIR_APPLY=1 to apply.');
    process.exit(0);
  }

  // ── apply preflight — validate ALL files before touching anything ──────────

  console.log('\n[repair] Validating all affected files before any mutation...');
  const filesToProcess = isFinite(LIMIT) ? affectedFiles.slice(0, LIMIT) : affectedFiles;

  for (const sf of filesToProcess) {
    if (missingFiles.includes(sf)) continue; // will be skipped
    try {
      safeResolveFile(SOURCE_ROOT, sf);
    } catch (err) {
      console.error(`[repair] Preflight FAIL: path traversal detected for hash=${hashPath(sf)}: ${err.message}`);
      console.error('[repair] Aborting before any data was modified.');
      process.exit(1);
    }
    const abs = safeResolveFile(SOURCE_ROOT, sf);
    if (!existsSync(abs)) {
      // Already in missingFiles — shouldn't reach here, but guard anyway
      console.error(`[repair] Preflight FAIL: file not found on disk — hash=${hashPath(sf)}`);
      console.error('[repair] Aborting before any data was modified.');
      process.exit(1);
    }
  }

  console.log('[repair] Disk validation OK. Running Ollama preflight...');
  try {
    await checkOllamaReachable();
    console.log('[repair] Ollama preflight OK.');
  } catch (err) {
    const reason = sanitizeErrorForReport(err.message);
    console.error(`[repair] Ollama preflight FAILED: ${reason}`);
    console.error('[repair] Aborting before any data was modified. Fix the service issue and retry.');
    process.exit(1);
  }

  // ── apply path ─────────────────────────────────────────────────────────────

  console.log('\n[repair] Starting apply...');

  const beforeGroups = dupGroups.length;
  const beforeFiles  = affectedFiles.length;

  // Group dupGroups by source_file for per-file cleanup plan
  const dupGroupsByFile = new Map();
  for (const entry of dupGroups) {
    const sf = entry[1][0].sourceFile;
    if (!dupGroupsByFile.has(sf)) dupGroupsByFile.set(sf, []);
    dupGroupsByFile.get(sf).push(entry);
  }

  // Read embeddingSchemaVersion from a sample point in the collection
  // so cleanup plan uses the correct schema version actually stored in Qdrant.
  let embeddingSchemaVersion = 2; // default
  {
    const samplePoint = all.find(p => p.payload?.embedding_schema_version != null);
    if (samplePoint) embeddingSchemaVersion = samplePoint.payload.embedding_schema_version;
  }

  let repaired = 0;
  let skipped  = 0;
  let failed   = 0;
  const failureDetails = [];

  for (const sf of filesToProcess) {
    const sfHash = hashPath(sf);

    if (missingFiles.includes(sf)) {
      console.log(`[repair] SKIP (file missing) hash=${sfHash}`);
      skipped++;
      continue;
    }

    const absPath = safeResolveFile(SOURCE_ROOT, sf);
    const fileGroups = dupGroupsByFile.get(sf) ?? [];

    console.log(`[repair] Processing hash=${sfHash} (${repaired + skipped + failed + 1}/${filesToProcess.length})`);

    try {
      if (LEGACY_MODE) {
        // ── Legacy: delete-first (unsafe, deprecated) ──────────────────────
        process.stderr.write(`  [legacy] deleting points...\n`);
        await deleteBySourceFile(COLLECTION, sf);
        process.stderr.write(`  [legacy] reindexing...\n`);
        reindexFile(absPath, SOURCE_ROOT);
      } else {
        // ── Safe: reindex-first ────────────────────────────────────────────

        // Step 1: Reindex — deterministic IDs overwrite current points in place
        process.stderr.write(`  reindexing (step 1/3)...\n`);
        reindexFile(absPath, SOURCE_ROOT);

        // Step 2: Verify >0 points exist after reindex
        process.stderr.write(`  verifying Qdrant points (step 2/3)...\n`);
        const afterReindex = await scrollBySourceFile(COLLECTION, sf);
        if (afterReindex.length === 0) {
          throw new Error(`Reindex verification failed: 0 points for hash=${sfHash} after reindex`);
        }

        // Step 3: Build cleanup plan and delete only orphan old-ID points
        process.stderr.write(`  deleting orphan duplicates (step 3/3)...\n`);
        const { orphanIds, missingDeterministicIdGroups } = buildCleanupPlan(
          fileGroups, COLLECTION, embeddingSchemaVersion
        );

        let toDelete;
        if (missingDeterministicIdGroups.length > 0) {
          // Some groups had no deterministic ID before reindex — verify they exist now.
          const freshIds = new Set(afterReindex.map(p => p.id));
          for (const g of missingDeterministicIdGroups) {
            const expectedId = computeDeterministicId({
              collection: COLLECTION,
              sourceFile: sf,
              chunkIndex: g.chunkIndex,
              embeddingSchemaVersion,
            });
            if (!freshIds.has(expectedId)) {
              throw new Error(`Cleanup refused: deterministic ID missing after reindex for hash=${sfHash} chunk ${g.chunkIndex}`);
            }
          }
          // Deterministic IDs confirmed — collect all pre-reindex IDs from those groups
          // as orphans. These are the old randomUUID IDs; they were not overwritten by
          // the reindex (SKIP_PRE_DELETE means they still exist in Qdrant). Delete them
          // directly — do NOT filter against freshIds, which still contains them.
          const missingGroupOrphans = missingDeterministicIdGroups.flatMap(g => g.actualIds);
          toDelete = [...orphanIds, ...missingGroupOrphans];
        } else {
          toDelete = orphanIds;
        }

        await deletePointsByIds(COLLECTION, toDelete);
        process.stderr.write(`  deleted ${toDelete.length} orphan point(s)\n`);
      }

      repaired++;
      console.log(`[repair] OK hash=${sfHash}`);
    } catch (err) {
      failed++;
      const rawMsg = (err.stderr?.toString() || err.message)
        .split('\n').map(l => l.trim()).find(l => l.length > 0) ?? 'unknown error';
      const reason = sanitizeErrorForReport(rawMsg);
      failureDetails.push({ hash: sfHash, reason });
      console.error(`[repair] FAILED hash=${sfHash}: ${reason}`);
      console.error('[repair] Stopping after first failure to avoid partial state.');
      break;
    }
  }

  // ── post-apply verification ────────────────────────────────────────────────

  console.log('\n[repair] Re-scanning for verification...');
  const allAfter = await scrollAll();
  const { dupGroups: dupGroupsAfter, affectedFiles: affectedFilesAfter } = buildDuplicateGroups(allAfter);

  console.log('\n[repair] APPLY RESULTS');
  console.log(`  Mode:                    ${repairMode}`);
  console.log(`  Duplicate groups before: ${beforeGroups}  →  after: ${dupGroupsAfter.length}`);
  console.log(`  Affected files before:   ${beforeFiles}  →  after: ${affectedFilesAfter.length}`);
  console.log(`  Repaired:  ${repaired}`);
  console.log(`  Skipped:   ${skipped}`);
  console.log(`  Failed:    ${failed}`);

  const stamp = nowStamp();
  const reportPath = writeApplyReport(stamp, {
    mode: repairMode,
    before: { dupGroups: beforeGroups, affectedFiles: beforeFiles },
    after:  { dupGroups: dupGroupsAfter.length, affectedFiles: affectedFilesAfter.length },
    repaired,
    skipped,
    failed,
    failureDetails,
    recoveryRequired: failed > 0,
  });
  console.log(`\n[repair] Report: ${reportPath}`);

  if (failed > 0) process.exit(1);
})();
