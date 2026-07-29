// Chunk-level hit -> benchmark document ID collapse. Genuinely new logic
// (does not exist anywhere else in the repo — the existing raw-client
// benchmark suites index one atomic point per document, so chunk hits and
// document hits are identical by construction for them; the production
// path chunks/entity-splits documents, so this collapse step is required
// before computing document-level metrics against qrels).
//
// Aggregation: MAX score across a document's chunks — the standard,
// simplest, most defensible choice for chunk-then-aggregate retrieval
// eval. Recorded as collapseStrategy: 'max' wherever this module's output
// is reported, as an explicit, logged fairness parameter (never silently
// varied between profiles).

export const COLLAPSE_STRATEGY = 'max';

/**
 * runHybridSearch() hits are adapter Chunk objects (src/core/storage/
 * qdrant-adapter.js's toChunk() shape — camelCase, flat: sourceFile,
 * text, rawContent, entityId, ...), NEVER a raw {payload:{...}} Qdrant
 * point. hit.sourceFile is the correct field — hit.payload.source_file
 * does not exist on this shape at all (a hand-tested regression: an
 * earlier version of this function read hit.payload?.source_file, which
 * is always undefined for a real Chunk, so EVERY hit was silently
 * misrouted into unmappedHits — caught only by a live run against a real
 * indexed collection, since every offline unit test's own hand-built hit
 * fixtures happened to use the same wrong {payload:{...}} shape).
 * @param {Array<{sourceFile?: string, score: number}>} hits — runHybridSearch() hits (Chunk shape)
 * @param {Map<string,string>} sourceFileToDocId — explicit filename->docID table (see core/materialize.mjs)
 * @returns {{
 *   rankedDocs: Array<{docId: string, score: number, chunkCount: number}>,
 *   unmappedHits: Array<{sourceFile: string|undefined, score: number}>,
 * }} rankedDocs sorted descending by score
 */
export function collapseHitsToDocuments(hits, sourceFileToDocId) {
  const byDoc = new Map(); // docId -> { score, chunkCount }
  const unmappedHits = [];
  for (const hit of hits) {
    const sourceFile = hit.sourceFile;
    const docId = sourceFile !== undefined && sourceFile !== null ? sourceFileToDocId.get(sourceFile) : undefined;
    if (!docId) {
      unmappedHits.push({ sourceFile, score: hit.score });
      continue;
    }
    const prev = byDoc.get(docId);
    if (!prev) {
      byDoc.set(docId, { score: hit.score, chunkCount: 1 });
    } else {
      byDoc.set(docId, { score: Math.max(prev.score, hit.score), chunkCount: prev.chunkCount + 1 });
    }
  }
  const rankedDocs = [...byDoc.entries()]
    .map(([docId, v]) => ({ docId, score: v.score, chunkCount: v.chunkCount }))
    .sort((a, b) => b.score - a.score);
  return { rankedDocs, unmappedHits };
}
