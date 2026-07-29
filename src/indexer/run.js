// Indexer implementation (Global Settings phase: split out of index.js).
// This module has several imports that transitively do
// `import 'dotenv/config'` (core/config.js, core/qdrant.js, core/embeddings.js,
// context.js/tag.js via core/ollama.js, skeleton-summary.js) — static
// imports hoist and execute at module-graph-resolution time, BEFORE any
// top-level statement in this file can run. That means bootstrapEnv() must
// run in a module that is imported strictly AFTER this one, never in this
// same file — src/indexer/index.js is that thin bootstrap wrapper: it
// calls bootstrapEnv() first, then dynamically imports this module
// (`await import('./run.js')`), guaranteeing OS-env is snapshotted before
// .env is ever loaded. Never import this file directly from a real entry
// point — always go through index.js. (Tests importing this module
// directly get whatever process.env already contains, same as any other
// test — no different from the previous single-file layout.)
import { createReadStream, statSync } from 'fs';
import { resolve, relative, dirname, isAbsolute } from 'path';
import { createHash } from 'crypto';

import { chunkFileFromPath, applyChunkingSettings } from './phases/chunk.js';
import { addContext, applyContextSettings } from './phases/context.js';
import { addTagsBatch, shouldGenerateTags, applyTagSettings } from './phases/tag.js';
import { addTagsOnnxBatch, isOnnxTagProvider, shutdownOnnxTagWorker } from './phases/tag-onnx.js';
import { isEmptySectionChunk } from './phases/empty-section.js';
import { addContextAndTags } from './phases/combined.js';
import { resolveCombinedLlmConfig } from '../core/doctor-checks.js';
import { runBatched } from './batch.js';
import { collectFiles, SUPPORTED_EXTENSIONS } from './files.js';
import { Profiler } from './profiler.js';
import { upsertPoints, upsertPointsWithoutVectors, listCollections, getCollectionInfo, getStoredMeta, deleteBySourceFile, deleteTrailingChunks, listSourceFiles, deleteByFilter } from '../core/qdrant.js';
import { makePointId } from '../core/point-id.js';
import { loadConfig, saveConfig, resolveEnvProviders } from '../core/config.js';
import { embedForIndex, embedForIndexBatch, shouldUseOnnxBatching, SCHEMA_VERSION } from '../core/embeddings.js';
import { createStorageAdapter } from '../core/storage/factory.js';
import { resolveExistingCollectionProfile, resolveNewCollectionProfile } from '../core/embedding-profile/resolve.js';
import { findDenseModel, resolveEmbeddingBudget } from '../core/embedding-profile/qdrant-cloud-catalog.js';
import { resolveCollectionConfigEntry } from '../core/embedding-profile/config-cache.js';
import { ensureOllamaPreflight } from './preflight.js';
import { CHUNKING_SCHEMA_VERSION, getTokenCounter, resolveTokenCountMode } from '../core/token-count.js';
import { Semaphore } from './semaphore.js';
import { SerialQueue } from './serial-queue.js';
import { envInt } from '../core/env.js';
import { expectedChunkingMeta, skeletonPayloadFields, indexingSchemaVersionField, isSkeletonChunk, makeSkeletonPointId, buildNavPointPayload, buildEntityRawPointPayload, INDEXING_SCHEMA_VERSION_BASE, INDEXING_SCHEMA_VERSION_PROFILE_BUDGET } from './skeleton-payload.js';
import { buildIndexingState, EXECUTION } from '../core/embedding-profile/schema.js';
import { generateNavSummaries, generateDirectorySummaries, buildCollectionSummary, resolveRunNumCtx, estTokens } from './phases/skeleton-summary.js';
import { buildDirectoryNavPoints } from './phases/skeleton-index.js';
import { makeNodeId } from '../core/node-id.js';
import { scroll } from '../core/qdrant.js';
import { PROGRESS_EVENT_PREFIX, createFileProgressReporter } from './progress-event.js';
import { applyEnvWriteBack } from '../core/settings/service.js';
import { getOllamaEmbeddingDimension } from '../core/ollama.js';

// let (not const): LLM_BATCH_SIZE is re-resolved from the settings registry.
// VECTOR_SIZE starts with the legacy/config fallback, then main() replaces it
// with the selected embedding model's detected output dimension before a new
// collection is created. Existing collections keep their recorded vectorSize
// from config.json (see configVectorSize/cfgVectorSize below).
// COLLECTION/SOURCE_ROOT are
// one-shot CLI-run parameters, not standing configuration — intentionally
// excluded from the settings registry, so they stay plain env reads.
let BATCH_SIZE     = envInt('LLM_BATCH_SIZE', 3, 1, 64, '[indexer] ');
let VECTOR_SIZE    = parseInt(process.env.VECTOR_SIZE || '1024');
const COLLECTION   = process.env.COLLECTION;
const SOURCE_ROOT  = process.env.SOURCE_ROOT ? resolve(process.env.SOURCE_ROOT) : null;

// Resolved exactly ONCE per process, in main(), before any file is
// processed — never re-resolved per file/call. Every embedForIndex/
// embedForIndexBatch call site below reads this same profile, so a whole
// indexing job always embeds against one identity, and stageA's skip-tuple
// comparison always compares against the same identity it will actually
// embed with if it decides to reindex. See src/core/embedding-profile/
// resolve.js — main() calls resolveNewCollectionProfile() for a brand-new
// collection or resolveExistingCollectionProfile() (+ an explicit
// migrateEmbeddingProfile() call, since an indexing job is a sanctioned,
// user-initiated write trigger) for an existing one, and fails fast before
// this file touches a single point if neither resolves.
let EMBEDDING_PROFILE = null;
const storageAdapter = createStorageAdapter();

/**
 * Re-resolves every indexer-consumed setting from a SettingsService: this
 * module's own BATCH_SIZE and the legacy VECTOR_SIZE fallback, plus
 * applyEnvWriteBack() (shared
 * with every other real entry point — see core/settings/service.js) writes
 * every OTHER writable setting's active value into process.env, so the
 * many existing per-call `process.env.X` reads throughout stageA/stageB/
 * etc. below (and core/config.js's resolveEnvProviders(),
 * core/qdrant/client.js's QDRANT_URL, etc.) observe the resolved value
 * with zero further code changes — every one of those reads already
 * re-parses process.env on each call, so updating the underlying string is
 * sufficient. Using the shared applyEnvWriteBack() instead of a hand-picked
 * key list means a field added to definitions.js later is automatically
 * covered here too (a hand-picked list previously missed QDRANT_URL —
 * code review finding). Call once, at indexer process startup, before any
 * file is processed. Also applies chunk.js/context.js/tag.js's own
 * settings (see their respective applyXSettings() functions).
 * @param {Object} settingsService
 */
function applyIndexerSettings(settingsService) {
  BATCH_SIZE = settingsService.getActiveValue('LLM_BATCH_SIZE');
  VECTOR_SIZE = settingsService.getActiveValue('VECTOR_SIZE');
  applyEnvWriteBack(settingsService);
}

// Machine-readable progress channel for the admin UI's job registry
// (src/admin/jobs/registry.js), which spawns this script as a child process
// and only has stdout/stderr text to observe. A single fixed-prefix JSON
// line is far cheaper to parse reliably than scraping arbitrary human-
// readable log output, and keeps progress data (processed/total/current
// file) fully separate from free-form log lines. Never include env vars,
// tokens, or file contents here — only counts, a relative file path, and a
// user-facing phase label (see progress-event.js for the phase-weight model).
function emitProgress({ processedFiles, totalFiles, currentFile, currentStep = null, currentFileProgress = null }) {
  console.log(PROGRESS_EVENT_PREFIX + JSON.stringify({
    processedFiles, totalFiles, currentFile, currentStep, currentFileProgress,
  }));
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(filePath).on('data', d => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

// ── Stage A: read-only preflight / hash / finalized chunking ─────────────────
// Non-destructive: no Qdrant deletes.
// Returns { status: 'skipped' } or a prepared object carrying needsDelete/deleteReason
// so later stages can act on them at the right time.
async function stageA(filePath, rootPath, collection, profiler, reporter = null) {
  const effectiveRoot = SOURCE_ROOT ?? rootPath;
  const sourceFile = relative(effectiveRoot, filePath).replace(/\\/g, '/');
  if (SOURCE_ROOT && (sourceFile.startsWith('../') || sourceFile === '..' || isAbsolute(sourceFile))) {
    throw new Error(`File "${filePath}" is outside SOURCE_ROOT "${SOURCE_ROOT}". Fix SOURCE_ROOT or remove it.`);
  }

  // EMBEDDING_PROFILE is resolved exactly once, in main(), before any file
  // is processed — never re-resolved per file. See its declaration above.
  const embedCfg = {
    denseProvider: EMBEDDING_PROFILE.embedding.dense.provider,
    denseModel: EMBEDDING_PROFILE.embedding.dense.model,
    sparseProvider: EMBEDDING_PROFILE.embedding.sparse?.provider ?? null,
    schemaVersion: EMBEDDING_PROFILE.embeddingSchemaVersion,
  };
  const tokenCountMode = resolveTokenCountMode();
  const configVectorSize = EMBEDDING_PROFILE.embedding.dense.dimensions;
  // Resolved once here (file-independent) so both the skip-tuple check
  // below and the actual chunking call further down use the SAME budget —
  // null for a client-execution profile, which preserves whole-entity
  // chunking exactly as before oversized-entity splitting existed.
  const chunkingBudget = resolveEmbeddingBudget(EMBEDDING_PROFILE);
  const budgetAwareTopology = chunkingBudget !== null;

  const fileHash   = await hashFile(filePath);
  const storedMeta = await getStoredMeta(collection, sourceFile);
  const storedHash = storedMeta?.hash ?? null;
  // Chunking-model agreement is part of the skip tuple — a file previously
  // indexed by the legacy chunker (chunkingModel: null) must reindex into
  // the now-mandatory skeleton model, never silently mix point models.
  // budgetAwareTopology (code review, P2): the indexing schema version is
  // topology-aware, not a hardcoded global bump — a collection whose
  // profile never requires entity splitting (e.g. local BGE-M3) reports
  // the BASE version, unaffected by entity-split.js's existence, so it is
  // never force-reindexed for a topology change that could never apply to
  // it.
  const chunkMeta = expectedChunkingMeta(filePath, { budgetAwareTopology });

  if (
    !process.env.FORCE_REINDEX &&
    storedHash === fileHash &&
    storedMeta?.chunkingModel          === chunkMeta.chunkingModel &&
    storedMeta?.indexingSchemaVersion  === chunkMeta.indexingSchemaVersion &&
    storedMeta?.denseProvider          === embedCfg.denseProvider &&
    storedMeta?.denseModel             === embedCfg.denseModel &&
    storedMeta?.sparseProvider         === embedCfg.sparseProvider &&
    storedMeta?.embeddingSchemaVersion === embedCfg.schemaVersion &&
    storedMeta?.chunkingSchemaVersion  === CHUNKING_SCHEMA_VERSION &&
    storedMeta?.tokenCountMode         === tokenCountMode &&
    (storedMeta?.vectorSize ?? configVectorSize) === configVectorSize
  ) {
    console.log('  ✓ unchanged, skipping');
    return { status: 'skipped' };
  }

  // Preflight runs once per process, on the first file that actually needs indexing.
  const ollamaUrl    = process.env.OLLAMA_URL    || 'http://localhost:11434';
  const contextModel = process.env.CONTEXT_MODEL || 'gemma3:4b';
  const combinedCfg  = resolveCombinedLlmConfig(process.env);
  const genTagsPreflight = shouldGenerateTags(process.env);
  // TAG_PROVIDER=onnx: tag generation goes to ONNX worker, not Ollama — skip tagModel check.
  const tagViaOnnx = isOnnxTagProvider(process.env);
  const tagModel = (combinedCfg.enabled || !genTagsPreflight || tagViaOnnx)
    ? contextModel
    : (process.env.TAG_MODEL || contextModel);
  // Skeleton files always use deterministic context (structural context is
  // no longer configurable) and therefore never call the LLM for context;
  // if tags are off or routed to the ONNX worker, Ollama is not needed at
  // all — skip the preflight so skeleton indexing works with no Ollama
  // running.
  const skeletonNoLlm = Boolean(chunkMeta.chunkingModel)
    && process.env.SKELETON_SUMMARY !== 'llm'
    && (!genTagsPreflight || tagViaOnnx);
  if (!skeletonNoLlm) {
    await ensureOllamaPreflight(ollamaUrl, contextModel, tagModel);
  }
  // Load/download tokenizer before any destructive work — a failure here leaves old points intact.
  if (tokenCountMode === 'bge-m3') await getTokenCounter({ mode: 'bge-m3' });

  // Compute whether a pre-delete is needed, but do NOT execute it yet.
  // Qdrant delete happens in stageD (after embed succeeds in stageC).
  let needsDelete = Boolean(storedHash && !process.env.SKIP_PRE_DELETE);
  if (storedHash && process.env.SKIP_PRE_DELETE && chunkMeta.chunkingModel) {
    console.warn('  [skeleton] SKIP_PRE_DELETE ignored for skeleton-v1 files — node-derived point IDs require full pre-delete');
    needsDelete = true;
  }
  let deleteReason = '';
  if (needsDelete) {
    const reasons = [];
    if (storedMeta?.denseProvider          !== embedCfg.denseProvider)  reasons.push(`denseProvider: ${storedMeta?.denseProvider} → ${embedCfg.denseProvider}`);
    if (storedMeta?.denseModel             !== embedCfg.denseModel)     reasons.push(`denseModel: ${storedMeta?.denseModel} → ${embedCfg.denseModel}`);
    if (storedMeta?.sparseProvider         !== embedCfg.sparseProvider) reasons.push(`sparseProvider: ${storedMeta?.sparseProvider} → ${embedCfg.sparseProvider}`);
    if (storedMeta?.embeddingSchemaVersion !== embedCfg.schemaVersion)  reasons.push(`schemaVersion: ${storedMeta?.embeddingSchemaVersion} → ${embedCfg.schemaVersion}`);
    if (storedMeta?.chunkingSchemaVersion  !== CHUNKING_SCHEMA_VERSION) reasons.push(`chunkingSchemaVersion: ${storedMeta?.chunkingSchemaVersion} → ${CHUNKING_SCHEMA_VERSION}`);
    if (storedMeta?.tokenCountMode         !== tokenCountMode)          reasons.push(`tokenCountMode: ${storedMeta?.tokenCountMode} → ${tokenCountMode}`);
    if ((storedMeta?.vectorSize ?? configVectorSize) !== configVectorSize) reasons.push(`vectorSize: ${storedMeta?.vectorSize} → ${configVectorSize}`);
    if (storedMeta?.chunkingModel          !== chunkMeta.chunkingModel)          reasons.push(`chunkingModel: ${storedMeta?.chunkingModel ?? 'legacy'} → ${chunkMeta.chunkingModel ?? 'legacy'}`);
    if (storedMeta?.indexingSchemaVersion  !== chunkMeta.indexingSchemaVersion)  reasons.push(`indexingSchemaVersion: ${storedMeta?.indexingSchemaVersion} → ${chunkMeta.indexingSchemaVersion}`);
    deleteReason = reasons.length ? reasons.join(', ') : 'content changed';
    console.log(`  ~ ${deleteReason}, reindexing...`);
  }
  profiler.mark('pre');

  console.log('  [1/5] chunking...');
  reporter?.step('chunking');
  // chunkingBudget resolved earlier in this function (alongside
  // budgetAwareTopology, used by the skip-tuple check above) — reused here
  // rather than re-resolved, so both consult the exact same value.
  // { chunks, navPoints, entityRawPoints } — explicit structured return
  // (chunkFileFromPath, chunk.js), replacing the previous non-enumerable
  // __navPoints side-channel. entityRawPoints are canonical entity_raw
  // points for split entities (entity-split.js) — deliberately never part
  // of the rawChunks chunk_index sequence (code review: a canonical point
  // sharing the chunk_index space with retrieval chunks created a gap a
  // window=1 query around a fragment could silently walk into).
  const { chunks: rawChunks, navPoints, entityRawPoints } = await chunkFileFromPath(filePath, sourceFile, chunkingBudget);
  console.log(`        ${rawChunks.length} chunks${entityRawPoints.length ? ` (+${entityRawPoints.length} entity_raw)` : ''}`);
  profiler.mark('chunk');

  return {
    status: 'ready',
    filePath, sourceFile, collection, fileHash,
    embedCfg, tokenCountMode, configVectorSize, budgetAwareTopology,
    needsDelete, deleteReason,
    rawChunks, navPoints, entityRawPoints, combinedCfg: resolveCombinedLlmConfig(process.env),
    profiler,
  };
}

// ── Stage B: context + tag generation (Ollama GPU) ───────────────────────────
// In default mode: guarded by ollamaSem in pipeline mode (caller wraps with sem.run).
// In TAG_PROVIDER=onnx mode: caller passes ollamaSem so context alone acquires it
// while ONNX tags run outside — both start after chunk finalization, freeing the
// semaphore sooner. `reporter` (sequential mode only, null in pipeline mode) —
// see progress-event.js.
async function stageB(prepared, ollamaSem = null, reporter = null) {
  const { rawChunks, combinedCfg, profiler } = prepared;

  if (combinedCfg.warning) console.warn(`  [combined] ${combinedCfg.warning}`);
  const genTags   = shouldGenerateTags(process.env);
  const tagViaOnnx = isOnnxTagProvider(process.env);

  // ── Skeleton leveled context (design §12, deterministic by default) ────────
  // Skeleton chunks arrive with a precomputed deterministic `context`
  // (heading path + adjacent prose) — the per-chunk LLM context phase is
  // always skipped: 0 LLM calls vs N in legacy. Structural context is no
  // longer configurable (always deterministic).
  const skeletonDeterministic = rawChunks.length > 0
    && rawChunks.every(ch => isSkeletonChunk(ch));

  if (skeletonDeterministic) {
    if (combinedCfg.enabled) {
      console.warn('  [skeleton] COMBINED_LLM=1 ignored for skeleton files — deterministic context owns the context phase');
    }
    console.log('  [2/5] contextualizing skipped (skeleton deterministic context)');
    // Deterministic context is real work (heading-path assembly), just not
    // an LLM call — report it under the "summarizing" weight with wording
    // that doesn't imply an LLM ran, per the task's explicit requirement.
    reporter?.step('summarizing', 'Building navigation context');
    let taggedChunks;
    if (genTags && tagViaOnnx) {
      console.log('  [3/5] tagging (onnx)...');
      reporter?.step('tagging');
      taggedChunks = await addTagsOnnxBatch(rawChunks);
    } else if (genTags) {
      console.log('  [3/5] tagging (ollama)...');
      reporter?.step('tagging');
      const tagged = [];
      for (let i = 0; i < rawChunks.length; i += BATCH_SIZE) {
        tagged.push(...await addTagsBatch(rawChunks.slice(i, i + BATCH_SIZE)));
      }
      taggedChunks = tagged;
    } else {
      // TAG_GEN off — no "Generating tags" step reported at all; progress
      // simply jumps from summarizing straight to embedding.
      console.log('  [3/5] tagging skipped (TAG_GEN not enabled)');
      taggedChunks = rawChunks.map(ch => ({ ...ch, tags: ch.tags ?? [] }));
    }
    profiler.mark('context');
    profiler.mark('tag');

    // Stage 2 (design §12.1): semantic nav summaries — the "pre-paid context"
    // an agent reads instead of walking the tree. Opt-in: SKELETON_SUMMARY=llm.
    // Cached by file_hash: unchanged files never regenerate (stageA skip).
    let navPoints = prepared.navPoints ?? [];
    if (navPoints.length > 0 && process.env.SKELETON_SUMMARY === 'llm') {
      console.log(`  [3.5/5] nav summaries (llm, ${navPoints.length} node(s))...`);
      reporter?.step('summarizing', 'Generating summaries');
      navPoints = await generateNavSummaries(navPoints, taggedChunks, {
        numCtx: prepared.runNumCtx ?? undefined,
      });
    }

    return { ...prepared, taggedChunks, navPoints };
  }

  let taggedChunks;
  if (combinedCfg.enabled) {
    // COMBINED_LLM=1 owns tags only when TAG_GEN=1; TAG_PROVIDER=onnx is ignored then.
    if (genTags && tagViaOnnx) {
      console.warn('  [tag-onnx] TAG_PROVIDER=onnx is ignored when COMBINED_LLM=1 — combined mode owns context+tags');
    }
    console.log(`  [2/5] ${genTags ? 'contextualizing + tagging' : 'contextualizing'} (combined)...`);
    reporter?.step('summarizing');
    const merged = rawChunks;
    console.log(`        ${merged.length} finalized chunks`);
    profiler.mark('context');

    if (genTags) {
      console.log('  [3/5] (combined — no separate tag phase)');
      // Same underlying LLM call as "summarizing" above (COMBINED_LLM=1
      // does both at once) — still worth its own step so the user sees tag
      // generation was part of what just happened, not skipped.
      reporter?.step('tagging');
      taggedChunks = await runBatched(merged, BATCH_SIZE, chunk => addContextAndTags(chunk, combinedCfg.model, merged));
    } else {
      // TAG_GEN is opt-in: run a pure context prompt and force tags: [].
      console.log('  [3/5] tagging skipped (TAG_GEN not enabled) — context only');
      const withContext = await runBatched(merged, BATCH_SIZE, addContext);
      taggedChunks = withContext.map(c => ({ ...c, tags: [] }));
    }
    profiler.mark('tag');
  } else if (tagViaOnnx && genTags) {
    // TAG_PROVIDER=onnx: ONNX tags (CPU worker) run outside ollamaSem; only context
    // acquires the semaphore. Both start after chunk finalization so GPU and CPU lanes overlap.
    // ollamaSem is null in non-pipeline mode — context runs ungated as before.
    //
    // Known limitation: stageC (embed) still waits for Promise.all to settle, so
    // embed starts after the slower of context/tags rather than right after context.
    // Full context→embed overlap requires returning the tag Promise from stageB and
    // awaiting it lazily in stageD — a larger contract change tracked separately.
    console.log('  [2/5] contextualizing...');
    reporter?.step('summarizing');
    const merged = rawChunks;
    console.log(`        ${merged.length} finalized chunks  [3/5] tagging (onnx, parallel)`);
    // Both run concurrently from here — report tagging right away too rather
    // than waiting for it to finish, since there's no meaningful "tagging
    // starts after summarizing" boundary in this branch.
    reporter?.step('tagging');

    const tContextStart = Date.now();
    const tTagStart     = Date.now();

    const runContext = () =>
      runBatched(merged, BATCH_SIZE, addContext).then(r => { profiler.markAt('context', tContextStart); return r; });

    const [contextChunks, onnxTagged] = await Promise.all([
      ollamaSem ? ollamaSem.run(runContext) : runContext(),
      addTagsOnnxBatch(merged).then(r => { profiler.markAt('tag', tTagStart); return r; }),
    ]);

    taggedChunks = contextChunks.map((chunk, i) => ({
      ...chunk,
      tags: onnxTagged[i]?.tags ?? [],
    }));
  } else {
    console.log('  [2/5] contextualizing...');
    reporter?.step('summarizing');
    const merged = rawChunks;
    const contextChunks = await runBatched(merged, BATCH_SIZE, addContext);
    console.log(`        ${merged.length} finalized chunks`);
    profiler.mark('context');

    if (genTags) {
      console.log('  [3/5] tagging...');
      reporter?.step('tagging');
      const tagged = [];
      for (let i = 0; i < contextChunks.length; i += BATCH_SIZE) {
        tagged.push(...await addTagsBatch(contextChunks.slice(i, i + BATCH_SIZE)));
      }
      taggedChunks = tagged;
    } else {
      console.log('  [3/5] tagging skipped (TAG_GEN not enabled)');
      taggedChunks = contextChunks.map(c => ({ ...c, tags: [] }));
    }
    profiler.mark('tag');
  }

  // Defensive guard: empty-section chunks must not reach Qdrant.
  // Skipped for skeleton-v1 chunks — emptiness is impossible by construction
  // there (isContentBearing gate), and the legacy "(empty section: ...)"
  // marker never occurs in skeleton output (impl spec §6).
  const emptySectionChunks = taggedChunks.filter(c => !isSkeletonChunk(c) && isEmptySectionChunk(c));
  if (emptySectionChunks.length > 0) {
    throw new Error(
      `${emptySectionChunks.length} empty-section chunk(s) reached the upsert gate — ` +
      `sections: ${emptySectionChunks.map(c => c.section || '(unknown)').join(', ')}`
    );
  }

  return { ...prepared, taggedChunks };
}

/**
 * Builds the (embedText, embedContext) pair for every chunk about to be
 * embedded — pure, no I/O, exported for direct unit testing (mirrors this
 * file's existing pattern for computeStaleSourceFiles/
 * shouldSkipCollectionNavRollup/collectionNavRollupNeeded below).
 *
 * `taggedChunks` never contains an entity_raw point — canonical entity_raw
 * points (entity-split.js) are threaded through the pipeline as their own
 * `entityRawPoints` array (see stageA), entirely separate from the
 * retrieval chunk_index sequence, and are upserted directly by stageD with
 * no vector and no embedding call at all (never searched, so there is
 * nothing for a vector to represent — code review: an earlier version of
 * this function embedded a cheap fixed marker string for entity_raw
 * points, which was itself unnecessary work, since Qdrant points do not
 * require a vector).
 *
 * @param {Array<Object>} taggedChunks
 * @param {{ useTextOnly?: boolean }} [opts]
 * @returns {{ embedTexts: string[], embedContexts: (string|null)[] }}
 */
export function buildEmbedInputsForChunks(taggedChunks, { useTextOnly = false } = {}) {
  const embedTexts = taggedChunks.map(chunk => (useTextOnly ? chunk.text : `${chunk.context}\n\n${chunk.text}`));
  // Passed alongside embedTexts (cloud-only) so a too-long assembled input
  // can have ITS CONTEXT trimmed — never the chunk body — and be retried
  // once before indexing fails outright for that chunk. See
  // embedForIndexCloud()'s own header comment (core/embeddings.js).
  const embedContexts = taggedChunks.map(chunk => (useTextOnly ? null : chunk.context));
  return { embedTexts, embedContexts };
}

// ── Stage C: embed + validate + build points (ONNX CPU, pure compute) ────────
// Guarded by embedSem in pipeline mode.
// No Qdrant mutations here — produces pointsWithDense for stageD to commit.
// Keeping embed separate from Qdrant writes allows ONNX to overlap with the
// serialised commit phase of a previous file.
async function stageC(withTagged, reporter = null) {
  const { taggedChunks, collection, sourceFile, fileHash,
          embedCfg, tokenCountMode, configVectorSize, budgetAwareTopology, profiler } = withTagged;

  console.log('  [4/5] embedding...');
  reporter?.step('embedding');
  // BENCH_EMBED_INPUT=text — benchmark/ablation only, not a stable config
  // option; in that mode there is no separate context prefix to reserve
  // budget for, so embedContexts is all-null.
  const useTextOnly = process.env.BENCH_EMBED_INPUT === 'text';
  const { embedTexts, embedContexts } = buildEmbedInputsForChunks(taggedChunks, { useTextOnly });

  const embedPairs = embedTexts.map((text, i) => ({ text, context: embedContexts[i] }));

  let embedResults;
  if (shouldUseOnnxBatching(process.env)) {
    try {
      embedResults = await embedForIndexBatch(EMBEDDING_PROFILE, embedTexts, runBatched, BATCH_SIZE, { contexts: embedContexts });
    } catch (batchErr) {
      process.stderr.write(`[embed] DML batch failed (${batchErr.message}) — retrying per-text\n`);
      embedResults = await runBatched(embedPairs, BATCH_SIZE, ({ text, context }) => embedForIndex(EMBEDDING_PROFILE, text, { context }));
    }
  } else {
    embedResults = await runBatched(embedPairs, BATCH_SIZE, ({ text, context }) => embedForIndex(EMBEDDING_PROFILE, text, { context }));
  }

  // Validate vectors before passing to stageD — no destructive work has happened yet.
  if (embedResults.length !== taggedChunks.length) {
    throw new Error(`embed phase: expected ${taggedChunks.length} results, got ${embedResults.length}`);
  }
  const isCloudExecution = EMBEDDING_PROFILE.embedding.dense.execution === EXECUTION.QDRANT_CLOUD;
  for (let i = 0; i < embedResults.length; i++) {
    const { dense, sparse } = embedResults[i];
    if (isCloudExecution) {
      // Qdrant computes the real vector server-side — no length to
      // validate here, only the {text, model} inference-descriptor shape.
      if (typeof dense !== 'object' || dense === null || typeof dense.text !== 'string' || typeof dense.model !== 'string') {
        throw new Error(`embed phase: chunk ${i} dense inference descriptor invalid`);
      }
      if (sparse !== null && (typeof sparse !== 'object' || typeof sparse.text !== 'string' || typeof sparse.model !== 'string')) {
        throw new Error(`embed phase: chunk ${i} sparse inference descriptor invalid`);
      }
    } else {
      if (!Array.isArray(dense) || dense.length !== configVectorSize) {
        throw new Error(`embed phase: chunk ${i} dense length ${dense?.length} ≠ ${configVectorSize}`);
      }
      if (!Array.isArray(sparse?.indices) || !Array.isArray(sparse?.values)) {
        throw new Error(`embed phase: chunk ${i} sparse shape invalid`);
      }
    }
  }

  const pointsWithDense = taggedChunks.map((chunk, i) => {
    const { dense, sparse, meta } = embedResults[i];
    return {
      dense,
      point: {
        // Skeleton-v1: point identity follows the structural node, not the
        // positional chunkIndex (transitional stage collapsed 2026-06-10).
        // Legacy: unchanged chunkIndex-based IDs.
        id: isSkeletonChunk(chunk)
          ? makeSkeletonPointId({
              collection,
              nodeId: chunk.node_id,
              embeddingSchemaVersion: embedCfg.schemaVersion,
            })
          : makePointId({
              collection,
              sourceFile: chunk.source_file,
              chunkIndex: chunk.chunkIndex,
              embeddingSchemaVersion: embedCfg.schemaVersion,
            }),
        vector: { dense, sparse },
        payload: {
          text: chunk.text,
          context: chunk.context,
          section: chunk.section,
          source_file: chunk.source_file,
          tags: chunk.tags,
          links: chunk.links,
          chunk_index: chunk.chunkIndex,
          total_chunks: chunk.totalChunks,
          file_hash: fileHash,
          vector_size: configVectorSize,
          chunking_schema_version: CHUNKING_SCHEMA_VERSION,
          token_count_mode: tokenCountMode,
          // indexing_schema_version must be written for ANY budget-aware
          // chunk, not only skeleton-v1 ones — skeletonPayloadFields below
          // is {} for a legacy/non-Markdown chunk (isSkeletonChunk gate),
          // so without this unconditional field a budget-aware PDF/Pandoc/
          // plain-text file's stored meta would read back null forever,
          // never matching expectedChunkingMeta's expected v6, and
          // reindexing on every single run (code review finding).
          ...indexingSchemaVersionField({ isSkeleton: isSkeletonChunk(chunk), budgetAwareTopology }),
          ...skeletonPayloadFields(chunk, { budgetAwareTopology }),   // additive; {} for legacy chunks (adds skeleton-only fields; its own indexing_schema_version matches the line above exactly)
          ...meta,
        },
      },
    };
  });

  // Canonical entity_raw points (entity-split.js) — built directly from
  // withTagged.entityRawPoints, with NO embedding call at all (code review:
  // Qdrant points do not require a vector — they remain fetchable via
  // scroll/filter and simply never participate in vector search — so the
  // earlier cheap-marker-embed workaround was pure waste: a real Cloud
  // Inference request and a stored vector for a point that is never
  // searched). No tags either — entity_raw is never returned by search or
  // tag-based aggregation, so tag generation would be equally wasted work.
  const entityRawPoints = withTagged.entityRawPoints ?? [];
  const entityRawQdrantPoints = entityRawPoints.map(chunk => ({
    id: makeSkeletonPointId({
      collection, nodeId: chunk.node_id,
      embeddingSchemaVersion: embedCfg.schemaVersion,
    }),
    // No `vector` key at all — see stageD's upsertPointsWithoutVectors(),
    // which upserts this array through a dedicated vectorless primitive
    // rather than the regular {dense, sparse}-shaped upsert path.
    payload: buildEntityRawPointPayload(chunk, {
      fileHash, chunkingSchemaVersion: CHUNKING_SCHEMA_VERSION, tokenCountMode,
      denseProvider: embedCfg.denseProvider, denseModel: embedCfg.denseModel,
      sparseProvider: embedCfg.sparseProvider, embeddingSchemaVersion: embedCfg.schemaVersion,
    }),
  }));

  // Task 6: embed nav summaries (local ONNX/provider — not an LLM cost) and
  // assemble skeleton_nav points. Same provider as content for consistency.
  const navPoints = withTagged.navPoints ?? [];
  let navQdrantPoints = [];
  if (navPoints.length > 0) {
    const navEmbeds = await runBatched(
      navPoints.map(n => n.summary ?? ''), BATCH_SIZE,
      text => embedForIndex(EMBEDDING_PROFILE, text),
    );
    navQdrantPoints = navPoints.map((nav, i) => {
      const { dense, sparse, meta } = navEmbeds[i];
      return {
        id: makeSkeletonPointId({
          collection, nodeId: nav.node_id,
          embeddingSchemaVersion: embedCfg.schemaVersion,
        }),
        vector: { dense, sparse },
        payload: buildNavPointPayload(nav, {
          fileHash, vectorSize: configVectorSize,
          tokenCountMode, chunkingSchemaVersion: CHUNKING_SCHEMA_VERSION,
          embedMeta: meta, budgetAwareTopology,
        }),
      };
    });
  }

  profiler.mark('embed+upsert'); // mark covers embed; Qdrant write happens in stageD

  return { ...withTagged, pointsWithDense, navQdrantPoints, entityRawQdrantPoints };
}

// ── Stage D: commit (always serial via SerialQueue) ───────────────────────────
// All Qdrant mutations are here, serialised.
// Order: deleteBySourceFile → upsert vectorless entity_raw points (wait:true)
//        → upsert retrieval fragments (real vectors) → upsert nav points →
//        deleteTrailingChunks. The canonical entity_raw upsert happens
// FIRST and is awaited with wait: true (upsertPointsWithoutVectors' own
// contract — see its doc comment in core/qdrant/store.js) specifically so
// it is GUARANTEED to have actually landed on the server — not merely been
// queued — before any fragment whose entity_id points at it is written.
// Writing fragments first (an earlier version of this function did, citing
// this exact guarantee in its own comment while the code contradicted it —
// code review finding) would let a query racing the indexing run observe a
// fragment whose entity_id resolves to nothing yet.
// Serialisation prevents stageC of file B from racing with the commit of file A.
async function stageD(withPoints, reporter = null) {
  const { taggedChunks, pointsWithDense, collection, rawChunks,
          sourceFile, needsDelete, profiler } = withPoints;

  console.log('  [4/5] upserting...');
  reporter?.step('writing');

  if (pointsWithDense.length === 0 && rawChunks.length > 0) {
    throw new Error(`stageD: refusing to commit 0 points for ${sourceFile} (${rawChunks.length} raw chunks)`);
  }

  if (needsDelete) {
    await deleteBySourceFile(collection, sourceFile);
  }

  // Canonical entity_raw points (entity-split.js) FIRST — vectorless
  // upsert (vector: {}, confirmed live against Qdrant Cloud v1.17.1:
  // accepted, scroll/filter-reachable, excluded from vector search on
  // every named vector), awaited with wait: true so it has genuinely
  // completed on the server before the fragments that reference it
  // (via entity_id) are written below.
  const entityRawQdrantPoints = withPoints.entityRawQdrantPoints ?? [];
  if (entityRawQdrantPoints.length > 0) {
    await upsertPointsWithoutVectors(collection, entityRawQdrantPoints);
    console.log(`        upserted ${entityRawQdrantPoints.length} entity_raw point(s) (vectorless)`);
  }

  const points = pointsWithDense.map(({ point }) => point);
  await upsertPoints(collection, points);
  console.log(`        upserted ${points.length} points`);

  // Task 6: nav points last — content is committed and the point_kind filter
  // (task 5) guarantees they never surface in search or tool aggregations.
  const navQdrantPoints = withPoints.navQdrantPoints ?? [];
  if (navQdrantPoints.length > 0) {
    await upsertPoints(collection, navQdrantPoints);
    console.log(`        upserted ${navQdrantPoints.length} nav point(s) (skeleton_nav)`);
  }

  await deleteTrailingChunks(collection, sourceFile, taggedChunks.length);

  const tokensEst = taggedChunks.reduce((s, c) => s + Math.ceil(c.text.length / 4), 0);
  profiler.report({ chunksIn: rawChunks.length, chunksOut: taggedChunks.length, tokensEst });

  console.log(`  ✓ done`);
}

// ── Sequential indexFile (default, PIPELINE_MODE unset) ───────────────────────
// `reporter` (see progress-event.js's createFileProgressReporter) is optional
// — callers that don't care about phase-aware progress (e.g. any future
// direct caller) simply omit it, and every reporter?.step(...) below is a
// no-op.
async function indexFile(filePath, rootPath, collection, { runNumCtx = null, reporter = null } = {}) {
  console.log(`\n→ ${filePath}`);
  const profiler = new Profiler();

  const preparedA = await stageA(filePath, rootPath, collection, profiler, reporter);
  if (preparedA.status === 'skipped') return 'skipped';

  if (runNumCtx != null) preparedA.runNumCtx = runNumCtx;
  const preparedB = await stageB(preparedA, null, reporter);
  const preparedC = await stageC(preparedB, reporter);
  await stageD(preparedC, reporter);
}

export function computeStaleSourceFiles(indexedSourceFiles, storedSourceFiles) {
  const indexed = new Set(indexedSourceFiles);
  return storedSourceFiles.filter(sf => !indexed.has(sf));
}

// A collection with no skeleton file nav nodes at all (e.g. one containing
// only non-Markdown formats, which never produce skeleton_nav points — see
// chunkFileFromPath's documented scope boundary) has nothing meaningful to
// roll up into a collection-level nav node. Exported so the guard's exact
// condition is independently testable without a real/mocked Qdrant scroll.
export function shouldSkipCollectionNavRollup(fileNodes) {
  return fileNodes.length === 0;
}

// Whether the collection-level nav rollup (rebuild-or-cleanup) needs to run
// at all this indexing run. `indexed > 0` alone misses two real cases:
// an empty-root run with PRUNE_STALE=1 that removes every previously-
// indexed file (indexed stays 0, but stale directory/collection nav points
// must still be cleared) and a partial prune with no new files indexed (the
// rollup must still rebuild from whatever file nav nodes remain).
export function collectionNavRollupNeeded(indexedCount, prunedCount) {
  return indexedCount > 0 || prunedCount > 0;
}


async function main() {
  const targetPath = process.argv[2];
  if (!targetPath || !COLLECTION) {
    console.error('Usage: COLLECTION=my-collection node src/indexer/index.js <file|folder>');
    process.exit(1);
  }

  let allCollections = await listCollections();
  if (!allCollections.includes(COLLECTION)) {
    const providerConfig = resolveEnvProviders();
    let newCollectionVectorSize = 1024;
    if (providerConfig.denseProvider === 'ollama') {
      const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
      newCollectionVectorSize = await getOllamaEmbeddingDimension(
        providerConfig.denseModel,
        ollamaUrl
      );
      if (!newCollectionVectorSize) {
        throw new Error(
          `Cannot determine embedding dimension for Ollama model "${providerConfig.denseModel}". ` +
          `Verify that the model is installed, supports embeddings, and Ollama is reachable at ${ollamaUrl}.`
        );
      }
    } else if (providerConfig.denseProvider === 'qdrant-cloud') {
      // Dimensions are fixed per catalog model ID — no network probe needed.
      const denseCatalog = findDenseModel(providerConfig.denseModel);
      if (!denseCatalog || denseCatalog.status !== 'supported') {
        throw new Error(`Cannot create a qdrant-cloud collection: "${providerConfig.denseModel}" is not a supported Qdrant Cloud dense model.`);
      }
      newCollectionVectorSize = denseCatalog.dimensions;
    }
    VECTOR_SIZE = newCollectionVectorSize;
    // resolveNewCollectionProfile() is the ONE legitimate place
    // resolveEnvProviders()-derived global/env defaults are used — this
    // profile and the Qdrant vector space are established together via
    // adapter.createCollection(), never via a follow-up
    // setEmbeddingProfile() call. config.json is then written AFTER this
    // resolution succeeds, as a cache of the SAME resolved profile object
    // (one value, two destinations — never two independent resolutions
    // that could drift apart).
    EMBEDDING_PROFILE = resolveNewCollectionProfile(providerConfig, {
      vectorSize: VECTOR_SIZE,
      embeddingSchemaVersion: SCHEMA_VERSION,
    });
    console.log(`Collection "${COLLECTION}" not found, creating...`);
    await storageAdapter.createCollection(COLLECTION, { profile: EMBEDDING_PROFILE });
    allCollections = [...allCollections, COLLECTION];
    const cfg = loadConfig();
    if (!cfg.collections) cfg.collections = {};
    cfg.collections[COLLECTION] = resolveCollectionConfigEntry(EMBEDDING_PROFILE, cfg.collections[COLLECTION]);
    saveConfig(cfg);
    console.log(`  saved config for "${COLLECTION}" (dense: ${providerConfig.denseProvider}/${providerConfig.denseModel}, sparse: ${providerConfig.sparseProvider})`);
  } else {
    // Guard against plain-vector collections (indexed outside semidex, e.g. via
    // third-party MCP plugins). semidex always uses named vectors {dense, sparse}.
    // A plain-vector collection has vectors.size at the top level instead of
    // vectors.dense — upsertting named-vector points into it silently corrupts it.
    const info = await getCollectionInfo(COLLECTION);
    const vectorsCfg = info?.config?.params?.vectors;
    const isPlainVectors = vectorsCfg && typeof vectorsCfg.size === 'number';
    if (isPlainVectors) {
      console.error(
        `\nERROR: Collection "${COLLECTION}" uses plain (unnamed) vectors — it was not indexed by semidex.\n` +
        `  semidex requires named vectors { dense, sparse }.\n` +
        `  To fix: delete the collection in Qdrant, then re-run indexing.\n` +
        `  Qdrant dashboard or: curl -X DELETE $QDRANT_URL/collections/${COLLECTION} -H "api-key: $QDRANT_KEY"`
      );
      process.exit(1);
    }

    // The indexer's own preflight is one of the two legitimate places
    // allowed to trigger migration (the other is sync.js) — an indexing
    // job is an explicit, user-initiated action, never a passive read.
    // resolveExistingCollectionProfile() itself is strictly read-only; if
    // it reports 'legacy_unmigrated', migrateEmbeddingProfile() is called
    // explicitly here, then re-resolved. If the profile still cannot be
    // resolved after that, this fails fast — before any embedding or
    // upsert call — rather than falling back to global/env defaults for
    // an existing collection.
    let resolution = await resolveExistingCollectionProfile(storageAdapter, COLLECTION);
    if (!resolution.resolved && resolution.reason === 'legacy_unmigrated') {
      const migration = await storageAdapter.migrateEmbeddingProfile(COLLECTION);
      if (migration.status === 'inferred') {
        console.log(`  ✓ migrated embedding profile for "${COLLECTION}" (dense: ${migration.profile.embedding.dense.provider}/${migration.profile.embedding.dense.model})`);
      }
      resolution = await resolveExistingCollectionProfile(storageAdapter, COLLECTION);
    }
    if (!resolution.resolved) {
      console.error(
        `\nERROR: Cannot determine the embedding identity of existing collection "${COLLECTION}" (${resolution.reason}).\n` +
        `  This collection has no valid native embedding profile, and its legacy point payloads (if any) are\n` +
        `  ambiguous or missing — reindexing would risk writing vectors from the wrong model into this collection.\n` +
        `  Resolve this by running "npm run sync" for a detailed diagnosis, or delete and reindex from scratch.`
      );
      process.exit(1);
    }
    EMBEDDING_PROFILE = resolution.profile;
    VECTOR_SIZE = EMBEDDING_PROFILE.embedding.dense.dimensions;
    // config.json's role for an existing collection is a cache/display
    // convenience, refreshed from the resolved profile so it never
    // silently drifts from the native metadata that is now canonical.
    const cfg = loadConfig();
    if (!cfg.collections) cfg.collections = {};
    cfg.collections[COLLECTION] = resolveCollectionConfigEntry(EMBEDDING_PROFILE, cfg.collections[COLLECTION]);
    saveConfig(cfg);
  }

  const PRUNE_STALE = process.env.PRUNE_STALE === '1';
  const absTarget = resolve(targetPath);
  const isDirectory = statSync(absTarget).isDirectory();
  const rootPath = isDirectory ? absTarget : dirname(absTarget);
  const effectiveRoot = SOURCE_ROOT ?? rootPath;
  const files = collectFiles(absTarget);

  // Without PRUNE_STALE an empty directory is a no-op; exit early.
  // With PRUNE_STALE we still need to run the stale check even if no files
  // are on disk (e.g. the last file in a collection was deleted).
  if (!files.length && !PRUNE_STALE) { console.log('No supported files found.'); process.exit(0); }
  if (!files.length && PRUNE_STALE)  { console.log('No supported files found on disk — continuing to stale check.'); }

  // PRUNE_STALE safety: single-file target cannot represent full collection scope.
  if (PRUNE_STALE && !isDirectory) {
    console.warn('\nWARN: PRUNE_STALE=1 ignored — stale cleanup requires a directory target, not a single file.');
  }

  // PRUNE_STALE safety: subset directory. If SOURCE_ROOT is set, prune is only
  // safe when the target covers the entire root. Indexing a subdirectory would
  // incorrectly treat files outside it as stale.
  const pruneAllowed = PRUNE_STALE && isDirectory && absTarget === effectiveRoot;
  if (PRUNE_STALE && isDirectory && !pruneAllowed) {
    console.warn(`\nWARN: PRUNE_STALE=1 ignored — target "${absTarget}" is a subset of SOURCE_ROOT "${effectiveRoot}". Run against the full root to prune safely.`);
  }

  if (files.length) console.log(`Found ${files.length} file(s) to process`);
  let indexed = 0, skipped = 0, prunedCount = 0;

  // Pre-run num_ctx: read all skeleton-eligible files once, find the largest,
  // resolve a single num_ctx for the whole run. Ollama loads the model once
  // at that size and never reloads mid-run (reloads happen on num_ctx change).
  let runNumCtx = null;
  if (process.env.SKELETON_SUMMARY === 'llm') {
    const contextModel = process.env.CONTEXT_MODEL || 'gemma3:4b';
    const { readFileSync } = await import('fs');
    let maxTokens = 0;
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      try {
        const tokens = estTokens(readFileSync(f, 'utf8'));
        if (tokens > maxTokens) maxTokens = tokens;
      } catch { /* unreadable file — stageA will handle it */ }
    }
    runNumCtx = await resolveRunNumCtx(contextModel, maxTokens);
    console.log(`[summary] run num_ctx=${runNumCtx} (largest file ~${maxTokens} tokens)`);
  }

  const pipelineMode = process.env.PIPELINE_MODE === '1';

  if (pipelineMode) {
    const parsedOllama = parseInt(process.env.OLLAMA_STAGE_CONCURRENCY ?? '1', 10);
    const parsedEmbed  = parseInt(process.env.EMBED_STAGE_CONCURRENCY  ?? '1', 10);
    const parsedStageA = parseInt(process.env.STAGEA_CONCURRENCY       ?? '4', 10);
    const ollamaConcurrency = (Number.isInteger(parsedOllama) && parsedOllama >= 1) ? parsedOllama : 1;
    const embedConcurrency  = (Number.isInteger(parsedEmbed)  && parsedEmbed  >= 1) ? parsedEmbed  : 1;
    const stageAConcurrency = (Number.isInteger(parsedStageA) && parsedStageA >= 1) ? parsedStageA : 4;
    if (parsedOllama !== ollamaConcurrency) console.warn(`[pipeline] invalid OLLAMA_STAGE_CONCURRENCY, using 1`);
    if (parsedEmbed  !== embedConcurrency)  console.warn(`[pipeline] invalid EMBED_STAGE_CONCURRENCY, using 1`);
    if (parsedStageA !== stageAConcurrency) console.warn(`[pipeline] invalid STAGEA_CONCURRENCY, using 4`);

    console.log(`[pipeline] enabled: stageA=${stageAConcurrency} ollama=${ollamaConcurrency} embed=${embedConcurrency} commit=serial`);

    const stageASem   = new Semaphore(stageAConcurrency);
    const ollamaSem   = new Semaphore(ollamaConcurrency);
    const embedSem    = new Semaphore(embedConcurrency);
    const commitQueue = new SerialQueue();

    // Pipeline mode runs files concurrently (out of order), so unlike the
    // sequential loop there's no single well-defined "current file". It still
    // reports processedFiles/totalFiles/currentFile (currentFile is the most
    // recently *started* file, not "the" file being worked on — useful
    // context, just not exclusive).
    //
    // Deliberately no phase-aware (createFileProgressReporter) instrumentation
    // here: stageB/stageC/stageD below are called without a `reporter`
    // argument, so their reporter?.step(...) calls are no-ops and
    // currentStep/currentFileProgress stay null for pipeline-mode jobs.
    // Multiple files run concurrent phases at once in this mode, so a single
    // "current phase" wouldn't describe what's actually happening; building a
    // correct multi-file phase model is out of scope here (task non-goals).
    //
    // Trade-off, by design: the admin API's percent formula requires
    // currentFileProgress to be a number (see src/admin/api/jobs.js), so
    // pipeline-mode jobs now always show percent: null (indeterminate
    // progress), even though totalFiles is known. An earlier iteration made
    // pipeline mode show a coarse file-count percent instead — this task's
    // stricter, explicitly-specified percent rule intentionally supersedes
    // that. The admin UI never sets PIPELINE_MODE=1 itself, so this only
    // affects an operator who exports it into the admin server's own
    // environment before running `npm run admin`.
    let pipelineProcessed = 0;
    const settlements = await Promise.allSettled(files.map(async filePath => {
      console.log(`\n→ ${filePath}`);
      const currentFile = relative(effectiveRoot, filePath).replace(/\\/g, '/');
      emitProgress({ processedFiles: pipelineProcessed, totalFiles: files.length, currentFile });
      const profiler = new Profiler();

      const preparedA = await stageASem.run(() => stageA(filePath, rootPath, COLLECTION, profiler));
      if (preparedA.status === 'skipped') { pipelineProcessed++; return 'skipped'; }

      if (runNumCtx != null) preparedA.runNumCtx = runNumCtx;
      // ONNX split-sem path: only active when tags actually go to the ONNX worker.
      // COMBINED_LLM=1 and disabled tags both bypass the ONNX lane inside stageB, so
      // they must keep the default ollamaSem.run() wrapper to gate Ollama correctly.
      const onnxLaneActive = isOnnxTagProvider(process.env)
        && shouldGenerateTags(process.env)
        && !resolveCombinedLlmConfig(process.env).enabled;
      const preparedB = onnxLaneActive
        ? await stageB(preparedA, ollamaSem)
        : await ollamaSem.run(() => stageB(preparedA));
      const preparedC = await embedSem.run(() => stageC(preparedB));
      await commitQueue.run(() => stageD(preparedC));
      pipelineProcessed++;
      emitProgress({ processedFiles: pipelineProcessed, totalFiles: files.length, currentFile: null });
      return 'indexed';
    }));

    const failures = [];
    for (const s of settlements) {
      if (s.status === 'fulfilled') {
        if (s.value === 'skipped') skipped++; else indexed++;
      } else {
        failures.push(s.reason);
      }
    }
    if (failures.length > 0) {
      for (const err of failures) console.error(`[pipeline] file failed: ${err?.message ?? err}`);
      throw new Error(`[pipeline] ${failures.length} file(s) failed — see errors above`);
    }
  } else {
    for (const [i, filePath] of files.entries()) {
      const currentFile = relative(effectiveRoot, filePath).replace(/\\/g, '/');
      const reporter = createFileProgressReporter({
        emit: emitProgress, fileIndex: i, totalFiles: files.length, currentFile,
      });
      reporter.step('preparing');
      const status = await indexFile(filePath, rootPath, COLLECTION, { runNumCtx, reporter });
      if (status === 'skipped') skipped++; else indexed++;
      reporter.done();
    }
  }

  if (pruneAllowed) {
    const indexedSourceFiles = files.map(f => relative(effectiveRoot, f).replace(/\\/g, '/'));
    let storedSourceFiles;
    let pruneSkipped = false;
    try {
      storedSourceFiles = await listSourceFiles(COLLECTION);
    } catch (e) {
      console.warn(`\nWARN: PRUNE_STALE=1 skipped — could not list source files from Qdrant: ${e.message}`);
      pruneSkipped = true;
    }
    if (!pruneSkipped) {
      const stale = computeStaleSourceFiles(indexedSourceFiles, storedSourceFiles);
      if (stale.length === 0) {
        console.log('\nPRUNE_STALE: no stale source files found.');
      } else {
        console.log(`\nPRUNE_STALE: pruning ${stale.length} stale source file(s)...`);
        for (const sf of stale) {
          await deleteBySourceFile(COLLECTION, sf);
          console.log(`  - removed: ${sf}`);
        }
        prunedCount = stale.length;
      }
    }
  }

  // ── Collection-level nav node (design §9/§12.1) ─────────────────────────────
  // See collectionNavRollupNeeded's own comment for why this isn't just
  // `indexed > 0`. Non-fatal on failure.
  if (collectionNavRollupNeeded(indexed, prunedCount)) {
    try {
      const fileNavs = await scroll(COLLECTION, {
        must: [
          { key: 'point_kind', match: { value: 'skeleton_nav' } },
          { key: 'node_type',  match: { value: 'file' } },
        ],
      }, 1000, ['source_file', 'summary', 'summary_kind', 'summary_version', 'key_topics', 'notable_terms']);
      const fileNodes = fileNavs
        .map(p => ({
          source_file:  p.payload?.source_file  ?? '',
          summary:      p.payload?.summary      ?? '',
          summary_kind: p.payload?.summary_kind ?? undefined,
          key_topics:   p.payload?.key_topics   ?? undefined,
          notable_terms: p.payload?.notable_terms ?? undefined,
        }))
        .filter(f => f.source_file)
        .sort((a, b) => a.source_file.localeCompare(b.source_file));

      // See shouldSkipCollectionNavRollup's own comment: without this guard,
      // `indexed > 0` alone would still create a misleading "0 files"
      // inventory collection node for a collection indexed with only
      // non-Markdown content. But skipping the rollup entirely is not
      // enough on its own — a collection that PREVIOUSLY had Markdown (so
      // directory/collection nav points already exist from an earlier run)
      // and has since moved to non-Markdown-only content (or had its
      // Markdown files pruned) must not be left with stale directory/
      // collection nav points describing content that no longer exists.
      if (shouldSkipCollectionNavRollup(fileNodes)) {
        await deleteByFilter(COLLECTION, {
          must: [
            { key: 'point_kind', match: { value: 'skeleton_nav' } },
            { key: 'node_type',  match: { any: ['directory', 'collection'] } },
          ],
        });
        console.log('\nNo skeleton file nav nodes in this collection — skipping collection nav rollup, removing any stale directory/collection nav points.');
      } else {
        const { directoryNodes, topChildren } = buildDirectoryNavPoints(COLLECTION, fileNodes);

        // Build a lookup map for generateDirectorySummaries: path → enriched nav node.
        // File nodes use the `<source_file>#file` path convention.
        const childSummaryByPath = new Map(
          fileNodes.map(f => [`${f.source_file}#file`, f])
        );

        // Generate directory summaries when LLM is enabled.
        const llmEnabled = process.env.SKELETON_SUMMARY === 'llm';
        const enrichedDirs = llmEnabled && directoryNodes.length > 0
          ? await generateDirectorySummaries(directoryNodes, childSummaryByPath, {
              numCtx: runNumCtx ?? undefined,
            })
          : directoryNodes;

        // Add enriched directory nodes into the lookup so collection can use them.
        for (const d of enrichedDirs) {
          childSummaryByPath.set(d.node_path, d);
        }

        await deleteByFilter(COLLECTION, {
          must: [
            { key: 'point_kind', match: { value: 'skeleton_nav' } },
            { key: 'node_type',  match: { value: 'directory' } },
          ],
        });

        if (enrichedDirs.length > 0) {
          const dirTexts = enrichedDirs.map(n => n.summary);
          const dirEmbeds = shouldUseOnnxBatching(process.env)
            ? await embedForIndexBatch(EMBEDDING_PROFILE, dirTexts, runBatched, BATCH_SIZE)
            : await runBatched(dirTexts, BATCH_SIZE, text => embedForIndex(EMBEDDING_PROFILE, text));
          const cfgVectorSize = EMBEDDING_PROFILE.embedding.dense.dimensions;
          const dirPoints = enrichedDirs.map((node, i) => ({
            id: makeSkeletonPointId({
              collection: COLLECTION,
              nodeId: node.node_id,
              embeddingSchemaVersion: EMBEDDING_PROFILE.embeddingSchemaVersion,
            }),
            vector: { dense: dirEmbeds[i].dense, sparse: dirEmbeds[i].sparse },
            payload: buildNavPointPayload(node, {
              fileHash: null,
              vectorSize: cfgVectorSize,
              tokenCountMode: resolveTokenCountMode(),
              chunkingSchemaVersion: CHUNKING_SCHEMA_VERSION,
              embedMeta: dirEmbeds[i].meta,
              budgetAwareTopology: resolveEmbeddingBudget(EMBEDDING_PROFILE) !== null,
            }),
          }));
          await upsertPoints(COLLECTION, dirPoints);
        }

        // Top-level nodes for collection overview: enriched dirs + root files.
        const rootFilePaths = new Set(
          topChildren.filter(p => p.endsWith('#file'))
        );
        const topLevelNodes = [
          ...enrichedDirs.filter(d => topChildren.includes(d.node_path)),
          ...fileNodes.filter(f => rootFilePaths.has(`${f.source_file}#file`)),
        ];

        const collResult = await buildCollectionSummary(COLLECTION, fileNodes, {
          llm: llmEnabled,
          numCtx: runNumCtx ?? undefined,
          topLevelNodes: topLevelNodes.length ? topLevelNodes : undefined,
        });

        const collectionNodeId = makeNodeId({
          collection: '', sourceFile: '', structuralPath: '',
          nodeType: 'collection', ordinalWithinParent: 1,
        });
        const { dense, sparse, meta } = await embedForIndex(EMBEDDING_PROFILE, collResult.summary);
        const cfgVectorSize = EMBEDDING_PROFILE.embedding.dense.dimensions;
        await upsertPoints(COLLECTION, [{
          id: makeSkeletonPointId({
            collection: COLLECTION, nodeId: collectionNodeId,
            embeddingSchemaVersion: EMBEDDING_PROFILE.embeddingSchemaVersion,
          }),
          vector: { dense, sparse },
          payload: buildNavPointPayload({
            point_kind: 'skeleton_nav', node_type: 'collection',
            node_id: collectionNodeId, node_path: `${COLLECTION}#collection`,
            source_file: '', heading_path: [], summary: collResult.summary,
            summary_kind:    collResult.summary_kind,
            summary_version: collResult.summary_version,
            ...(collResult.key_topics    ? { key_topics:    collResult.key_topics }    : {}),
            ...(collResult.notable_terms ? { notable_terms: collResult.notable_terms } : {}),
            children: topChildren.length ? topChildren : collResult.children,
          }, {
            fileHash: null, vectorSize: cfgVectorSize,
            tokenCountMode: resolveTokenCountMode(),
            chunkingSchemaVersion: CHUNKING_SCHEMA_VERSION,
            embedMeta: meta,
            budgetAwareTopology: resolveEmbeddingBudget(EMBEDDING_PROFILE) !== null,
          }),
        }]);
        console.log(`\nCollection nav node updated (${fileNodes.length} file summaries, ${enrichedDirs.length} directory summaries).`);
      }
    } catch (err) {
      console.warn(`\nWARN: collection nav node update failed — ${err.message}`);
    }
  }

  // Records the schema versions this indexing run actually wrote, as the
  // mutable sibling of the immutable embedding profile (Part D/architecture
  // doc's two-key split: semidex_indexing_state next to
  // semidex_embedding_profile, updated freely on every successful run,
  // never touching the embedding-profile key). Best-effort: a failure here
  // must never fail an otherwise-successful indexing run — the payload-level
  // chunking_schema_version/indexing_schema_version fields (already written
  // per-point above) remain the authoritative per-file record regardless.
  try {
    await storageAdapter.setIndexingState(COLLECTION, buildIndexingState({
      // Topology-aware (code review, P2): matches expectedChunkingMeta's
      // own per-file logic — this collection's profile decides which
      // version applies, never a hardcoded ceiling constant.
      indexingSchemaVersion: resolveEmbeddingBudget(EMBEDDING_PROFILE) !== null
        ? INDEXING_SCHEMA_VERSION_PROFILE_BUDGET : INDEXING_SCHEMA_VERSION_BASE,
      chunkingSchemaVersion: CHUNKING_SCHEMA_VERSION,
    }));
  } catch (err) {
    console.warn(`\nWARN: failed to update collection indexing-state metadata — ${err.message}`);
  }

  console.log(`\nDone. ${files.length} file(s): ${indexed} indexed, ${skipped} skipped.`);
}

/**
 * Applies every settings-registry field this module and its phase
 * dependencies consume, from one SettingsService instance. Called by
 * index.js (the real CLI entry point) right after bootstrapEnv(), before
 * run() executes — never call this from within run.js itself, since
 * settingsService construction requires bootstrapEnv() to have already run
 * in the CALLING module (index.js), before run.js was ever imported.
 * @param {Object} settingsService
 */
export function applyAllSettings(settingsService) {
  applyIndexerSettings(settingsService);
  applyChunkingSettings(settingsService);
  applyContextSettings(settingsService);
  applyTagSettings(settingsService);
}

/**
 * Runs the indexer. Exported for index.js (the real CLI entry point) to
 * call after bootstrapping env and applying settings — see this file's own
 * header comment for why main() itself cannot safely call bootstrapEnv().
 */
export async function run() {
  try {
    await main();
  } finally {
    await shutdownOnnxTagWorker();
  }
}
