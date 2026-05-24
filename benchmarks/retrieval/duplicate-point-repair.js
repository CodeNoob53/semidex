/**
 * Duplicate Qdrant point repair.
 *
 * Finds all duplicate (source_file, chunk_index) groups, then for each
 * affected source_file: deletes all its points and reindexes the file.
 *
 * Required env:
 *   QDRANT_URL, QDRANT_KEY (via .env)
 *   COLLECTION            — target collection name
 *   SOURCE_ROOT           — must match the root used during original indexing
 *
 * Optional env:
 *   DUPLICATE_REPAIR_APPLY=1        — enable destructive mode (default: dry-run)
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
 *   - Resolved file paths must stay inside SOURCE_ROOT (path traversal guard).
 *   - Sequential only: one file at a time.
 *   - On first failure: stop, report, do not continue.
 *
 * Known gap — delete-before-reindex window:
 *   Apply deletes a file's points THEN reindexes. If the process is interrupted
 *   between those two steps (Ollama down, network error, Ctrl-C), that file will
 *   be absent from Qdrant until manually reindexed. With deterministic point IDs
 *   a plain reindex (no prior delete) is sufficient to restore it — run:
 *     SOURCE_ROOT=<same root> COLLECTION=<col> ONNX_EMBED=1 npm run index <file>
 *   The apply report records the failed file hash so you can identify which file
 *   needs recovery. A future improvement could flip the order to reindex-first
 *   (upsert overwrites old point IDs via deterministic IDs), then delete orphan
 *   old-ID points. That would eliminate this window entirely.
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

// ── helpers ───────────────────────────────────────────────────────────────────

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

const qdrantHeaders = { 'api-key': QDRANT_KEY, 'Content-Type': 'application/json' };

const PAYLOAD_FIELDS = ['source_file', 'chunk_index'];

// ── scroll ────────────────────────────────────────────────────────────────────

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

// ── duplicate grouping (shared logic with diagnostic) ────────────────────────

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

// ── dry-run summary ───────────────────────────────────────────────────────────

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

// ── delete ────────────────────────────────────────────────────────────────────

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

// ── reindex ───────────────────────────────────────────────────────────────────

function buildIndexerEnv(sourceRoot) {
  const env = { ...process.env, COLLECTION, SOURCE_ROOT: sourceRoot };
  // Ensure passthrough vars are forwarded if present
  for (const k of INDEXER_PASSTHROUGH) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}

function reindexFile(absFilePath, sourceRoot) {
  const env = buildIndexerEnv(sourceRoot);
  execFileSync(process.execPath, ['src/indexer/index.js', absFilePath], {
    env,
    cwd: resolve(__dirname, '..', '..'),
    stdio: 'inherit',
  });
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

function writeApplyReport(stamp, { before, after, repaired, skipped, failed, failureDetails }) {
  const path = REPORT_PATH
    ? REPORT_PATH.replace('{suffix}', 'apply')
    : defaultReportPath(stamp, 'apply');

  const lines = [
    `# Duplicate Point Repair — Apply — \`${COLLECTION}\``,
    '',
    `*Generated: ${stamp}*`,
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
  // ── preflight checks ───────────────────────────────────────────────────────

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

  const mode = APPLY ? 'APPLY' : 'DRY-RUN';
  console.log(`[repair] Duplicate point repair — collection: ${COLLECTION} — mode: ${mode}`);
  if (APPLY) console.log(`[repair] SOURCE_ROOT: ${SOURCE_ROOT}`);
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

  // Check which affected files exist under SOURCE_ROOT (or report unknown when dry-run)
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

  // ── apply path ─────────────────────────────────────────────────────────────

  console.log('\n[repair] Starting apply...');

  const beforeGroups = dupGroups.length;
  const beforeFiles  = affectedFiles.length;

  let repaired = 0;
  let skipped  = 0;
  let failed   = 0;
  const failureDetails = [];

  const filesToProcess = isFinite(LIMIT) ? affectedFiles.slice(0, LIMIT) : affectedFiles;

  for (const sf of filesToProcess) {
    const sfHash = hashPath(sf);

    // Resolve and validate path
    let absPath;
    try {
      absPath = safeResolveFile(SOURCE_ROOT, sf);
    } catch (err) {
      console.error(`[repair] SKIP (path traversal) hash=${sfHash}: ${err.message}`);
      skipped++;
      continue;
    }

    if (!existsSync(absPath)) {
      console.log(`[repair] SKIP (file missing) hash=${sfHash}`);
      skipped++;
      continue;
    }

    console.log(`[repair] Processing hash=${sfHash} (${repaired + skipped + failed + 1}/${filesToProcess.length})`);

    try {
      // 1. Delete all existing points for this source_file
      process.stderr.write(`  deleting points...`);
      await deleteBySourceFile(COLLECTION, sf);
      process.stderr.write(` done\n`);

      // 2. Reindex
      process.stderr.write(`  reindexing...\n`);
      reindexFile(absPath, SOURCE_ROOT);

      repaired++;
      console.log(`[repair] OK hash=${sfHash}`);
    } catch (err) {
      failed++;
      // execFileSync embeds the full argv in err.message; prefer stderr for the
      // human-readable cause, then fall back to err.message first non-empty line.
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
  console.log(`  Duplicate groups before: ${beforeGroups}  →  after: ${dupGroupsAfter.length}`);
  console.log(`  Affected files before:   ${beforeFiles}  →  after: ${affectedFilesAfter.length}`);
  console.log(`  Repaired:  ${repaired}`);
  console.log(`  Skipped:   ${skipped}`);
  console.log(`  Failed:    ${failed}`);

  const stamp = nowStamp();
  const reportPath = writeApplyReport(stamp, {
    before: { dupGroups: beforeGroups, affectedFiles: beforeFiles },
    after:  { dupGroups: dupGroupsAfter.length, affectedFiles: affectedFilesAfter.length },
    repaired,
    skipped,
    failed,
    failureDetails,
  });
  console.log(`\n[repair] Report: ${reportPath}`);

  if (failed > 0) process.exit(1);
})();
