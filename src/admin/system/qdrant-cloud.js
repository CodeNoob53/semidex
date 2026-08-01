// Thin admin-layer wrapper around the provider-neutral
// StorageAdapter.probeInference()/checkCloudInferenceReachable() methods
// (src/core/storage/qdrant-adapter.js) — this file never imports the
// Qdrant SDK, client, or store directly, and never builds a collection
// schema or inference request shape itself. That knowledge stays entirely
// inside the adapter, which is what keeps src/admin/ dependent on
// StorageAdapter only (see tests/unit/admin/server.test.js's layering
// check). This module's only jobs are: call the adapter, redact secrets
// from any error text, and shape the result for the Admin API route.
import { createStorageAdapter } from '../../core/storage/factory.js';
import { sanitiseErrorMessage } from '../../core/doctor-checks.js';

/**
 * Tier 1 — cheap reachability + auth check. Never attempts inference.
 * @param {{ adapter?: import('../../core/storage/adapter.js').StorageAdapter }} [deps]
 * @returns {Promise<{ status: 'ok'|'unreachable'|'auth_failed', message?: string }>}
 */
export async function checkQdrantReachable({ adapter = createStorageAdapter() } = {}) {
  const result = await adapter.checkCloudInferenceReachable();
  if (result.message) {
    return { ...result, message: sanitiseErrorMessage(result.message, process.env.QDRANT_KEY) };
  }
  return result;
}

/**
 * Tier 2 — real, minimal inference round-trip against a disposable
 * collection, entirely delegated to adapter.probeInference(). Only ever
 * invoked on an explicit user action (the Admin UI's "Test Cloud
 * Inference" button) — never by routine availability resolution.
 *
 * @param {{ profile: Object, sampleText?: string, adapter?: import('../../core/storage/adapter.js').StorageAdapter }} params
 * @returns {Promise<{ status: string, message?: string }>}
 */
export async function probeQdrantCloudInference({ profile, sampleText, adapter = createStorageAdapter() }) {
  const result = await adapter.probeInference({ profile, sampleText });
  if (result.message) {
    return { ...result, message: sanitiseErrorMessage(result.message, process.env.QDRANT_KEY) };
  }
  return result;
}

// Qdrant's own error text for a tier-gated (dedicated/paid-cluster-only)
// model — live-confirmed against a real free-tier cluster on 2026-08-01
// (see docs/design/qdrant-cloud-inference-model-research-2026-08-01.md):
// `"This model: <id> is not allowed in free tier"`. Deliberately narrow
// (matches "not allowed in <word> tier", not a bare "tier" substring) so
// an unrelated error mentioning "tier" in some other sense is never
// misclassified as a cluster-tier gate.
const TIER_GATED_ERROR_PATTERN = /not allowed in \w+ tier/i;

// Qdrant's own error text for a model ID it doesn't recognize at all —
// live-confirmed: `"Bad request: Inference request validation failed:
// Unsupported model: <id>"`. Distinct from TIER_GATED_ERROR_PATTERN even
// though both are inference-model failures — this one means the ID itself
// is wrong (a real bug in Semidex's own catalog, or a caller-supplied
// model that was never in it), never a cluster capability question.
const UNSUPPORTED_MODEL_ERROR_PATTERN = /unsupported model/i;

/**
 * Classifies an inference-probe outcome (either a resolved
 * probeQdrantCloudInference() result OR a caught error from calling it —
 * probeInference()/store.js can both return a typed
 * inference_disabled_or_model_unavailable result AND rethrow a bare Error
 * for failure shapes its own INFERENCE_ERROR_PATTERN doesn't recognize;
 * the tier-gated case is exactly the latter, confirmed live) into the
 * task's four settings-time availability statuses:
 *
 *   - 'available' — the real round-trip succeeded.
 *   - 'unavailable_for_cluster' — a REAL, catalog-known model, rejected
 *     specifically because this cluster's tier doesn't allow it (never
 *     produced for a model Semidex itself doesn't support — see
 *     'unsupported_by_semidex' below).
 *   - 'unsupported_by_semidex' — Qdrant itself doesn't recognize the model
 *     ID, or Semidex's own catalog check rejected it before any network
 *     call (a bug or an out-of-date catalog entry, never a cluster
 *     limitation).
 *   - 'unverified' — the probe could not be completed for an unrelated
 *     reason (network/auth/unreachable) — genuinely unknown, not a
 *     confirmed rejection either way.
 *
 * @param {{ result?: {status: string, message?: string}, error?: Error }} outcome — exactly one of `result`/`error` set
 * @returns {{ status: 'available'|'unavailable_for_cluster'|'unsupported_by_semidex'|'unverified', message: string|null }}
 */
export function classifyInferenceProbeError({ result, error } = {}) {
  if (result) {
    if (result.status === 'inference_available') return { status: 'available', message: null };
    const message = result.message ?? null;
    if (message && UNSUPPORTED_MODEL_ERROR_PATTERN.test(message)) {
      return { status: 'unsupported_by_semidex', message };
    }
    if (message && TIER_GATED_ERROR_PATTERN.test(message)) {
      return { status: 'unavailable_for_cluster', message };
    }
    // inference_disabled_or_model_unavailable with a message not matching
    // either specific pattern — a real inference-layer rejection whose
    // exact cause isn't distinguishable from the message text alone;
    // 'unverified' is the honest answer, not a guess at which of the two
    // more specific statuses applies.
    return { status: 'unverified', message };
  }
  const message = error ? sanitiseErrorMessage(String(error.message ?? error), process.env.QDRANT_KEY) : null;
  if (message && UNSUPPORTED_MODEL_ERROR_PATTERN.test(message)) {
    return { status: 'unsupported_by_semidex', message };
  }
  if (message && TIER_GATED_ERROR_PATTERN.test(message)) {
    return { status: 'unavailable_for_cluster', message };
  }
  return { status: 'unverified', message };
}

/**
 * Settings-time (not collection-time) model availability probe — runs a
 * REAL disposable-collection inference round-trip via
 * probeQdrantCloudInference() and classifies the outcome into the task's
 * four statuses via classifyInferenceProbeError(). Distinct from
 * core/embedding-profile/availability.js's resolveAvailability(), which is
 * scoped to an EXISTING collection's already-resolved profile — this
 * function has no collection at all yet, it answers "would model X work
 * on this cluster if I created a collection with it."
 *
 * @param {{ profile: Object, sampleText?: string, adapter?: import('../../core/storage/adapter.js').StorageAdapter }} params
 * @returns {Promise<{ status: string, message: string|null }>}
 */
export async function probeModelAvailability({ profile, sampleText, adapter = createStorageAdapter() }) {
  try {
    const result = await probeQdrantCloudInference({ profile, sampleText, adapter });
    return classifyInferenceProbeError({ result });
  } catch (error) {
    return classifyInferenceProbeError({ error });
  }
}
