// Resolves which onnxruntime-node build mcp/server.js's own onnxEmbed
// capability should use — pulled into its own small, importable module
// specifically so it has real behavioral test coverage (see
// tests/unit/mcp/onnx-runtime-resolution.test.js), unlike mcp/server.js
// itself, which is a self-starting script with no isMainModule guard (it
// connects a real MCP stdio transport unconditionally on import) and so
// cannot safely be imported by a test at all.
//
// Review finding (P1): mcp/server.js used to write settings back into
// process.env via applyEnvWriteBack() but never resolved which
// onnxruntime-node build to actually load — a managed CUDA selection
// (ONNX_MANAGED_RUNTIME) had no effect in the MCP process, so MCP search
// against an ONNX-backed collection could silently load the plain npm
// package (no CUDA) even when Admin/the indexer correctly picked up the
// managed runtime. This function is the ONE place MCP now resolves that,
// via the exact same shared sequence (resolveOnnxRuntimeForProcess())
// indexer/index-full.js and admin/bootstrap.js already go through.
//
// Review finding (P2): a broken resolved runtime (prepared.ok === false —
// e.g. the managed selection's own recorded cuDNN directory has vanished
// since install) must never be silently attempted later, deep inside a
// real search request. MCP is a long-lived server, not a one-shot job —
// it stays up and keeps answering non-ONNX-backed collection queries
// fine, but ONNX embedding itself gets a typed, immediately-throwing
// "unavailable" capability instead of ever trying to load a runtime this
// resolution already proved is broken — exactly mirroring
// admin/bootstrap.js's own onnxEmbedCapability override for createApp().
import { resolveOnnxRuntimeForProcess } from '../local/core/onnx-runtime-source-resolution.js';
import { createOnnxRuntimeUnavailableCapability } from '../local/core/onnx-runtime-unavailable-capability.js';
import { createOnnxEmbeddingCapability } from '../local/core/onnx-embed.js';

/**
 * @param {{
 *   settingsService: { getActiveValue(key: string): string },
 *   env?: NodeJS.ProcessEnv,
 *   resolveOnnxRuntimeForProcessFn?: typeof resolveOnnxRuntimeForProcess,
 *   createOnnxEmbeddingCapabilityFn?: typeof createOnnxEmbeddingCapability,
 *   createOnnxRuntimeUnavailableCapabilityFn?: typeof createOnnxRuntimeUnavailableCapability,
 *   warnLogFn?: (msg: string) => void,
 * }} opts
 * @returns {Promise<import('../shared/core/onnx-embed-capability.js').OnnxEmbedCapability>}
 */
export async function resolveOnnxEmbedCapabilityForMcp({
  settingsService, env = process.env,
  resolveOnnxRuntimeForProcessFn = resolveOnnxRuntimeForProcess,
  createOnnxEmbeddingCapabilityFn = createOnnxEmbeddingCapability,
  createOnnxRuntimeUnavailableCapabilityFn = createOnnxRuntimeUnavailableCapability,
  warnLogFn = console.warn,
}) {
  const onnxRuntimeResolution = resolveOnnxRuntimeForProcessFn({ settingsService, env });
  if (onnxRuntimeResolution.resolutionWarning) warnLogFn(`[mcp] ${onnxRuntimeResolution.resolutionWarning}`);
  if (!onnxRuntimeResolution.prepared.ok) {
    warnLogFn(`[mcp] ${onnxRuntimeResolution.prepared.reason}`);
    return createOnnxRuntimeUnavailableCapabilityFn(onnxRuntimeResolution.prepared.reason);
  }
  return createOnnxEmbeddingCapabilityFn();
}
