// Stable facade over the semidex Qdrant adapter (src/core/qdrant/).
//
// Existing imports (`from './core/qdrant.js'`) keep working unchanged.
// New code may import the specific submodule instead:
//   client.js  — lazy SDK client + cache reset + error helpers
//   store.js   — network operations
//   payload.js — pure payload helpers (safe without QDRANT_URL)
//   schema.js  — canonical collection schema constants
export * from './qdrant/index.js';
