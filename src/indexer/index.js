import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, rmSync, createReadStream, statSync, readdirSync } from 'fs';
import { resolve, relative, basename, dirname, join, extname, isAbsolute } from 'path';
import { randomUUID, createHash } from 'crypto';

import { chunkFileFromPath } from './phases/chunk.js';
import { processChunks } from './phases/context.js';
import { addTagsBatch } from './phases/tag.js';
import { buildLinks } from './phases/link.js';
import { runBatched } from './batch.js';
import { upsertPoints, updatePayload, listCollections, createCollection, getStoredMeta, deleteBySourceFile, listSourceFiles } from '../core/qdrant.js';
import { loadGraph, saveGraph, removeFile } from '../core/graph.js';
import { loadConfig, saveConfig, resolveEnvProviders } from '../core/config.js';
import { embedForIndex, getEmbeddingConfig, SCHEMA_VERSION } from '../core/embeddings.js';

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

  console.log('  [1/5] chunking...');
  const rawChunks = await chunkFileFromPath(filePath, sourceFile);
  console.log(`        ${rawChunks.length} chunks`);

  console.log('  [2/5] contextualizing...');
  const contextChunks = await processChunks(rawChunks);
  console.log(`        ${contextChunks.length} chunks after merge`);

  console.log('  [3/5] tagging...');
  const taggedChunks = [];
  for (let i = 0; i < contextChunks.length; i += BATCH_SIZE) {
    taggedChunks.push(...await addTagsBatch(contextChunks.slice(i, i + BATCH_SIZE)));
  }

  console.log('  [4/5] embedding + upserting...');
  const points = await runBatched(taggedChunks, BATCH_SIZE, async (chunk) => {
    const embedText = `${chunk.context}\n\n${chunk.text}`;
    const { dense, sparse, meta } = await embedForIndex(collection, embedText);
    return {
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
    };
  });
  await upsertPoints(collection, points);
  console.log(`        upserted ${points.length} points`);

  console.log('  [5/5] linking...');
  const linkedChunks = await runBatched(taggedChunks, BATCH_SIZE, chunk => buildLinks(chunk, allCollections, graph, collection));

  await Promise.all(linkedChunks.map((chunk, i) => {
    const newLinks = chunk.links ?? [];
    const oldLinks = points[i].payload.links ?? [];
    const changed = newLinks.length !== oldLinks.length || newLinks.some(l => !oldLinks.includes(l));
    if (!changed) return Promise.resolve();
    return updatePayload(collection, points[i].id, { links: newLinks });
  }));

  saveChunksMd(filePath, linkedChunks);
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

const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt', '.docx', '.odt', '.rtf', '.epub', '.html', '.htm', '.pdf']);

function collectFiles(targetPath) {
  const stat = statSync(targetPath);
  if (stat.isFile()) return SUPPORTED_EXTENSIONS.has(extname(targetPath).toLowerCase()) ? [targetPath] : [];
  const files = [];
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(targetPath, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(full));
    else if (SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(full);
  }
  return files;
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

  const graph = loadGraph(COLLECTION);
  for (const filePath of files) {
    const status = await indexFile(filePath, rootPath, COLLECTION, allCollections, graph);
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
