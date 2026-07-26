// Skeleton-first production invariant — expectedChunkingMeta() and the
// stageA() skip-tuple contract that consumes it (src/indexer/run.js).
//
// Skeleton chunking, navigation-point generation, and deterministic
// structural context are unconditional architecture for Markdown now, not
// configurable via SKELETON_CHUNKING/SKELETON_NAV/SKELETON_CONTEXT (those
// env vars no longer exist as recognized settings — see
// tests/unit/core/settings/definitions.test.js). This file proves:
//   - required-test #2: setting the old env vars has zero effect.
//   - required-test #3: Markdown always resolves to the skeleton model.
//   - required-test #6: a legacy-shaped stored meta forces a reindex
//     (never silently skipped) once compared against the current,
//     unconditional expectation.
//   - required-test #7: an already-current skeleton-shaped stored meta is
//     correctly skipped (no needless rebuild).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expectedChunkingMeta,
  SKELETON_CHUNKING_MODEL,
  INDEXING_SCHEMA_VERSION,
} from '../../../src/indexer/skeleton-payload.js';
import { chunkFileFromPath } from '../../../src/indexer/phases/chunk.js';

// Mirrors the chunkingModel/indexingSchemaVersion half of stageA()'s
// skip-tuple boolean (src/indexer/run.js) — stageA itself is a private,
// non-exported function that reads real files and Qdrant, so it isn't
// independently callable here; this reproduces its actual comparison
// exactly rather than re-deriving new logic, so a regression in either
// place would be caught by keeping them in sync.
function wouldSkipOnChunkingMeta(storedMeta, chunkMeta) {
  return storedMeta?.chunkingModel === chunkMeta.chunkingModel &&
         storedMeta?.indexingSchemaVersion === chunkMeta.indexingSchemaVersion;
}

describe('expectedChunkingMeta — unconditional for Markdown, no env dependency', () => {
  test('.md always resolves to the skeleton model', () => {
    assert.deepEqual(expectedChunkingMeta('docs/a.md'), {
      chunkingModel: SKELETON_CHUNKING_MODEL,
      indexingSchemaVersion: INDEXING_SCHEMA_VERSION,
    });
  });

  test('.MD (case-insensitive extension) also resolves to the skeleton model', () => {
    assert.equal(expectedChunkingMeta('DOCS/A.MD').chunkingModel, SKELETON_CHUNKING_MODEL);
  });

  test('non-Markdown files resolve to legacy (null) meta — documented scope boundary', () => {
    for (const filePath of ['notes/a.txt', 'docs/a.pdf', 'docs/a.docx', 'docs/a.html']) {
      const meta = expectedChunkingMeta(filePath);
      assert.equal(meta.chunkingModel, null, filePath);
      assert.equal(meta.indexingSchemaVersion, null, filePath);
    }
  });

  test('takes no env parameter at all — the function signature itself proves no env dependency', () => {
    assert.equal(expectedChunkingMeta.length, 1, 'expectedChunkingMeta(filePath) must be single-arity, no env param');
  });

  for (const envValue of [undefined, '0', '1', 'llm']) {
    test(`setting SKELETON_CHUNKING/SKELETON_NAV/SKELETON_CONTEXT=${JSON.stringify(envValue)} as raw OS env vars has no effect on .md meta`, () => {
      const saved = {
        SKELETON_CHUNKING: process.env.SKELETON_CHUNKING,
        SKELETON_NAV: process.env.SKELETON_NAV,
        SKELETON_CONTEXT: process.env.SKELETON_CONTEXT,
      };
      try {
        for (const key of Object.keys(saved)) {
          if (envValue === undefined) delete process.env[key];
          else process.env[key] = envValue;
        }
        assert.deepEqual(expectedChunkingMeta('docs/a.md'), {
          chunkingModel: SKELETON_CHUNKING_MODEL,
          indexingSchemaVersion: INDEXING_SCHEMA_VERSION,
        });
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
      }
    });
  }
});

describe('stageA skip-tuple contract — chunkingModel/indexingSchemaVersion half', () => {
  test('required-test #6: a legacy-shaped stored meta (chunkingModel: null) forces a reindex, never skipped', () => {
    const storedLegacy = { chunkingModel: null, indexingSchemaVersion: null };
    const chunkMeta = expectedChunkingMeta('docs/a.md');
    assert.equal(wouldSkipOnChunkingMeta(storedLegacy, chunkMeta), false,
      'a pre-existing legacy-indexed .md file must not be skipped — it must be reindexed into the canonical skeleton model');
  });

  test('required-test #7: an already-current skeleton-shaped stored meta is correctly skipped, no needless rebuild', () => {
    const storedCurrent = { chunkingModel: SKELETON_CHUNKING_MODEL, indexingSchemaVersion: INDEXING_SCHEMA_VERSION };
    const chunkMeta = expectedChunkingMeta('docs/a.md');
    assert.equal(wouldSkipOnChunkingMeta(storedCurrent, chunkMeta), true,
      'an already-skeleton-indexed .md file with matching schema version must be skipped, not needlessly rebuilt');
  });

  test('a stored meta from a stale indexing-schema version (same model, older version) still forces a reindex', () => {
    const storedStale = { chunkingModel: SKELETON_CHUNKING_MODEL, indexingSchemaVersion: INDEXING_SCHEMA_VERSION - 1 };
    const chunkMeta = expectedChunkingMeta('docs/a.md');
    assert.equal(wouldSkipOnChunkingMeta(storedStale, chunkMeta), false);
  });

  test('non-Markdown files: legacy stored meta matches legacy expectation, correctly skipped (unaffected by this change)', () => {
    const storedLegacy = { chunkingModel: null, indexingSchemaVersion: null };
    const chunkMeta = expectedChunkingMeta('notes/a.txt');
    assert.equal(wouldSkipOnChunkingMeta(storedLegacy, chunkMeta), true,
      'non-Markdown formats are an explicit, unchanged scope boundary — no forced reindex for them');
  });
});

describe('chunkFileFromPath — required-test #3: Markdown always uses the skeleton AST path', () => {
  const MD = '# Heading\n\nSome prose with enough meaningful words to pass the gate.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';

  async function withTempMdFile(fn) {
    const dir = mkdtempSync(join(tmpdir(), 'semidex-skel-invariant-'));
    const fp = join(dir, 'doc.md');
    writeFileSync(fp, MD, 'utf8');
    try {
      return await fn(fp);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const envValue of [undefined, '0', '1']) {
    test(`produces skeleton-v1 chunks when SKELETON_CHUNKING=${JSON.stringify(envValue)} (env has no effect)`, async () => {
      const savedChunking = process.env.SKELETON_CHUNKING;
      const savedTokenCount = process.env.TOKEN_COUNT;
      process.env.TOKEN_COUNT = 'heuristic'; // avoid tokenizer download in a unit test
      if (envValue === undefined) delete process.env.SKELETON_CHUNKING;
      else process.env.SKELETON_CHUNKING = envValue;
      try {
        await withTempMdFile(async (fp) => {
          const chunks = await chunkFileFromPath(fp, 'doc.md');
          assert.ok(chunks.some((c) => c.chunking_model === SKELETON_CHUNKING_MODEL));
          assert.ok(chunks.some((c) => c.node_type === 'table'), 'the table must be a real skeleton entity, not legacy flat text');
        });
      } finally {
        if (savedChunking === undefined) delete process.env.SKELETON_CHUNKING; else process.env.SKELETON_CHUNKING = savedChunking;
        if (savedTokenCount === undefined) delete process.env.TOKEN_COUNT; else process.env.TOKEN_COUNT = savedTokenCount;
      }
    });
  }
});
