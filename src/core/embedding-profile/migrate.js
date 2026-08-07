// Legacy point-payload migration/backfill — pure inference logic for
// recovering an unambiguous embedding profile from a collection's own
// content-point payloads (dense_provider/dense_model/sparse_provider/
// embedding_schema_version/vector_size), when native Qdrant metadata is
// absent. No network I/O here — the adapter (Part B,
// src/core/storage/qdrant-adapter.js) owns paginating through the real
// collection and calling these functions per page.
//
// Deliberately conservative: only the two known, currently-supported
// Semidex provider combinations are ever inferred. Any payload that
// disagrees across points, or maps to an unrecognized combination, is
// reported ambiguous — never guessed.
import { VALID_PROVIDER_COMBOS } from '../../shared/core/env.js';
import { buildEmbeddingProfile } from './schema.js';

const IDENTITY_FIELDS = [
  'source_file', 'dense_provider', 'dense_model', 'sparse_provider',
  'embedding_schema_version', 'vector_size',
];

export { IDENTITY_FIELDS };

function extractIdentity(payload) {
  return {
    denseProvider: payload?.dense_provider ?? null,
    denseModel: payload?.dense_model ?? null,
    sparseProvider: payload?.sparse_provider ?? null,
    embeddingSchemaVersion: payload?.embedding_schema_version ?? null,
    vectorSize: payload?.vector_size ?? null,
  };
}

function identityEqual(a, b) {
  return a.denseProvider === b.denseProvider
    && a.denseModel === b.denseModel
    && a.sparseProvider === b.sparseProvider
    && a.embeddingSchemaVersion === b.embeddingSchemaVersion
    && a.vectorSize === b.vectorSize;
}

/**
 * Folds ONE page (array of narrow-projected content-point payloads — nav
 * points already excluded by the caller) into a running accumulator, so a
 * caller can process a large collection page-by-page and stop as soon as a
 * page produces a disagreement, without ever materializing the whole
 * collection in memory.
 *
 * @param {{ consistent: true, agreed: object, count: number } | { consistent: false, reason: string, disagreement?: object } | null} accumulator
 *   `null` on the first call.
 * @param {Array<object>} pagePayloads — raw point payload objects (snake_case
 *   fields), content-only/nav-excluded.
 * @returns {{ consistent: true, agreed: object, count: number } | { consistent: false, reason: string, disagreement?: object }}
 *   A `consistent: false` result is terminal — callers must stop folding
 *   further pages once they see one.
 */
export function foldPayloadConsistency(accumulator, pagePayloads) {
  if (accumulator && accumulator.consistent === false) return accumulator; // terminal, never re-enters

  let agreed = accumulator?.agreed ?? null;
  let count = accumulator?.count ?? 0;

  for (const payload of pagePayloads ?? []) {
    const identity = extractIdentity(payload);
    if (agreed === null) {
      agreed = identity;
      count = 1;
      continue;
    }
    if (!identityEqual(agreed, identity)) {
      return {
        consistent: false,
        reason: 'inconsistent embedding identity across content points',
        disagreement: { sourceFile: payload?.source_file ?? null, expected: agreed, found: identity },
      };
    }
    count += 1;
  }

  if (agreed === null) {
    // Empty page contributed nothing — preserve whatever accumulator state
    // came in (or the empty-sample state if this is the very first call).
    return accumulator ?? { consistent: false, reason: 'empty' };
  }
  return { consistent: true, agreed, count };
}

/**
 * Convenience wrapper for tests/fixtures that already have the whole array
 * in hand — never used by the live adapter path, which folds page-by-page
 * via foldPayloadConsistency(). Equivalent to reduce()-ing
 * foldPayloadConsistency over the array, plus the explicit
 * `{ consistent: false, reason: 'empty' }` result for a zero-length array.
 *
 * @param {Array<object>} payloads
 */
export function checkPayloadConsistency(payloads) {
  if (!payloads || payloads.length === 0) return { consistent: false, reason: 'empty' };
  let acc = null;
  for (const payload of payloads) {
    acc = foldPayloadConsistency(acc, [payload]);
    if (acc.consistent === false) return acc;
  }
  return acc;
}

/**
 * Pure function. Takes a checkPayloadConsistency()/foldPayloadConsistency()
 * result (not a raw payload) plus the live Qdrant vector-schema summary
 * (the SAME normalized shape qdrant-adapter.js's normalizeVectorSchema()
 * produces — { dense: { name, dimensions, distance } | null,
 * sparse: { name, modifier } | null }).
 *
 * @param {{ consistent: true, agreed: object, count: number } | { consistent: false, reason: string }} consistencyResult
 * @param {{ dense: object|null, sparse: object|null }} vectorSchemaInfo
 * @returns {{ status: 'inferred', profile: object } | { status: 'ambiguous', reason: string } | { status: 'no_payload', reason: string }}
 */
export function inferLegacyProfile(consistencyResult, vectorSchemaInfo) {
  if (!consistencyResult || consistencyResult.consistent !== true) {
    const reason = consistencyResult?.reason ?? 'unknown';
    if (reason === 'empty') return { status: 'no_payload', reason: 'collection has no content points with recoverable embedding metadata' };
    return { status: 'ambiguous', reason };
  }

  const { agreed } = consistencyResult;
  if (agreed.denseProvider === null || agreed.sparseProvider === null) {
    return { status: 'no_payload', reason: 'content points are missing dense_provider/sparse_provider payload fields' };
  }

  const comboKey = `${agreed.denseProvider}:${agreed.sparseProvider}`;
  if (!VALID_PROVIDER_COMBOS.has(comboKey)) {
    return { status: 'ambiguous', reason: `unrecognized provider combination "${comboKey}" — not a known Semidex combo` };
  }

  if (!vectorSchemaInfo?.dense) {
    return { status: 'ambiguous', reason: 'live collection has no dense vector schema to verify against' };
  }
  if (agreed.vectorSize !== null && agreed.vectorSize !== vectorSchemaInfo.dense.dimensions) {
    return { status: 'ambiguous', reason: `payload vector_size (${agreed.vectorSize}) disagrees with live dense dimensions (${vectorSchemaInfo.dense.dimensions})` };
  }

  const hasSparseSchema = Boolean(vectorSchemaInfo.sparse);
  if (hasSparseSchema !== Boolean(agreed.sparseProvider)) {
    return { status: 'ambiguous', reason: 'payload sparse_provider presence disagrees with live sparse vector schema presence' };
  }

  const profile = buildEmbeddingProfile({
    dense: {
      provider: agreed.denseProvider,
      model: agreed.denseModel,
      vectorName: vectorSchemaInfo.dense.name,
      dimensions: vectorSchemaInfo.dense.dimensions,
      distance: vectorSchemaInfo.dense.distance,
      execution: 'client',
    },
    sparse: hasSparseSchema ? {
      provider: agreed.sparseProvider,
      model: agreed.sparseProvider, // legacy payloads never recorded a distinct sparse model id — the provider name doubles as the model id for the two known combos (hashed-tf, bge-m3-onnx)
      vectorName: vectorSchemaInfo.sparse.name,
      execution: 'client',
      modifier: vectorSchemaInfo.sparse.modifier ?? null,
    } : null,
    embeddingSchemaVersion: agreed.embeddingSchemaVersion ?? 2,
  });

  return { status: 'inferred', profile };
}
