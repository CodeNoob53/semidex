import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, rmSync, createReadStream, statSync, readdirSync } from 'fs';
import { resolve, relative, basename, dirname, join, extname, isAbsolute } from 'path';
import { randomUUID, createHash } from 'crypto';

import { chunkFileFromPath } from './phases/chunk.js';
import { processChunks } from './phases/context.js';
import { addTagsBatch } from './phases/tag.js';
import { buildLinks } from './phases/link.js';
import { embed } from './lib/ollama.js';
import { upsertPoints, updatePayload, listCollections, createCollection, getStoredHash, deleteBySourceFile } from './lib/qdrant.js';
import { runBatched } from './lib/batch.js';
import { loadGraph, saveGraph, removeFile } from './lib/graph.js';

const BATCH_SIZE = parseInt(process.env.LLM_BATCH_SIZE || '3');

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(filePath).on('data', d => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

const EMBED_MODEL = process.env.EMBED_MODEL || 'bge-m3';
const CHUNKS_OUT_DIR = process.env.CHUNKS_OUT_DIR || './chunks_out';
const COLLECTION = process.env.COLLECTION;
const VECTOR_SIZE = parseInt(process.env.VECTOR_SIZE || '1024');
// SOURCE_ROOT pins the root for relative source_file paths — set this to keep
// source_file stable regardless of what path you pass as the indexing target.
const SOURCE_ROOT = process.env.SOURCE_ROOT ? resolve(process.env.SOURCE_ROOT) : null;

async function indexFile(filePath, rootPath, collection, allCollections, graph) {
  console.log(`\n→ ${filePath}`);

  // source_file: use SOURCE_ROOT env if set, otherwise fall back to rootPath
  const effectiveRoot = SOURCE_ROOT ?? rootPath;
  const sourceFile = relative(effectiveRoot, filePath).replace(/\\/g, '/');
  if (SOURCE_ROOT && (sourceFile.startsWith('../') || sourceFile === '..' || isAbsolute(sourceFile))) {
    throw new Error(`File "${filePath}" is outside SOURCE_ROOT "${SOURCE_ROOT}". Fix SOURCE_ROOT or remove it.`);
  }

  // hash check — skip if file unchanged
  const fileHash = await hashFile(filePath);
  const storedHash = await getStoredHash(collection, sourceFile);
  if (storedHash === fileHash) {
    console.log('  ✓ unchanged, skipping');
    return 'skipped';
  }
  if (storedHash) {
    console.log('  ~ changed, reindexing...');
    await deleteBySourceFile(collection, sourceFile);
    removeFile(graph, sourceFile);
  }

  // phase 1: chunk
  console.log('  [1/4] chunking...');
  const rawChunks = await chunkFileFromPath(filePath, sourceFile);
  console.log(`        ${rawChunks.length} chunks`);

  // phase 2: context + boundary check
  console.log('  [2/4] contextualizing...');
  const contextChunks = await processChunks(rawChunks);
  console.log(`        ${contextChunks.length} chunks after merge`);

  // phase 3: tag (batched — one LLM call per BATCH_SIZE chunks)
  console.log('  [3/4] tagging...');
  const taggedChunks = [];
  for (let i = 0; i < contextChunks.length; i += BATCH_SIZE) {
    const batch = contextChunks.slice(i, i + BATCH_SIZE);
    taggedChunks.push(...await addTagsBatch(batch));
  }

  // phase 4: embed + upsert (parallel)
  console.log('  [4/4] embedding + upserting...');
  const points = await runBatched(taggedChunks, BATCH_SIZE, async (chunk) => {
    const text = `${chunk.context}\n\n${chunk.text}`;
    const vector = await embed(text, EMBED_MODEL);
    return {
      id: randomUUID(),
      vector,
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
      },
    };
  });
  await upsertPoints(collection, points);
  console.log(`        upserted ${points.length} points`);

  // phase 5: build links — graph mutated in place, saved by caller
  console.log('  [5/5] linking...');
  const linkedChunks = await runBatched(taggedChunks, BATCH_SIZE, chunk => buildLinks(chunk, allCollections, graph));

  // persist semantic links back to Qdrant
  await Promise.all(linkedChunks.map((chunk, i) => {
    const newLinks = chunk.links ?? [];
    const oldLinks = points[i].payload.links ?? [];
    const changed = newLinks.length !== oldLinks.length ||
      newLinks.some(l => !oldLinks.includes(l));
    if (!changed) return Promise.resolve();
    return updatePayload(collection, points[i].id, { links: newLinks });
  }));

  // save chunks_out after linking so Obsidian sees semantic links
  saveChunksMd(filePath, linkedChunks);

  console.log(`  ✓ done`);
}

function saveChunksMd(filePath, chunks) {
  const outDir = join(CHUNKS_OUT_DIR, basename(dirname(filePath)));
  mkdirSync(outDir, { recursive: true });
  const base = basename(filePath, extname(filePath));
  // remove stale chunks from previous indexing run (count may have decreased)
  for (const entry of readdirSync(outDir)) {
    if (entry.startsWith(`${base}__chunk`) && entry.endsWith('.md')) {
      rmSync(join(outDir, entry));
    }
  }
  chunks.forEach((chunk, i) => {
    const name = `${base}__chunk${i + 1}.md`;
    const content = `---
source_file: ${chunk.source_file}
section: ${chunk.section || ''}
chunk: ${i + 1}/${chunks.length}
tags: [${(chunk.tags || []).join(', ')}]
links: [${(chunk.links || []).join(', ')}]
context: "${(chunk.context || '').replace(/"/g, "'")}"
---

${chunk.text}
`;
    writeFileSync(join(outDir, name), content, 'utf8');
  });
}

const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt', '.docx']);

function collectFiles(targetPath) {
  const stat = statSync(targetPath);
  if (stat.isFile()) {
    return SUPPORTED_EXTENSIONS.has(extname(targetPath).toLowerCase()) ? [targetPath] : [];
  }
  // directory — recurse
  const files = [];
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue; // skip hidden
    const full = join(targetPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full));
    } else if (SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  const targetPath = process.argv[2];
  if (!targetPath || !COLLECTION) {
    console.error('Usage: COLLECTION=my-collection node src/index.js <file|folder>');
    process.exit(1);
  }

  let allCollections = await listCollections();
  if (!allCollections.includes(COLLECTION)) {
    console.log(`Collection "${COLLECTION}" not found, creating...`);
    await createCollection(COLLECTION, VECTOR_SIZE);
    allCollections = [...allCollections, COLLECTION];
  }

  const absTarget = resolve(targetPath);
  const rootPath = statSync(absTarget).isDirectory() ? absTarget : dirname(absTarget);
  const files = collectFiles(absTarget);
  if (!files.length) {
    console.log('No supported files found.');
    process.exit(0);
  }

  console.log(`Found ${files.length} file(s) to process`);
  let indexed = 0, skipped = 0;

  const graph = loadGraph();
  for (const filePath of files) {
    const status = await indexFile(filePath, rootPath, COLLECTION, allCollections, graph);
    if (status === 'skipped') skipped++; else indexed++;
  }
  saveGraph(graph);

  console.log(`\nDone. ${files.length} file(s): ${indexed} indexed, ${skipped} skipped.`);
}

main().catch(err => { console.error(err); process.exit(1); });
