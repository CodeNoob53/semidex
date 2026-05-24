import { resolve } from 'path';
import { hashPath, buildDuplicateGroups, buildDryRunSummary, safeResolveFile, sanitizeErrorForReport } from '../../../benchmarks/retrieval/duplicate-point-repair.js';

export default async function ({ ok, throws }) {
  console.log('\n[33] Duplicate repair helpers');

  // ── hashPath ──────────────────────────────────────────────────────────────

  ok('hashPath returns 16-char hex string',
    /^[0-9a-f]{16}$/.test(hashPath('docs/intro.md')));

  ok('hashPath is stable (same input → same hash)',
    hashPath('docs/intro.md') === hashPath('docs/intro.md'));

  ok('hashPath differs for different inputs',
    hashPath('docs/intro.md') !== hashPath('docs/other.md'));

  ok('hashPath handles empty string',
    /^[0-9a-f]{16}$/.test(hashPath('')));

  ok('hashPath handles null/undefined',
    /^[0-9a-f]{16}$/.test(hashPath(null)));

  // ── safeResolveFile ───────────────────────────────────────────────────────

  // Use process.cwd() as root — guaranteed to be an absolute path on all platforms
  const root = process.cwd();
  const expectedAbs = resolve(root, 'docs/intro.md');

  ok('safeResolveFile resolves file under root',
    safeResolveFile(root, 'docs/intro.md') === expectedAbs);

  ok('safeResolveFile: SOURCE_ROOT=. works (relative root resolves correctly)',
    safeResolveFile('.', 'docs/intro.md') === resolve('.', 'docs/intro.md'));

  // Path traversal — must throw
  throws('safeResolveFile rejects ../ traversal',
    () => safeResolveFile(root, '../../../etc/passwd'),
    'Path traversal rejected');

  throws('safeResolveFile rejects encoded traversal attempt',
    () => safeResolveFile(root, '..\\..\\windows\\system32'),
    'Path traversal rejected');

  // ── buildDuplicateGroups ──────────────────────────────────────────────────

  // Fake points: two duplicates for file-a chunk 0, one unique for file-b chunk 0
  const fakePoints = [
    { id: 'id-1', payload: { source_file: 'file-a.md', chunk_index: 0 } },
    { id: 'id-2', payload: { source_file: 'file-a.md', chunk_index: 0 } },
    { id: 'id-3', payload: { source_file: 'file-b.md', chunk_index: 0 } },
  ];

  const { dupGroups, affectedFiles, totalExtraPoints } = buildDuplicateGroups(fakePoints);

  ok('buildDuplicateGroups finds one duplicate group',
    dupGroups.length === 1);

  ok('buildDuplicateGroups identifies one affected file',
    affectedFiles.length === 1);

  ok('buildDuplicateGroups calculates extra points correctly',
    totalExtraPoints === 1); // 2 copies → 1 extra

  ok('buildDuplicateGroups excludes clean chunks — dup group is file-a.md',
    dupGroups.every(([, entries]) => entries[0].sourceFile === 'file-a.md'));

  // No duplicates
  const { dupGroups: noDups } = buildDuplicateGroups([
    { id: 'x', payload: { source_file: 'a.md', chunk_index: 0 } },
    { id: 'y', payload: { source_file: 'a.md', chunk_index: 1 } },
  ]);
  ok('buildDuplicateGroups returns empty when no duplicates', noDups.length === 0);

  // Multiple duplicates across several files
  const multiPoints = [
    { id: 'a1', payload: { source_file: 'alpha.md', chunk_index: 0 } },
    { id: 'a2', payload: { source_file: 'alpha.md', chunk_index: 0 } },
    { id: 'a3', payload: { source_file: 'alpha.md', chunk_index: 0 } },
    { id: 'b1', payload: { source_file: 'beta.md',  chunk_index: 5 } },
    { id: 'b2', payload: { source_file: 'beta.md',  chunk_index: 5 } },
    { id: 'c1', payload: { source_file: 'gamma.md', chunk_index: 1 } },
  ];
  const multi = buildDuplicateGroups(multiPoints);
  ok('buildDuplicateGroups handles multiple dup groups',
    multi.dupGroups.length === 2);
  ok('buildDuplicateGroups counts extra points across groups',
    multi.totalExtraPoints === 3); // alpha: 2 extra, beta: 1 extra
  ok('buildDuplicateGroups finds two affected files',
    multi.affectedFiles.length === 2);

  // ── buildDryRunSummary ────────────────────────────────────────────────────

  const summary = buildDryRunSummary({
    collection: 'test-col',
    dupGroups,
    affectedFiles,
    totalExtraPoints,
    totalPoints: fakePoints.length,
    sourceRootExists: true,
    missingFiles: [],
  });

  ok('buildDryRunSummary: no raw paths in affectedFileHashes',
    summary.affectedFileHashes.every(h => /^[0-9a-f]{16}$/.test(h)));

  ok('buildDryRunSummary: duplicateGroups count matches',
    summary.duplicateGroups === 1);

  ok('buildDryRunSummary: affectedSourceFiles count matches',
    summary.affectedSourceFiles === 1);

  ok('buildDryRunSummary: estimatedExtraPoints is correct',
    summary.estimatedExtraPoints === 1);

  ok('buildDryRunSummary: no field contains raw array of source paths (privacy)',
    !Object.values(summary).some(v => Array.isArray(v) && v.some(x => typeof x === 'string' && x.includes('/')
      && !(/^[0-9a-f]{16}$/.test(x)))));

  // Summary with missing files
  const summaryWithMissing = buildDryRunSummary({
    collection: 'test-col',
    dupGroups,
    affectedFiles,
    totalExtraPoints,
    totalPoints: fakePoints.length,
    sourceRootExists: false,
    missingFiles: ['file-a.md'],
  });
  ok('buildDryRunSummary: missing files hashed, not raw',
    summaryWithMissing.missingFileHashes.every(h => /^[0-9a-f]{16}$/.test(h)));
  ok('buildDryRunSummary: missingFilesCount correct',
    summaryWithMissing.missingFilesCount === 1);

  // ── sanitizeErrorForReport ────────────────────────────────────────────────

  // Windows absolute path (with and without spaces)
  ok('sanitizeErrorForReport: strips Windows path without spaces',
    !sanitizeErrorForReport('Command failed: C:\\nvm4w\\node.exe src\\idx.js C:\\Users\\Aorus\\file.md').includes('Users'));

  ok('sanitizeErrorForReport: strips Windows path with spaces',
    !sanitizeErrorForReport('failed: C:\\Program Files\\Some App\\runner.exe').includes('Program Files'));

  ok('sanitizeErrorForReport: strips Windows drive+slash variant',
    !sanitizeErrorForReport('Error at C:/Users/Aorus/project/file.md line 1').includes('Aorus'));

  // UNC path
  ok('sanitizeErrorForReport: strips UNC path',
    !sanitizeErrorForReport('failed: \\\\server\\share\\private\\file.txt').includes('private'));

  // POSIX absolute path
  ok('sanitizeErrorForReport: strips POSIX absolute path',
    !sanitizeErrorForReport('[preflight] model not found at /usr/local/models/bge-m3').includes('/usr/local'));

  // Preserves human-readable error text
  ok('sanitizeErrorForReport: preserves Ollama error text',
    sanitizeErrorForReport('[preflight] Ollama unreachable at http://localhost:11434').includes('Ollama unreachable'));

  ok('sanitizeErrorForReport: preserves http URL (not stripped as POSIX path)',
    sanitizeErrorForReport('fetch failed at http://localhost:11434/api').includes('http://localhost'));

  // null / undefined safety
  ok('sanitizeErrorForReport: handles null',
    sanitizeErrorForReport(null) === '');

  ok('sanitizeErrorForReport: handles undefined',
    sanitizeErrorForReport(undefined) === '');

  // Length cap
  ok('sanitizeErrorForReport: output capped at 300 chars',
    sanitizeErrorForReport('x'.repeat(400)).length <= 300);
}
