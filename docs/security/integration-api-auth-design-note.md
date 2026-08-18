# Integration API authentication — design note

**Status: IMPLEMENTED (2026-08-18), except rate limiting.** Bearer keys,
per-key collection/operation scopes, the key store, and the CLI all ship. Rate
limiting remains a separate follow-up phase.

Implementation:

| Piece | Where |
|---|---|
| Key store, token format, digests | `src/core/auth/key-store.js` |
| The two policy halves | `src/core/auth/integration-policy.js` |
| Default wiring for both editions | `src/core/auth/resolve-policy.js` |
| Shared `key add/list/revoke` | `src/core/auth/key-cli.js` |
| Full entry point | `src/key.js` (`npm run key -- …`) |
| Lite entry point | `packages/lite/bin/semidex-lite.js` (`semidex-lite key …`) |

Decisions marked **(implemented)** below reflect what actually shipped.

Scope of the next task: authenticate and authorize the **Integration API**
(`POST /api/v1/ask`, `POST /api/v2/ask`). The Admin API is explicitly out of
scope — see decision 6.

## Wire format (implemented)

`Authorization: Bearer <token>`, per
[RFC 6750 §2.1](https://datatracker.ietf.org/doc/html/rfc6750#section-2.1).

**Token format:** `sdx_v1_<keyId>_<secret>`

| Segment | Value |
|---|---|
| `sdx_v1` | Literal prefix + format version, so a future format is introduced unambiguously and an old one rejected explicitly. |
| `<keyId>` | 16 base64url chars (96 bits). A **public** identifier, not a secret — it makes authentication an O(1) lookup plus one constant-time comparison, and gives revocation and future rate-limit identity something stable to key on. |
| `<secret>` | 43 base64url chars = **256 bits** from `crypto.randomBytes`. |

Parsing is strict and **positional**: both segments are fixed-width, so the
boundary is computed by offset, never by splitting on the first `_`. This
matters because base64url's alphabet *includes* `_` — roughly one keyId in
five contains one, and a delimiter split would corrupt those tokens. (This was
a real bug, caught by a flaky test at ~20% failure rate and now pinned by a
1000-iteration round-trip test.)

Exposing the keyId costs nothing — an attacker holding the token already has
the secret — but to prevent enumeration an unknown keyId still performs a
**dummy `timingSafeEqual`** and returns byte-identical output to a wrong
secret.

Tokens must **never** be accepted in a query string. RFC 6750 §5.3 warns
that URI-borne credentials leak into logs, `Referer` headers and browser
history; Semidex additionally logs request paths in job/operation records,
so a query-string token would be written to disk by design.

## Decision matrix

Each row is a decision the next task must make explicitly. Recommendations
are the author's, not settled policy.

| # | Decision | Options | Recommendation | Rationale |
|---|---|---|---|---|
| 1 | **One key or many** | Single shared key / multiple named keys | **Multiple** | Rotation and revocation are impossible with one key without downtime, and per-caller rate-limit identity (row 9) needs distinguishable callers. Cost: a real key store. |
| 2 | **Storage** | env var / file in `SEMIDEX_HOME` / `SettingsService` | **File in `SEMIDEX_HOME`** | Env cannot express a list with metadata (created, expiry, scopes) and cannot be rotated without a restart. `SettingsService` is the wrong home: it is readable through `GET /api/settings`, which would put credential material on an HTTP surface. A dedicated file inherits the existing per-OS app-data location and stays off every API. |
| 3 | **Raw token or digest** | Store raw / store digest only | **Digest only** | Reading the store must not yield usable credentials. Show the raw token exactly once at creation, then persist only a digest. Note: a fast hash is appropriate here (tokens are high-entropy random, not passwords) — SHA-256 over a ≥256-bit random token, compared in constant time. Do not use bcrypt/argon2 on a per-request path. |
| 4 | **Scope format** | flat strings / `operation:resource` pairs / structured object | **`operation` + `collections`** | The route registry already carries `operation` and `collectionSource`, so scopes can be checked against real route metadata rather than a parallel path list. Start with `{ operations: ["generate"], collections: [...] }`. |
| 5 | **Exact collections vs wildcard** | exact list / wildcard / both | **Exact list, with an explicit opt-in `"*"`** | Exact is the safe default and satisfies OWASP API1:2023 object-level authorization. A wildcard must be a deliberate, visible choice, never the default a key gets by omission. |
| 6 | **Loopback behavior / no keys configured** | require keys everywhere / open when unconfigured / **fail-closed when unconfigured** | **Fail-closed: no keys ⇒ Integration returns `503 integration_auth_not_configured`. Admin stays loopback-bound and credential-free.** | See the expanded rationale below — an earlier draft of this row recommended "zero keys means open", which was rejected in review as a silent security downgrade. |
| 7 | **Reverse proxy on the same host** | trust `X-Forwarded-*` / ignore / explicit opt-in | **Ignore; keep the existing explicit `ADMIN_ALLOWED_ORIGINS`/`ADMIN_ALLOWED_HOSTS` model** | `X-Forwarded-*` is attacker-controlled on a directly reachable listener. This was already settled for Host/Origin in Phase 1 and must not be relaxed for auth. |
| 8 | **Rotation and revocation** | none / manual file edit / CLI | **CLI (`semidex-lite key add|list|revoke`) + expiry field** | Mirrors the model Qdrant Cloud itself uses for granular keys. Revocation must take effect without a restart, which means the store is re-read (or invalidated) per request or on change. |
| 9 | **Rate-limit identity** | per IP / per key / per key+route | **Per key, bucketed by `costClass`** | IP is wrong behind a wrapper backend (every request shares one IP). The route registry already classifies `llm` vs `qdrant` vs `low`, so limits can be tighter where OWASP API4:2023 cost exposure is real. |
| 10 | **Admin UI without an integration credential** | embed a key / session cookie / none | **None — the dashboard never holds an integration credential** | This is why the Admin/Integration split had to come first. The dashboard calls only Admin routes; those stay loopback-bound and credential-free. No token in HTML, static JS, URL, or `localStorage` — the constraint that made a single shared secret unworkable. |

## Row 6 in full — the unconfigured-key-store contract

**Rejected (an earlier draft of this note):** "if zero keys are configured,
the Integration API behaves as today (open), with a startup warning; once
≥1 key exists, it requires one."

That rule makes *absence of configuration* mean *absence of protection*, and
every realistic failure of the key store lands in exactly that state:

- the key file is deleted, or never created by a deployment step;
- `SEMIDEX_HOME` resolves somewhere unexpected (a container without the
  volume mounted, a different user, a changed env var), so the store is
  looked up at a path that happens to be empty;
- the file is corrupt or unparseable and the loader yields "no keys";
- a migration or a fresh install runs before keys are provisioned.

In each case the operator believes the API is protected while it is fully
open, and nothing in the request path signals otherwise. A protection that
disappears silently when its configuration goes missing is not a protection.

**Adopted contract:**

1. **Zero configured keys ⇒ Integration API is unavailable, not open.**
   Every Integration route returns:

   ```
   503 Service Unavailable
   { "error": { "code": "integration_auth_not_configured",
                "message": "Integration API authentication is not configured." } }
   ```

   `503` rather than `401`: the caller has done nothing wrong and no
   credential could succeed — the *server* is unconfigured. This is also
   trivially distinguishable in a caller's logs from "my key is wrong".

2. **A load failure is never silently treated as "zero keys".** A corrupt or
   unreadable store must fail loudly (startup error, or the same `503` with a
   distinct log line) — never degrade into either "open" or a state
   indistinguishable from a fresh install.

3. **The Admin API is unaffected.** It stays loopback-bound and
   credential-free; the dashboard keeps working on a machine with no keys
   configured at all. This is the whole reason the Admin/Integration split
   had to land first.

4. **Backward compatibility, if needed, is an explicit insecure opt-in —
   loopback only.** Something like
   `SEMIDEX_INSECURE_INTEGRATION_NO_AUTH=1`, which:
   - must be set deliberately; absence never implies it;
   - is **refused when the listener is not loopback** (i.e. it cannot combine
     with `ADMIN_ALLOW_REMOTE=1`), so it can never expose an unauthenticated
     Integration API to a network;
   - logs a prominent warning on every startup, not once;
   - is documented as a migration aid with a removal target, not a supported
     configuration.

   Whether to ship this at all is a judgement call: it exists only to avoid
   breaking someone already calling `/api/v1/ask` from their own backend. If
   the upgrade note is considered sufficient, omitting it is the safer
   choice.

## Open questions for the reviewer
2. Should `/api/search` gain a versioned `POST /api/v1/search` on the
   Integration surface? It is currently Admin-only and unversioned. This is a
   product decision, not a security one, and is deliberately not bundled in.
3. Should Admin ever be reachable remotely with a credential, or does it stay
   loopback-only permanently? The current answer is loopback-only; changing it
   requires a real session model, not an API key.

## What is already in place for this work

- Every route declares `audience`, `operation`, `resourceType`,
  `collectionSource`, `costClass` and `edition`
  (`src/core/http/route-audience.js`), validated fail-closed at registration.
- `router.listRoutes()` exposes the machine-readable inventory.
- **Two authorization stages**, because one is not sufficient. An earlier
  draft claimed the pre-body seam was the single attachment point for
  everything including collection scopes; that was wrong, and the correction
  is load-bearing for row 4/5:

  | Stage | Where | Runs | Attach here |
  |---|---|---|---|
  | 1 | `integrationPolicy.authorizeRequest({ req, route, params })` — `src/shared/admin/router.js` | after route match, before the handler, **before any body read** | bearer authentication, coarse rate limiting, audit start |
  | 2 | `authorizeCollectionAccess(auth, { req, collection })` — `src/core/http/authorize.js` | after the route's own body parse, **before `adapter.getCollection()`** | object-level authorization (OWASP API1:2023) |

- **The two halves are one atomic policy.** `createRouter` /
  `createApp` / `createLiteApp` take a single `integrationPolicy` object;
  supplying `authorizeRequest` without `authorizeCollection` (or vice versa)
  **throws at construction**. Configuring authentication alone would
  authenticate every caller and then let any authenticated caller reach any
  collection — a BOLA bypass that looks correctly configured from the
  outside. Omitting the policy entirely remains allowed and unchanged.

- **The policy is scoped to the Integration audience.** Both stages run only
  when the matched route declares `audience: integration`; admin routes never
  invoke either and get an auth context with no principal and no stage-2
  hook. This is what makes row 6 implementable: "zero keys ⇒ 503" gates Ask
  while leaving the dashboard fully usable on a machine with no keys at all.
  Admin authorization, if it is ever needed remotely, is a separate session
  model — not this key-based one.

- **The principal flows explicitly, never through request mutation, and is
  deeply frozen.** Stage 1 returns `{ ok: true, principal }`; the router
  deep-freezes the principal and puts it in a frozen `auth` context
  (`{ principal, route, authorizeCollection }`) passed as a handler argument,
  which the handler forwards to stage 2. An earlier revision read
  `req.semidexPrincipal` — an undeclared side channel — and froze the context
  only shallowly, leaving nested `scopes`/`collections` arrays mutable, so
  code between the stages could widen its own authority before stage 2
  evaluated it.

- **The principal must be a plain JSON-like value** — `null`, string, finite
  number, boolean, plain object, or array. Enforced by
  `assertPlainPrincipal()` before freezing; anything else denies the request
  (403) and logs a configuration error for the operator. This is a
  *request-time* check, not a startup one: the principal is produced by stage
  1 on every call, so there is no earlier point at which its shape is known.
  **The key store must therefore hand the policy plain data**, which is
  natural since keys are loaded from JSON on disk — but it means e.g. a `Set`
  for `collections`, or a `Date` for `expiresAt`, is a contract violation
  rather than a style choice. Use `["a","b"]` and an ISO string.

  `undefined` is rejected wherever it appears, including nested in a field or
  an array element. An absent optional field must be genuinely absent (omit
  the key) or explicitly `null` — `{ collections: undefined }` does not
  survive a JSON round-trip (`JSON.stringify` drops the key; `[undefined]`
  becomes `[null]`), and in an authorization value that ambiguity is worth
  refusing: one code path reads it as "no scopes", another as "field missing,
  apply a default". A policy that omits `principal` altogether is fine — the
  router normalizes that to `null`.

  This exists because `Object.freeze` is not a general immutability
  primitive: on a `Map`/`Set` it returns success and `Object.isFrozen`
  reports `true` while `.set()`/`.add()` keep working — a *false* guarantee,
  which is more dangerous than an obvious failure — and on a typed array it
  throws outright. Narrowing the accepted shape was preferred over growing
  the freeze into a partial deep-clone that would silently normalize some
  cases and miss others.

- **`operation` comes from route metadata**, i.e. `auth.route.operation`, not
  a literal re-declared at each call site, so a route's registered
  classification and the value policy evaluates can never drift apart.

  Stage 1 cannot do collection scoping: for Ask v1/v2 the collection
  identifier lives in the request body, and a body is a single-use stream —
  a hook that consumed it there would leave the handler with nothing to
  parse. Stage 2 exists precisely for identifiers that are only knowable
  after parsing, and is positioned so a denial still costs no Qdrant round
  trip and no Gemini call.

- **Both stages are fail-closed.** When a hook is supplied, only an explicit
  `{ ok: true }` allows the request; `undefined`, `null`, `false`, `{}`, an
  unknown shape, or a thrown error all deny. A hook that silently allows on a
  forgotten `return` reads as protection while providing none. Omitting a
  hook entirely preserves current behavior — which is what makes row 6's
  "unconfigured means unavailable" rule a deliberate decision rather than an
  accident of wiring.
