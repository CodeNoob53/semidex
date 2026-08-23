// Stage 2 of the two-stage authorization model: object-level authorization
// for a collection identifier that only becomes known AFTER the request body
// has been parsed.
//
// WHY TWO STAGES
// --------------
// OWASP API1:2023 (Broken Object Level Authorization) requires an
// authorization check against the object identifier the CLIENT supplied, on
// every request. For Ask v1/v2 that identifier is `body.collection` — it does
// not exist in the URL, the path params, or any header.
//
// The router's pre-body seam (src/shared/admin/router.js) therefore cannot
// perform this check: a request body is a single-use stream, so a hook that
// read it there would leave the handler with nothing to parse. Splitting the
// concerns is the correct fix, not a workaround:
//
//   Stage 1 — pre-body, in the router: authentication (who is calling?) and
//             coarse rate limiting. Needs only headers, so it runs before any
//             cost is incurred and before the body is touched.
//   Stage 2 — post-parse, HERE: object-level authorization (may this
//             principal touch THIS collection?). Runs after the body has been
//             parsed by the route's own parser and BEFORE the first adapter
//             call, so a denied request performs no Qdrant work.
//
// Keeping stage 2 in this shared module — rather than inline in each route —
// means every collection-bearing route enforces the same contract, and the
// next phase has one function to implement rather than N call sites to audit.
//
// This module contains NO policy of its own. It is the invocation contract
// and the fail-closed wrapper around a caller-supplied hook.

import { HttpError } from './http.js';
import { recordAuditEvent } from '../audit/sink.js';
import { AUDIT_EVENT_TYPE } from '../audit/event.js';

/**
 * Validates that a principal is a plain JSON-like value before it is frozen.
 *
 * WHY THIS IS ENFORCED RATHER THAN DOCUMENTED (review note, 2026-08-18)
 * --------------------------------------------------------------------
 * `deepFreeze()` genuinely protects plain objects and arrays — the shape the
 * principal contract is designed around — but `Object.freeze` is not a
 * general immutability primitive:
 *
 *   - `Map`/`Set`: `Object.freeze` returns **true** for `Object.isFrozen`
 *     while `.set()`/`.add()`/`.delete()` keep working. Internal slots are
 *     not own properties, so freezing touches nothing that matters. A
 *     principal holding `collections` in a `Set` would look frozen and be
 *     fully mutable — the most dangerous outcome of the three, because it
 *     produces a *false* guarantee rather than an obvious failure.
 *   - Typed arrays / `ArrayBuffer` views: `Object.freeze` **throws**
 *     ("Cannot freeze array buffer views with elements"), which would surface
 *     as an opaque 403 from the router's catch rather than a clear
 *     configuration error.
 *   - `Date`, class instances with private state, functions: mutable through
 *     methods or closures that freezing cannot reach.
 *
 * Rather than grow `deepFreeze` into a partial, best-effort deep-clone that
 * silently normalizes some of these and misses others, the principal is
 * constrained to what a bearer-key principal actually needs and what can be
 * genuinely frozen: JSON primitives, plain objects and arrays. A key store
 * loads principals from JSON on disk, so this costs nothing in practice and
 * turns a silent immutability hole into a loud, request-time policy error
 * (the router denies with 403 and logs the reason for the operator). Note
 * this runs per request, not at startup: the principal is produced by stage 1
 * on each call, so there is no earlier point at which its shape is known.
 *
 * @param {unknown} value
 * @param {string} [path] dotted path used in the error message
 * @param {WeakSet<object>} [seen]
 * @throws {TypeError} when the principal contains a non-JSON-like value
 */
export function assertPlainPrincipal(value, path = 'principal', seen = new WeakSet()) {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must be a finite number (received ${value}); a principal must be JSON-representable.`);
    }
    return;
  }
  // `undefined` is NOT JSON-representable and is rejected wherever it
  // appears. An absent optional field must be genuinely absent, not present
  // with an undefined value — the two are not interchangeable here:
  //
  //   JSON.stringify({ a: undefined })  ->  "{}"      (the key vanishes)
  //   JSON.stringify([undefined])       ->  "[null]"  (silently becomes null)
  //
  // So a principal carrying `undefined` cannot survive the JSON round-trip a
  // key store performs, and would come back a different shape than the
  // policy returned. In an authorization value that is exactly the kind of
  // quiet drift worth refusing: `{ collections: undefined }` reads as "no
  // scopes" to one code path and "field missing, apply a default" to
  // another. A bare `undefined` principal is likewise rejected — stage 1
  // must return `null` to mean "no principal", explicitly.
  if (type === 'undefined') {
    throw new TypeError(
      `${path} is undefined, which is not JSON-representable. ` +
      'Omit the field entirely, or use null to represent an absent value explicitly.'
    );
  }

  if (type !== 'object') {
    throw new TypeError(
      `${path} has unsupported type "${type}". A principal must be a plain JSON-like value ` +
      '(null, string, number, boolean, plain object, or array) so it can be genuinely deep-frozen.'
    );
  }

  if (seen.has(value)) {
    throw new TypeError(
      `${path} is part of a circular structure. A principal must be JSON-representable, which excludes cycles.`
    );
  }
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, i) => assertPlainPrincipal(item, `${path}[${i}]`, seen));
    return;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const name = value.constructor?.name ?? 'object';
    throw new TypeError(
      `${path} is a ${name}, which cannot be reliably frozen. ` +
      'Map/Set report as frozen while staying mutable, and typed arrays throw when frozen. ' +
      'Use a plain object or array instead (e.g. { collections: ["a", "b"] }, not a Set).'
    );
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') {
      throw new TypeError(`${path} has a symbol key, which is not JSON-representable.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !('value' in descriptor)) {
      throw new TypeError(
        `${path}.${key} is an accessor (getter/setter). A principal must hold plain data only — ` +
        'an accessor can return a different value on each read, defeating the point of freezing it.'
      );
    }
    assertPlainPrincipal(descriptor.value, `${path}.${key}`, seen);
  }
}

/**
 * Recursively freezes a value, so an authenticated principal cannot be
 * widened after stage 1 produced it.
 *
 * A shallow `Object.freeze` on the auth context was not enough: it protected
 * the context's own fields while leaving `principal` — and the
 * `scopes`/`collections` arrays inside it — fully mutable. A handler (or any
 * code between the two stages) could therefore push a collection name onto
 * `auth.principal.collections` and have stage 2 authorize against the widened
 * list. The context promises immutability, so it must actually enforce it
 * rather than depend on every policy author remembering to return something
 * already frozen.
 *
 * Cycle-safe via a seen-set: a principal is normally plain JSON, but a policy
 * could return a richer object, and a cyclic structure must not hang the
 * request path. Non-objects and already-frozen values are returned as-is.
 *
 * @template T
 * @param {T} value
 * @param {WeakSet<object>} [seen]
 * @returns {T} the same reference, deeply frozen
 */
export function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (seen.has(value)) return value;
  seen.add(value);

  for (const key of Reflect.ownKeys(value)) {
    // Reading a getter here could execute arbitrary policy code; only own
    // DATA properties are traversed.
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

/**
 * Validates an integration policy at CONSTRUCTION time and returns its two
 * halves. The policy is atomic by design: `authorizeRequest` (stage 1,
 * authentication) and `authorizeCollection` (stage 2, object-level
 * authorization) must be supplied together or not at all.
 *
 * Why this is enforced rather than documented: supplying only
 * `authorizeRequest` produces a server that authenticates every caller and
 * then lets any authenticated caller reach ANY collection. That is a BOLA
 * bypass (OWASP API1:2023) which, from the outside, looks like a correctly
 * secured deployment — exactly the failure mode that is hardest to notice.
 * Supplying only `authorizeCollection` is equally wrong in the other
 * direction: collection scopes would be evaluated against a principal that
 * was never authenticated.
 *
 * Omitting the policy entirely is allowed and preserves current behavior —
 * this phase adds no authorization, and the "unconfigured means unavailable"
 * rule for the Integration API is a separate, deliberate decision (see the
 * design note's row 6), not an accident of wiring.
 *
 * checkRateLimit (rate limiting, added alongside authentication/authorization)
 * is deliberately NOT part of the atomic authorizeRequest/authorizeCollection
 * pairing above: rate limiting is a narrow, independent add-on stage that
 * only makes sense once a principal exists, so it may accompany
 * authorizeRequest but is never required by it — a policy may authenticate
 * and scope collections with no rate limiting at all (existing callers that
 * predate this stage keep working unchanged). Supplying checkRateLimit
 * WITHOUT authorizeRequest is rejected, since there would be no principal to
 * key a bucket on and no stage that could ever invoke it.
 *
 * @param {undefined|null|{ authorizeRequest?: Function, authorizeCollection?: Function, checkRateLimit?: Function }} integrationPolicy
 * @returns {{ authorizeRequest: Function|null, authorizeCollection: Function|null, checkRateLimit: Function|null }}
 */
export function validateIntegrationPolicy(integrationPolicy) {
  if (integrationPolicy === undefined || integrationPolicy === null) {
    return { authorizeRequest: null, authorizeCollection: null, checkRateLimit: null };
  }
  if (typeof integrationPolicy !== 'object') {
    throw new TypeError(
      `integrationPolicy must be an object with { authorizeRequest, authorizeCollection }, received ${typeof integrationPolicy}.`
    );
  }

  const { authorizeRequest, authorizeCollection, checkRateLimit } = integrationPolicy;
  const hasRequest = authorizeRequest !== undefined && authorizeRequest !== null;
  const hasCollection = authorizeCollection !== undefined && authorizeCollection !== null;
  const hasRateLimit = checkRateLimit !== undefined && checkRateLimit !== null;

  if (hasRequest && typeof authorizeRequest !== 'function') {
    throw new TypeError('integrationPolicy.authorizeRequest must be a function.');
  }
  if (hasCollection && typeof authorizeCollection !== 'function') {
    throw new TypeError('integrationPolicy.authorizeCollection must be a function.');
  }
  if (hasRateLimit && typeof checkRateLimit !== 'function') {
    throw new TypeError('integrationPolicy.checkRateLimit must be a function.');
  }

  if (hasRequest !== hasCollection) {
    const supplied = hasRequest ? 'authorizeRequest' : 'authorizeCollection';
    const missing = hasRequest ? 'authorizeCollection' : 'authorizeRequest';
    throw new TypeError(
      `integrationPolicy is incomplete: "${supplied}" was supplied without "${missing}".\n` +
      'Request authentication and collection authorization are two halves of one decision and must be ' +
      'configured together — authenticating callers without scoping which collections they may reach is a ' +
      'broken-object-level-authorization bypass (OWASP API1:2023) that looks correctly configured from the outside.\n' +
      'Supply both functions, or omit integrationPolicy entirely to keep the current unauthenticated behavior.'
    );
  }

  if (hasRateLimit && !hasRequest) {
    throw new TypeError(
      'integrationPolicy.checkRateLimit was supplied without authorizeRequest.\n' +
      'Rate limiting keys a bucket on the authenticated principal, so it is meaningless without ' +
      'authentication. Supply authorizeRequest (and authorizeCollection) alongside it, or omit ' +
      'checkRateLimit entirely.'
    );
  }

  return {
    authorizeRequest: hasRequest ? authorizeRequest : null,
    authorizeCollection: hasCollection ? authorizeCollection : null,
    checkRateLimit: hasRateLimit ? checkRateLimit : null,
  };
}

/**
 * Raised when object-level authorization denies a request. Carries an HTTP
 * status so route error mappers can serialize it without special-casing.
 */
export function forbiddenCollection(message = 'Access to this collection is not permitted.') {
  return new HttpError(403, 'forbidden', message);
}

/**
 * Invokes the object-level authorization hook, fail-closed.
 *
 * The hook and the principal both arrive through the `auth` context the
 * router built from stage 1's decision — NOT through a mutated
 * `IncomingMessage`. An earlier revision read `req.semidexPrincipal`, an
 * implicit side channel that no contract declared, that node's own types know
 * nothing about, and that any middleware or test double could clobber
 * silently. Passing the context explicitly makes the stage-1 → stage-2 flow
 * greppable and impossible to forge by accident.
 *
 * `operation` comes from the matched route's validated metadata
 * (`auth.route.operation`) rather than a literal re-declared at each call
 * site, so a route's classification and the value policy sees can never
 * drift apart.
 *
 * Contract mirrors the router's stage-1 seam exactly, deliberately: when a
 * hook is configured, ONLY an explicit `{ ok: true }` allows the request.
 * `undefined`, `null`, `false`, `{}`, an unknown shape, or a thrown error all
 * deny. When no hook is configured, the request is allowed — preserving
 * current behavior for every deployment that has not opted into
 * authorization.
 *
 * @param {undefined|null|{ principal?: any, route?: Object, authorizeCollection?: Function|null }} auth
 *   the frozen auth context from the router's handler arguments.
 * @param {{ req: import('node:http').IncomingMessage, collection: string, operation?: string }} ctx
 * @returns {Promise<void>} resolves when allowed; throws HttpError when denied
 */
export async function authorizeCollectionAccess(auth, ctx) {
  const authorizeCollection = auth?.authorizeCollection;
  if (!authorizeCollection) return; // no policy configured — unchanged behavior

  let decision;
  try {
    decision = await authorizeCollection({
      req: ctx.req,
      route: auth.route ?? null,
      collection: ctx.collection,
      // Route metadata is the single source of truth for the operation;
      // `ctx.operation` remains only as an explicit override for a route that
      // performs something other than its declared primary operation.
      operation: ctx.operation ?? auth.route?.operation ?? null,
      // Opaque by design: this module must not know how the next phase
      // represents an authenticated caller.
      principal: auth.principal ?? null,
    });
  } catch {
    recordCollectionDenied(auth, ctx, 'policy_error');
    throw forbiddenCollection();
  }

  if (!decision || decision.ok !== true) {
    const message = (decision && typeof decision.message === 'string')
      ? decision.message
      : 'Access to this collection is not permitted.';
    const code = (decision && typeof decision.code === 'string') ? decision.code : 'forbidden';
    const status = (decision && typeof decision.status === 'number') ? decision.status : 403;
    recordCollectionDenied(auth, ctx, code);
    throw new HttpError(status, code, message);
  }
}

/**
 * Emits authz.collection_denied through the per-request sink the router
 * attached to `auth` (see router.js's own comment on why requestId/
 * auditSink live there rather than being threaded through a new
 * constructor parameter). Only the DENIAL path is audited here — the task's
 * own coverage requirement for this area is "operation/collection-scope
 * denial," and a successful stage 1 already recorded
 * auth.integration_accepted (router.js), so a second "allowed" event at
 * stage 2 would be redundant noise for every accepted Ask call.
 *
 * `collection` is logged as the plain value stage 2 evaluated (not a raw
 * body) — see the design doc §3 for why collection names are logged in
 * full. Never a no-op sink call is skipped defensively: `auth` may be
 * absent entirely for a caller that invoked this function directly (a
 * test, or a future non-router entry point) with no context at all.
 */
function recordCollectionDenied(auth, ctx, reason) {
  const collection = typeof ctx?.collection === 'string' && ctx.collection.length > 0 ? ctx.collection : null;
  if (!collection) return; // collection is a required field on this event type — nothing safe to log without it
  recordAuditEvent(auth?.auditSink, AUDIT_EVENT_TYPE.AUTHZ_COLLECTION_DENIED, {
    outcome: 'denied',
    requestId: auth?.requestId ?? null,
    route: auth?.route ? { method: auth.route.method, path: auth.route.path } : null,
    audience: auth?.route?.audience ?? null,
    operation: ctx?.operation ?? auth?.route?.operation ?? null,
    reason,
    collection,
    keyId: (auth?.principal && typeof auth.principal === 'object' && typeof auth.principal.keyId === 'string') ? auth.principal.keyId : null,
  });
}
