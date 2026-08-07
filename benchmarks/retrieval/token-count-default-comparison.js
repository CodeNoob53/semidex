// Offline comparison of production BGE-M3 token-aware chunking vs the legacy
// chars/4 heuristic. Uses public repository fixtures only; does not touch Qdrant.

import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { chunkFileFromPath } from '../../src/shared/indexer/phases/chunk.js';
import { getTokenCounter } from '../../src/shared/core/token-count.js';

const realCount = await getTokenCounter({ mode: 'bge-m3', localFilesOnly: true });

function markdownFiles(root) {
  const files = [];
  for (const name of readdirSync(root)) {
    const filePath = join(root, name);
    if (statSync(filePath).isDirectory()) files.push(...markdownFiles(filePath));
    else if (name.toLowerCase().endsWith('.md')) files.push(filePath);
  }
  return files.sort();
}

async function measure(label, files, mode) {
  if (mode === null) delete process.env.TOKEN_COUNT;
  else process.env.TOKEN_COUNT = mode;
  const started = performance.now();
  const chunks = [];
  for (const file of files) chunks.push(...await chunkFileFromPath(file));
  const elapsedMs = performance.now() - started;
  const sizes = [];
  for (const chunk of chunks) sizes.push(await realCount(chunk.text));

  return {
    label,
    mode: mode ?? '(default:bge-m3)',
    files: files.length,
    chunks: chunks.length,
    elapsedMs: Math.round(elapsedMs),
    avgRealTokens: Number(
      (sizes.reduce((sum, count) => sum + count, 0) / Math.max(1, sizes.length)).toFixed(1)
    ),
    maxRealTokens: Math.max(0, ...sizes),
    over400: sizes.filter(count => count > 400).length,
    over512: sizes.filter(count => count > 512).length,
  };
}

const corpora = [
  ['ua-synthetic', ['benchmarks/retrieval/fixtures/ua-prose-synthetic.md']],
  ['docs-en', markdownFiles('docs/en')],
];

for (const [label, files] of corpora) {
  const bgeM3Default = await measure(label, files, null);
  const heuristic = await measure(label, files, 'heuristic');
  console.log(JSON.stringify({
    corpus: label,
    heuristic,
    bgeM3Default,
    deltaChunks: bgeM3Default.chunks - heuristic.chunks,
  }, null, 2));
}
