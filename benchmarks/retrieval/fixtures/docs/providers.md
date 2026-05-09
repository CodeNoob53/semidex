# Embedding Providers

semidex supports two embedding provider combinations. Each collection stores its provider
configuration in config.json so that re-indexing is triggered automatically when the
provider changes.

## ollama + hashed-tf (default)

The default combination uses Ollama for dense embeddings and hashed-tf for sparse embeddings.
Ollama runs a local model server; the model is configured via `EMBED_MODEL` (default: bge-m3).
hashed-tf is a zero-dependency sparse encoder that produces term-frequency vectors using
a deterministic hash function. It does not require a running service.

Configuration in config.json:

```json
{
  "denseProvider": "ollama",
  "denseModel": "bge-m3",
  "sparseProvider": "hashed-tf"
}
```

To use this combination set `DENSE_PROVIDER=ollama` and `SPARSE_PROVIDER=hashed-tf`, or
leave both unset since it is the default.

## bge-m3-onnx + bge-m3-onnx

The ONNX combination runs the BGE-M3 model locally via ONNX Runtime. It produces both
dense and sparse vectors from the same model pass. The model is downloaded from Hugging
Face on first use (~2.3 GB) and cached in `./models/`.

Configuration in config.json:

```json
{
  "denseProvider": "bge-m3-onnx",
  "denseModel": "aapot/bge-m3-onnx",
  "sparseProvider": "bge-m3-onnx"
}
```

Enable with `ONNX_EMBED=1` (shorthand) or explicitly with
`DENSE_PROVIDER=bge-m3-onnx SPARSE_PROVIDER=bge-m3-onnx`.

## sparseProvider configuration

The `sparseProvider` field in config.json controls which sparse encoder is used for a
collection. Valid values are `hashed-tf` (default, no external dependency) and
`bge-m3-onnx` (requires ONNX model). Mixed combinations such as
`ollama + bge-m3-onnx` or `bge-m3-onnx + hashed-tf` are rejected at runtime with an
`Invalid provider combination` error.

The `resolveEnvProviders()` function in `src/core/config.js` is the single source of
truth for mapping environment variables to provider names. It is called by the indexer
when creating a new collection and by sync when backfilling existing entries.

## Provider validation

Both `resolveEnvProviders()` (env-time) and `_embed()` in `src/core/embeddings.js`
(runtime) validate the provider combination before any embedding work is done. This
ensures that metadata stored in Qdrant payloads always matches the vectors actually
stored, which is required for correct reindex detection.

## Reindex triggers

Changing `sparseProvider`, `denseProvider`, `denseModel`, or `embeddingSchemaVersion`
in config.json for a collection will cause every file in that collection to be reindexed
on the next `npm run index` run. The six reindex discriminators are: file hash,
denseProvider, denseModel, sparseProvider, embeddingSchemaVersion, vectorSize.
