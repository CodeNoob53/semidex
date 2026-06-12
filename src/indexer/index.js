import 'dotenv/config';
import { createReadStream, statSync } from 'fs';
import { resolve, relative, dirname, isAbsolute } from 'path';
import { pathToFileURL } from 'url';
import { createHash } from 'crypto';

import { chunkFileFromPath } from './phases/chunk.js';
import { addContext } from './phases/context.js';
import { addTagsBatch, shouldGenerateTags } from './phases/tag.js';
import { addTagsOnnxBatch, isOnnxTagProvider, shutdownOnnxTagWorker } from './phases/tag-onnx.js';
import { isEmptySectionChunk } from './phases/empty-section.js';
import { addContextAndTags } from './phases/combined.js';
import { resolveCombinedLlmConfig } from '../core/doctor-checks.js';
import { runBatched } from './batch.js';
import { collectFiles, SUPPORTED_EXTENSIONS } from './files.js';
import { Profiler } from './profiler.js';
import { upsertPoints, listCollections, createCollection, getCollectionInfo, getStoredMeta, deleteBySourceFile, deleteTrailingChunks, listSourceFiles, deleteByFilter } from '../core/qdrant.js';
import { makePointId } from '../core/point-id.js';
import { loadConfig, saveConfig, resolveEnvProviders } from '../core/config.js';
import { embedForIndex, embedForIndexBatch, shouldUseOnnxBatching, getEmbeddingConfig, SCHEMA_VERSION } from '../core/embeddings.js';
import { ensureOllamaPreflight } from './preflight.js';
import { CHUNKING_SCHEMA_VERSION, getTokenCounter, resolveTokenCountMode } from '../core/token-count.js';
import { Semaphore } from './semaphore.js';
import { SerialQueue } from './serial-queue.js';
import { envInt } from '../core/env.js';
import { expectedChunkingMeta, skeletonPayloadFields, isSkeletonChunk, makeSkeletonPointId, buildNavPointPayload } from './skeleton-payload.js';
import { generateNavSummaries, buildCollectionSummary, resolveRunNumCtx, estTokens } from './phases/skeleton-summary.js';
import { buildDirectoryNavPoints } from './phases/skeleton-index.js';
import { makeNodeId } from '../core/node-id.js';
import { scroll } from '../core/qdrant.js';

const BATCH_SIZE   = envInt('LLM_BATCH_SIZE', 3, 1, 64, '[indexer] ');
const COLLECTION   = process.env.COLLECTION;
const VECTOR_SIZE  = parseInt(process.env.VECTOR_SIZE || '1024');
const SOURCE_ROOT  = process.env.SOURCE_ROOT ? resolve(process.env.SOURCE_ROOT) : null;

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
async function stageA(filePath, rootPath, collection, profiler) {
  const effectiveRoot = SOURCE_ROOT ?? rootPath;
  const sourceFile = relative(effectiveRoot, filePath).replace(/\\/g, '/');
  if (SOURCE_ROOT && (sourceFile.startsWith('../') || sourceFile === '..' || isAbsolute(sourceFile))) {
    throw new Error(`File "${filePath}" is outside SOURCE_ROOT "${SOURCE_ROOT}". Fix SOURCE_ROOT or remove it.`);
  }

  const embedCfg       = getEmbeddingConfig(collection);
  const tokenCountMode = resolveTokenCountMode();
  const configVectorSize = loadConfig().collections?.[collection]?.vectorSize ?? VECTOR_SIZE;

  const fileHash   = await hashFile(filePath);
  const storedMeta = await getStoredMeta(collection, sourceFile);
  const storedHash = storedMeta?.hash ?? null;
  // B1: chunking-model agreement is part of the skip tuple — toggling
  // SKELETON_CHUNKING must reindex, never silently mix point models.
  const chunkMeta = expectedChunkingMeta(process.env, filePath);

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
  // Skeleton files with deterministic context (§12, default) never call the
  // LLM for context; if tags are off or routed to the ONNX worker, Ollama is
  // not needed at all — skip the preflight so skeleton indexing works with
  // no Ollama running. SKELETON_CONTEXT=llm restores the legacy requirement.
  const skeletonNoLlm = Boolean(chunkMeta.chunkingModel)
    && process.env.SKELETON_CONTEXT !== 'llm'
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
  const rawChunks = await chunkFileFromPath(filePath, sourceFile);
  console.log(`        ${rawChunks.length} chunks`);
  profiler.mark('chunk');

  // Task 6: nav points ride a non-enumerable side-channel on the chunk array.
  // SKELETON_NAV=0 is the kill-switch (default: on for skeleton files).
  const navPoints = (process.env.SKELETON_NAV === '0') ? [] : (rawChunks.__navPoints ?? []);

  return {
    status: 'ready',
    filePath, sourceFile, collection, fileHash,
    embedCfg, tokenCountMode, configVectorSize,
    needsDelete, deleteReason,
    rawChunks, navPoints, combinedCfg: resolveCombinedLlmConfig(process.env),
    profiler,
  };
}

// ── Stage B: context + tag generation (Ollama GPU) ───────────────────────────
// In default mode: guarded by ollamaSem in pipeline mode (caller wraps with sem.run).
// In TAG_PROVIDER=onnx mode: caller passes ollamaSem so context alone acquires it
// while ONNX tags run outside — both start after chunk finalization, freeing the
// semaphore sooner.
async function stageB(prepared, ollamaSem = null) {
  const { rawChunks, combinedCfg, profiler } = prepared;

  if (combinedCfg.warning) console.warn(`  [combined] ${combinedCfg.warning}`);
  const genTags   = shouldGenerateTags(process.env);
  const tagViaOnnx = isOnnxTagProvider(process.env);

  // ── Skeleton leveled context (design §12, deterministic by default) ────────
  // Skeleton chunks arrive with a precomputed deterministic `context`
  // (heading path + adjacent prose) — the per-chunk LLM context phase is
  // skipped entirely: 0 LLM calls vs N in legacy. SKELETON_CONTEXT=llm opts
  // back into the legacy per-chunk LLM path for A/B benchmarking.
  const skeletonDeterministic = rawChunks.length > 0
    && rawChunks.every(ch => isSkeletonChunk(ch))
    && process.env.SKELETON_CONTEXT !== 'llm';

  if (skeletonDeterministic) {
    if (combinedCfg.enabled) {
      console.warn('  [skeleton] COMBINED_LLM=1 ignored for skeleton files — deterministic context owns the context phase');
    }
    console.log('  [2/5] contextualizing skipped (skeleton deterministic context)');
    let taggedChunks;
    if (genTags && tagViaOnnx) {
      console.log('  [3/5] tagging (onnx)...');
      taggedChunks = await addTagsOnnxBatch(rawChunks);
    } else if (genTags) {
      console.log('  [3/5] tagging (ollama)...');
      const tagged = [];
      for (let i = 0; i < rawChunks.length; i += BATCH_SIZE) {
        tagged.push(...await addTagsBatch(rawChunks.slice(i, i + BATCH_SIZE)));
      }
      taggedChunks = tagged;
    } else {
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
    const merged = rawChunks;
    console.log(`        ${merged.length} finalized chunks`);
    profiler.mark('context');

    if (genTags) {
      console.log('  [3/5] (combined — no separate tag phase)');
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
    const merged = rawChunks;
    console.log(`        ${merged.length} finalized chunks  [3/5] tagging (onnx, parallel)`);

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
    const merged = rawChunks;
    const contextChunks = await runBatched(merged, BATCH_SIZE, addContext);
    console.log(`        ${merged.length} finalized chunks`);
    profiler.mark('context');

    if (genTags) {
      console.log('  [3/5] tagging...');
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

// ── Stage C: embed + validate + build points (ONNX CPU, pure compute) ────────
// Guarded by embedSem in pipeline mode.
// No Qdrant mutations here — produces pointsWithDense for stageD to commit.
// Keeping embed separate from Qdrant writes allows ONNX to overlap with the
// serialised commit phase of a previous file.
async function stageC(withTagged) {
  const { taggedChunks, collection, sourceFile, fileHash,
          embedCfg, tokenCountMode, configVectorSize, profiler } = withTagged;

  console.log('  [4/5] embedding...');
  // BENCH_EMBED_INPUT=text — benchmark/ablation only, not a stable config option.
  const embedTexts = process.env.BENCH_EMBED_INPUT === 'text'
    ? taggedChunks.map(chunk => chunk.text)
    : taggedChunks.map(chunk => `${chunk.context}\n\n${chunk.text}`);

  let embedResults;
  if (shouldUseOnnxBatching(process.env)) {
    try {
      embedResults = await embedForIndexBatch(collection, embedTexts, runBatched, BATCH_SIZE);
    } catch (batchErr) {
      process.stderr.write(`[embed] DML batch failed (${batchErr.message}) — retrying per-text\n`);
      embedResults = await runBatched(embedTexts, BATCH_SIZE, text => embedForIndex(collection, text));
    }
  } else {
    embedResults = await runBatched(embedTexts, BATCH_SIZE, text => embedForIndex(collection, text));
  }

  // Validate vectors before passing to stageD — no destructive work has happened yet.
  if (embedResults.length !== taggedChunks.length) {
    throw new Error(`embed phase: expected ${taggedChunks.length} results, got ${embedResults.length}`);
  }
  for (let i = 0; i < embedResults.length; i++) {
    const { dense, sparse } = embedResults[i];
    if (!Array.isArray(dense) || dense.length !== configVectorSize) {
      throw new Error(`embed phase: chunk ${i} dense length ${dense?.length} ≠ ${configVectorSize}`);
    }
    if (!Array.isArray(sparse?.indices) || !Array.isArray(sparse?.values)) {
      throw new Error(`embed phase: chunk ${i} sparse shape invalid`);
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
          ...skeletonPayloadFields(chunk),   // additive; {} for legacy chunks
          ...meta,
        },
      },
    };
  });

  // Task 6: embed nav summaries (local ONNX/provider — not an LLM cost) and
  // assemble skeleton_nav points. Same provider as content for consistency.
  const navPoints = withTagged.navPoints ?? [];
  let navQdrantPoints = [];
  if (navPoints.length > 0) {
    const navEmbeds = await runBatched(
      navPoints.map(n => n.summary ?? ''), BATCH_SIZE,
      text => embedForIndex(collection, text),
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
          embedMeta: meta,
        }),
      };
    });
  }

  profiler.mark('embed+upsert'); // mark covers embed; Qdrant write happens in stageD

  return { ...withTagged, pointsWithDense, navQdrantPoints };
}

// ── Stage D: commit (always serial via SerialQueue) ───────────────────────────
// All Qdrant mutations are here, serialised.
// Order: deleteBySourceFile → upsertPoints → deleteTrailingChunks
// Serialisation prevents stageC of file B from racing with the commit of file A.
async function stageD(withPoints) {
  const { taggedChunks, pointsWithDense, collection, rawChunks,
          sourceFile, needsDelete, profiler } = withPoints;

  console.log('  [4/5] upserting...');

  if (pointsWithDense.length === 0 && rawChunks.length > 0) {
    throw new Error(`stageD: refusing to commit 0 points for ${sourceFile} (${rawChunks.length} raw chunks)`);
  }

  if (needsDelete) {
    await deleteBySourceFile(collection, sourceFile);
  }

  const points = pointsWithDense.map(({ point }) => point);
  await upsertPoints(collection, points);
  console.log(`        upserted ${points.length} points`);

  await deleteTrailingChunks(collection, sourceFile, taggedChunks.length);

  // Task 6: nav points last — content is committed and the point_kind filter
  // (task 5) guarantees they never surface in search or tool aggregations.
  const navQdrantPoints = withPoints.navQdrantPoints ?? [];
  if (navQdrantPoints.length > 0) {
    await upsertPoints(collection, navQdrantPoints);
    console.log(`        upserted ${navQdrantPoints.length} nav point(s) (skeleton_nav)`);
  }

  const tokensEst = taggedChunks.reduce((s, c) => s + Math.ceil(c.text.length / 4), 0);
  profiler.report({ chunksIn: rawChunks.length, chunksOut: taggedChunks.length, tokensEst });

  console.log(`  ✓ done`);
}

// ── Sequential indexFile (default, PIPELINE_MODE unset) ───────────────────────
async function indexFile(filePath, rootPath, collection, { runNumCtx = null } = {}) {
  console.log(`\n→ ${filePath}`);
  const profiler = new Profiler();

  const preparedA = await stageA(filePath, rootPath, collection, profiler);
  if (preparedA.status === 'skipped') return 'skipped';

  if (runNumCtx != null) preparedA.runNumCtx = runNumCtx;
  const preparedB = await stageB(preparedA);
  const preparedC = await stageC(preparedB);
  await stageD(preparedC);
}

export function computeStaleSourceFiles(indexedSourceFiles, storedSourceFiles) {
  const indexed = new Set(indexedSourceFiles);
  return storedSourceFiles.filter(sf => !indexed.has(sf));
}


async function main() {
  const targetPath = process.argv[2];
  if (!targetPath || !COLLECTION) {
    console.error('Usage: COLLECTION=my-collection node src/indexer/index.js <file|folder>');
    process.exit(1);
  }

  let allCollections = await listCollections();
  if (!allCollections.includes(COLLECTION)) {
    console.log(`Collection "${COLLECTION}" not found, creating...`);
    await createCollection(COLLECTION, VECTOR_SIZE);
    allCollections = [...allCollections, COLLECTION];
    const cfg = loadConfig();
    if (!cfg.collections) cfg.collections = {};
    if (!cfg.collections[COLLECTION]) {
      const { denseProvider, denseModel, sparseProvider } = resolveEnvProviders();
      cfg.collections[COLLECTION] = {
        denseProvider,
        denseModel,
        sparseProvider,
        embeddingSchemaVersion: SCHEMA_VERSION,
        vectorSize:  VECTOR_SIZE,
        description: '',
      };
      saveConfig(cfg);
      console.log(`  saved config for "${COLLECTION}" (dense: ${denseProvider}/${denseModel}, sparse: ${sparseProvider})`);
    }
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
  let indexed = 0, skipped = 0;

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

    const settlements = await Promise.allSettled(files.map(async filePath => {
      console.log(`\n→ ${filePath}`);
      const profiler = new Profiler();

      const preparedA = await stageASem.run(() => stageA(filePath, rootPath, COLLECTION, profiler));
      if (preparedA.status === 'skipped') return 'skipped';

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
    for (const filePath of files) {
      const status = await indexFile(filePath, rootPath, COLLECTION, { runNumCtx });
      if (status === 'skipped') skipped++; else indexed++;
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
      }
    }
  }

  // ── Collection-level nav node (design §9/§12.1) ─────────────────────────────
  // Regenerated whenever anything was indexed this run (incremental contract:
  // file change → file branch + collection roll-up). Non-fatal on failure.
  if (process.env.SKELETON_CHUNKING === '1' && process.env.SKELETON_NAV !== '0' && indexed > 0) {
    try {
      const fileNavs = await scroll(COLLECTION, {
        must: [
          { key: 'point_kind', match: { value: 'skeleton_nav' } },
          { key: 'node_type',  match: { value: 'file' } },
        ],
      }, 1000, ['source_file', 'summary']);
      const fileNodes = fileNavs
        .map(p => ({ source_file: p.payload?.source_file ?? '', summary: p.payload?.summary ?? '' }))
        .filter(f => f.source_file)
        .sort((a, b) => a.source_file.localeCompare(b.source_file));

      const { directoryNodes, topChildren } = buildDirectoryNavPoints(COLLECTION, fileNodes);

      await deleteByFilter(COLLECTION, {
        must: [
          { key: 'point_kind', match: { value: 'skeleton_nav' } },
          { key: 'node_type',  match: { value: 'directory' } },
        ],
      });

      if (directoryNodes.length > 0) {
        const dirTexts = directoryNodes.map(n => n.summary);
        const dirEmbeds = shouldUseOnnxBatching(process.env)
          ? await embedForIndexBatch(COLLECTION, dirTexts, runBatched, BATCH_SIZE)
          : await runBatched(dirTexts, BATCH_SIZE, text => embedForIndex(COLLECTION, text));
        const cfgVectorSize = loadConfig().collections?.[COLLECTION]?.vectorSize ?? VECTOR_SIZE;
        const dirPoints = directoryNodes.map((node, i) => ({
          id: makeSkeletonPointId({
            collection: COLLECTION,
            nodeId: node.node_id,
            embeddingSchemaVersion: SCHEMA_VERSION,
          }),
          vector: { dense: dirEmbeds[i].dense, sparse: dirEmbeds[i].sparse },
          payload: buildNavPointPayload(node, {
            fileHash: null,
            vectorSize: cfgVectorSize,
            tokenCountMode: resolveTokenCountMode(),
            chunkingSchemaVersion: CHUNKING_SCHEMA_VERSION,
            embedMeta: dirEmbeds[i].meta,
          }),
        }));
        await upsertPoints(COLLECTION, dirPoints);
      }

      const { summary, children } = await buildCollectionSummary(COLLECTION, fileNodes, {
        llm: process.env.SKELETON_SUMMARY === 'llm',
        numCtx: runNumCtx ?? undefined,
      });

      const collectionNodeId = makeNodeId({
        collection: '', sourceFile: '', structuralPath: '',
        nodeType: 'collection', ordinalWithinParent: 1,
      });
      const { dense, sparse, meta } = await embedForIndex(COLLECTION, summary);
      const cfgVectorSize = loadConfig().collections?.[COLLECTION]?.vectorSize ?? VECTOR_SIZE;
      await upsertPoints(COLLECTION, [{
        id: makeSkeletonPointId({
          collection: COLLECTION, nodeId: collectionNodeId,
          embeddingSchemaVersion: SCHEMA_VERSION,
        }),
        vector: { dense, sparse },
        payload: buildNavPointPayload({
          point_kind: 'skeleton_nav', node_type: 'collection',
          node_id: collectionNodeId, node_path: `${COLLECTION}#collection`,
          source_file: '', heading_path: [], summary,
          children: topChildren.length ? topChildren : children,
        }, {
          fileHash: null, vectorSize: cfgVectorSize,
          tokenCountMode: resolveTokenCountMode(),
          chunkingSchemaVersion: CHUNKING_SCHEMA_VERSION,
          embedMeta: meta,
        }),
      }]);
      console.log(`\nCollection nav node updated (${fileNodes.length} file summaries, ${directoryNodes.length} directory summaries).`);
    } catch (err) {
      console.warn(`\nWARN: collection nav node update failed — ${err.message}`);
    }
  }

  console.log(`\nDone. ${files.length} file(s): ${indexed} indexed, ${skipped} skipped.`);
}

// Run only when executed directly, not when imported for testing.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
    .catch(err => { console.error(err); process.exit(1); })
    .finally(() => shutdownOnnxTagWorker());
}
