# Admin UI - Provider-Aware Models and Embedding Settings

Date: 2026-07-16

Status: implemented, code-reviewed, and verified. Not committed.

## Goal

Make the Global Settings model controls reflect the providers and models that
semidex will actually use. The UI must not expose impossible provider
combinations, guess model capabilities from names, or ask users to enter a
Qdrant vector size manually.

## Implemented Behavior

### Ollama model discovery

`GET /api/ollama-models` lists installed Ollama models without starting Ollama
or loading model weights.

For every model:

- `/api/tags` provides the installed model list and basic metadata;
- `/api/show` provides Ollama's `capabilities` array and `model_info`;
- the full capabilities array is preserved, including models that support more
  than one capability;
- a failed or incomplete `/api/show` result is represented as unverified
  (`capabilities: null`), never guessed from the model name;
- successful `/api/show` responses are cached per Ollama URL and model;
- failed responses are not cached, so a temporary outage can recover;
- `?refresh=1` bypasses successful discovery cache entries;
- `/api/show` requests are bounded to four concurrent requests.

The response model shape is:

```json
{
  "name": "nomic-embed-text:latest",
  "capabilities": ["embedding"],
  "embeddingDimension": 768,
  "parameterSize": "137M",
  "family": "nomic-bert"
}
```

The endpoint always returns HTTP 200 with availability in the response body.
An unreachable Ollama instance is a normal status state, not an admin-server
failure.

### Provider-aware model selectors

The following settings use installed-model selectors:

- `ASK_MODEL`
- `CONTEXT_MODEL`
- `TAG_MODEL` when `TAG_PROVIDER=ollama`
- `EMBED_MODEL` when `EMBEDDING_BACKEND=ollama`

Generation selectors require Ollama's `completion` capability. The embedding
selector requires `embedding`.

Models whose capabilities could not be verified remain selectable and are
labeled as unverified. A configured model that is no longer installed remains
visible as a selected `not installed` option instead of silently changing the
configuration.

The Refresh Models button requests `/api/ollama-models?refresh=1`.

### Canonical embedding backend

`EMBEDDING_BACKEND` is the only provider selector rendered in the UI:

- `ollama` maps to `DENSE_PROVIDER=ollama` and
  `SPARSE_PROVIDER=hashed-tf`;
- `bge-m3-onnx` maps to `DENSE_PROVIDER=bge-m3-onnx` and
  `SPARSE_PROVIDER=bge-m3-onnx`.

`DENSE_PROVIDER` and `SPARSE_PROVIDER` remain available to scripts through the
settings API, but are hidden from the UI. Direct API writes are cross-validated
against the final effective pair and an invalid combination is rejected
atomically.

The read-side backend resolution uses the same
`resolveEffectiveEmbeddingBackend()` logic as the runtime, including the
legacy `ONNX_EMBED=1` shorthand. Invalid explicit provider values are preserved
and reported to the UI instead of being normalized to a misleading default.

### Canonical embedding model

For the Ollama backend, `EMBED_MODEL` is canonical. `DENSE_MODEL` is retained
as a legacy fallback only when `EMBED_MODEL` is unset.

If a legacy `DENSE_MODEL` value currently wins, the settings response exposes
that fact through `shadowedBy` and the UI renders a warning. Saving
`EMBED_MODEL` does not silently delete another setting.

For the ONNX backend:

- the model is the shared `ONNX_DENSE_MODEL_ID`;
- the vector size is the fixed value `1024`;
- the Ollama embedding-model selector is hidden;
- ONNX execution settings are shown.

### Vector dimension safety

`VECTOR_SIZE` is read-only in Global Settings.

For Ollama embedding models:

1. semidex first reads the architecture-specific `*.embedding_length` from
   `/api/show.model_info`, but only when the model declares the `embedding`
   capability;
2. if metadata is incomplete, collection creation performs one `/api/embed`
   probe and uses the returned vector length as the authoritative dimension;
3. if the dimension cannot be verified, semidex stops before creating the
   Qdrant collection.

This prevents a collection from being created with a manually entered vector
size that does not match the selected model.

The Settings UI shows the detected dimension from discovery metadata. If an
installed embedding model does not expose a verified dimension, the UI marks
it as unknown and blocks saving that model. Refresh can recover after Ollama or
model metadata becomes available.

## Declarative Settings Metadata

The settings registry now carries these UI-neutral dependency fields:

- `visibleWhen`
- `dynamicOptions`
- `derivedWhen`
- `dynamicDerived`
- `uiHidden`

The admin UI consumes this metadata instead of hardcoding each setting key's
layout behavior.

## Safety Properties

- Model capability is never inferred from a model name.
- Multi-capability models are not collapsed into one category.
- Failed discovery is retryable.
- Invalid provider configuration is visible instead of normalized away.
- Dense and sparse provider writes cannot create an invalid pair.
- Vector size is derived from the real embedding model.
- Secrets are not returned by the model-discovery endpoint.
- Model discovery does not call `/api/embed`; only new-collection creation may
  perform the one-vector dimension probe.

## Tests

Coverage includes:

- unreachable and failed Ollama endpoints;
- full and unknown capability sets;
- multi-capability models;
- failed `/api/show` recovery and forced refresh;
- bounded discovery concurrency;
- `/api/show` dimension extraction and `/api/embed` fallback;
- `ONNX_EMBED` precedence;
- invalid explicit provider visibility;
- direct provider-pair validation;
- legacy `DENSE_MODEL` shadow reporting;
- capability-filtered model selectors;
- read-only and dynamically updated vector dimensions;
- save blocking when the selected embedding dimension is unknown.

## Verification

Targeted provider/settings suite:

```powershell
$env:NODE_OPTIONS = '--max-old-space-size=768'
node --test --test-concurrency=1 `
  tests/unit/core/ollama.test.js `
  tests/unit/core/ollama-models.test.js `
  tests/unit/core/settings/service.test.js `
  tests/unit/admin/api/ollama-models.test.js `
  tests/unit/admin/ui-global-settings.test.js
```

Result: 169 passed, 0 failed.

Repository-wide verification:

- unit tests: 1551 passed, 0 failed;
- smoke tests: 1293 passed, 0 failed;
- `npm run admin:build`: passed;
- `git diff --check`: passed, with only expected Windows LF/CRLF notices.

## Files

- `src/core/ollama.js`
- `src/core/ollama-models.js`
- `src/core/env.js`
- `src/core/config.js`
- `src/core/onnx-paths.js`
- `src/core/onnx-embed.js`
- `src/core/token-count.js`
- `src/core/settings/definitions.js`
- `src/core/settings/service.js`
- `src/indexer/run.js`
- `src/sync.js`
- `src/admin/api/ollama-models.js`
- `src/admin/server.js`
- `src/admin/ui-src/global-settings-view.js`
- corresponding unit tests
