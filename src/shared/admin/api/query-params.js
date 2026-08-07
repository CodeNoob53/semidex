// Query-string parsing/validation helpers shared by the read/navigation API
// handlers. Local to src/admin/api/ — not promoted to core, since these are
// HTTP-input-shaping concerns, not domain logic.
import { badRequest } from '../../../core/http/http.js';

/**
 * Parse an optional integer query param, bounded to [min, max].
 * Throws 400 for a non-integer value. Missing/empty param returns
 * defaultValue without touching min/max.
 *
 * Out-of-range handling is independently configurable per bound via
 * `belowMin`/`aboveMax` ('clamp' | 'reject', default 'clamp' for both) —
 * different endpoints in this API intentionally clamp one side and reject
 * the other (e.g. `limit`: reject <1 as a likely client bug, clamp >1000 as
 * a safe cap on an honest "give me a lot" request).
 */
export function parseIntParam(query, name, {
  defaultValue, min = -Infinity, max = Infinity, belowMin = 'clamp', aboveMax = 'clamp',
} = {}) {
  const raw = query.get(name);
  if (raw === null || raw === '') return defaultValue;

  if (!/^-?\d+$/.test(raw)) {
    throw badRequest(`Query param "${name}" must be an integer, got "${raw}"`);
  }
  const value = Number(raw);

  if (value < min) {
    if (belowMin === 'clamp') return min;
    throw badRequest(`Query param "${name}" must be >= ${min}, got ${value}`);
  }
  if (value > max) {
    if (aboveMax === 'clamp') return max;
    throw badRequest(`Query param "${name}" must be <= ${max}, got ${value}`);
  }
  return value;
}

/**
 * Require an integer query param (no default — missing throws 400 with a
 * "required" message rather than silently returning undefined). Bounds
 * behave exactly like parseIntParam.
 */
export function requireIntParam(query, name, { min = -Infinity, max = Infinity, belowMin = 'clamp', aboveMax = 'clamp' } = {}) {
  const raw = query.get(name);
  if (raw === null || raw === '') {
    throw badRequest(`Query param "${name}" is required`);
  }
  return parseIntParam(query, name, { min, max, belowMin, aboveMax });
}

/**
 * Require exactly one of the given query param names to be present
 * (non-empty). Returns { key, value } for whichever one was provided.
 * Throws 400 if zero or more than one is present.
 */
export function requireExactlyOne(query, names) {
  const present = names.filter((n) => {
    const v = query.get(n);
    return v !== null && v !== '';
  });
  if (present.length === 0) {
    throw badRequest(`Provide exactly one of: ${names.join(', ')}`);
  }
  if (present.length > 1) {
    throw badRequest(`Provide exactly one of: ${names.join(', ')} (got ${present.join(', ')})`);
  }
  const key = present[0];
  return { key, value: query.get(key) };
}

/**
 * Require a non-empty string query param. Throws 400 if missing/empty.
 */
export function requireStringParam(query, name) {
  const raw = query.get(name);
  if (raw === null || raw === '') {
    throw badRequest(`Query param "${name}" is required`);
  }
  return raw;
}
