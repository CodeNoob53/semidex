// Audit composition: unchanged production indexer/search, explicit current capabilities.
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { createStorageAdapter } from '../../../../src/core/storage/factory.js';
import { runHybridSearch } from '../../../../src/core/retrieval/search.js';
import { embedForSearch } from '../../../../src/shared/core/embeddings.js';
import { createOnnxEmbeddingCapability } from '../../../../src/local/core/onnx-embed.js';
import { createCloudEmbeddingCapability } from '../../../../src/cloud/embedding/cloud-embedding-provider.js';
import { runSuiteAcrossProfiles } from '../../../external/production-path/core/run-suite.mjs';
import { runIndexer } from '../../../external/production-path/core/index-via-cli.mjs';
import { CHUNK_CANDIDATE_LIMIT } from '../../../external/production-path/core/query-via-search.mjs';
import { fetchAndValidateScifact } from '../../../external/beir/fetch-scifact.mjs';
import { buildAndCachePilotSubset } from '../../../external/production-path/core/pilot-subset.mjs';
import { buildStructuralFixtureCorpus, buildStructuralFixtureQueriesMap, buildStructuralFixtureQrels } from '../../../external/production-path/fixtures/structural-fixture.mjs';
import { pairedBootstrapByQuery, perQueryMetrics } from '../../../external/miracl/bootstrap.mjs';
const outDir = new URL('./', import.meta.url);
const onnxEmbed = createOnnxEmbeddingCapability();
const cloudEmbed = createCloudEmbeddingCapability();
const adapter = createStorageAdapter();
const embedQuery = (profile, text) => embedForSearch(profile, text, { capabilities: { onnxEmbed } });
async function queryOne({ adapter, collection, query }) {
  const start = performance.now();
  const result = await runHybridSearch({ adapter, collection, query, top: CHUNK_CANDIDATE_LIMIT, embedQuery, cloudEmbed });
  return { ok: !result.error, hits: result.hits ?? [], ms: performance.now() - start, error: result.error ? { error: result.error, message: result.message } : null };
}
try {
  for (const name of ['structural', 'scifact-pilot']) {
    const dataset = name === 'structural'
      ? { corpus: buildStructuralFixtureCorpus(), queries: buildStructuralFixtureQueriesMap(), qrels: buildStructuralFixtureQrels(), fingerprint: 'structural-fixture-v1' }
      : buildAndCachePilotSubset(await fetchAndValidateScifact({ log: console.log }));
    const result = await runSuiteAcrossProfiles({
      suiteId: `audit-20260906-${name}`, datasetFingerprint: dataset.fingerprint,
      ...dataset, toMarkdown: doc => name === 'structural' ? doc.text : `# ${doc.title}\n\n${doc.text}`,
      restart: true, adapter, runIndexer, queryOne, log: console.log,
    });
    const { state, rankedRunsByProfile } = result;
    if (rankedRunsByProfile.local && rankedRunsByProfile.cloud) {
      const a = perQueryMetrics(dataset.qrels, rankedRunsByProfile.local);
      const b = perQueryMetrics(dataset.qrels, rankedRunsByProfile.cloud);
      state.bootstrapComparison = Object.fromEntries(['ndcgAt10', 'recallAt10', 'mrrAt10'].map(k => [k, pairedBootstrapByQuery(a, b, k)]));
    }
    writeFileSync(new URL(`${name}-explicit.json`, outDir), JSON.stringify(state, null, 2));
    console.log(`${name}: ${state.verdict}`);
    if (state.verdict !== 'COMPLETE') process.exitCode = 1;
  }
} finally { await onnxEmbed.shutdown(); }
