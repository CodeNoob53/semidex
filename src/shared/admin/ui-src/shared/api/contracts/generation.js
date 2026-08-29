// Hand-written response validator for GET /api/generation/status (design
// plan §5.1, §8.2, §15). Field-by-field derived from
// src/core/generation/runtime.js's getStatus() — the single function that
// builds this response, shared by every generation backend
// (src/shared/admin/api/generation.js's route delegates to it directly):
//
//   { backend: string|null, model: string|null, ready: boolean,
//     reason: string|null, numCtx: number|null, capabilities: object,
//     devicePolicy: { value: string|null, supported: string[] },
//     configuration: object|null }
//
// Overview only ever reads backend/model/ready/reason — capabilities/
// devicePolicy/configuration are validated at presence+shape only (an
// object or null), not deep-validated field-by-field, since no S1 surface
// consumes their nested fields yet; a deeper validator belongs to whichever
// slice first reads inside them (e.g. a future Settings screen). Unknown
// top-level fields are never stripped — the same object the server sent is
// returned unchanged on success.
import { ApiError } from '../client.js';

function contractError(message) {
  return new ApiError({ kind: 'contract', message });
}

function isNullableString(value) {
  return value === null || typeof value === 'string';
}

/**
 * Validates a GET /api/generation/status response body. Throws
 * ApiError{kind:'contract'} on any malformed required field. Returns the
 * same body object on success.
 */
export function validateGenerationStatusResponse(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw contractError('GET /api/generation/status response must be an object');
  }
  if (!isNullableString(body.backend)) {
    throw contractError('generation status field "backend" must be a string or null');
  }
  if (!isNullableString(body.model)) {
    throw contractError('generation status field "model" must be a string or null');
  }
  if (typeof body.ready !== 'boolean') {
    throw contractError('generation status field "ready" must be a boolean');
  }
  if (!isNullableString(body.reason)) {
    throw contractError('generation status field "reason" must be a string or null');
  }
  if (body.numCtx !== null && !(typeof body.numCtx === 'number' && Number.isFinite(body.numCtx))) {
    throw contractError('generation status field "numCtx" must be a finite number or null');
  }
  if (typeof body.capabilities !== 'object' || body.capabilities === null || Array.isArray(body.capabilities)) {
    throw contractError('generation status field "capabilities" must be an object');
  }
  const devicePolicy = body.devicePolicy;
  if (typeof devicePolicy !== 'object' || devicePolicy === null || Array.isArray(devicePolicy)) {
    throw contractError('generation status field "devicePolicy" must be an object');
  }
  if (!isNullableString(devicePolicy.value)) {
    throw contractError('devicePolicy.value must be a string or null');
  }
  if (!Array.isArray(devicePolicy.supported) || devicePolicy.supported.some((v) => typeof v !== 'string')) {
    throw contractError('devicePolicy.supported must be an array of strings');
  }
  if (body.configuration !== null && (typeof body.configuration !== 'object' || Array.isArray(body.configuration))) {
    throw contractError('generation status field "configuration" must be an object or null');
  }
  return body;
}
