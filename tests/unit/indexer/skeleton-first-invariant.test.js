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
  skeletonPayloadFields,
  indexingSchemaVersionField,
  isSkeletonChunk,
  SKELETON_CHUNKING_MODEL,
  INDEXING_SCHEMA_VERSION_BASE,
  INDEXING_SCHEMA_VERSION_PROFILE_BUDGET,
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
  test('.md always resolves to the skeleton model (default: BASE version, no split topology)', () => {
    assert.deepEqual(expectedChunkingMeta('docs/a.md'), {
      chunkingModel: SKELETON_CHUNKING_MODEL,
      indexingSchemaVersion: INDEXING_SCHEMA_VERSION_BASE,
    });
  });

  test('.md with budgetAwareTopology:true resolves to the PROFILE_BUDGET (v6) version', () => {
    assert.deepEqual(expectedChunkingMeta('docs/a.md', { budgetAwareTopology: true }), {
      chunkingModel: SKELETON_CHUNKING_MODEL,
      indexingSchemaVersion: INDEXING_SCHEMA_VERSION_PROFILE_BUDGET,
    });
  });

  test('.MD (case-insensitive extension) also resolves to the skeleton model', () => {
    assert.equal(expectedChunkingMeta('DOCS/A.MD').chunkingModel, SKELETON_CHUNKING_MODEL);
  });

  test('non-Markdown files resolve to legacy (null) meta when not budget-aware — documented scope boundary', () => {
    for (const filePath of ['notes/a.txt', 'docs/a.pdf', 'docs/a.docx', 'docs/a.html']) {
      const meta = expectedChunkingMeta(filePath);
      assert.equal(meta.chunkingModel, null, filePath);
      assert.equal(meta.indexingSchemaVersion, null, filePath);
    }
  });

  test('non-Markdown files under a budget-aware profile resolve to PROFILE_BUDGET (v6), not null — format-agnostic (code review round 6)', () => {
    for (const filePath of ['notes/a.txt', 'docs/a.pdf', 'docs/a.docx', 'docs/a.html']) {
      const meta = expectedChunkingMeta(filePath, { budgetAwareTopology: true });
      assert.equal(meta.chunkingModel, null, filePath); // chunkingModel unaffected — non-Markdown never uses skeleton-v1
      assert.equal(meta.indexingSchemaVersion, INDEXING_SCHEMA_VERSION_PROFILE_BUDGET, filePath);
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
          indexingSchemaVersion: INDEXING_SCHEMA_VERSION_BASE,
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
    const storedCurrent = { chunkingModel: SKELETON_CHUNKING_MODEL, indexingSchemaVersion: INDEXING_SCHEMA_VERSION_BASE };
    const chunkMeta = expectedChunkingMeta('docs/a.md');
    assert.equal(wouldSkipOnChunkingMeta(storedCurrent, chunkMeta), true,
      'an already-skeleton-indexed .md file with matching schema version must be skipped, not needlessly rebuilt');
  });

  test('a stored meta from a stale indexing-schema version (same model, older version) still forces a reindex', () => {
    const storedStale = { chunkingModel: SKELETON_CHUNKING_MODEL, indexingSchemaVersion: INDEXING_SCHEMA_VERSION_BASE - 1 };
    const chunkMeta = expectedChunkingMeta('docs/a.md');
    assert.equal(wouldSkipOnChunkingMeta(storedStale, chunkMeta), false);
  });

  test('a collection whose topology requires a budget reports PROFILE_BUDGET (v6) — a BASE-version stored meta forces reindex (code review, P2)', () => {
    const storedBase = { chunkingModel: SKELETON_CHUNKING_MODEL, indexingSchemaVersion: INDEXING_SCHEMA_VERSION_BASE };
    const chunkMeta = expectedChunkingMeta('docs/a.md', { budgetAwareTopology: true });
    assert.equal(wouldSkipOnChunkingMeta(storedBase, chunkMeta), false,
      'a collection that now requires a token budget must reindex even a previously-current BASE-version file');
  });

  test('a collection whose topology never requires a budget reports BASE version — never force-reindexed by PROFILE_BUDGET existing (code review, P2)', () => {
    const storedBase = { chunkingModel: SKELETON_CHUNKING_MODEL, indexingSchemaVersion: INDEXING_SCHEMA_VERSION_BASE };
    const chunkMeta = expectedChunkingMeta('docs/a.md', { budgetAwareTopology: false });
    assert.equal(wouldSkipOnChunkingMeta(storedBase, chunkMeta), true,
      'a local/client-execution collection must stay on BASE and skip unchanged files — never force-reindexed for a topology change that could never apply to it');
  });

  test('non-Markdown files: legacy stored meta matches legacy expectation, correctly skipped (unaffected by this change)', () => {
    const storedLegacy = { chunkingModel: null, indexingSchemaVersion: null };
    const chunkMeta = expectedChunkingMeta('notes/a.txt');
    assert.equal(wouldSkipOnChunkingMeta(storedLegacy, chunkMeta), true,
      'non-Markdown formats are an explicit, unchanged scope boundary — no forced reindex for them, when the profile is not budget-aware');
  });

  test('non-Markdown files: a stored null meta under a now-budget-aware profile forces a reindex — format-agnostic (code review round 6)', () => {
    const storedLegacy = { chunkingModel: null, indexingSchemaVersion: null };
    const chunkMeta = expectedChunkingMeta('notes/a.txt', { budgetAwareTopology: true });
    assert.equal(wouldSkipOnChunkingMeta(storedLegacy, chunkMeta), false,
      'a non-Markdown file already indexed under a profile that now requires a budget must be reindexed, never silently skipped forever via null === null');
  });

  test('non-Markdown files: a stored v5 meta under a now-budget-aware profile forces a reindex (v5 predates prose-budget-awareness)', () => {
    const storedV5 = { chunkingModel: null, indexingSchemaVersion: 5 };
    const chunkMeta = expectedChunkingMeta('notes/a.txt', { budgetAwareTopology: true });
    assert.equal(wouldSkipOnChunkingMeta(storedV5, chunkMeta), false);
  });
});

// Full round-trip: expected meta -> the ACTUAL point payload run.js builds
// (payload assembly at run.js:530-552) -> the meta getStoredMeta() would
// read back from that payload (store.js:456-468's `?? null` extraction) ->
// the skip predicate. A prior version of this fix only proved
// expectedChunkingMeta() itself was format-agnostic (v6 for a budget-aware
// non-Markdown file) — but skeletonPayloadFields() early-returns {} for
// any non-skeleton-v1 chunk, so nothing actually WROTE that v6 into the
// non-Markdown point's payload, and getStoredMeta() would read back null
// forever, permanently reindexing (code review finding: { expected: v6,
// written: {} }). This describe block proves the fix end to end — a
// budget-aware non-Markdown file's SECOND run correctly skips.
describe('full cycle: expected meta -> written payload -> stored meta -> skip (code review regression)', () => {
  // Mirrors run.js's own point payload assembly (run.js:530-552) exactly,
  // including passing isSkeleton: isSkeletonChunk(chunk) — not a
  // reimplementation of the whole pipeline, just the two lines that decide
  // indexing_schema_version's presence on the stored payload.
  function buildPointPayload(chunk, { budgetAwareTopology }) {
    return {
      // ...other fields omitted, irrelevant to this contract...
      ...indexingSchemaVersionField({ isSkeleton: isSkeletonChunk(chunk), budgetAwareTopology }),
      ...skeletonPayloadFields(chunk, { budgetAwareTopology }),
    };
  }

  // Mirrors store.js's getStoredMeta() extraction exactly (store.js:466-467).
  function readBackStoredMeta(payload) {
    return {
      chunkingModel: payload.chunking_model ?? null,
      indexingSchemaVersion: payload.indexing_schema_version ?? null,
    };
  }

  test('a budget-aware non-Markdown chunk: written payload carries indexing_schema_version=6, stored meta reads it back, second run skips', () => {
    const legacyChunk = { text: 'body', section: 's', chunkIndex: 0, totalChunks: 1 }; // non-skeleton shape — chunking_model never set
    const chunkMeta = expectedChunkingMeta('notes/a.txt', { budgetAwareTopology: true });
    assert.equal(chunkMeta.indexingSchemaVersion, INDEXING_SCHEMA_VERSION_PROFILE_BUDGET, 'sanity: expectation itself is v6');

    const payload = buildPointPayload(legacyChunk, { budgetAwareTopology: true });
    assert.equal(payload.indexing_schema_version, INDEXING_SCHEMA_VERSION_PROFILE_BUDGET,
      'REGRESSION: the written payload must carry v6, not be silently omitted for a non-skeleton chunk');

    const storedMeta = readBackStoredMeta(payload);
    assert.equal(storedMeta.indexingSchemaVersion, INDEXING_SCHEMA_VERSION_PROFILE_BUDGET);

    // Second run: stageA re-derives the same expectation and compares
    // against what was actually stored on the first run.
    const chunkMetaSecondRun = expectedChunkingMeta('notes/a.txt', { budgetAwareTopology: true });
    assert.equal(wouldSkipOnChunkingMeta(storedMeta, chunkMetaSecondRun), true,
      'a budget-aware non-Markdown file must be skipped on its SECOND run, not reindexed forever');
  });

  test('a non-budget-aware (local) non-Markdown chunk: written payload has NO indexing_schema_version key at all, matching expectedChunkingMeta\'s own null contract exactly', () => {
    const legacyChunk = { text: 'body', section: 's', chunkIndex: 0, totalChunks: 1 };
    const payload = buildPointPayload(legacyChunk, { budgetAwareTopology: false });
    // indexingSchemaVersionField's isSkeleton/budgetAwareTopology gate
    // mirrors expectedChunkingMeta's own three-way branch exactly — a
    // non-skeleton, non-budget-aware chunk gets NO key at all (never
    // BASE), because expectedChunkingMeta itself reports null for this
    // exact case, not BASE. Writing BASE here would cause the OPPOSITE
    // bug this fix closes: every ordinary local PDF/plain-text file would
    // spuriously reindex forever (stored BASE vs expected null, never
    // matching).
    assert.ok(!('indexing_schema_version' in payload), 'no key at all, not even undefined');
    const storedMeta = readBackStoredMeta(payload);
    const chunkMeta = expectedChunkingMeta('notes/a.txt', { budgetAwareTopology: false });
    assert.equal(chunkMeta.indexingSchemaVersion, null, 'sanity: expectedChunkingMeta itself reports null here, not BASE');
    assert.equal(storedMeta.chunkingModel, chunkMeta.chunkingModel);
    assert.equal(storedMeta.indexingSchemaVersion, chunkMeta.indexingSchemaVersion);
    assert.equal(wouldSkipOnChunkingMeta(storedMeta, chunkMeta), true);
  });

  test('a budget-aware Markdown (skeleton) chunk: skeletonPayloadFields already covers it, and indexingSchemaVersionField agrees exactly (no double-write conflict)', () => {
    const skelChunk = {
      text: 't', chunking_model: SKELETON_CHUNKING_MODEL,
      point_kind: 'retrieval_content', node_type: 'paragraph',
      node_id: 'uuid-1', node_path: 'a.md#p-1', parent_id: null,
      heading_path: [], raw_content: 't',
    };
    const payload = buildPointPayload(skelChunk, { budgetAwareTopology: true });
    assert.equal(payload.indexing_schema_version, INDEXING_SCHEMA_VERSION_PROFILE_BUDGET);
    const storedMeta = readBackStoredMeta(payload);
    const chunkMeta = expectedChunkingMeta('a.md', { budgetAwareTopology: true });
    assert.equal(wouldSkipOnChunkingMeta(storedMeta, chunkMeta), true);
  });

  test('a non-budget-aware (local) Markdown (skeleton) chunk: written payload carries BASE, not omitted — completes the 2x2 isSkeleton x budgetAwareTopology matrix', () => {
    const skelChunk = {
      text: 't', chunking_model: SKELETON_CHUNKING_MODEL,
      point_kind: 'retrieval_content', node_type: 'paragraph',
      node_id: 'uuid-1', node_path: 'a.md#p-1', parent_id: null,
      heading_path: [], raw_content: 't',
    };
    const payload = buildPointPayload(skelChunk, { budgetAwareTopology: false });
    assert.equal(payload.indexing_schema_version, INDEXING_SCHEMA_VERSION_BASE,
      'a skeleton chunk always carries a version — BASE when not budget-aware, never omitted (isSkeleton:true always contributes a key)');
    const storedMeta = readBackStoredMeta(payload);
    const chunkMeta = expectedChunkingMeta('a.md', { budgetAwareTopology: false });
    assert.equal(wouldSkipOnChunkingMeta(storedMeta, chunkMeta), true);
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
          const { chunks } = await chunkFileFromPath(fp, 'doc.md');
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
