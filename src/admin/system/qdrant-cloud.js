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
