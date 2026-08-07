// Typed "runtime unavailable" OnnxEmbedCapability — returned by a
// composition root (mcp/server.js, admin/bootstrap.js via server-full.js)
// when resolveOnnxRuntimeForProcess()'s own prepareOnnxRuntimeProcessEnv()
// step reports a broken managed/custom runtime (e.g. the recorded cuDNN
// bin directory has vanished since install). Review finding (P2): a
// long-lived server process must never silently attempt to load a
// runtime this function already proved is broken and fail confusingly
// deep inside a real embed call later — every method throws immediately,
// with the SAME diagnostic reason recorded at resolution time, so a
// caller sees exactly why ONNX embedding is unavailable right away.
//
// Mirrors admin/composition/lite.js's own unavailableOnnxEmbedCapability()
// shape exactly (same REQUIRED_ONNX_EMBED_CAPABILITY_METHODS contract,
// same always-safe-no-op shutdown()) — that one exists because Lite never
// has a local ONNX runtime at all; this one exists because Full's
// selected local ONNX runtime turned out to be broken. Two different
// reasons, one shared shape.
import { REQUIRED_ONNX_EMBED_CAPABILITY_METHODS } from '../../core/onnx-embed-capability.js';

export class OnnxRuntimeUnavailableError extends Error {
  constructor(reason, method) {
    super(`ONNX embedding is unavailable: ${reason} (attempted via ${method}())`);
    this.name = 'OnnxRuntimeUnavailableError';
    this.code = 'onnx_runtime_unavailable';
    this.reason = reason;
  }
}

/**
 * @param {string} reason — the exact `prepared.reason` string from
 *   prepareOnnxRuntimeProcessEnv()'s own non-ok result, so the thrown
 *   error names the real, specific cause (e.g. a vanished cuDNN
 *   directory) rather than a generic "unavailable" message.
 * @returns {import('../../core/onnx-embed-capability.js').OnnxEmbedCapability}
 */
export function createOnnxRuntimeUnavailableCapability(reason) {
  const capability = {};
  for (const m of REQUIRED_ONNX_EMBED_CAPABILITY_METHODS) {
    capability[m] = async () => { throw new OnnxRuntimeUnavailableError(reason, m); };
  }
  // shutdown must stay a safe no-op regardless (see this file's own header
  // comment / onnx-embed-capability.js's own always-safe-no-op contract) —
  // indexer/run.js and any other real caller calls this unconditionally in
  // a `finally` block, and no session was ever created here to release.
  capability.shutdown = async () => { /* no-op: no ONNX session is ever created by this capability */ };
  return capability;
}
