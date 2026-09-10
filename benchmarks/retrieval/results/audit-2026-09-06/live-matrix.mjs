// Read-only audit on an EXISTING custom-50 collection. No indexing or schema changes.
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createStorageAdapter } from '../../../../src/core/storage/factory.js';
import { runHybridSearch } from '../../../../src/core/retrieval/search.js';
import { embedForSearch } from '../../../../src/shared/core/embeddings.js';
import { createOnnxEmbeddingCapability } from '../../../../src/local/core/onnx-embed.js';
import { getQdrantClient } from '../../../../src/core/qdrant/client.js';
import { withNavExcluded } from '../../../../src/core/qdrant/nav-filter.js';
const dir = new URL('./', import.meta.url);
const collection = 'bench-retrieval-custom-50';
const queryBytes = readFileSync(new URL('../../custom-50/queries.json', import.meta.url));
const queries = JSON.parse(queryBytes).queries;
const adapter = createStorageAdapter();
const onnxEmbed = createOnnxEmbeddingCapability();
const client = getQdrantClient();
const modes = [
  { id: 'prod-top3', top: 3, k: 60, mult: 2 },
  { id: 'prod-top5', top: 5, k: 60, mult: 2 },
  { id: 'prod-top10', top: 10, k: 60, mult: 2 },
  { id: 'prod-top50', top: 50, k: 60, mult: 2 },
  { id: 'rrf-k2-top10', top: 10, k: 2, mult: 2 },
  { id: 'dense-top10', lane: 'dense', top: 10 },
  { id: 'sparse-top10', lane: 'sparse', top: 10 },
];
const report = { date: new Date().toISOString(), scope: 'read-only existing custom-50, legacy corpus; not fresh production indexing or held-out evaluation', collection, querySha256: createHash('sha256').update(queryBytes).digest('hex'), modes, rows: [] };
const snapshot = [];
try {
  report.collectionInfo = await client.getCollection(collection);
  let offset;
  do {
    const page = await client.scroll(collection, { limit: 200, with_payload: true, with_vector: false, ...(offset ? { offset } : {}) });
    snapshot.push(...page.points); offset = page.next_page_offset;
  } while (offset);
  writeFileSync(new URL('custom50-payload-snapshot.json', dir), JSON.stringify(snapshot, null, 2));
  report.payloadSha256 = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const priorPath = new URL('live-matrix.json', dir);
  if (existsSync(priorPath)) {
    const prior = JSON.parse(readFileSync(priorPath));
    if (prior.querySha256 !== report.querySha256 || prior.payloadSha256 !== report.payloadSha256) throw new Error('Cannot resume changed corpus/queries');
    report.rows = prior.rows;
    report.resumeNote = 'Resumed completed query rows after transient Windows file-write error; first embedding of each process is cold.';
  }
  const ids = new Set(snapshot.map(p => `${p.payload.source_file}#${p.payload.chunk_index}`));
  const missing = queries.flatMap(q => (q.relevantChunks ?? []).filter(r => !ids.has(r.chunkId)).map(r => `${q.id}:${r.chunkId}`));
  if (missing.length) throw new Error(`Invalid qrels: ${missing.join(',')}`);
  report.qrelIdValidation = 'all present; semantic validity still requires review';
  const resolution = await adapter.getEmbeddingProfile(collection);
  if (resolution.state !== 'valid') throw new Error(`profile: ${resolution.state}`);
  report.profile = resolution.profile;
  // Explicitly scoped CPU benchmark; no managed runtime/settings mutation.
  process.env.ONNX_EXECUTION_PROVIDER = 'cpu';
  for (const q of queries) {
    if (report.rows.some(r => r.id === q.id)) continue;
    const embedStart = performance.now();
    const vectors = await embedForSearch(resolution.profile, q.query, { capabilities: { onnxEmbed } });
    const embeddingMs = performance.now() - embedStart;
    const row = { id: q.id, type: q.type, query: q.query, expectedTokens: q.expectedTokens, relevantChunks: q.relevantChunks, negative: q.shouldHaveNoStrongHit === true || q.type === 'negative', embeddingMs, runs: {} };
    for (const mode of modes) {
      const t = performance.now();
      let hits;
      if (mode.lane) {
        const result = await client.query(collection, { query: vectors[mode.lane], using: mode.lane, filter: withNavExcluded(null), limit: mode.top, with_payload: true });
        hits = result.points.map(p => ({ id: p.id, sourceFile: p.payload.source_file, chunkIndex: p.payload.chunk_index, text: p.payload.text, section: p.payload.section, score: p.score }));
      } else {
        const settingsService = { getActiveValue: key => ({ RRF_K: mode.k, HYBRID_PREFETCH_LIMIT: mode.mult })[key] };
        const result = await runHybridSearch({ adapter, collection, query: q.query, top: mode.top, embedQuery: async () => vectors, settingsService });
        if (result.error) throw new Error(`${mode.id}: ${result.message}`);
        hits = result.hits;
      }
      row.runs[mode.id] = { retrievalMs: performance.now() - t, hits: hits.map(h => ({ id: h.id, chunkId: `${h.sourceFile}#${h.chunkIndex}`, score: h.score, section: h.section, text: h.text })) };
    }
    report.rows.push(row);
    console.log(`${q.id} ${report.rows.length}/${queries.length} embed=${embeddingMs.toFixed(0)}ms`);
  }
  report.complete = true;
} catch (err) { report.error = err.message; process.exitCode = 1; }
finally { await onnxEmbed.shutdown(); writeFileSync(new URL('live-matrix.json', dir), JSON.stringify(report, null, 2)); }
