// Public surface of the semidex Qdrant adapter.
//
// Consumers (indexer, MCP tools, sync, backfill, benchmarks) import from
// src/core/qdrant.js (stable facade) or from the specific submodule:
//   client.js        — lazy SDK client, cache reset, error helpers
//   store.js         — all network operations
//   payload.js       — pure payload helpers and field constants
//   schema.js        — canonical vector schema and required payload indexes
//   ensure-schema.js — idempotent per-collection index/sparse-vector repair
export * from './client.js';
export * from './store.js';
export * from './payload.js';
export * from './schema.js';
export * from './ensure-schema.js';
