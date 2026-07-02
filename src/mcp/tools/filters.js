// Thin re-export for existing MCP tool imports.
//
// The actual nav-filter logic lives in src/core/qdrant/nav-filter.js so the
// storage adapter (src/core/storage/qdrant-adapter.js) can depend on it
// without the core/storage layer importing from src/mcp/ — MCP tools depend
// on core, not the other way around. New code should import from
// core/qdrant/nav-filter.js directly; this file exists only so existing
// `from './filters.js'` imports across src/mcp/tools/ keep working.
export * from '../../core/qdrant/nav-filter.js';
