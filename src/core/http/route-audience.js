// Route metadata vocabulary and the fail-closed contract that every route
// registration must satisfy. Zero dependencies — pure constants plus a
// validator, so both the router (src/shared/admin/router.js) and any test or
// tooling can import it without pulling in HTTP, storage, or composition code.
//
// WHY THIS EXISTS
// ---------------
// docs/security/semidex-lite-public-api-audit-2026-08.md §10 step 3: the
// admin surface and the application-facing integration surface have
// genuinely different callers, threat models and credential needs, and
// conflating them is what makes a single shared secret collapse. Before any
// bearer key, scope, collection allow-list or rate limit can be added, every
// route must declare WHICH surface it belongs to — otherwise the first
// credential shipped would be attached to a boundary nobody had actually
// drawn.
//
// The declaration is mandatory and validated at registration time
// (fail-closed): a route with no audience throws when it is registered, which
// surfaces at server construction and in tests, never as a silently-unguarded
// route in production. There is deliberately no default: defaulting to
// "admin" would silently mis-scope a new public endpoint, and defaulting to
// "integration" would silently expose a new management endpoint. Both
// failure modes are worse than a startup error.
//
// This module carries NO authorization logic and NO credentials. It only
// makes the boundary explicit and machine-readable so the next phase has one
// obvious place to attach policy. See the audit's §12c for that follow-up.

/**
 * Which trust surface a route belongs to.
 *
 * - `admin`: dashboard/management. Settings, collection CRUD, indexing jobs,
 *   schema sync, folder picker, probes/status, and the dashboard's own
 *   internal search. Intended to stay loopback-bound; never safe to expose to
 *   an untrusted caller.
 * - `integration`: stable, versioned, application-facing routes a third-party
 *   backend calls (a website, bot, or wrapper service). Currently Ask v1/v2
 *   only. This is the surface that will receive bearer keys and collection
 *   scopes in the next phase.
 */
export const AUDIENCE = Object.freeze({
  ADMIN: 'admin',
  INTEGRATION: 'integration',
});

const AUDIENCE_VALUES = new Set(Object.values(AUDIENCE));

/** What the route does. Drives future audit events and scope names. */
export const OPERATION = Object.freeze({
  READ: 'read',
  SEARCH: 'search',
  GENERATE: 'generate',
  INDEX: 'index',
  MUTATE: 'mutate',
  DELETE: 'delete',
  PROBE: 'probe',
});

const OPERATION_VALUES = new Set(Object.values(OPERATION));

/**
 * What the route costs to serve. Drives future rate limiting — OWASP
 * API4:2023 (Unrestricted Resource Consumption) is specifically about paid
 * per-request third-party integrations, which `llm` and `qdrant` are.
 *
 * - `low`: in-process only (registry reads, static capability flags).
 * - `qdrant`: one or more Qdrant round-trips.
 * - `llm`: billed generation (Gemini) — the most expensive class.
 * - `indexing`: spawns a subprocess and does sustained work.
 * - `system`: touches the OS (dialogs, runtime probes, local providers).
 */
export const COST_CLASS = Object.freeze({
  LOW: 'low',
  QDRANT: 'qdrant',
  LLM: 'llm',
  INDEXING: 'indexing',
  SYSTEM: 'system',
});

const COST_CLASS_VALUES = new Set(Object.values(COST_CLASS));

/**
 * Where the target collection name comes from, if any. This is the field the
 * next phase's object-level authorization (OWASP API1:2023) keys off: every
 * client-supplied object identifier must be authorized per request, and this
 * says where to find that identifier.
 *
 * - `none`: no collection involved.
 * - `path`: from a route param (`/api/collections/:name/...`).
 * - `body`: from the request body (`{ collection: "..." }`).
 * - `query`: from the query string.
 */
export const COLLECTION_SOURCE = Object.freeze({
  NONE: 'none',
  PATH: 'path',
  BODY: 'body',
  QUERY: 'query',
});

const COLLECTION_SOURCE_VALUES = new Set(Object.values(COLLECTION_SOURCE));

/** Which edition serves the route. */
export const EDITION = Object.freeze({
  SHARED: 'shared',
  FULL: 'full',
  LITE: 'lite',
});

const EDITION_VALUES = new Set(Object.values(EDITION));

function fail(method, path, message) {
  throw new Error(
    `Route registration rejected for ${method} ${path}: ${message}\n` +
    'Every route must declare its trust surface explicitly — see ' +
    'src/core/http/route-audience.js and the Admin/Integration boundary in ' +
    'docs/security/semidex-lite-public-api-audit-2026-08.md.'
  );
}

/**
 * Validates and freezes a route's metadata. Throws on anything missing or
 * unrecognized — there is no default audience, by design (see header).
 *
 * @param {string} method
 * @param {string} path
 * @param {{
 *   audience: string,
 *   operation: string,
 *   costClass: string,
 *   resourceType?: string,
 *   collectionSource?: string,
 *   edition?: string,
 * }} meta
 * @returns {Readonly<Object>} the normalized, frozen metadata
 */
export function validateRouteMeta(method, path, meta) {
  if (meta === undefined || meta === null) {
    fail(method, path, 'no route metadata was supplied (audience is mandatory).');
  }
  if (typeof meta !== 'object') {
    fail(method, path, `route metadata must be an object, received ${typeof meta}.`);
  }

  const { audience, operation, costClass } = meta;

  if (audience === undefined) {
    fail(method, path, 'metadata is missing the required "audience" field.');
  }
  if (!AUDIENCE_VALUES.has(audience)) {
    fail(method, path, `unknown audience "${audience}" (expected one of: ${[...AUDIENCE_VALUES].join(', ')}).`);
  }
  if (operation === undefined) {
    fail(method, path, 'metadata is missing the required "operation" field.');
  }
  if (!OPERATION_VALUES.has(operation)) {
    fail(method, path, `unknown operation "${operation}" (expected one of: ${[...OPERATION_VALUES].join(', ')}).`);
  }
  if (costClass === undefined) {
    fail(method, path, 'metadata is missing the required "costClass" field.');
  }
  if (!COST_CLASS_VALUES.has(costClass)) {
    fail(method, path, `unknown costClass "${costClass}" (expected one of: ${[...COST_CLASS_VALUES].join(', ')}).`);
  }

  const collectionSource = meta.collectionSource ?? COLLECTION_SOURCE.NONE;
  if (!COLLECTION_SOURCE_VALUES.has(collectionSource)) {
    fail(method, path, `unknown collectionSource "${collectionSource}" (expected one of: ${[...COLLECTION_SOURCE_VALUES].join(', ')}).`);
  }

  const edition = meta.edition ?? EDITION.SHARED;
  if (!EDITION_VALUES.has(edition)) {
    fail(method, path, `unknown edition "${edition}" (expected one of: ${[...EDITION_VALUES].join(', ')}).`);
  }

  return Object.freeze({
    method,
    path,
    audience,
    operation,
    resourceType: meta.resourceType ?? 'none',
    collectionSource,
    costClass,
    edition,
  });
}
