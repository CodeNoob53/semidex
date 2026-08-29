// Hand-written response validators for GET /api/operations and
// GET /api/operations/:id (design plan §15 item 3). Field-by-field derived
// from src/shared/admin/api/operations.js's jobToOperation()/
// taskToOperation() projections — the two functions that build every
// operation object either endpoint can ever send:
//
//   { id, kind: 'index'|'reindex'|'repair', collection, path,
//     state: 'queued'|'running'|'cancelling'|'succeeded'|'failed'|'cancelled',
//     startedAt, finishedAt, cancellable,
//     progress: { percent, phase, currentFile, processedFiles, totalFiles } | null,
//     error }
//
// The :id detail route additionally spreads `sourcePath` and `log` onto the
// same shape (src/shared/admin/api/operations.js's GET /api/operations/:id
// handler).
//
// Unknown fields are never stripped — a validated operation is the SAME
// object the server sent, so a server-side addition this module doesn't yet
// know about still reaches the UI unchanged (forward compatibility).
import { ApiError } from '../client.js';

const OPERATION_KINDS = new Set(['index', 'reindex', 'repair']);
const OPERATION_STATES = new Set(['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled']);

function contractError(message) {
  return new ApiError({ kind: 'contract', message });
}

function isNullableString(value) {
  return value === null || typeof value === 'string';
}

function isNullableFiniteNumber(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function validateProgress(progress, path) {
  if (progress === null) return;
  if (typeof progress !== 'object' || Array.isArray(progress)) {
    throw contractError(`${path}.progress must be an object or null`);
  }
  if (!isNullableFiniteNumber(progress.percent)) throw contractError(`${path}.progress.percent must be a finite number or null`);
  if (!isNullableString(progress.phase)) throw contractError(`${path}.progress.phase must be a string or null`);
  if (!isNullableString(progress.currentFile)) throw contractError(`${path}.progress.currentFile must be a string or null`);
  if (!isNullableFiniteNumber(progress.processedFiles)) throw contractError(`${path}.progress.processedFiles must be a finite number or null`);
  if (!isNullableFiniteNumber(progress.totalFiles)) throw contractError(`${path}.progress.totalFiles must be a finite number or null`);
}

// Every one of these fields is unconditionally emitted by
// jobToOperation()/taskToOperation() for every operation, in every state —
// there is no code path in either projection that omits any of them (path/
// error are set to `null`, never left off the object). "Nullable" describes
// the VALUE (`string | null`), not whether the KEY may be absent — a
// response missing one of these keys is exactly as malformed as one with a
// wrong-typed value, so presence is required for all of them, matched by
// `op.path !== undefined` (a missing key reads back as `undefined`, which
// fails the isNullableString/isNullableFiniteNumber check the same as any
// other wrong type — no separate "has own property" check is needed, this
// comment just states the intent so a future edit doesn't accidentally
// relax it back to "checked only when present").
function validateOperationShape(op, path) {
  if (typeof op !== 'object' || op === null || Array.isArray(op)) {
    throw contractError(`${path} must be an object`);
  }
  if (typeof op.id !== 'string' || op.id === '') {
    throw contractError(`${path}.id must be a non-empty string`);
  }
  if (typeof op.kind !== 'string' || !OPERATION_KINDS.has(op.kind)) {
    throw contractError(`${path}.kind must be one of "index", "reindex", "repair"`);
  }
  if (typeof op.collection !== 'string') {
    throw contractError(`${path}.collection must be a string`);
  }
  if (!isNullableString(op.path)) {
    throw contractError(`${path}.path must be a string or null`);
  }
  if (typeof op.state !== 'string' || !OPERATION_STATES.has(op.state)) {
    throw contractError(`${path}.state must be a known operation state`);
  }
  if (!isNullableString(op.startedAt)) {
    throw contractError(`${path}.startedAt must be a string or null`);
  }
  if (!isNullableString(op.finishedAt)) {
    throw contractError(`${path}.finishedAt must be a string or null`);
  }
  if (typeof op.cancellable !== 'boolean') {
    throw contractError(`${path}.cancellable must be a boolean`);
  }
  if (!('progress' in op)) {
    throw contractError(`${path}.progress is required`);
  }
  validateProgress(op.progress, path);
  if (!isNullableString(op.error)) {
    throw contractError(`${path}.error must be a string or null`);
  }
  return op;
}

/**
 * Validates a GET /api/operations response body: `{ operations: [...] }`.
 * Throws ApiError{kind:'contract'} on any malformed required field. Returns
 * the same body object on success.
 */
export function validateOperationsListResponse(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw contractError('GET /api/operations response must be an object');
  }
  if (!Array.isArray(body.operations)) {
    throw contractError('GET /api/operations response field "operations" must be an array');
  }
  body.operations.forEach((op, index) => validateOperationShape(op, `operations[${index}]`));
  return body;
}

/**
 * Validates a GET /api/operations/:id response body: `{ operation: {...} }`,
 * including the detail-only `sourcePath`/`log` fields. Throws
 * ApiError{kind:'contract'} on any malformed required field. Returns the
 * same body object on success.
 */
export function validateOperationDetailResponse(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw contractError('GET /api/operations/:id response must be an object');
  }
  const op = validateOperationShape(body.operation, 'operation');
  if (!isNullableString(op.sourcePath)) {
    throw contractError('operation.sourcePath must be a string or null');
  }
  if (!Array.isArray(op.log) || op.log.some((line) => typeof line !== 'string')) {
    throw contractError('operation.log must be an array of strings');
  }
  return body;
}
