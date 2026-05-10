# semidex Migration Guide: v1 to v2

**Domain:** Migration from dense-only indexing to hybrid dense+sparse retrieval with schema metadata and sync backfill.

---

## 1. Overview and Motivation

This document details the migration path from semidex v1 to v2. The primary architectural shift moves from a purely **dense-only** retrieval model to a **hybrid dense+sparse** system. This enhancement improves recall by incorporating keyword matching alongside semantic similarity.

The v2 architecture mandates explicit schema metadata and introduces a synchronization backfill mechanism to ensure data parity across the new indexing paradigm.

### 1.1 Key Changes Summary

| Feature | v1 Behavior | v2 Behavior | Impact |
| :--- | :--- | :--- | :--- |
| Retrieval Model | Dense Only | Hybrid (Dense + Sparse) | Improved precision/recall. |
| Metadata | Implicit | Explicit Schema Metadata | Required for advanced filtering. |
| Syncing | Simple Delta | Full State Reconciliation | Requires `npm run sync`. |
| Schema Version | N/A | `embedding_schema_version` | Must be updated during migration. |

---

[[BENCH_ANCHOR: MIG_SCHEMA_VERSION]]
## 2. Schema Versioning and Metadata Handling

The introduction of structured metadata requires a formal schema update. All new indexes must adhere to the `embedding_schema_version` defined in `config.json`.

The old `config.json` structure is insufficient. The schema definition must be updated to accommodate new metadata fields, particularly those related to document provenance and source context.

**Action Item:** Update `config.json` to reflect the new metadata requirements.

```json
{
  "schema_version": "2.0",
  "embedding_schema_version": "1.1",
  "metadata_fields": ["source_system", "document_type", "confidence_score"]
}
```

---

[[BENCH_ANCHOR: MIG_QDRANT_COLLECTION]]
### Qdrant Collection Preparation

Before enabling v2 search, create or verify the target Qdrant collection with named vectors for `dense` and `sparse` data. The migration must confirm collection aliases, payload indexes, the `graph.<collection>.json` link map, and the expected vector schema before `npm run sync` writes any points.

[[BENCH_ANCHOR: MIG_PROVIDER_META]]
## 3. Provider Configuration Update

The connection details for vector stores must be updated to support hybrid indexing. The move is from simple vector storage pointers to structured provider metadata.

The provider configuration must specify both the primary `DENSE_PROVIDER` and the `SPARSE_PROVIDER` for the sparse index.

**Example `.env` Update:**

```bash
QDRANT_URL=http://localhost:6333
DENSE_PROVIDER=bge-m3-onnx
SPARSE_PROVIDER=bge-m3-onnx
ONNX_EMBED=1
```

---

[[BENCH_ANCHOR: MIG_CHUNK_INDEX_CHANGE]]
## 4. Chunking Strategy Evolution

In v1, chunking was based solely on fixed token counts. In v2, semidex adopts a structure-aware chunking strategy that respects heading section boundaries defined by the source document.

The `chunks_out/` output now includes structural markers alongside the raw text payload.

**Old Chunking (v1):**
* Size: 512 tokens
* Overlap: fixed token overlap

**New Chunking (v2):**
* Strategy: Markdown heading section boundaries
* Metadata Inclusion: `chunk_index`, `total_chunks`, `section`, `source_file`

---

[[BENCH_ANCHOR: MIG_ENV_COMPAT]]
## 5. Environment Compatibility Checks

Before proceeding, verify environment compatibility. The v2 indexing pipeline requires Node.js 18 or later and the packages defined in `package.json`.

**Compatibility Checklist:**

* [ ] Node.js Runtime: >= 18
* [ ] Qdrant: running and reachable at `QDRANT_URL`
* [ ] Ollama: running if using `DENSE_PROVIDER=ollama`
* [ ] ONNX model: downloaded if using `ONNX_EMBED=1`

Run `npm run smoke` to verify the environment offline before connecting to Qdrant.

---

[[BENCH_ANCHOR: MIG_CONFIG_REWRITE]]
## 6. Configuration File Rewriting

The core configuration file, `config.json`, must undergo a mandatory rewrite. This process updates deprecated keys and injects the new schema version identifiers.

**Procedure:**
1. Back up the existing `config.json`.
2. Run `npm run sync` to regenerate `config.json` from the current environment.
3. Verify the presence of `embeddingSchemaVersion` in the resulting file under the relevant collection entry.

---

[[BENCH_ANCHOR: MIG_OBSIDIAN_REVIEW]]
## 7. Content Review and Validation

Given the shift in retrieval logic, a manual review of high-value documents is recommended. Inspect `chunks_out/` after reindexing to verify that section boundaries are respected and no critical sections are split unexpectedly.

* **Focus Area:** Documents with more than 30 heading sections.
* **Goal:** Ensure the hybrid retrieval mechanism surfaces contextually relevant chunks, not just keyword matches.

---

[[BENCH_ANCHOR: MIG_REINDEX_REQUIRED]]
## 8. Reindexing Strategy

Due to the fundamental change in indexing structure (dense-only to hybrid), a simple incremental update is insufficient. A full reindex is mandatory.

**Warning:** Running the reindex process overwrites existing vector embeddings.

Set the target collection and path, then run:

```bash
COLLECTION=my-docs npm run index ./docs/
```

---

[[BENCH_ANCHOR: MIG_DRY_RUN]]
## 9. Initial Dry Run Execution

Always verify connectivity before a full reindex. Run `npm run sync` first to ensure `config.json` and Qdrant payload indexes are consistent without touching document vectors.

You can also index a single small file as a smoke test before committing to a full-corpus reindex:

```bash
COLLECTION=my-docs npm run index ./docs/README.md
```

---

[[BENCH_ANCHOR: MIG_SYNC_BACKFILL]]
## 10. Data Synchronization Backfill

After the initial reindex, run `npm run sync` again to reconcile collection metadata and ensure payload indexes reflect the new schema.

```bash
npm run sync
```

This updates the `config.json` provider records and ensures Qdrant payload field indexes are aligned with the current schema version.

---

[[BENCH_ANCHOR: MIG_VALIDATION]]
## 11. Post-Migration Validation

Once the backfill is complete, perform comprehensive validation checks.

1. **Vector Count Check:** Verify that the vector count in the Qdrant collection matches the expected document count within chunking overhead.
2. **Query Test:** Run `npm run bench:retrieval` to confirm semantic recall is at least as high as the pre-migration baseline.
3. **Schema Check:** Run `npm run sync` and confirm no schema version mismatch warnings appear.

---

[[BENCH_ANCHOR: MIG_ROLLBACK_PLAN]]
## 12. Rollback Plan

If critical failures occur during the v2 deployment, execute the following steps.

1. Halt all indexing processes.
2. Restore the previous `config.json` backup.
3. Reindex the collection using the previous provider configuration from `.env`.
4. Run `npm run sync` to restore the payload indexes.

The `graph.<collection>.json` file should also be restored from backup if graph links are used.

---

**Summary Checklist:**

* [ ] Update `.env` (Provider Configuration)
* [ ] Run `npm run sync` (Schema Versioning)
* [ ] Verify Node.js compatibility
* [ ] Execute full reindex (`COLLECTION=<name> npm run index <path>`)
* [ ] Run `npm run sync` (Backfill)
* [ ] Final validation: `npm run bench:retrieval`
