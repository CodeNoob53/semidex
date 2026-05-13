# Link-Building Cross-Collection Compatibility Audit

**Date:** 2026-05-12  
**Scope:** `src/indexer/phases/link.js`, `src/indexer/index.js`, `src/core/qdrant.js`, `config.json`  
**Status:** Audit only — no runtime changes

---

## 1. Current Behavior

### How `allCollections` is formed (index.js:173)

```js
let allCollections = await listCollections();
```

`listCollections()` calls `GET /collections` on Qdrant and returns **every collection name Qdrant
knows about** — including collections created by other tools, other users, or temporary bench
collections. The result is passed verbatim to `buildLinks` for each indexed file.

### How `buildLinks` uses that list (link.js:13–47)

```js
export async function buildLinks(chunk, collections, graph, sourceCollection) {
  const { dense } = await embedForSearch(sourceCollection, chunk.context + '\n' + chunk.text);
  const vector    = { name: 'dense', vector: dense };

  const targets = LINK_ALLOWLIST
    ? collections.filter(c => LINK_ALLOWLIST.has(c))
    : collections;          // ← no filtering without LINK_COLLECTIONS env var

  for (const collection of targets) {
    let results;
    try {
      results = await search(collection, vector, LINK_TOP);
    } catch (err) {
      console.warn(`  [link] skipping collection "${collection}": ${err.message}`);
      continue;              // ← swallowed silently per collection
    }
    ...
  }
}
```

Key facts:
- Without `LINK_COLLECTIONS`, **every Qdrant collection is searched** — including bench-only,
  incompatible, or foreign collections.
- `LINK_COLLECTIONS` env allowlist exists and works, but is undiscoverable unless you already
  know about it.
- The `search()` call uses a **named vector** `{ name: 'dense', ... }`. If the target collection
  has no vector named `dense`, Qdrant returns an HTTP error. The error is caught and the
  collection is skipped with a `console.warn`.
- Vector dimension mismatch (e.g. 768 vs 1024) also throws from Qdrant → also swallowed.
- Embedding provider/model mismatch is **not detected** at the search layer — cross-provider
  embeddings differ in geometry, producing meaningless cosine similarity scores that are unlikely
  to reach `LINK_MIN_SCORE=0.75` but are not guaranteed to be filtered out.

### Error propagation in `qdrant.js`

`search()` (qdrant.js:40–54) throws a plain `Error` on any non-2xx response. The error message
includes the collection name and the raw Qdrant error body. `buildLinks` catches these at the
collection level and continues (`continue`). No error is re-thrown, no counter is incremented.

`hybridSearch()` has one additional silent path: if Qdrant returns a `sparse`/`Wrong input`
error it falls back to dense-only search and returns silently — but this path is **not used
by link.js** (link.js calls `search()` directly, not `hybridSearch()`).

---

## 2. Risk Assessment

| Risk | Severity | Likelihood |
|------|----------|------------|
| Cross-provider false links (e.g. ollama→onnx geometry mismatch) | Medium | Low — score threshold filters most, but not guaranteed |
| Linking into bench collections (`bench-retrieval-*`) | Medium | High — bench collections live in the same Qdrant instance |
| Linking into foreign/third-party collections with `dense` vector of same size | Medium | Low in practice, unpredictable at scale |
| Performance: searching N=7+ collections per chunk × M chunks per file | Low–Medium | Present today: 7 collections in config.json |
| Silent skip of incompatible collections masking misconfiguration | Low | Medium — the warn is easy to miss in verbose output |
| `updatePayload` called on a foreign collection's point (backlink write) | Medium | Follows from any cross-collection link that passes score threshold |

### Specific concern: bench collections

`config.json` currently has 4 bench collections (`bench-retrieval`, `bench-retrieval-custom-50`,
`bench-retrieval-custom-large`, `bench-retrieval-custom-raw`). These use **ONNX** embeddings
(bge-m3-onnx/1024), while user collections (`test-indexer`, `sql-cursova`, `music-genres`) use
**ollama** (bge-m3/1024). The vector names match (`dense`) and vector sizes match (1024), so
no Qdrant error is thrown. The link phase silently searches bench collections with ollama query
vectors, producing geometrically meaningless scores. Most will be below 0.75, but the behavior
is incorrect by design.

### Specific concern: backlink writes

If a cross-collection link passes the score threshold, `buildLinks` writes a backlink into the
foreign collection's point payload (line 39–42). This mutates data in a collection the user may
not own or expect to be modified.

---

## 3. Why the Current Design Searches All Collections

There is no explicit design decision captured in docs or code comments for this. The likely
original intent: cross-collection semantic links are a feature — a chunk in `sql-cursova` might
legitimately link to a related chunk in `music-genres`. The `LINK_COLLECTIONS` env var exists
as an opt-in filter for users who want to restrict this. The problem is that the default (no
env var) expands to all Qdrant-visible collections, not just semidex-managed ones.

---

## 4. Eligible Collections: What "Compatible" Should Mean

A collection is eligible for link building if:

1. **It is known to semidex** — present in `config.json` under `.collections`.
2. **Its `denseProvider` and `denseModel` match `sourceCollection`** — ensures query and index
   vectors share the same geometry.
3. **Its `vectorSize` matches `sourceCollection`** — prevents dimension mismatch errors from
   Qdrant (currently swallowed, but wasteful).
4. **It is not a bench-only collection unless explicitly allowed** — bench collections are
   auto-managed and should not accumulate user-data backlinks.

Condition 1 alone (config-known) would eliminate foreign/unknown collections.  
Conditions 1+2+3 would eliminate cross-provider mismatches.

---

## 5. Can Compatibility Be Determined from config.json or Qdrant Collection Info?

### Via config.json (preferred)

Yes. `loadConfig().collections` already contains `denseProvider`, `denseModel`, `sparseProvider`,
`embeddingSchemaVersion`, and `vectorSize` for every semidex-managed collection. Filtering
`allCollections` to the keys of `config.collections` before passing to `buildLinks` would:
- exclude non-semidex collections
- enable provider/size comparison without extra Qdrant calls

No new API calls needed. Config is already loaded in `index.js`.

### Via `getCollectionInfo` (qdrant.js:15)

`getCollectionInfo` returns Qdrant's schema including `vectors_config` (vector names, sizes,
distance). This could detect `dense` vector presence and size at runtime, but requires one HTTP
call per collection before the link phase starts. Overhead is O(N collections), acceptable for
small N but adds latency. Payloads do not expose provider/model — only config.json has that.

---

## 6. Current vs. Target Collection for Links: Include or Exclude?

### Self-links (same collection)

`buildLinks` already excludes self-source-file links:

```js
if (!targetFile || targetFile === chunk.source_file) continue;
```

But the current collection itself **is** searched. This is correct: a chunk in file A should
be able to link to file B within the same collection (cross-file, same collection). Excluding
the source collection would break intra-collection links.

### Should the source collection be excluded from `targets`?

No. It must remain in `targets`. The source file exclusion (line 33) handles the only real
risk (self-linking to the same file). Cross-file links within the same collection are the
primary use case.

---

## 7. Error Handling Assessment

| Error path | Current handling | Assessment |
|------------|-----------------|------------|
| `search()` throws (no `dense` vector, dimension mismatch, auth) | `console.warn` + `continue` | Acceptable for incompatible collections; should become expected behavior once filtering eliminates most cases |
| `updatePayload()` throws (foreign collection write fails) | Not caught — propagates to `runBatched` → `indexFile` → process exit | Latent risk: if a foreign link passes score threshold and the backlink write fails, the entire file indexing aborts |
| `listCollections()` throws | Propagates to `main()` → process exit | Correct |
| Empty results from `search()` | Loop body never executes | Correct |
| `r.payload?.source_file` missing | `if (!targetFile ...) continue` | Correct |

The `updatePayload` gap is the most consequential: a foreign collection link that passes the
score threshold and then fails on backlink write will crash the indexing run. Currently rare
because cross-provider scores usually stay below 0.75, but not guaranteed.

---

## 8. Recommended Minimal Safe Fix

### Option A — Filter to config-known collections (recommended)

**Change in `index.js`**, before passing `allCollections` to `buildLinks`:

```js
const cfg = loadConfig();
const knownCollections = new Set(Object.keys(cfg.collections ?? {}));
const allCollections = (await listCollections()).filter(c => knownCollections.has(c));
```

**Why minimal:** no new env vars, no new API calls, no changes to `link.js` or `qdrant.js`.
Config.json is already loaded in `main()`. This alone eliminates all foreign and bench-only
collections from link targets.

**Why sufficient for now:** all semidex-managed collections in config.json are user-intentional.
Cross-collection links between user collections (e.g. `sql-cursova` ↔ `music-genres`) remain
possible and may be desirable. Provider mismatch between those collections is a secondary concern
— mismatched-geometry scores are very unlikely to clear 0.75.

### Option B — Filter to config-known + same-provider (stricter)

```js
const srcProvider = cfg.collections?.[COLLECTION]?.denseProvider;
const srcModel    = cfg.collections?.[COLLECTION]?.denseModel;
const srcSize     = cfg.collections?.[COLLECTION]?.vectorSize;

const allCollections = (await listCollections()).filter(c => {
  if (!knownCollections.has(c)) return false;
  const col = cfg.collections[c];
  return col.denseProvider === srcProvider
      && col.denseModel    === srcModel
      && col.vectorSize    === srcSize;
});
```

**Why more correct:** eliminates cross-provider links that produce meaningless scores and
cross-size links that cause Qdrant errors (currently swallowed). The bench collections
(ONNX, same size as ollama but different provider) are excluded cleanly.

**Trade-off:** cross-collection links between intentionally different providers become
impossible even if the user wants them. This should be the default, with `LINK_COLLECTIONS`
as the override for explicit cross-provider scenarios.

### Option C — Add `LINK_COLLECTIONS` documentation (non-code)

`LINK_COLLECTIONS` already exists and works. Documenting it prominently in operations.md as
"set this to restrict cross-collection linking" is zero-risk. Does not fix the default, but
gives operators a workaround without waiting for a code change.

### Recommended sequence

1. **Immediate (docs-only):** document `LINK_COLLECTIONS` prominently in operations.md with
   a note that the default searches all Qdrant-visible collections (including bench).
2. **Stage 1 (minimal code):** Option A — filter to config-known collections in `index.js`.
3. **Stage 2 (correct default):** Option B — additionally filter by provider+model+size match.
4. **Guard `updatePayload` in `buildLinks`:** wrap the backlink write in try/catch with a
   `console.warn`, so a foreign-collection write failure does not abort indexing.

---

## 9. Tests / Smoke to Add (If Implementation Happens)

### Unit tests for `buildLinks` isolation (no Qdrant)

```
computeLinkEligibleCollections(allCollections, config, sourceCollection)
  → excludes collections not in config
  → excludes collections with different denseProvider
  → excludes collections with different vectorSize
  → includes source collection (for cross-file intra-collection links)
  → LINK_COLLECTIONS allowlist overrides computed set
```

### Smoke test additions

```
[10] buildLinks collection filtering (no Qdrant)
  ✓ config-known filter excludes unknown collections
  ✓ same-provider filter excludes cross-provider collections
  ✓ source collection is included in targets
  ✓ LINK_COLLECTIONS allowlist applied after config filter
  ✓ updatePayload failure in buildLinks does not throw (guarded)
```

### Integration test scenario

Run `COLLECTION=test-indexer npm run index ./docs` with Qdrant containing a non-semidex
collection (`foreign-coll` with `dense` vector, size 1024). Verify:
- `foreign-coll` does not appear in link targets
- No `console.warn` about skipping `foreign-coll` (it was never attempted)
- Graph file does not contain edges into `foreign-coll`

---

## 10. Non-Goals

- Replacing `LINK_COLLECTIONS` — it should remain as an explicit override.
- Querying `getCollectionInfo` for every collection on each index run — config.json is
  sufficient as the source of truth for semidex-managed collections.
- Making cross-collection linking impossible by default — the goal is to limit to
  *semidex-known* collections, not to enforce single-collection linking.
- Detecting provider compatibility via Qdrant payload scanning — too expensive and
  unreliable for collections with mixed metadata.
- Fixing bench collection isolation at the Qdrant level (separate Qdrant instance, namespacing)
  — out of scope for this audit.
- Changing how `hybridSearch` fallback works — it is not used in the link phase.
