// Collection lifecycle helpers for the graph-expanded-retrieval live
// benchmark (run-live.mjs).
//
// P0 safety invariant: this script creates ONE disposable collection and
// must delete it in `finally` — but ONLY the collection it itself created.
// It must NEVER delete a pre-existing collection it merely collided with,
// and it must NEVER skip deleting a collection it did create just because
// a later step (indexing, a query) failed.
//
// These three functions are the single place that invariant is enforced,
// extracted so it can be regression-tested offline (mock adapter, no
// network) — see tests/unit/benchmarks/graph-expand-retrieval-collection-lifecycle.test.js.

// Confirms the generated collection name is not already in use before this
// run attempts to create anything. Throws on collision. The caller must
// never establish ownership from this check alone — a `null` result here
// only means "nothing exists yet", not "this run created it".
export async function assertCollectionAvailable(adapter, collection) {
  const existing = await adapter.getCollection(collection);
  if (existing) {
    throw new Error(`Collection "${collection}" already exists — refusing to proceed.`);
  }
}

// Ownership can only be established by observing that the collection now
// exists, called AFTER assertCollectionAvailable() proved it did not exist
// moments earlier and AFTER the step that was supposed to create it has run
// (regardless of whether that step reports success or failure — a job that
// creates the collection and then fails later still leaves this run owning
// an orphaned collection that cleanup must remove). This is the only place
// `ownsCollection` may become true.
export async function confirmOwnership(adapter, collection) {
  const existing = await adapter.getCollection(collection);
  return Boolean(existing);
}

// Deletes the collection if and only if `owned` is true. A collision or any
// failure that occurs before ownership was confirmed must never reach
// adapter.deleteCollection() — this is the sole gate for that call.
export async function cleanupOwnedCollection({ adapter, collection, owned }) {
  if (!owned) return { attempted: false };
  await adapter.deleteCollection(collection);
  return { attempted: true };
}
