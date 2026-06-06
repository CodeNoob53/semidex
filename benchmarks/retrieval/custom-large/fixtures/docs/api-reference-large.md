# semidex API Reference

semidex exposes a local REST API for retrieval, indexing, and collection navigation. This reference covers all available endpoints.

## Authentication

All requests must be authenticated using the `X-Semidex-API-Token` header.

[[BENCH_ANCHOR: API_AUTH_TOKEN]]
**Header:** `X-Semidex-API-Token: <YOUR_TOKEN>`

## Search Endpoints

[[BENCH_ANCHOR: API_SEARCH_REQUEST]]
### Search Documents

Performs a hybrid dense+sparse search across all indexed chunks. Supports tag filtering, source filtering, and optional reranking.

**Endpoint:** `POST /v1/search`

**Headers:**
* `Content-Type: application/json`
* `X-Semidex-API-Token: <TOKEN>`

**Request Body:**
```json
{
  "query": "What are the key differences between RAG and fine-tuning?",
  "top_k": 10,
  "rerank": true,
  "filter": {
    "tag_filter": ["technical", "architecture"],
    "source_file": "project_specs.md"
  },
  "window": 1
}
```

**Parameters:**
* `query` (string): The search query.
* `top_k` (integer): Number of top results to return.
* `rerank` (boolean): If true, applies the cross-encoder reranking model.
* `filter` (object): Compound filter supporting `tag_filter` and `source_file`.
* `window` (integer): If set, returns adjacent chunks on each side of each result.

**Example Request (cURL):**
```bash
curl -X POST "http://localhost:8080/v1/search" \
     -H "X-Semidex-API-Token: <TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{
           "query": "Explain the deployment pipeline.",
           "top_k": 5,
           "rerank": true,
           "filter": {
             "tag_filter": ["deployment"],
             "source_file": "ci_cd.yaml"
           }
         }'
```

**Example Response (JSON):**
```json
{
  "results": [
    {
      "score": 0.921,
      "chunk_id": "abc123xyz",
      "text_snippet": "The pipeline involves build, test, and deploy stages...",
      "metadata": {
        "source_file": "ci_cd.yaml",
        "tags": ["deployment", "ci"]
      }
    }
  ],
  "metadata": {
    "total_hits": 150,
    "processed_by": "semidex v2"
  }
}
```

### Retrieve Specific Chunk

Retrieves a chunk directly using its source file and index.

**Endpoint:** `GET /v1/chunks/{source_file}/{chunk_index}`

**Example Request (cURL):**
```bash
curl -X GET "http://localhost:8080/v1/chunks/user_manual.pdf/42" \
     -H "X-Semidex-API-Token: <TOKEN>"
```

### List Files in Collection

Returns all source files indexed in a collection, optionally scoped to a directory prefix.

[[BENCH_ANCHOR: API_LIST_FILES]]
**Endpoint:** `GET /v1/files`

**Query Params:** `?collection=my-docs&directory=docs/`

**Example Response:**
```json
{
  "files": ["docs/architecture.md", "docs/configuration.md", "docs/retrieval.md"],
  "collection": "my-docs"
}
```

## Indexing Endpoints

### Batch Indexing

Indexes multiple documents or chunks in a single transaction.

[[BENCH_ANCHOR: API_BATCH_INDEX]]
**Endpoint:** `POST /v1/index/batch`

**Headers:**
* `Content-Type: application/json`

**Request Body:**
```json
{
  "chunks": [
    {"text": "Chunk A content...", "source": "doc1.txt", "tags": ["doc1"]},
    {"text": "Chunk B content...", "source": "doc2.txt", "tags": ["doc2"]}
  ],
  "batch_size": 500
}
```

**CLI Example (Batch Indexing):**
```bash
COLLECTION=my-docs npm run index ./data/ -- --batch-size 100 --tag "initial_load"
```

### Vector Upsert

Manually upserts vectors and associated metadata, bypassing file parsing.

[[BENCH_ANCHOR: API_VECTOR_UPSERT]]
**Endpoint:** `POST /v1/vectors/upsert`

**Request Body:**
```json
{
  "vectors": [
    {"id": "vec_001", "embedding": [0.1, 0.2], "metadata": {"source": "manual", "tags": ["manual"]}}
  ],
  "batch_size": 100
}
```

## Utility and Status Endpoints

### Health Check

Checks the operational status of the semidex service.

[[BENCH_ANCHOR: API_HEALTH_CHECK]]
**Endpoint:** `GET /v1/health`

**Response:**
```json
{
  "status": "OPERATIONAL",
  "health_status": "ready",
  "uptime_seconds": 86400,
  "version": "2.0.0"
}
```

### Streaming Indexing Status

Monitors the progress of a long-running indexing job.

[[BENCH_ANCHOR: API_STREAMING_STATUS]]
**Endpoint:** `GET /v1/status/stream/{job_id}`

**Response:**
```json
{
  "job_id": "job_xyz789",
  "status": "IN_PROGRESS",
  "progress_percent": 65,
  "processed_count": 12500,
  "estimated_remaining_seconds": 300
}
```

### Filtering by Tags

Retrieves metadata or chunks matching specific tags across the index.

[[BENCH_ANCHOR: API_FILTER_TAGS]]
**Endpoint:** `GET /v1/filter/tags`

**Query Params:** `?tags=security,compliance`

### Filtering by Source File

Retrieves all indexed chunks originating from a specific file path.

[[BENCH_ANCHOR: API_SOURCE_FILE_FILTER]]
**Endpoint:** `GET /v1/filter/source`

**Query Params:** `?source_file=api_spec.json`

## Error Handling

All API errors return a standardized schema for programmatic handling.

[[BENCH_ANCHOR: API_ERROR_SCHEMA]]
**Example Error Response (JSON):**
```json
{
  "type": "SemidexApiError",
  "error_code": "INVALID_ARGUMENT",
  "message": "The 'top_k' parameter must be a positive integer.",
  "details": [
    {"field": "top_k", "reason": "Must be > 0"}
  ],
  "http_status": 400
}
```

## Advanced Usage Notes

[[BENCH_ANCHOR: API_RERANK_FLAG]]
### Reranking Control

When searching, setting `rerank=true` triggers the cross-encoder model, significantly improving relevance over pure vector similarity scores.

### Chunk Retrieval Window

To fetch a chunk and its surrounding context (preceding and succeeding chunks), use the dedicated endpoint.

[[BENCH_ANCHOR: API_GET_CHUNK_WINDOW]]
**Endpoint:** `GET /v1/chunks/window/{source_file}/{chunk_index}`

### Search Parameters Summary

| Parameter | Type | Description | Required |
| :--- | :--- | :--- | :--- |
| `query` | string | Search text. | Yes |
| `rerank` | boolean | Enable cross-encoder reranking. | No |
| `tag_filter` | array | List of tags to restrict results. | No |
| `source_file` | string | Filter by exact source file name. | No |
| `window` | integer | Number of adjacent chunks to return on each side. | No |

### Rate Limiting and Pagination

All endpoints support standard pagination via `limit` and `offset` query parameters. Exceeding rate limits returns HTTP 429.
