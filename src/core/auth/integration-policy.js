// The real integration policy — the two halves the router's atomic
// `integrationPolicy` contract requires, built on the key store.
//
// This module implements authentication; it does not redesign the seam. See:
//   - src/shared/admin/router.js         stage 1 invocation + fail-closed rules
//   - src/core/http/authorize.js         stage 2 invocation + principal contract
//   - docs/security/integration-api-auth-design-note.md
//
// SCOPE: only routes declaring `audience: integration` ever reach this policy
// (the router enforces that). Admin routes stay loopback-bound and
// credential-free, which is why a missing key store takes down Ask and leaves
// the dashboard fully usable.
import { AUTH_RESULT, collectionAllowed } from './key-store.js';
import { rateLimitedDecision } from './rate-limiter.js';

/**
 * The single external response for "authentication is not usable". Returned
 * for a missing file, an unreadable file, corrupt JSON, an unknown schema
 * version, and a validation failure alike — the client learns only that the
 * Integration API is unavailable, never anything about the server's
 * configuration state. The operator gets the distinction in the log instead.
 */
const NOT_CONFIGURED = Object.freeze({
  ok: false,
  status: 503,
  code: 'integration_auth_not_configured',
  message: 'Integration API authentication is not configured.',
});

/**
 * The single external response for every credential failure: missing header,
 * wrong scheme, duplicate header, malformed token, unknown keyId, wrong
 * secret, revoked key, expired key. Collapsing them is deliberate — a caller
 * must not be able to probe which key ids exist (OWASP API1/API2), and a
 * differentiated message would do exactly that.
 */
const UNAUTHENTICATED = Object.freeze({
  ok: false,
  status: 401,
  code: 'unauthorized',
  message: 'A valid Integration API bearer token is required.',
});

/**
 * Denial for an out-of-scope operation or collection. Identical whether the
 * collection exists, does not exist, or exists but is not in scope — see
 * authorizeCollection below.
 */
const FORBIDDEN = Object.freeze({
  ok: false,
  status: 403,
  code: 'forbidden',
  message: 'This key is not authorized for the requested collection or operation.',
});

/**
 * Extracts a bearer token from the Authorization header.
 *
 * Returns null for anything that is not exactly one well-formed
 * `Authorization: Bearer <token>` header. A duplicated Authorization header
 * arrives from node joined as "a, b" (or as an array on some paths); rather
 * than guessing which one the caller meant — the kind of ambiguity that
 * enables request smuggling and proxy disagreement — it is rejected.
 *
 * The token is NEVER read from a query string, cookie, or body: those places
 * are logged, cached, and shared in ways a credential must not be.
 */
export function extractBearerToken(req) {
  const headers = req?.headers ?? {};

  // Duplicate detection: headersDistinct preserves every value where
  // req.headers collapses them (the same trap as the Host header — see
  // request-security.js).
  const distinct = req?.headersDistinct?.authorization;
  if (Array.isArray(distinct) && distinct.length > 1) return null;

  const raw = headers.authorization;
  if (Array.isArray(raw)) return null;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (raw.includes(',')) return null; // joined duplicates

  // Scheme must be exactly "Bearer" (case-insensitive per RFC 7235), followed
  // by exactly one space and a non-empty token with no further whitespace.
  const match = /^Bearer ([^\s]+)$/i.exec(raw);
  if (!match) return null;
  return match[1];
}

/**
 * Builds the atomic { authorizeRequest, authorizeCollection } pair, plus an
 * optional third `checkRateLimit` stage when `rateLimiter` is supplied.
 *
 * checkRateLimit is deliberately NOT part of the atomic authorizeRequest/
 * authorizeCollection pairing validateIntegrationPolicy() enforces — a
 * caller may authenticate and scope collections without rate limiting (many
 * existing tests do exactly this, and omitting it preserves their current,
 * unrelated behavior unchanged), but rate limiting itself is meaningless
 * without an authenticated principal to key a bucket on, which is why it is
 * only ever invoked by the router AFTER authorizeRequest has already
 * produced one (see router.js's stage ordering).
 *
 * @param {{
 *   keyStore: ReturnType<typeof import('./key-store.js').createKeyStore>,
 *   rateLimiter?: ReturnType<typeof import('./rate-limiter.js').createRateLimiter>,
 *   logger?: { warn: Function, error: Function },
 * }} deps
 */
export function createIntegrationPolicy({ keyStore, rateLimiter, logger = console } = {}) {
  if (!keyStore) throw new TypeError('createIntegrationPolicy requires a keyStore.');

  // Operator-facing diagnostics for an unusable store. The CLIENT always sees
  // the same 503; these messages exist so an operator can tell "I never
  // created a key" from "the file is corrupt" — a distinction that matters a
  // lot at 3am and not at all to an attacker.
  function logStoreUnavailable(error) {
    const detail = {
      missing: 'the key store file does not exist (run `key add` to create the first key)',
      unreadable: 'the key store file exists but could not be read (check file permissions)',
      corrupt: 'the key store file contains invalid JSON or failed validation',
      unsupported_schema_version: 'the key store schemaVersion is newer than this build understands',
      invalid_record: 'the key store contains a malformed key record',
    }[error?.code] ?? 'the key store is unusable for an unknown reason';

    logger.error(
      `[semidex] Integration API unavailable: ${detail}. ` +
      `Returning 503 integration_auth_not_configured. Underlying error: ${error?.message ?? '(none)'}`
    );
  }

  return {
    /**
     * Stage 1 — pre-body. Authenticates the bearer token and checks that the
     * key is scoped to the route's declared operation. Runs before any body
     * is read, so an unauthenticated request costs nothing.
     */
    authorizeRequest({ req, route }) {
      const token = extractBearerToken(req);

      // A missing/malformed credential still consults the store first, so
      // "no keys configured" reports 503 rather than 401 — the caller has
      // done nothing wrong and no token could succeed.
      const outcome = keyStore.authenticateToken(token);

      switch (outcome.result) {
        case AUTH_RESULT.NOT_CONFIGURED:
          logger.warn(
            '[semidex] Integration API request refused: no API keys are configured. ' +
            'Create one with `semidex-lite key add --name <name> --collection <collection>`.'
          );
          return NOT_CONFIGURED;

        case AUTH_RESULT.STORE_UNAVAILABLE:
          logStoreUnavailable(outcome.error);
          return NOT_CONFIGURED; // same external response, different log

        case AUTH_RESULT.INVALID:
          return UNAUTHENTICATED;

        case AUTH_RESULT.OK:
          break;

        default:
          // Unreachable given the typed results; fail closed regardless.
          return UNAUTHENTICATED;
      }

      // Operation scope, checked against ROUTE METADATA rather than a
      // hardcoded path — a route's declared operation is the single source of
      // truth (see route-audience.js).
      const operation = route?.operation ?? null;
      if (!operation || !outcome.principal.operations.includes(operation)) {
        return FORBIDDEN;
      }

      return { ok: true, principal: outcome.principal };
    },

    /**
     * Stage 2 — post-parse, pre-Qdrant. Checks the client-supplied collection
     * against the key's scope.
     *
     * Returns the SAME denial regardless of whether the collection exists:
     * this runs before adapter.getCollection(), so existence is not even
     * known here, which is precisely what makes "forbidden" and "no such
     * collection" indistinguishable from outside.
     */
    authorizeCollection({ principal, collection, operation }) {
      if (!principal) return UNAUTHENTICATED;
      if (typeof collection !== 'string' || collection.length === 0) return FORBIDDEN;
      if (operation && !principal.operations.includes(operation)) return FORBIDDEN;
      if (!collectionAllowed(principal.collections, collection)) return FORBIDDEN;
      return { ok: true };
    },

    // Only present when a rateLimiter was injected — see this function's
    // own header comment for why this is independent of the atomic
    // authorizeRequest/authorizeCollection pair.
    ...(rateLimiter ? {
      /**
       * Stage 1.5 — immediately after a successful authorizeRequest, still
       * pre-body. Consumes exactly one token from the bucket identified by
       * `principal.keyId`. Every route metadata is intentionally unused
       * here (rate limiting is per-key, not per-route/per-costClass in this
       * phase — see the design note's row 9 recommendation for a possible
       * future refinement) but accepted for a uniform stage signature with
       * authorizeRequest/authorizeCollection.
       */
      checkRateLimit({ principal }) {
        // Defensive only: the router never calls this stage without a
        // principal already produced by a successful authorizeRequest, so
        // this branch should be unreachable in practice. Fail closed
        // rather than throw, matching every other stage's contract.
        if (!principal || typeof principal.keyId !== 'string' || principal.keyId.length === 0) {
          return { ok: false, status: 403, code: 'forbidden', message: 'Rate limiting requires an authenticated principal.' };
        }
        const result = rateLimiter.consume(principal.keyId, {
          requestsPerMinute: principal.requestsPerMinute,
          burst: principal.burst,
        });
        if (result.allowed) return { ok: true };
        return rateLimitedDecision(result.retryAfterMs);
      },
    } : {}),
  };
}
