// Boot capability object (design plan §6, §13 S1, §16 D-1). Resolved ONCE
// per app boot from GET /api/capabilities (storage capability — today the
// only capability data available over HTTP, GAP-01: no edition/feature
// manifest exists server-side yet) plus a build-time edition constant the
// Full/Lite entry point supplies directly (entries/full.js -> 'full',
// entries/lite.js -> 'lite') — never probed, never inferred from
// `if (edition === 'lite')` scattered through feature views. Module-level
// singleton state, same convention as operation-store.js/status/store.js
// (this module's boot fetch runs once, at app startup — see app.js — and
// the result is reused for the app's whole lifetime).
//
// Capability is presentation/composition data, never authorization — the
// server enforces every edition-gated action independently
// (api/jobs.js:95, service.lite.js). This module exposes read-only,
// deep-frozen plain data so nothing downstream can accidentally treat a
// mutated local copy as authoritative.
import { apiGet, ApiError } from '../api/client.js';
import { validateCapabilitiesResponse } from '../api/contracts/capabilities.js';

const EDITIONS = new Set(['full', 'lite']);

let bootPromise = null; // set synchronously by the first bootCapabilities() call — later calls reuse it rather than issuing a second /api/capabilities fetch
let resolvedValue = null; // set once bootPromise settles successfully; stays null on failure (whenCapabilitiesReady()'s promise carries the rejection instead)
let configuredEdition = null;
let resolvedError = null;

function freezeDeep(value) {
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    return Object.freeze(value);
  }
  return value;
}

/**
 * Starts (or reuses) the one boot capability fetch. Must be called exactly
 * once by the app's composition entry point (app.js's startAdminApp), with
 * the edition it was built for — see entries/full.js / entries/lite.js.
 * A second call (e.g. an accidental double startAdminApp()) is safe: it
 * reuses the same in-flight/resolved promise rather than issuing a second
 * request.
 * @param {{ edition: 'full'|'lite' }} opts
 * @returns {Promise<{ edition: 'full'|'lite', storage: { backend: string, capabilities: object } }>}
 */
export function bootCapabilities({ edition } = {}) {
  if (!EDITIONS.has(edition)) {
    throw new TypeError(`bootCapabilities({ edition }): edition must be 'full' or 'lite', got ${JSON.stringify(edition)}`);
  }
  if (bootPromise) return bootPromise;
  configuredEdition = edition;
  bootPromise = (async () => {
    const body = validateCapabilitiesResponse(await apiGet('/api/capabilities'));
    resolvedValue = freezeDeep({ edition, storage: { backend: body.backend, capabilities: body.capabilities } });
    return resolvedValue;
  })().catch((err) => {
    resolvedError = err;
    throw err;
  });
  return bootPromise;
}

/**
 * Synchronous accessor — null until bootCapabilities()'s promise has
 * resolved (or if it rejected). Feature views that can tolerate "not ready
 * yet" (e.g. render a neutral placeholder, then re-render once
 * whenCapabilitiesReady() settles) read this directly.
 */
export function capabilities() {
  return resolvedValue;
}

export function capabilityEdition() {
  return configuredEdition;
}

export function capabilityError() {
  return resolvedError;
}

/**
 * Returns the SAME promise bootCapabilities() started — never issues a
 * second /api/capabilities request. A feature view (e.g. Overview) that
 * needs the resolved value awaits this instead of calling
 * bootCapabilities() itself, since only the app entry point knows the
 * build-time edition constant.
 * @throws {Error} if bootCapabilities() has not been called yet — a real
 *   programming-order bug (the app entry point must boot capabilities
 *   before mounting any view that reads them), not a runtime condition a
 *   feature view should have to handle defensively.
 */
export function whenCapabilitiesReady() {
  if (!bootPromise) {
    throw new Error('whenCapabilitiesReady() called before bootCapabilities({ edition }) — the app entry point must boot capabilities at startup');
  }
  return bootPromise;
}

export { ApiError };

/** Test-only: clears memoized state so each test starts from a clean module. */
export function resetCapabilitiesForTests() {
  bootPromise = null;
  resolvedValue = null;
  configuredEdition = null;
  resolvedError = null;
}
