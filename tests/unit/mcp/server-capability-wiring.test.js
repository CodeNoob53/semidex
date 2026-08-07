// Phase 8B Step 1, code review (multiple rounds) — proves src/mcp/server.js's
// real startup sequence binds tools/search.js's own runHybridSearch() call
// to this process's real capability explicitly via search.setEmbedQuery()
// — the actual per-call isolation fix (round 3): "last call wins" on a
// shared embeddings.js singleton (via applyEmbeddingCapabilities()) is not
// real isolation between composition roots that might share one process.
//
// Round 4: mcp/server.js no longer calls applyEmbeddingCapabilities() at
// all (removed as redundant once every real request path — here, only
// search.setEmbedQuery()'s own bound closure — receives its capability
// explicitly per call; see that file's own header comment). The shared
// embeddings.js module-scope fallback is left completely untouched by
// this file in either direction.
//
// mcp/server.js is a self-starting isMainModule-shaped script (it
// connects a real MCP stdio server transport on import, with no guard —
// unlike admin/server-full.js's createApp(), it cannot be imported as a
// library in a test without actually starting a server), so this test
// proves the fix via source inspection only, the same approach
// tests/unit/indexer/index-capability-wiring.test.js already uses for
// indexer/index-full.js's own equivalent fix.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('mcp/server.js — never calls applyEmbeddingCapabilities() (code review, round 4)', () => {
  const src = readFileSync(new URL('../../../src/mcp/server.js', import.meta.url), 'utf-8');

  it('imports embedForSearch from shared/core/embeddings.js, but not applyEmbeddingCapabilities', () => {
    assert.match(src, /\{\s*embedForSearch\s*}\s*=\s*await import\(['"]\.\.\/shared\/core\/embeddings\.js['"]\)/);
    // Doesn't grep for the bare identifier — this file's own header
    // comment legitimately mentions applyEmbeddingCapabilities() in prose
    // explaining why it is no longer called. What must be absent is an
    // actual import of it or a call to it.
    assert.doesNotMatch(src, /import\s*\{[^}]*\bapplyEmbeddingCapabilities\b[^}]*\}/);
    assert.doesNotMatch(src, /(?<!\/\/[^\n]*)\bapplyEmbeddingCapabilities\s*\(/);
  });

  it('still dynamically imports the real ollama-lazy.js module for search.setEmbedQuery()\'s own bound closure', () => {
    assert.match(src, /await import\(['"]\.\.\/core\/ollama-lazy\.js['"]\)/);
  });

  it('resolves onnxEmbed via mcp/onnx-runtime-resolution.js\'s resolveOnnxEmbedCapabilityForMcp() — review finding (P1): this is what makes a managed CUDA selection (ONNX_MANAGED_RUNTIME) actually reach the MCP process; real behavioral coverage lives in tests/unit/mcp/onnx-runtime-resolution.test.js, this is structural wiring proof only', () => {
    assert.match(src, /import \{ resolveOnnxEmbedCapabilityForMcp \} from '\.\/onnx-runtime-resolution\.js'/);
    assert.match(src, /const onnxEmbed = await resolveOnnxEmbedCapabilityForMcp\(\{ settingsService \}\);/);
    // onnx-embed-lazy.js's createOnnxEmbeddingCapability() itself is no
    // longer imported/called directly in THIS file — it moved into
    // onnx-runtime-resolution.js, which is the one place that decides
    // between the real capability and the typed-unavailable one.
    assert.doesNotMatch(src, /await import\(['"]\.\.\/core\/onnx-embed-lazy\.js['"]\)/);
  });
});

describe('mcp/server.js — the real per-call isolation fix: search.setEmbedQuery() binds runHybridSearch() to this process\'s own capability', () => {
  const src = readFileSync(new URL('../../../src/mcp/server.js', import.meta.url), 'utf-8');

  it('calls search.setEmbedQuery() with a closure that calls embedForSearch(profile, query, { capabilities })', () => {
    const lineMatch = src.split('\n').find((line) => !line.trim().startsWith('//') && line.includes('search.setEmbedQuery('));
    assert.ok(lineMatch, 'expected a real (non-comment) search.setEmbedQuery(...) call');
    assert.match(lineMatch, /embedForSearch\(profile,\s*query,\s*\{\s*capabilities:/);
    assert.match(lineMatch, /ollama:\s*ollamaLazy/);
    assert.match(lineMatch, /onnxEmbed\b/);
  });

  it('search.setEmbedQuery() is called after search.setSettingsService(), before the server starts handling requests', () => {
    const codeOnly = src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    const setSettingsIndex = codeOnly.indexOf('search.setSettingsService(');
    const setEmbedQueryIndex = codeOnly.indexOf('search.setEmbedQuery(');
    const connectIndex = codeOnly.indexOf('await server.connect(');
    assert.ok(setSettingsIndex >= 0 && setEmbedQueryIndex > setSettingsIndex, 'setEmbedQuery() must run after setSettingsService()');
    assert.ok(connectIndex > setEmbedQueryIndex, 'setEmbedQuery() must run before the server starts accepting connections');
  });
});

describe('mcp/tools/search.js — setEmbedQuery() override seam', () => {
  it('exports setEmbedQuery, mirroring the existing setStorageAdapter/setSettingsService DI convention', async () => {
    const mod = await import('../../../src/mcp/tools/search.js');
    assert.equal(typeof mod.setEmbedQuery, 'function');
  });
});
