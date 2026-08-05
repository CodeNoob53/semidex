// Cheap, routine ONNX lane availability check — file-existence only, NEVER
// loads the model or creates an inference session. Distinct from the
// expensive explicit-probe path (src/local/core/onnx-provider-probe.js's
// probeOnnxProvider(), which actually creates an InferenceSession and can
// take tens of seconds / load ~2.3GB) — that path is used ONLY by
// deliberate, explicit actions (npm run doctor, the Admin API's existing
// POST /api/system/onnx-probe endpoint), never by routine collection
// browsing/availability resolution.
import { isOnnxModelCached } from '../onnx-paths.js';
import { LANE_STATUS } from './availability.js';

/**
 * @param {{ requiredModel: string }} opts — requiredModel is accepted for
 *   parity with checkOllamaLane's signature, but is not currently used to
 *   distinguish between different cached ONNX models (this codebase caches
 *   exactly one ONNX dense model at a time, per ONNX_DENSE_MODEL_ID).
 * @returns {Promise<{ status: string }>}
 */
export async function checkOnnxModelCached() {
  return { status: isOnnxModelCached() ? LANE_STATUS.MODEL_CACHED : LANE_STATUS.NOT_CACHED };
}
