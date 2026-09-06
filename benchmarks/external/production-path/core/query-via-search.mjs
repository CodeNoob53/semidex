// Wraps runHybridSearch() (the REAL production retrieval function) with
// the deep-recall candidate limit and a normalized {ok, hits, ms, error}
// result shape — never a raw client.query() call.
import { runHybridSearch } from '../../../../src/core/retrieval/search.js';

// Two distinct limits, never conflated:
//  - CHUNK_CANDIDATE_LIMIT: the `top` value actually passed to
//    runHybridSearch(). No hardcoded cap exists anywhere in
//    search.js -> qdrant-adapter.js -> store.js; resolvePrefetchLimit()
//    is Math.max(limit*mult, limit+1), always >= top. 400 gives
//    comfortable headroom above 100 distinct documents even when several
//    chunks per document appear in the top of the ranking.
//  - DOCUMENT_METRIC_DEPTH: the depth computeMetrics() actually scores
//    against (Recall@100/MAP@100), taken from the collapsed, deduplicated
//    document ranking — never from raw chunk count.
export const CHUNK_CANDIDATE_LIMIT = 400;
export const DOCUMENT_METRIC_DEPTH = 100;

/**
 * True when the collapsed, ranked document list reached full metric
 * depth (or the entire corpus, whichever is smaller — a corpus genuinely
 * smaller than 100 docs is not a depth failure).
 * @param {Array} rankedDocs
 * @param {number} corpusSize
 */
export function checkDepthSufficient(rankedDocs, corpusSize) {
  return rankedDocs.length >= Math.min(DOCUMENT_METRIC_DEPTH, corpusSize);
}

/**
 * Issues ONE real runHybridSearch() query, normalizing its two possible
 * return shapes ({searchMode, hits} | {error, message}) into one
 * consistent {ok, hits, ms, error} record — callers never branch on the
 * raw shape. An {error} result is NOT the same claim as "the production
 * system searched and found nothing" — it must never be scored as an
 * empty/zero ranking for nDCG/Recall purposes (see run-suite.mjs's
 * queryErrorCount gate).
 * `embedQuery` / `cloudEmbed` are the real embedding capabilities this
 * wrapper's caller composed for the run (see
 * benchmarks/lib/embedding-capabilities.mjs — the ONE benchmark-owned
 * factory). A real suite run MUST pass them: runHybridSearch() constructs
 * no capability of its own, so without `embedQuery` every local (BGE-M3
 * ONNX / Ollama) query fails with "no onnxEmbed capability available" and
 * without `cloudEmbed` every qdrant-cloud query fails with "no cloudEmbed
 * capability was supplied" (audit 2026-09-06, P1). Both stay optional in
 * the signature purely so offline tests of THIS wrapper can inject a fake
 * embed function (or omit `cloudEmbed` entirely for a client-only fake
 * profile) instead of composing the real thing.
 * @param {{ adapter, collection: string, query: string, top?: number, embedQuery?: Function, cloudEmbed?: Object }} params
 * @returns {Promise<{ ok: boolean, hits: Array, ms: number, error: {error:string, message:string}|null }>}
 */
export async function queryOne({ adapter, collection, query, top = CHUNK_CANDIDATE_LIMIT, embedQuery, cloudEmbed }) {
  const t0 = process.hrtime.bigint();
  const result = await runHybridSearch({
    adapter, collection, query, top,
    ...(embedQuery && { embedQuery }),
    ...(cloudEmbed && { cloudEmbed }),
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (result?.error) {
    return { ok: false, hits: [], ms, error: { error: result.error, message: result.message } };
  }
  return { ok: true, hits: result?.hits ?? [], ms, error: null };
}
