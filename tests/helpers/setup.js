// Shared test bootstrap. Import this FIRST in every test file — before any
// import from src/ — so that module-level env reads in src/ see hermetic
// defaults instead of a developer's .env or an empty CI environment.
//
// Why set instead of delete: src modules load `dotenv/config` themselves, and
// dotenv only fills in variables that are still unset. Setting explicit values
// here guarantees they survive the dotenv pass.

// src/core/qdrant.js creates its SDK client lazily and no longer needs
// QDRANT_URL at import time. The default below is kept anyway so that any
// test accidentally reaching a lazy client constructor gets a predictable
// local URL instead of a developer's cloud instance from .env.
// (tests/unit/core/qdrant-lazy.test.js skips this file on purpose.)
process.env.QDRANT_URL ??= 'http://localhost:6333';

// Force optional reranker paths off regardless of local .env contents, so
// unit tests exercise the default pipeline deterministically.
process.env.RERANK_ENABLED = '0';
process.env.RERANK_CE_ENABLED = '0';
