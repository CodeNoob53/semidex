// Prefix-guarded collection deletion + orphan sweep for the
// production-path benchmark. Every deletion is gated on the exact owned
// prefix — this module never deletes anything that doesn't start with
// COLLECTION_PREFIX, regardless of what name is passed in.
import { COLLECTION_PREFIX } from './profiles.mjs';

// Substrings a Qdrant "collection doesn't exist" response is known to
// contain — a delete of an already-absent collection is a successfully
// clean final state, never a cleanup failure (code review: an earlier
// design gated cleanup on the harness's own `created` bookkeeping, which
// could be skipped by a crash between "subprocess created the collection
// server-side" and "harness observed that" — the fix is to always
// attempt deletion unconditionally and treat "not found" as success,
// never to trust a local flag about what state the server is in).
const NOT_FOUND_RE = /doesn.t exist|not found|404/i;

/**
 * Deletes ONE collection, gated on the owned prefix. Never throws on a
 * "not found" response — that is a successfully clean final state, not a
 * cleanup failure. Any OTHER error is reported, never silently swallowed.
 * @param {import('../../../../src/core/storage/adapter.js').StorageAdapter} adapter
 * @param {string} name
 * @returns {Promise<{ attempted: boolean, deleted: boolean, note?: string, error?: string }>}
 */
export async function cleanupCollection(adapter, name) {
  if (!name || !name.startsWith(COLLECTION_PREFIX)) {
    throw new Error(`cleanupCollection: refusing to delete "${name}" — does not start with the owned prefix "${COLLECTION_PREFIX}"`);
  }
  try {
    await adapter.deleteCollection(name);
    return { attempted: true, deleted: true };
  } catch (err) {
    const message = err?.message ?? String(err);
    if (NOT_FOUND_RE.test(message)) {
      return { attempted: true, deleted: true, note: 'already absent' };
    }
    return { attempted: true, deleted: false, error: message };
  }
}

/**
 * Lists every collection whose name starts with the owned prefix and
 * deletes each one (best-effort — one failure does not stop the sweep).
 * This is the real safety net for a hard-killed prior run, whose
 * `finally`-based cleanup never got to run at all — called
 * unconditionally at the start of every suite runner invocation, and
 * separately invocable as a standalone cleanup-verification step.
 *
 * adapter.listCollections() returns full per-collection info objects
 * ({name, pointCount, provider, ...} — it also reads config.json), not
 * bare name strings; only .name is used here.
 * @param {import('../../../../src/core/storage/adapter.js').StorageAdapter} adapter
 * @returns {Promise<{ scanned: number, owned: string[], results: Array<{name:string, deleted:boolean, error?:string}> }>}
 */
export async function cleanupAllOwnedCollections(adapter) {
  const all = await adapter.listCollections();
  const ownedNames = all.map((c) => c.name).filter((name) => name.startsWith(COLLECTION_PREFIX));
  const results = [];
  for (const name of ownedNames) {
    const result = await cleanupCollection(adapter, name);
    results.push({ name, deleted: result.deleted, error: result.error });
  }
  return { scanned: all.length, owned: ownedNames, results };
}
