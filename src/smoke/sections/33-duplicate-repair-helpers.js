import { resolve } from 'path';
import { hashPath, buildDuplicateGroups, buildDryRunSummary, safeResolveFile, sanitizeErrorForReport, computeDeterministicId, buildCleanupPlan, resolveOllamaModelsToCheck } from '../../../benchmarks/retrieval/duplicate-point-repair.js';

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

  // ── computeDeterministicId ────────────────────────────────────────────────

  // Must match src/core/point-id.js makePointId exactly
  const { makePointId } = await import('../../core/point-id.js');

  const idArgs = { collection: 'test-col', sourceFile: 'docs/intro.md', chunkIndex: 0, embeddingSchemaVersion: 2 };

  ok('computeDeterministicId matches makePointId output',
    computeDeterministicId(idArgs) === makePointId(idArgs));

  ok('computeDeterministicId is stable across calls',
    computeDeterministicId(idArgs) === computeDeterministicId(idArgs));

  ok('computeDeterministicId differs for different chunkIndex',
    computeDeterministicId(idArgs) !== computeDeterministicId({ ...idArgs, chunkIndex: 1 }));

  ok('computeDeterministicId differs for different sourceFile',
    computeDeterministicId(idArgs) !== computeDeterministicId({ ...idArgs, sourceFile: 'docs/other.md' }));

  ok('computeDeterministicId differs for different embeddingSchemaVersion',
    computeDeterministicId(idArgs) !== computeDeterministicId({ ...idArgs, embeddingSchemaVersion: 3 }));

  ok('computeDeterministicId normalises Windows backslash paths',
    computeDeterministicId({ ...idArgs, sourceFile: 'docs\\intro.md' }) ===
    computeDeterministicId({ ...idArgs, sourceFile: 'docs/intro.md' }));

  // ── buildCleanupPlan ──────────────────────────────────────────────────────

  const col = 'test-col';
  const schemaVersion = 2;

  // Build two groups for file-a.md: chunk 0 has the deterministic ID + one orphan;
  // chunk 1 has two orphan IDs and the deterministic ID is NOT present.
  const detIdChunk0 = computeDeterministicId({ collection: col, sourceFile: 'file-a.md', chunkIndex: 0, embeddingSchemaVersion: schemaVersion });
  const detIdChunk1 = computeDeterministicId({ collection: col, sourceFile: 'file-a.md', chunkIndex: 1, embeddingSchemaVersion: schemaVersion });

  const planGroups = [
    // chunk 0: deterministic ID present + one random orphan
    ['file-a.md\x000', [
      { id: detIdChunk0,              sourceFile: 'file-a.md', payload: { source_file: 'file-a.md', chunk_index: 0 } },
      { id: 'random-uuid-orphan-000', sourceFile: 'file-a.md', payload: { source_file: 'file-a.md', chunk_index: 0 } },
    ]],
    // chunk 1: deterministic ID NOT present (both are old random UUIDs)
    ['file-a.md\x001', [
      { id: 'random-uuid-orphan-100', sourceFile: 'file-a.md', payload: { source_file: 'file-a.md', chunk_index: 1 } },
      { id: 'random-uuid-orphan-101', sourceFile: 'file-a.md', payload: { source_file: 'file-a.md', chunk_index: 1 } },
    ]],
  ];

  const plan = buildCleanupPlan(planGroups, col, schemaVersion);

  ok('buildCleanupPlan: orphanIds contains the random-UUID point from chunk 0',
    plan.orphanIds.includes('random-uuid-orphan-000'));

  ok('buildCleanupPlan: keeper (deterministic ID) is NOT in orphanIds',
    !plan.orphanIds.includes(detIdChunk0));

  ok('buildCleanupPlan: chunk 1 has no deterministic ID → missingDeterministicIdGroups',
    plan.missingDeterministicIdGroups.length === 1);

  ok('buildCleanupPlan: missing group chunkIndex is 1',
    plan.missingDeterministicIdGroups[0].chunkIndex === 1);

  ok('buildCleanupPlan: missing group actualIds contains both orphan IDs',
    plan.missingDeterministicIdGroups[0].actualIds.includes('random-uuid-orphan-100') &&
    plan.missingDeterministicIdGroups[0].actualIds.includes('random-uuid-orphan-101'));

  // All deterministic IDs present → no missing groups, all orphans collected
  const allDetPlanGroups = [
    ['file-b.md\x000', [
      { id: computeDeterministicId({ collection: col, sourceFile: 'file-b.md', chunkIndex: 0, embeddingSchemaVersion: schemaVersion }),
        sourceFile: 'file-b.md', payload: { source_file: 'file-b.md', chunk_index: 0 } },
      { id: 'old-orphan-b0',
        sourceFile: 'file-b.md', payload: { source_file: 'file-b.md', chunk_index: 0 } },
    ]],
  ];
  const cleanPlan = buildCleanupPlan(allDetPlanGroups, col, schemaVersion);
  ok('buildCleanupPlan: no missing groups when all deterministic IDs present',
    cleanPlan.missingDeterministicIdGroups.length === 0);
  ok('buildCleanupPlan: orphan collected when all deterministic IDs present',
    cleanPlan.orphanIds.includes('old-orphan-b0'));

  // ── post-reindex cleanup logic ────────────────────────────────────────────
  // Simulates the repair's step-3 branch: deterministic ID was missing before
  // reindex (so it appears in missingDeterministicIdGroups), but after reindex
  // the fresh Qdrant scan confirms it now exists. The old randomUUID IDs must
  // be deleted directly from g.actualIds — NOT filtered against freshIds,
  // because freshIds still contains the old IDs (SKIP_PRE_DELETE means they
  // were never removed before reindex).

  {
    // chunk 1 had no deterministic ID before reindex (appears in missingDeterministicIdGroups)
    const missingGroups = plan.missingDeterministicIdGroups; // [{chunkIndex:1, actualIds:[...]}]

    // After reindex, fresh scan returns: old orphans still present + new det ID
    const freshAfterReindex = new Set([
      detIdChunk1,            // new — written by reindex
      'random-uuid-orphan-100', // old — still in Qdrant (SKIP_PRE_DELETE)
      'random-uuid-orphan-101', // old — still in Qdrant
    ]);

    // Verify deterministic ID is now confirmed
    const confirmedInFresh = missingGroups.every(g => {
      const expId = computeDeterministicId({
        collection: col, sourceFile: 'file-a.md',
        chunkIndex: g.chunkIndex, embeddingSchemaVersion: schemaVersion,
      });
      return freshAfterReindex.has(expId);
    });
    ok('post-reindex: deterministic ID confirmed in fresh scan', confirmedInFresh);

    // Correct: delete g.actualIds directly (they are all orphans by definition)
    const correctToDelete = missingGroups.flatMap(g => g.actualIds);
    ok('post-reindex correct: old randomUUID IDs included in toDelete',
      correctToDelete.includes('random-uuid-orphan-100') &&
      correctToDelete.includes('random-uuid-orphan-101'));

    // Wrong (the bug): filter against freshIds — old IDs are in freshIds so they
    // would be excluded, leaving duplicates un-deleted.
    const buggyToDelete = missingGroups.flatMap(g => g.actualIds)
      .filter(id => !freshAfterReindex.has(id));
    ok('post-reindex buggy filter: would produce empty toDelete (demonstrates the bug)',
      buggyToDelete.length === 0);

    ok('post-reindex: correct toDelete is non-empty while buggy toDelete is empty',
      correctToDelete.length > 0 && buggyToDelete.length === 0);
  }

  // ── resolveOllamaModelsToCheck ────────────────────────────────────────────

  ok('resolveOllamaModelsToCheck: defaults to [gemma3:4b]',
    resolveOllamaModelsToCheck({}).join(',') === 'gemma3:4b');

  ok('resolveOllamaModelsToCheck: CONTEXT_MODEL only (no TAG_MODEL set)',
    resolveOllamaModelsToCheck({ CONTEXT_MODEL: 'qwen3:1.7b' }).join(',') === 'qwen3:1.7b');

  ok('resolveOllamaModelsToCheck: default tags disabled → TAG_MODEL not needed',
    !resolveOllamaModelsToCheck({ CONTEXT_MODEL: 'ctx:1b', TAG_MODEL: 'tag:4b' })
      .includes('tag:4b'));

  ok('resolveOllamaModelsToCheck: TAG_GEN=1 includes separate TAG_MODEL',
    resolveOllamaModelsToCheck({ TAG_GEN: '1', CONTEXT_MODEL: 'ctx:1b', TAG_MODEL: 'tag:4b' })
      .includes('tag:4b'));

  ok('resolveOllamaModelsToCheck: TAG_GEN=1 without TAG_MODEL uses CONTEXT_MODEL',
    resolveOllamaModelsToCheck({ TAG_GEN: '1', CONTEXT_MODEL: 'ctx:1b' }).join(',') === 'ctx:1b');

  ok('resolveOllamaModelsToCheck: COMBINED_LLM=1 → TAG_MODEL ignored, only context model',
    !resolveOllamaModelsToCheck({ TAG_GEN: '1', COMBINED_LLM: '1', CONTEXT_MODEL: 'ctx:1b', TAG_MODEL: 'tag:4b' })
      .includes('tag:4b'));

  ok('resolveOllamaModelsToCheck: TAG_GEN=0 → TAG_MODEL not needed',
    !resolveOllamaModelsToCheck({ TAG_GEN: '0', CONTEXT_MODEL: 'ctx:1b', TAG_MODEL: 'tag:4b' })
      .includes('tag:4b'));

  ok('resolveOllamaModelsToCheck: deduplicates when context=tag model',
    resolveOllamaModelsToCheck({ TAG_GEN: '1', CONTEXT_MODEL: 'same:1b', TAG_MODEL: 'same:1b' }).length === 1);

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
