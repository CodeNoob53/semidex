// Tiny method+path router. No framework, no regex path-to-regexp dependency
// — segment-by-segment matching is enough for the handful of routes this API
// needs. Route params (":name") are URL-decoded before being handed to
// handlers, so a handler never has to think about percent-encoding.
import { sendError, HttpError } from '../../core/http/http.js';
import { sanitiseErrorMessage } from '../core/doctor-checks.js';
import {
  createRequestSecurityPolicy,
  evaluateRequestSecurity,
  applySecurityVaryHeaders,
} from '../../core/http/request-security.js';
import { validateRouteMeta, AUDIENCE } from '../../core/http/route-audience.js';
import { validateIntegrationPolicy, deepFreeze, assertPlainPrincipal } from '../../core/http/authorize.js';

/**
 * @typedef {(ctx: { req, res, params: Object, query: URLSearchParams }) => Promise<void>|void} RouteHandler
 */

/**
 * @param {{ securityPolicy?: ReturnType<typeof createRequestSecurityPolicy> }} [opts]
 *   securityPolicy is optional DI so a test can construct a router with a
 *   specific host/remote configuration. Omitting it yields the safe default:
 *   loopback-only hosts, no remote mode. It is never absent in production —
 *   both composition roots build one from resolved server config.
 */
export function createRouter({ securityPolicy, integrationPolicy } = {}) {
  // An integration policy is ATOMIC: request authentication and collection
  // authorization are two halves of one decision and must be configured
  // together. Wiring only `authorizeRequest` would authenticate callers and
  // then let any authenticated caller reach ANY collection — a BOLA bypass
  // (OWASP API1:2023) that looks fully configured from the outside. This is
  // rejected at construction rather than discovered in production.
  const { authorizeRequest, authorizeCollection } = validateIntegrationPolicy(integrationPolicy);
  // Default policy covers loopback on the DEFAULT admin port as well as the
  // bare hostnames, so a router constructed without explicit config (tests,
  // scripts, embedders) still accepts the ordinary "127.0.0.1:8642" Host a
  // real client sends. Production always passes an explicit policy resolved
  // from real bind config (shared/admin/server.js's
  // resolveRequestSecurityPolicy), and a server on an ephemeral port is
  // additionally covered by checkHost()'s real-listening-port allowance.
  const policy = securityPolicy ?? createRequestSecurityPolicy({ port: 8642 });
  const routes = []; // { method, segments: string[], handler, meta }

  // Fail-closed registration: `meta` is mandatory and validated here, so a
  // route with no declared audience throws at construction time rather than
  // serving unclassified traffic. See src/core/http/route-audience.js.
  function add(method, path, handler, meta) {
    const segments = path.split('/').filter(Boolean);
    const validated = validateRouteMeta(method, path, meta);
    routes.push({ method, segments, handler, meta: validated });
  }

  function match(method, pathname) {
    const reqSegments = pathname.split('/').filter(Boolean);
    let pathMatchedForOtherMethod = false;

    for (const route of routes) {
      if (route.segments.length !== reqSegments.length) continue;

      const params = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const routeSeg = route.segments[i];
        const reqSeg = reqSegments[i];
        if (routeSeg.startsWith(':')) {
          params[routeSeg.slice(1)] = decodeURIComponent(reqSeg);
        } else if (routeSeg !== reqSeg) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      if (route.method !== method) {
        pathMatchedForOtherMethod = true;
        continue;
      }
      return { handler: route.handler, params, meta: route.meta };
    }

    return pathMatchedForOtherMethod ? { methodNotAllowed: true } : null;
  }

  async function handleRequest(req, res) {
    // Wraps the whole request — not just the handler call — because both
    // `new URL()` (malformed req.url) and `match()`'s decodeURIComponent()
    // on a route param (malformed percent-encoding, e.g. "%E0%A4%A") throw
    // synchronously outside any handler's control. Left uncaught, either one
    // rejects handleRequest() itself with no response ever sent to the client.
    try {
      // Request security runs FIRST — before route matching, before any
      // handler, and (critically) before any body is read. A rejected
      // cross-site or bad-Host request must never reach Qdrant, Gemini, the
      // filesystem, a subprocess spawn, or the folder-picker dialog. See
      // core/http/request-security.js for the policy and its rationale.
      applySecurityVaryHeaders(res);
      const verdict = evaluateRequestSecurity(req, policy);
      if (!verdict.ok) {
        return sendError(res, verdict.status, verdict.code, verdict.message);
      }

      const url = new URL(req.url, 'http://localhost');
      const found = match(req.method, url.pathname);

      if (!found || found.methodNotAllowed) {
        return sendError(res, 404, 'not_found', `No route for ${req.method} ${url.pathname}`);
      }

      // Policy seam (stage 1 — pre-body) — runs AFTER route match (so it sees
      // the route's declared audience/operation/costClass) but BEFORE the
      // handler and before any body is read. This is where the next phase
      // attaches bearer AUTHENTICATION and coarse rate limiting; it is
      // deliberately empty of authorization logic today.
      //
      // Object-level authorization (does this principal may touch THIS
      // collection?) deliberately does NOT happen here: for Ask v1/v2 the
      // collection identifier arrives in the request body, and consuming the
      // stream here would leave nothing for the handler to parse. That check
      // belongs to stage 2 — see authorizeCollectionAccess in
      // src/core/http/authorize.js, invoked after the body is parsed and
      // before any adapter call.
      //
      // FAIL-CLOSED: when a hook is present, ONLY an explicit `{ ok: true }`
      // allows the request. undefined/null/false/{}/a thrown error all block
      // it. An authorization hook that silently allows on a forgotten
      // `return`, a typo'd field, or an exception is worse than no hook at
      // all, because it reads as protection while providing none. Omitting
      // the hook entirely preserves the previous behavior unchanged.
      //
      // Instance-scoped (captured from createRouter's arguments), never a
      // module-level global, so Full and Lite servers in the same process
      // cannot influence one another and construction order is irrelevant.
      // The authenticated caller, carried EXPLICITLY from stage 1 to the
      // handler (and from there to stage 2). Never attached to `req`:
      // mutating IncomingMessage to smuggle a principal is an undocumented
      // side channel — nothing in node's type declares it, any middleware or
      // test double can clobber it, and a reader of the handler cannot see
      // where the value came from. An explicit, frozen context makes the flow
      // greppable and impossible to forge by accident.
      let principal = null;

      // The integration policy applies to the INTEGRATION surface ONLY.
      //
      // Running it for admin routes too would contradict the boundary this
      // whole phase exists to draw: the Admin API stays loopback-bound and
      // credential-free, and the dashboard must keep working on a machine
      // with no integration keys configured at all. Concretely, the planned
      // "zero keys ⇒ 503 integration_auth_not_configured" rule would
      // otherwise take down /api/settings and every other dashboard route,
      // not just Ask — turning a missing integration credential into a
      // total loss of local administration.
      //
      // Admin routes therefore never see an integration principal and never
      // carry the stage-2 hook: an admin handler that somehow called
      // authorizeCollectionAccess() would get a no-op, which is correct —
      // admin authorization is a separate concern with a separate (future)
      // session model, not this key-based one.
      const isIntegration = found.meta.audience === AUDIENCE.INTEGRATION;

      if (authorizeRequest && isIntegration) {
        let decision;
        try {
          decision = await authorizeRequest({
            req,
            route: found.meta,
            params: found.params,
          });
        } catch (err) {
          // A policy that throws must never fall through to the handler, and
          // must not leak its internals: this is deliberately not re-thrown
          // into the generic 500 branch below.
          return sendError(res, 403, 'forbidden', 'Request rejected by policy.');
        }
        if (!decision || decision.ok !== true) {
          const status = (decision && typeof decision.status === 'number') ? decision.status : 403;
          const code = (decision && typeof decision.code === 'string') ? decision.code : 'forbidden';
          const message = (decision && typeof decision.message === 'string')
            ? decision.message
            : 'Request rejected by policy.';
          // RFC 6750 §3: a protected resource returning 401 for a bearer
          // token failure SHOULD include WWW-Authenticate. No `error`/
          // `error_description` attribute is added: integration-policy.js
          // deliberately collapses every credential failure (missing,
          // malformed, unknown, wrong, revoked, expired) into the same 401
          // body specifically to prevent a caller from distinguishing them
          // (see that file's own UNAUTHENTICATED comment) — an `error`
          // attribute here would reopen exactly that distinction via a
          // second channel.
          const headers = status === 401 ? { 'WWW-Authenticate': 'Bearer realm="Integration API"' } : {};
          return sendError(res, status, code, message, headers);
        }
        // Validated, then deep-frozen. A shallow Object.freeze on the
        // context left the principal itself — and nested
        // `scopes`/`collections` arrays — fully mutable, so a handler could
        // widen its own authority between stage 1 and stage 2.
        //
        // The validation is what makes the freeze meaningful: Object.freeze
        // reports success on a Map/Set while leaving it fully mutable, and
        // throws on typed arrays. Constraining the principal to plain
        // JSON-like data (assertPlainPrincipal) turns both into a clear
        // configuration error instead of a silent immutability hole. A
        // malformed principal is a policy BUG, so it denies rather than
        // proceeding with an unenforceable guarantee.
        try {
          assertPlainPrincipal(decision.principal ?? null);
        } catch (err) {
          // Logged for the operator (this is their policy misconfigured),
          // but never echoed to the caller.
          console.error(`[semidex] integration policy returned an invalid principal: ${err.message}`);
          return sendError(res, 403, 'forbidden', 'Request rejected by policy.');
        }
        principal = deepFreeze(decision.principal ?? null);
      }

      // `auth` is frozen so a handler cannot rewrite who the caller is before
      // stage 2 sees it. `route` is the matched route's own validated
      // metadata, so stage 2 reads `auth.route.operation` rather than
      // re-declaring a literal that could drift from the registry.
      const auth = Object.freeze({
        principal,
        route: found.meta,
        // Admin routes get no stage-2 hook at all — see the comment above.
        authorizeCollection: (isIntegration && authorizeCollection) ? authorizeCollection : null,
      });

      await found.handler({ req, res, params: found.params, query: url.searchParams, auth });
    } catch (err) {
      if (err instanceof HttpError) {
        return sendError(res, err.statusCode, err.code, err.message);
      }
      if (err instanceof URIError) {
        return sendError(res, 400, 'bad_request', 'Malformed URL (invalid percent-encoding)');
      }
      // A route handler that throws something other than a deliberate
      // HttpError (badRequest/notFound/conflict/etc., all pre-composed with
      // safe, fixed wording — see http.js) is, by construction, an
      // UNEXPECTED failure: a raw exception from a StorageAdapter call, a
      // Qdrant client error, or similar — the kind of message that can
      // legitimately contain a connection URL with embedded credentials or
      // a literal QDRANT_KEY (confirmed live via api/collections.js's
      // sync-schema route, whose ensureCollectionSchema() rejection used to
      // reach this exact branch verbatim). Every OTHER admin-API error path
      // that touches raw Qdrant/process output already redacts at capture
      // time (jobs/registry.js's appendLine(), task-registry.js's
      // runTracked()) — this is the one remaining path that didn't: any
      // route handler's uncaught exception, not just repair's.
      return sendError(res, 500, 'internal_error', sanitiseErrorMessage(err?.message ?? String(err), process.env.QDRANT_KEY));
    }
  }

  return {
    get(path, handler, meta) { add('GET', path, handler, meta); },
    post(path, handler, meta) { add('POST', path, handler, meta); },
    patch(path, handler, meta) { add('PATCH', path, handler, meta); },
    delete(path, handler, meta) { add('DELETE', path, handler, meta); },
    handleRequest,
    /**
     * The machine-readable route inventory (Part A of the Admin/Integration
     * split). Every registered route, with its validated metadata — this is
     * what the classification tests assert against, so the inventory can
     * never drift from what is actually served.
     * @returns {Array<Readonly<Object>>}
     */
    listRoutes() { return routes.map((r) => r.meta); },
  };
}
