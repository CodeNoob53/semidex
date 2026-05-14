# Audit: npm run sync semantics vs link-target filtering

Date: 2026-05-14

## Summary

`npm run sync` unconditionally adds every remote Qdrant collection to
`config.json`. Because `resolveLinkCollections()` trusts `config.json` as the
definition of "semidex-managed", any foreign or legacy collection that sync has
touched becomes eligible as a link target. This is a latent bug — currently
mitigated in practice because foreign collections lack the `dense` named vector
and cause a runtime warning, not silent wrong results. But the defence is
accidental, not designed.

---

## Q1 — Does sync add all remote collections to config.json?

**Yes, unconditionally.**

`sync.js` iterates over every name returned by `listCollections()` and calls:

```js
if (!config.collections[name]) {
  config.collections[name] = {
    denseProvider,   // from current ENV, not from the collection
    denseModel,
    sparseProvider,
    embeddingSchemaVersion: SCHEMA_VERSION,
    vectorSize: ...,
    description: '',
  };
}
```

There is no check for whether the collection was created by semidex. A Qdrant
collection created by another application (e.g. a different RAG tool, a
benchmark harness, or a test fixture) is added with the current env's provider
metadata — which may be completely wrong for that collection.

The only existing guard is the flat-schema detection (`isFlatSchema`), which
prints a warning but still adds the collection to config and still creates
payload indexes on it.

---

## Q2 — Can foreign collections reach resolveLinkCollections()?

**Yes, after a single sync run.**

`resolveLinkCollections()` in `src/indexer/index.js`:

```js
export function resolveLinkCollections(qdrantCollections, configCollections, currentCollection, envAllowlist) {
  const configKnown = new Set(configCollections);    // <-- source: config.json
  configKnown.add(currentCollection);

  const base = qdrantCollections.filter(c => configKnown.has(c));
  ...
}
```

It is called in `main()` as:

```js
const linkCfg = loadConfig();
const linkTargetCollections = resolveLinkCollections(
  allCollections,
  Object.keys(linkCfg.collections ?? {}),   // <-- all config.json keys
  COLLECTION,
  linkEnvAllowlist,
);
```

After `npm run sync` has run once, `linkCfg.collections` contains every remote
collection. So `resolveLinkCollections()` allows all of them as link targets.

The only runtime barrier is that linking calls `qdrant_search` on each target,
and a foreign collection with a flat vector schema will return an error or
warning (`Not existing vector name: dense`) — which is logged but does not crash
the indexer. A foreign collection that happens to have a `dense` named vector
(created by a different semidex-compatible tool, or a test harness) would
silently receive link traffic.

---

## Q3 — Is there enough metadata to identify semidex-managed collections?

**Partially, and not reliably from Qdrant alone.**

Available signals and their reliability:

| Signal | Where | Reliable? | Notes |
|--------|-------|-----------|-------|
| Named vector `dense` | Qdrant collection config | Necessary but not sufficient | Any tool that uses bge-m3 with named vectors would pass |
| Sparse vector `sparse` | Qdrant collection config | Stronger, but still not semidex-exclusive | Other hybrid search tools may use the same name |
| Payload indexes on `source_file`, `tags`, `chunk_index` | Qdrant | Weak — sync creates them on foreign collections too | After sync, every collection has them |
| Payload fields: `file_hash`, `dense_provider`, `sparse_provider`, `embedding_schema_version` | Point payload | Strong — very semidex-specific field set | Requires sampling a point, not just collection info |
| `config.json` presence | Local file | Meaningful only before sync contaminates it | After sync, presence in config proves nothing |
| `embeddingSchemaVersion` in config | config.json | Useful — sync writes SCHEMA_VERSION from semidex code | But sync also writes it for foreign collections |

**Best available signal without sampling points:** named `dense` vector +
absence of flat schema + `sparse_vectors.sparse` entry. This is a reasonable
heuristic but not a proof of semidex origin.

**Definitive signal:** presence of a point with `embedding_schema_version` in
payload matching a known SCHEMA_VERSION. Requires at least one indexed point to
exist.

---

## Q4 — Safest default?

**Recommended: sync only semidex-compatible collections (with flat-schema still
logged but excluded from config).**

Options evaluated:

| Option | Risk | Operability |
|--------|------|-------------|
| **Current: sync all** | Foreign collections enter config → eligible for link targets | Simple, but leaks scope |
| **Sync only compatible** (named dense + sparse) | Foreign collections never enter config | Breaking for users who ran sync on mixed Qdrant instances — they lose config entries for foreign collections on next sync |
| **Sync all, mark incompatible as `linkDisabled: true`** | No leakage if `resolveLinkCollections` respects the flag | Slightly more complex, non-breaking |
| **Separate `SYNC_FOREIGN=1` flag** | Opt-in for foreign inclusion | Clean, explicit, but adds env surface |

The `linkDisabled` approach is the minimal non-breaking path:

- sync continues to add all remote collections (existing behaviour)
- collections that fail the semidex-compatibility check get `linkDisabled: true`
  written into their config entry
- `resolveLinkCollections()` filters out any collection where
  `config.collections[name].linkDisabled === true`
- flat-schema collections already detected by sync → mark them `linkDisabled: true`
- foreign collections that pass schema check (named dense + sparse) → no flag,
  eligible as link targets (intentional — user may have a second semidex instance)

This is strictly additive to existing code and has no false positives for
legitimate semidex collections.

---

## Q5 — What needs to change?

Three components need changes, in sequence:

### Stage 1 — Minimal (recommended now)

**`src/sync.js`:**
- Set `linkDisabled: true` on flat-schema collections (already detected, just
  not flagged in config).
- Set `linkDisabled: true` on collections that lack a named `dense` vector
  (i.e. not flat-schema but still not semidex-compatible — e.g. a Qdrant
  collection with only unnamed dense vectors from another tool).

**`src/indexer/index.js` — `resolveLinkCollections()`:**
- Accept `configCollectionsMap` (the full collections object, not just keys) so
  it can inspect `linkDisabled`.
- Filter out collections where `linkDisabled === true`.
- Update the call site in `main()` to pass `linkCfg.collections` (the map) instead
  of `Object.keys(linkCfg.collections)`.

**Smoke test addition:**
- `resolveLinkCollections()` with a config map where one entry has
  `linkDisabled: true` — verify it is excluded.
- `resolveLinkCollections()` with a config map where the current collection has
  `linkDisabled: true` — verify it is still included (current collection is
  always in scope).

**Risk:** low. `resolveLinkCollections()` is a pure function already covered by
smoke tests. The sync change adds a write to config.json that is idempotent.

### Stage 2 — Stronger metadata (future)

- Sample one point from each collection during sync to check for
  `embedding_schema_version` in payload. If absent or mismatched, mark
  `linkDisabled: true`.
- Add a `semidexManaged: true` field to config entries created by the indexer
  (not by sync), so sync can distinguish collections it created vs collections
  it discovered.
- Document the `semidexManaged` / `linkDisabled` fields in `config.json` schema
  docs.

### Stage 3 — Docs and tests

- Add a note to `docs/en/operations.md` "Qdrant indexes and sync" section
  explaining that sync touches all remote collections and that foreign/legacy
  collections are marked `linkDisabled` and excluded from link building.
- Add a troubleshooting row: "unexpected cross-collection links / foreign
  collection appearing in link results → run `npm run sync` to update
  `linkDisabled` flags".
- Extend the smoke test section for `resolveLinkCollections` with the
  `linkDisabled` cases described in Stage 1.

---

## Appendix: call-site trace

```
npm run sync
  → listCollections()              → all remote names
  → getCollectionInfo(name)        → vectors config
  → config.collections[name] = {}  → WRITES for every remote name
  → saveConfig(config)

npm run index <path>
  → listCollections()              → all remote names (allCollections)
  → loadConfig()                   → linkCfg (now contains all remote names)
  → resolveLinkCollections(
      allCollections,
      Object.keys(linkCfg.collections),  ← all remote names post-sync
      COLLECTION,
      envAllowlist
    )
  → link phase queries every collection in linkTargetCollections
```

After sync, `Object.keys(linkCfg.collections)` equals `allCollections`.
`resolveLinkCollections` intersects them — the intersection is everything.
The env allowlist `LINK_COLLECTIONS` is the only user-reachable escape hatch
today, and it must be set explicitly.

---

## Verdict

The bug is real but currently has no silent failure mode: foreign flat-schema
collections produce a logged warning during link building, not wrong links. A
foreign collection with compatible named vectors would silently receive link
queries — this is the unguarded case.

Stage 1 fix is small (≈30 lines across two files + smoke tests), non-breaking,
and closes the primary risk. Stage 2 is optional hardening. Recommend
implementing Stage 1 before the next release that users run `npm run sync` on a
shared or mixed Qdrant instance.
