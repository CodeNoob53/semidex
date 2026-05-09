# Sync

`npm run sync` (or `node src/sync.js`) synchronises `config.json` with the live
collections in Qdrant. It does not index any files — it only updates the local config.

## What sync does

1. Fetches the list of all collections from Qdrant via `listCollections()`.
2. For each collection, fetches collection info via `getCollectionInfo()`.
3. For new collections (not yet in config.json), writes a full provider entry using
   `resolveEnvProviders()` to determine the current provider configuration.
4. For existing collections, backfills any missing provider fields introduced by schema
   upgrades (e.g. `denseProvider`, `denseModel`, `sparseProvider`,
   `embeddingSchemaVersion`).

## Backfill logic

When an existing config entry is missing the new provider fields, sync infers them from
context:

- If `sparseProvider` is already `bge-m3-onnx`, then `denseProvider` is set to
  `bge-m3-onnx` and `denseModel` to `aapot/bge-m3-onnx`.
- Otherwise, `denseProvider`, `denseModel`, and `sparseProvider` are copied from the
  current env provider resolution (i.e. what `resolveEnvProviders()` returns).
- `embeddingSchemaVersion` defaults to the current `SCHEMA_VERSION` constant.

This backfill is safe because it only fills in fields that are `undefined` — it never
overwrites values that were explicitly set.

## When to run sync

Run sync after:
- Creating a new Qdrant collection manually.
- Upgrading semidex to a version that adds new config.json fields.
- Switching provider configuration and wanting to record the change in config.json
  without re-indexing.

## Relationship to indexer

The indexer also updates config.json when it creates a new collection. Sync is only
needed for collections that were created outside the indexer (e.g. manually via the
Qdrant API or dashboard), or to repair a config.json that has drifted from the live
Qdrant state.

## Provider recorded by sync

The provider written by sync reflects the environment at the time sync is run, not the
environment at the time the collection was originally indexed. If you run sync with
`ONNX_EMBED=1` on a collection that was indexed with the default Ollama provider, the
config entry will be updated to `bge-m3-onnx`. This is intentional: sync is a
declaration of current intent, not a historical record.
