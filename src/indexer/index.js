import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, rmSync, createReadStream, statSync, readdirSync } from 'fs';
import { resolve, relative, basename, dirname, join, extname, isAbsolute } from 'path';
import { randomUUID, createHash } from 'crypto';

import { chunkFileFromPath } from './phases/chunk.js';
import { processChunks, mergeChunks } from './phases/context.js';
import { addTagsBatch, shouldGenerateTags } from './phases/tag.js';
import { addContextAndTags } from './phases/combined.js';
import { resolveCombinedLlmConfig } from '../core/doctor-checks.js';
import { buildLinks } from './phases/link.js';
import { runBatched } from './batch.js';
import { collectFiles, SUPPORTED_EXTENSIONS } from './files.js';
import { Profiler } from './profiler.js';
import { upsertPoints, updatePayload, listCollections, createCollection, getCollectionInfo, getStoredMeta, deleteBySourceFile, listSourceFiles } from '../core/qdrant.js';
import { loadGraph, saveGraph, removeFile } from '../core/graph.js';
import { loadConfig, saveConfig, resolveEnvProviders } from '../core/config.js';
import { embedForIndex, embedForIndexBatch, shouldUseOnnxBatching, getEmbeddingConfig, SCHEMA_VERSION } from '../core/embeddings.js';
import { ensureOllamaPreflight } from './preflight.js';

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

async function indexFile(filePath, rootPath, collection, allCollections, graph) {
  console.log(`\n→ ${filePath}`);

  const profiler = new Profiler();

  const effectiveRoot = SOURCE_ROOT ?? rootPath;
  const sourceFile = relative(effectiveRoot, filePath).replace(/\\/g, '/');
  if (SOURCE_ROOT && (sourceFile.startsWith('../') || sourceFile === '..' || isAbsolute(sourceFile))) {
    throw new Error(`File "${filePath}" is outside SOURCE_ROOT "${SOURCE_ROOT}". Fix SOURCE_ROOT or remove it.`);
  }

  const embedCfg       = getEmbeddingConfig(collection);
  const configVectorSize = loadConfig().collections?.[collection]?.vectorSize ?? VECTOR_SIZE;

  const fileHash   = await hashFile(filePath);
  const storedMeta = await getStoredMeta(collection, sourceFile);
  const storedHash = storedMeta?.hash ?? null;

  if (
    storedHash === fileHash &&
    storedMeta?.denseProvider          === embedCfg.denseProvider &&
    storedMeta?.denseModel             === embedCfg.denseModel &&
    storedMeta?.sparseProvider         === embedCfg.sparseProvider &&
    storedMeta?.embeddingSchemaVersion === embedCfg.schemaVersion &&
    (storedMeta?.vectorSize ?? configVectorSize) === configVectorSize
  ) {
    console.log('  ✓ unchanged, skipping');
    return 'skipped';
  }

  // Preflight runs once per process, on the first file that actually needs indexing.
  // Skipped files and PRUNE_STALE-only runs never trigger it.
  const ollamaUrl    = process.env.OLLAMA_URL    || 'http://localhost:11434';
  const contextModel = process.env.CONTEXT_MODEL || 'gemma3:4b';
  const combinedCfg  = resolveCombinedLlmConfig(process.env);
  // COMBINED_LLM=1 uses CONTEXT_MODEL for both context and tags; TAG_MODEL is ignored.
  // TAG_GEN=0 skips tag generation entirely; no need to check TAG_MODEL reachability.
  // Only check TAG_MODEL when actually using the separate tag path.
  const genTagsPreflight = shouldGenerateTags(process.env);
  const tagModel = (combinedCfg.enabled || !genTagsPreflight) ? contextModel : (process.env.TAG_MODEL || 'gemma3:4b');
  await ensureOllamaPreflight(ollamaUrl, contextModel, tagModel);
  if (storedHash) {
    const reasons = [];
    if (storedMeta?.denseProvider          !== embedCfg.denseProvider)  reasons.push(`denseProvider: ${storedMeta?.denseProvider} → ${embedCfg.denseProvider}`);
    if (storedMeta?.denseModel             !== embedCfg.denseModel)     reasons.push(`denseModel: ${storedMeta?.denseModel} → ${embedCfg.denseModel}`);
    if (storedMeta?.sparseProvider         !== embedCfg.sparseProvider) reasons.push(`sparseProvider: ${storedMeta?.sparseProvider} → ${embedCfg.sparseProvider}`);
    if (storedMeta?.embeddingSchemaVersion !== embedCfg.schemaVersion)  reasons.push(`schemaVersion: ${storedMeta?.embeddingSchemaVersion} → ${embedCfg.schemaVersion}`);
    if ((storedMeta?.vectorSize ?? configVectorSize) !== configVectorSize) reasons.push(`vectorSize: ${storedMeta?.vectorSize} → ${configVectorSize}`);
    const reason = reasons.length ? reasons.join(', ') : 'content changed';
    console.log(`  ~ ${reason}, reindexing...`);
    await deleteBySourceFile(collection, sourceFile);
    removeFile(graph, sourceFile);
  }
  profiler.mark('pre');

  console.log('  [1/5] chunking...');
  const rawChunks = await chunkFileFromPath(filePath, sourceFile);
  console.log(`        ${rawChunks.length} chunks`);
  profiler.mark('chunk');

  if (combinedCfg.warning) console.warn(`  [combined] ${combinedCfg.warning}`);

  const genTags = shouldGenerateTags(process.env);

  let taggedChunks;
  if (combinedCfg.enabled) {
    console.log('  [2/5] contextualizing + tagging (combined)...');
    const merged = await mergeChunks(rawChunks);
    console.log(`        ${merged.length} chunks after merge`);
    profiler.mark('context');

    if (genTags) {
      console.log('  [3/5] (combined — no separate tag phase)');
      taggedChunks = await runBatched(merged, BATCH_SIZE, chunk => addContextAndTags(chunk, combinedCfg.model, merged));
    } else {
      // TAG_GEN=0: run combined call for context only, then force tags: [].
      // addContextAndTags still generates tags internally but we discard them here
      // rather than splitting the prompt, which would be a riskier change.
      console.log('  [3/5] tagging skipped (TAG_GEN=0) — context only');
      const withContext = await runBatched(merged, BATCH_SIZE, chunk => addContextAndTags(chunk, combinedCfg.model, merged));
      taggedChunks = withContext.map(c => ({ ...c, tags: [] }));
    }
    profiler.mark('tag');
  } else {
    console.log('  [2/5] contextualizing...');
    const contextChunks = await processChunks(rawChunks);
    console.log(`        ${contextChunks.length} chunks after merge`);
    profiler.mark('context');

    if (genTags) {
      console.log('  [3/5] tagging...');
      taggedChunks = [];
      for (let i = 0; i < contextChunks.length; i += BATCH_SIZE) {
        taggedChunks.push(...await addTagsBatch(contextChunks.slice(i, i + BATCH_SIZE)));
      }
    } else {
      console.log('  [3/5] tagging skipped (TAG_GEN=0)');
      taggedChunks = contextChunks.map(c => ({ ...c, tags: [] }));
    }
    profiler.mark('tag');
  }

  console.log('  [4/5] embedding + upserting...');
  // BENCH_EMBED_INPUT=text — benchmark/ablation only, not a stable config option.
  // Default (unset): context+text. Do not rely on this in production.
  const embedTexts = process.env.BENCH_EMBED_INPUT === 'text'
    ? taggedChunks.map(chunk => chunk.text)
    : taggedChunks.map(chunk => `${chunk.context}\n\n${chunk.text}`);

  // Attempt DML-bucketed batch embed; fall back to per-text path on any failure.
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

  // Correctness guards — catch misalignment before any upsert.
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
        id: randomUUID(),
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
          ...meta,
        },
      },
    };
  });
  const points = pointsWithDense.map(({ point }) => point);
  await upsertPoints(collection, points);
  console.log(`        upserted ${points.length} points`);
  profiler.mark('embed+upsert');

  console.log('  [5/5] linking...');
  // zip outside runBatched — taggedChunks[i] and pointsWithDense[i] share the same global index.
  // never do (chunk, i) => ... inside the runBatched callback: i is batch-local and resets to 0.
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
  for (const filePath of files) {
    const status = await indexFile(filePath, rootPath, COLLECTION, linkTargetCollections, graph);
    if (status === 'skipped') skipped++; else indexed++;
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
if (process.argv[1] && (process.argv[1].endsWith('index.js') || process.argv[1].endsWith('index'))) {
  main().catch(err => { console.error(err); process.exit(1); });
}
