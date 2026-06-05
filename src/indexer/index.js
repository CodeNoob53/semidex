import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, rmSync, createReadStream, statSync, readdirSync } from 'fs';
import { resolve, relative, basename, dirname, join, extname, isAbsolute } from 'path';
import { pathToFileURL } from 'url';
import { createHash } from 'crypto';

import { chunkFileFromPath } from './phases/chunk.js';
import { addContext, mergeChunks } from './phases/context.js';
import { addTagsBatch, shouldGenerateTags } from './phases/tag.js';
import { addTagsOnnxBatch, isOnnxTagProvider, shutdownOnnxTagWorker } from './phases/tag-onnx.js';
import { isEmptySectionChunk } from './phases/empty-section.js';
import { addContextAndTags } from './phases/combined.js';
import { resolveCombinedLlmConfig } from '../core/doctor-checks.js';
import { buildLinks } from './phases/link.js';
import { runBatched } from './batch.js';
import { collectFiles, SUPPORTED_EXTENSIONS } from './files.js';
import { Profiler } from './profiler.js';
import { upsertPoints, updatePayload, listCollections, createCollection, getCollectionInfo, getStoredMeta, deleteBySourceFile, deleteTrailingChunks, listSourceFiles } from '../core/qdrant.js';
import { makePointId } from '../core/point-id.js';
import { loadGraph, saveGraph, removeFile } from '../core/graph.js';
import { loadConfig, saveConfig, resolveEnvProviders } from '../core/config.js';
import { embedForIndex, embedForIndexBatch, shouldUseOnnxBatching, getEmbeddingConfig, SCHEMA_VERSION } from '../core/embeddings.js';
import { ensureOllamaPreflight } from './preflight.js';
import { CHUNKING_SCHEMA_VERSION, getTokenCounter, resolveTokenCountMode } from '../core/token-count.js';
import { Semaphore } from './semaphore.js';
import { SerialQueue } from './serial-queue.js';

const BATCH_SIZE   = parseInt(process.env.LLM_BATCH_SIZE || '3');
const CHUNKS_OUT_DIR = process.env.CHUNKS_OUT_DIR || './chunks_out';
const COLLECTION   = process.env.COLLECTION;
const VECTOR_SIZE  = parseInt(process.env.VECTOR_SIZE || '1024');
const SOURCE_ROOT  = process.env.SOURCE_ROOT ? resolve(process.env.SOURCE_ROOT) : null;

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(filePath).on('data', d => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

// ── Stage A: read-only preflight / hash / chunk / merge ──────────────────────
// Non-destructive: no Qdrant deletes, no graph mutations.
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

  if (
    !process.env.FORCE_REINDEX &&
    storedHash === fileHash &&
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
    : (process.env.TAG_MODEL || 'gemma3:4b');
  await ensureOllamaPreflight(ollamaUrl, contextModel, tagModel);
  // Load/download tokenizer before any destructive work — a failure here leaves old points intact.
  if (tokenCountMode === 'bge-m3') await getTokenCounter({ mode: 'bge-m3' });

  // Compute whether a pre-delete is needed, but do NOT execute it yet.
  // Qdrant delete happens in stageC (after embed succeeds); graph removeFile in stageD.
  const needsDelete = Boolean(storedHash && !process.env.SKIP_PRE_DELETE);
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
    deleteReason = reasons.length ? reasons.join(', ') : 'content changed';
    console.log(`  ~ ${deleteReason}, reindexing...`);
  }
  profiler.mark('pre');

  console.log('  [1/5] chunking...');
  const rawChunks = await chunkFileFromPath(filePath, sourceFile);
  console.log(`        ${rawChunks.length} chunks`);
  profiler.mark('chunk');

  return {
    status: 'ready',
    filePath, sourceFile, collection, fileHash,
    embedCfg, tokenCountMode, configVectorSize,
    needsDelete, deleteReason,
    rawChunks, combinedCfg: resolveCombinedLlmConfig(process.env),
    profiler,
  };
}

// ── Stage B: context + tag generation (Ollama GPU) ───────────────────────────
// In default mode: guarded by ollamaSem in pipeline mode (caller wraps with sem.run).
// In TAG_PROVIDER=onnx mode: caller passes ollamaSem so context alone acquires it
// while ONNX tags run outside — both start after merge, freeing the semaphore sooner.
async function stageB(prepared, ollamaSem = null) {
  const { rawChunks, combinedCfg, profiler } = prepared;

  if (combinedCfg.warning) console.warn(`  [combined] ${combinedCfg.warning}`);
  const genTags   = shouldGenerateTags(process.env);
  const tagViaOnnx = isOnnxTagProvider(process.env);

  let taggedChunks;
  if (combinedCfg.enabled) {
    // COMBINED_LLM=1 owns both context and tags in one call; TAG_PROVIDER=onnx is ignored.
    if (tagViaOnnx) {
      console.warn('  [tag-onnx] TAG_PROVIDER=onnx is ignored when COMBINED_LLM=1 — combined mode owns context+tags');
    }
    console.log('  [2/5] contextualizing + tagging (combined)...');
    const merged = await mergeChunks(rawChunks);
    console.log(`        ${merged.length} chunks after merge`);
    profiler.mark('context');

    if (genTags) {
      console.log('  [3/5] (combined — no separate tag phase)');
      taggedChunks = await runBatched(merged, BATCH_SIZE, chunk => addContextAndTags(chunk, combinedCfg.model, merged));
    } else {
      // TAG_GEN=0: run combined call for context only, then force tags: [].
      console.log('  [3/5] tagging skipped (TAG_GEN=0) — context only');
      const withContext = await runBatched(merged, BATCH_SIZE, chunk => addContextAndTags(chunk, combinedCfg.model, merged));
      taggedChunks = withContext.map(c => ({ ...c, tags: [] }));
    }
    profiler.mark('tag');
  } else if (tagViaOnnx && genTags) {
    // TAG_PROVIDER=onnx: ONNX tags (CPU worker) run outside ollamaSem; only context
    // acquires the semaphore. Both start after merge so GPU and CPU lanes overlap.
    // ollamaSem is null in non-pipeline mode — context runs ungated as before.
    console.log('  [2/5] contextualizing...');
    const merged = await mergeChunks(rawChunks);
    console.log(`        ${merged.length} chunks after merge  [3/5] tagging (onnx, parallel)`);

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
    const merged = await mergeChunks(rawChunks);
    const contextChunks = await runBatched(merged, BATCH_SIZE, addContext);
    console.log(`        ${merged.length} chunks after merge`);
    profiler.mark('context');

    if (genTags) {
      console.log('  [3/5] tagging...');
      const tagged = [];
      for (let i = 0; i < contextChunks.length; i += BATCH_SIZE) {
        tagged.push(...await addTagsBatch(contextChunks.slice(i, i + BATCH_SIZE)));
      }
      taggedChunks = tagged;
    } else {
      console.log('  [3/5] tagging skipped (TAG_GEN=0)');
      taggedChunks = contextChunks.map(c => ({ ...c, tags: [] }));
    }
    profiler.mark('tag');
  }

  // Defensive guard: empty-section chunks must not reach Qdrant.
  const emptySectionChunks = taggedChunks.filter(isEmptySectionChunk);
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
// serialised commit+link phase of a previous file.
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
        id: makePointId({
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
          backlinks: [],
          chunk_index: chunk.chunkIndex,
          total_chunks: chunk.totalChunks,
          file_hash: fileHash,
          vector_size: configVectorSize,
          chunking_schema_version: CHUNKING_SCHEMA_VERSION,
          token_count_mode: tokenCountMode,
          ...meta,
        },
      },
    };
  });

  profiler.mark('embed+upsert'); // mark covers embed; Qdrant write happens in stageD

  return { ...withTagged, pointsWithDense };
}

// ── Stage D: commit + link (always serial via SerialQueue) ────────────────────
// All Qdrant mutations and graph mutations are here, serialised.
// Order: removeFile → deleteBySourceFile → upsertPoints → deleteTrailingChunks
//        → buildLinks → updatePayload (backlinks)
// This prevents Stage C of file B from racing with buildLinks/updatePayload of file A.
async function stageD(withPoints, allCollections, graph) {
  const { filePath, taggedChunks, pointsWithDense, collection, rawChunks,
          sourceFile, needsDelete, profiler } = withPoints;

  // ── Qdrant commit ──
  console.log('  [4/5] upserting...');

  // Graph: remove stale entry before buildLinks sees the graph.
  if (needsDelete) {
    removeFile(graph, sourceFile);
  }

  // Qdrant: delete old points only when we have validated replacements ready.
  if (needsDelete) {
    await deleteBySourceFile(collection, sourceFile);
  }

  const points = pointsWithDense.map(({ point }) => point);
  await upsertPoints(collection, points);
  console.log(`        upserted ${points.length} points`);

  await deleteTrailingChunks(collection, sourceFile, taggedChunks.length);

  // ── Link phase ──
  console.log('  [5/5] linking...');
  // zip outside runBatched — taggedChunks[i] and pointsWithDense[i] share the same global index.
  const chunksWithDense = taggedChunks.map((chunk, i) => ({ chunk, dense: pointsWithDense[i].dense }));
  const linkedChunks = await runBatched(chunksWithDense, BATCH_SIZE, ({ chunk, dense }) =>
    buildLinks(chunk, allCollections, graph, collection, dense));

  await Promise.all(linkedChunks.map((chunk, i) => {
    const newLinks = chunk.links ?? [];
    const oldLinks = points[i].payload.links ?? [];
    const changed = newLinks.length !== oldLinks.length || newLinks.some(l => !oldLinks.includes(l));
    if (!changed) return Promise.resolve();
    return updatePayload(collection, points[i].id, { links: newLinks });
  }));
  profiler.mark('link');

  saveChunksMd(filePath, linkedChunks);
  profiler.mark('chunks_out');

  const tokensEst = taggedChunks.reduce((s, c) => s + Math.ceil(c.text.length / 4), 0);
  profiler.report({ chunksIn: rawChunks.length, chunksOut: taggedChunks.length, tokensEst });

  console.log(`  ✓ done`);
}

// ── Sequential indexFile (default, PIPELINE_MODE unset) ───────────────────────
async function indexFile(filePath, rootPath, collection, allCollections, graph) {
  console.log(`\n→ ${filePath}`);
  const profiler = new Profiler();

  const preparedA = await stageA(filePath, rootPath, collection, profiler);
  if (preparedA.status === 'skipped') return 'skipped';

  const preparedB = await stageB(preparedA);
  const preparedC = await stageC(preparedB);
  await stageD(preparedC, allCollections, graph);
}

function saveChunksMd(filePath, chunks) {
  const outDir = join(CHUNKS_OUT_DIR, basename(dirname(filePath)));
  mkdirSync(outDir, { recursive: true });
  const base = basename(filePath, extname(filePath));
  for (const entry of readdirSync(outDir)) {
    if (entry.startsWith(`${base}__chunk`) && entry.endsWith('.md')) rmSync(join(outDir, entry));
  }
  chunks.forEach((chunk, i) => {
    writeFileSync(join(outDir, `${base}__chunk${i + 1}.md`), `---
source_file: ${chunk.source_file}
section: ${chunk.section || ''}
chunk: ${i + 1}/${chunks.length}
tags: [${(chunk.tags || []).join(', ')}]
links: [${(chunk.links || []).join(', ')}]
context: "${(chunk.context || '').replace(/"/g, "'")}"
---

${chunk.text}
`, 'utf8');
  });
}

export function computeStaleSourceFiles(indexedSourceFiles, storedSourceFiles) {
  const indexed = new Set(indexedSourceFiles);
  return storedSourceFiles.filter(sf => !indexed.has(sf));
}

// Returns the set of collections eligible as link targets.
// configCollectionsMap: the full config.collections object (name → entry).
// Only Qdrant collections present in configCollectionsMap are eligible, unless
// they carry linkDisabled: true — those are excluded (incompatible/foreign schema).
// The current collection is always included regardless of linkDisabled, because
// intra-collection links must work even when the collection was just created and
// sync has not yet run (linkDisabled would be wrong for a fresh semidex collection).
// If LINK_COLLECTIONS env allowlist is set, it narrows the result and does NOT
// auto-add the current collection (existing semantics).
export function resolveLinkCollections(qdrantCollections, configCollectionsMap, currentCollection, envAllowlist) {
  const configMap = configCollectionsMap ?? {};
  const configKnown = new Set(Object.keys(configMap));
  configKnown.add(currentCollection); // always include current, even if missing from config

  const base = qdrantCollections.filter(c => {
    if (!configKnown.has(c)) return false;
    // Exclude linkDisabled entries, but never exclude the current collection.
    if (c !== currentCollection && configMap[c]?.linkDisabled === true) return false;
    return true;
  });
  // Ensure current collection is present even if not yet in qdrantCollections
  // (e.g. just created and not yet returned by a fresh listCollections call).
  if (!base.includes(currentCollection)) base.push(currentCollection);

  if (!envAllowlist) return base;
  return base.filter(c => envAllowlist.has(c));
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

  // Limit link targets to config-known semidex collections (Stage 1 filter).
  // LINK_COLLECTIONS env allowlist, if set, narrows further (existing semantics).
  const linkCfg = loadConfig();
  const linkEnvAllowlist = process.env.LINK_COLLECTIONS
    ? new Set(process.env.LINK_COLLECTIONS.split(',').map(s => s.trim()))
    : null;
  const linkTargetCollections = resolveLinkCollections(
    allCollections,
    linkCfg.collections ?? {},
    COLLECTION,
    linkEnvAllowlist,
  );

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

  const graph = loadGraph(COLLECTION);

  const pipelineMode = process.env.PIPELINE_MODE === '1';

  if (pipelineMode) {
    const parsedOllama = parseInt(process.env.OLLAMA_STAGE_CONCURRENCY ?? '1', 10);
    const parsedEmbed  = parseInt(process.env.EMBED_STAGE_CONCURRENCY  ?? '1', 10);
    const ollamaConcurrency = (Number.isInteger(parsedOllama) && parsedOllama >= 1) ? parsedOllama : 1;
    const embedConcurrency  = (Number.isInteger(parsedEmbed)  && parsedEmbed  >= 1) ? parsedEmbed  : 1;
    if (parsedOllama !== ollamaConcurrency) console.warn(`[pipeline] invalid OLLAMA_STAGE_CONCURRENCY, using 1`);
    if (parsedEmbed  !== embedConcurrency)  console.warn(`[pipeline] invalid EMBED_STAGE_CONCURRENCY, using 1`);

    console.log(`[pipeline] enabled: ollama=${ollamaConcurrency} embed=${embedConcurrency} link=serial`);

    const ollamaSem = new Semaphore(ollamaConcurrency);
    const embedSem  = new Semaphore(embedConcurrency);
    const linkQueue = new SerialQueue();

    const settlements = await Promise.allSettled(files.map(async filePath => {
      console.log(`\n→ ${filePath}`);
      const profiler = new Profiler();

      const preparedA = await stageA(filePath, rootPath, COLLECTION, profiler);
      if (preparedA.status === 'skipped') return 'skipped';

      // TAG_PROVIDER=onnx: pass ollamaSem into stageB so context acquires it
      // while ONNX tags run outside — the semaphore is held only for the GPU call.
      // Default mode: stageB runs entirely under ollamaSem as before.
      const preparedB = isOnnxTagProvider(process.env)
        ? await stageB(preparedA, ollamaSem)
        : await ollamaSem.run(() => stageB(preparedA));
      const preparedC = await embedSem.run(() => stageC(preparedB));
      await linkQueue.run(() => stageD(preparedC, linkTargetCollections, graph));
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
      const status = await indexFile(filePath, rootPath, COLLECTION, linkTargetCollections, graph);
      if (status === 'skipped') skipped++; else indexed++;
    }
  }

  saveGraph(graph, COLLECTION);

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
          removeFile(graph, sf);
          console.log(`  - removed: ${sf}`);
        }
        saveGraph(graph, COLLECTION);
      }
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
