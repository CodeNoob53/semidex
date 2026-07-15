// Generate or regenerate payload tags for an existing Qdrant collection.
//
// This does not re-embed or reindex documents. It reads existing point payloads,
// generates tags from text/context, then updates only the `tags` payload field.

// bootstrapEnv() must run before any import below could transitively load
// .env via a static 'dotenv/config' import — same reasoning as sync.js.
// This script genuinely consumes TAG_PROVIDER/TAG_MODEL/CONTEXT_MODEL (via
// isOnnxTagProvider/addTagsBatch below), so a real SettingsService is
// constructed and applied, matching indexer/index.js's own
// applyTagSettings() pattern — a backfill run should honor the same
// settings.json-tiered TAG_* values an indexing run would.
const { bootstrapEnv } = await import('./core/env-bootstrap.js');
const { createSettingsService, applyEnvWriteBack } = await import('./core/settings/service.js');
const { osEnv, dotenvValues } = bootstrapEnv();
const settingsService = createSettingsService({ osEnv, dotenvValues });

const { scrollAllPoints, updatePayload } = await import('./core/qdrant.js');
const { addTagsBatch, applyTagSettings } = await import('./indexer/phases/tag.js');
const { addTagsOnnxBatch, isOnnxTagProvider, shutdownOnnxTagWorker } = await import('./indexer/phases/tag-onnx.js');

applyTagSettings(settingsService);
// Writes every writable setting's active value into process.env — TAG_*/
// QDRANT_URL/etc. — so isOnnxTagProvider(process.env) below, tag-onnx.js's
// own resolveWorkerConfig(process.env), and core/qdrant/client.js's
// QDRANT_URL read all observe the resolved value (same shared mechanism
// every other real entry point uses; see core/settings/service.js).
applyEnvWriteBack(settingsService);

const COLLECTION = process.env.COLLECTION;
const FORCE_TAGS = process.env.FORCE_TAGS === '1';
const DRY_RUN = process.env.DRY_RUN === '1';
const BATCH_SIZE = Math.max(1, parseInt(process.env.TAG_BACKFILL_BATCH_SIZE || process.env.LLM_BATCH_SIZE || '3', 10) || 3);

if (!COLLECTION) {
  console.error('Usage: COLLECTION=my-docs npm run backfill:tags');
  console.error('Optional: TAG_PROVIDER=onnx, FORCE_TAGS=1, DRY_RUN=1, TAG_BACKFILL_BATCH_SIZE=3');
  process.exit(1);
}

function needsTags(point) {
  if (FORCE_TAGS) return true;
  const tags = point.payload?.tags;
  return !Array.isArray(tags) || tags.length === 0;
}

function toChunk(point) {
  const p = point.payload ?? {};
  return {
    text: p.text ?? '',
    context: p.context ?? '',
    section: p.section ?? '',
    source_file: p.source_file ?? '',
    chunk_index: p.chunk_index,
    // FORCE_TAGS replaces tags. Default backfill only targets empty/missing tags.
    meta: FORCE_TAGS ? {} : { tags: p.tags ?? [] },
  };
}

async function generateTags(chunks) {
  if (isOnnxTagProvider(process.env)) return addTagsOnnxBatch(chunks);
  return addTagsBatch(chunks);
}

console.log(`[tags] scanning collection "${COLLECTION}"...`);

try {
  const points = await scrollAllPoints(
    COLLECTION,
    ['text', 'context', 'section', 'source_file', 'chunk_index', 'tags'],
    250
  );
  const targets = points.filter(p => p.id && p.payload?.text && needsTags(p));

  console.log(`[tags] points scanned: ${points.length}`);
  console.log(`[tags] points selected: ${targets.length}${FORCE_TAGS ? ' (FORCE_TAGS=1)' : ' (empty/missing tags only)'}`);
  console.log(`[tags] provider: ${isOnnxTagProvider(process.env) ? 'onnx' : 'ollama'}`);

  if (DRY_RUN) {
    console.log('[tags] DRY_RUN=1, no payload updates written');
  } else {
    let updated = 0;
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      const batch = targets.slice(i, i + BATCH_SIZE);
      const tagged = await generateTags(batch.map(toChunk));

      for (let j = 0; j < batch.length; j++) {
        const tags = Array.isArray(tagged[j]?.tags) ? tagged[j].tags : [];
        await updatePayload(COLLECTION, batch[j].id, { tags });
        updated++;
      }

      console.log(`[tags] updated ${updated}/${targets.length}`);
    }
  }
} finally {
  await shutdownOnnxTagWorker();
}
