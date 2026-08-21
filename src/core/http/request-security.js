// The ONE request-security policy for every HTTP route in this API — Origin/
// Fetch-Metadata (cross-site) enforcement, Host/DNS-rebinding validation, and
// Content-Type enforcement for JSON bodies. Deliberately a single shared
// module rather than per-route checks: a check that has to be remembered at
// each of ~32 registration sites is a check that will be forgotten at one of
// them, and the one it is forgotten at will be the one that matters.
//
// Zero dependencies (node:http request objects in, verdict objects out). No
// Qdrant/Gemini/filesystem knowledge, no framework — same constraints as
// core/http/http.js, which this sits alongside.
//
// WHY THIS EXISTS (see docs/security/semidex-lite-public-api-audit-2026-08.md
// finding P1-1): readJsonBody() historically parsed the body as JSON
// regardless of the declared Content-Type. A browser can send a CORS-"simple"
// request (no preflight) with `Content-Type: text/plain` and a body that is
// valid JSON, so an attacker-controlled page could reach and fully execute
// state-changing routes cross-origin — confirmed live against
// POST /api/jobs/index, which returned 202 and really spawned an indexer
// against an arbitrary local path. The absence of Access-Control-Allow-Origin
// stops the attacker from READING the response; it never stopped the server
// from DOING the work. This module closes that at the dispatch boundary,
// before any body is read.
//
// NOT authentication. Nothing here identifies a caller or proves authority —
// it only distinguishes "a browser sent this from another site" from
// everything else, and pins the Host. Bearer keys/scopes are explicitly a
// later phase (see the audit's §10 sequencing constraint: the admin vs
// integration split must be decided before any credential is introduced).

/**
 * Header used by the bundled Admin UI on non-safe requests. Defense in depth
 * with a second, independent purpose: a custom header is NOT CORS-safelisted,
 * so any cross-origin attempt to send it forces a preflight, and this server
 * answers no OPTIONS — the preflight fails and the real request is never sent.
 *
 * NOT a secret and NOT authentication: it is served in plain static JS to
 * every visitor and trivially forgeable by any non-browser client. Its only
 * security value is the preflight-forcing property above, which is a
 * browser-enforced property, not a confidentiality one.
 */
export const ADMIN_REQUEST_HEADER = 'x-semidex-request';
export const ADMIN_REQUEST_VALUE = 'admin';

// Methods that cannot change state and are safe to serve without the
// cross-site checks below (RFC 9110 §9.2.1). Note GET/HEAD are still subject
// to Host validation — DNS rebinding targets reads too.
const SAFE_METHODS = new Set(['GET', 'HEAD']);

const JSON_MEDIA_TYPE = 'application/json';

// Hostnames that denote this machine's loopback interface. Used only for the
// "real listening port" allowance in checkHost() — never for suffix matching.
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Parses a Host header into { hostname, port } WITHOUT using `new URL()`'s
 * lenient parsing. Returns null for anything malformed. Handles bracketed
 * IPv6 literals ("[::1]:8642") explicitly, since splitting those on ":"
 * naively would mangle them.
 * @param {string} raw
 * @returns {{ hostname: string, port: string|null }|null}
 */
export function parseHostHeader(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 255) return null;
  // Reject anything with whitespace, commas (a duplicated/merged Host header
  // arrives as "a, b" via node's header joining), or control characters.
  if (/[\s,]/.test(raw)) return null;

  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close === -1) return null;
    const hostname = raw.slice(0, close + 1).toLowerCase();
    const rest = raw.slice(close + 1);
    if (rest === '') return { hostname, port: null };
    if (!rest.startsWith(':')) return null;
    const port = rest.slice(1);
    if (!/^\d{1,5}$/.test(port)) return null;
    return { hostname, port };
  }

  const parts = raw.split(':');
  if (parts.length > 2) return null; // bare (unbracketed) IPv6 or garbage
  const hostname = parts[0].toLowerCase();
  if (hostname === '') return null;
  if (parts.length === 1) return { hostname, port: null };
  const port = parts[1];
  if (!/^\d{1,5}$/.test(port)) return null;
  return { hostname, port };
}

/**
 * Normalizes one allow-list entry ("semidex.example.com", "192.168.1.10:8642",
 * "[::1]:8642") into a comparable "hostname[:port]" string, or null if the
 * entry is unusable. Exported for startup diagnostics and tests.
 * @param {string} entry
 * @returns {string|null}
 */
export function normalizeAllowedHost(entry) {
  const parsed = parseHostHeader(String(entry ?? '').trim());
  if (!parsed) return null;
  return parsed.port === null ? parsed.hostname : `${parsed.hostname}:${parsed.port}`;
}

/**
 * Parses ADMIN_ALLOWED_HOSTS (comma-separated) into a normalized Set.
 * @param {string|undefined} raw
 * @returns {{ hosts: Set<string>, invalid: string[] }}
 */
export function parseAllowedHosts(raw) {
  const hosts = new Set();
  const invalid = [];
  if (!raw) return { hosts, invalid };
  for (const piece of String(raw).split(',')) {
    const trimmed = piece.trim();
    if (trimmed === '') continue;
    const normalized = normalizeAllowedHost(trimmed);
    if (normalized === null) invalid.push(trimmed);
    else hosts.add(normalized);
  }
  return { hosts, invalid };
}

/**
 * The default loopback allow-list for a given listening port. Exact
 * hostname+port pairs only — never suffix matching (`endsWith('localhost')`
 * would accept "evil-localhost", and `endsWith('.localhost')` still accepts
 * attacker-controlled subdomains that resolve wherever they like).
 * @param {number|string|null} port
 * @returns {Set<string>}
 */
export function defaultLoopbackHosts(port) {
  const hosts = new Set();
  const names = ['127.0.0.1', 'localhost', '[::1]'];
  for (const name of names) {
    hosts.add(name); // Host without an explicit port (default 80/443 via proxy)
    if (port !== null && port !== undefined && port !== '') hosts.add(`${name}:${port}`);
  }
  return hosts;
}

/**
 * Builds the immutable policy object consulted per request. Resolved ONCE at
 * server-construction time, never per request, so a misconfiguration is a
 * startup-time failure rather than a per-request surprise.
 *
 * Fail-closed by explicit decision (2026-08, user-approved): when the server
 * is bound beyond loopback (`allowRemote`), ADMIN_ALLOWED_HOSTS is REQUIRED.
 * Rationale: ADMIN_ALLOW_REMOTE=1 is precisely the mode where Host/rebinding
 * protection matters most, so defaulting it off there would disable the
 * defense exactly where it is needed. This is a deliberate breaking change
 * for that opt-in mode; see the README migration note.
 *
 * @param {{ port?: number|string|null, allowRemote?: boolean, allowedHosts?: string, trustProxy?: boolean }} opts
 * @returns {{ allowedHosts: Set<string>, allowRemote: boolean, trustProxy: boolean, port: string|null }}
 */
export function createRequestSecurityPolicy({
  port = null,
  allowRemote = false,
  allowedHosts: allowedHostsRaw = undefined,
  allowedOrigins: allowedOriginsRaw = undefined,
  trustProxy = false,
} = {}) {
  const { hosts: configured, invalid } = parseAllowedHosts(allowedHostsRaw);
  if (invalid.length > 0) {
    throw new Error(
      `ADMIN_ALLOWED_HOSTS contains unparseable entries: ${invalid.map((h) => `"${h}"`).join(', ')}. ` +
      'Use a comma-separated list of "hostname" or "hostname:port" values, e.g. ' +
      'ADMIN_ALLOWED_HOSTS=semidex.example.com,192.168.1.10:8642'
    );
  }

  if (allowRemote && configured.size === 0) {
    throw new Error(
      'ADMIN_ALLOW_REMOTE=1 requires ADMIN_ALLOWED_HOSTS to be set explicitly.\n' +
      'Binding beyond loopback without a Host allow-list would leave the server open to ' +
      'DNS-rebinding and Host-header attacks — the exact risk this mode introduces.\n' +
      'Set the host(s) clients will actually use, for example:\n' +
      '  ADMIN_ALLOW_REMOTE=1\n' +
      '  ADMIN_ALLOWED_HOSTS=semidex.example.com,192.168.1.10:8642\n' +
      'Include the port when clients connect on a non-default port.'
    );
  }

  // When an explicit allow-list is configured it REPLACES the loopback
  // default for remote mode, but is ADDITIVE for loopback mode (so a local
  // operator who names an extra alias does not lose 127.0.0.1).
  const allowedHosts = allowRemote
    ? configured
    : new Set([...defaultLoopbackHosts(port), ...configured]);

  // Explicit exact-origin allow-list (ADMIN_ALLOWED_ORIGINS). Needed for a
  // TLS-terminating reverse proxy, where the browser's Origin is
  // "https://semidex.example.com" but this process sees a plaintext socket
  // and a possibly-different Host — a mismatch that must be resolved by
  // operator configuration, never by trusting X-Forwarded-Proto.
  // Strict parsing, deliberately NOT just `new URL(x).origin`. That getter
  // silently DISCARDS userinfo, path, query and fragment, so a config entry
  // that looks narrow would quietly widen: "https://user:pass@semidex.example.com/admin"
  // normalizes to "https://semidex.example.com" — every path on that host,
  // no credentials required. An operator who wrote that string believed they
  // had restricted something. It also accepts any scheme, so "ftp://host"
  // would be stored verbatim and could never match a real browser Origin.
  //
  // Rather than normalize surprising input into a broader rule, reject it and
  // make the operator write exactly what they mean.
  const allowedOrigins = new Set();
  const invalidOrigins = [];
  for (const piece of String(allowedOriginsRaw ?? '').split(',')) {
    const trimmed = piece.trim();
    if (trimmed === '') continue;

    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      invalidOrigins.push(trimmed);
      continue;
    }

    const isHttpScheme = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    const hasCredentials = parsed.username !== '' || parsed.password !== '';
    // `new URL('https://host')` yields pathname '/', so '/' is the only
    // acceptable value — anything longer is a real path the operator wrote.
    const hasPath = parsed.pathname !== '/';
    const hasQueryOrHash = parsed.search !== '' || parsed.hash !== '';

    if (!isHttpScheme || hasCredentials || hasPath || hasQueryOrHash || parsed.origin === 'null') {
      invalidOrigins.push(trimmed);
      continue;
    }

    allowedOrigins.add(parsed.origin.toLowerCase());
  }
  if (invalidOrigins.length > 0) {
    throw new Error(
      `ADMIN_ALLOWED_ORIGINS contains invalid entries: ${invalidOrigins.map((o) => `"${o}"`).join(', ')}.\n` +
      'Each entry must be a bare http:// or https:// origin — scheme, host and optional port ONLY, ' +
      'with no username/password, no path, no query string and no fragment.\n' +
      'A browser\'s Origin header never contains those, and accepting them would silently widen the rule ' +
      '(e.g. "https://user:pass@host/admin" would match every path on "https://host").\n' +
      'Correct form:\n' +
      '  ADMIN_ALLOWED_ORIGINS=https://semidex.example.com\n' +
      '  ADMIN_ALLOWED_ORIGINS=https://semidex.example.com,http://192.168.1.10:8642'
    );
  }

  return {
    allowedHosts,
    allowedOrigins,
    allowRemote,
    trustProxy,
    port: port === null ? null : String(port),
  };
}

/**
 * Host validation. Runs for EVERY method including GET — DNS rebinding is a
 * read-exfiltration attack as much as a write one.
 *
 * X-Forwarded-Host is deliberately NOT consulted unless `trustProxy` is
 * explicitly enabled: it is attacker-controlled on any directly-reachable
 * listener, so honouring it by default would hand an attacker the very bypass
 * this check exists to prevent.
 */
function checkHost(req, policy) {
  // Duplicate-Host detection MUST NOT use req.headers.host: node collapses a
  // repeated Host header down to the FIRST value there, so `Array.isArray()`
  // on it is dead code and a request with two Host headers sails through
  // (verified: two Host headers -> req.headers.host is a plain string).
  // req.headersDistinct.host preserves every value; rawHeaders is the
  // fallback for any caller/fake that predates headersDistinct (node <18.3)
  // or constructs req objects by hand.
  //
  // This matters because a duplicated Host is a classic request-smuggling /
  // proxy-disagreement primitive: an intermediary may route on one value
  // while the origin server validates the other.
  const distinct = req.headersDistinct?.host;
  if (Array.isArray(distinct)) {
    if (distinct.length === 0) {
      return { ok: false, status: 400, code: 'bad_request', message: 'Missing or malformed Host header' };
    }
    if (distinct.length > 1) {
      return { ok: false, status: 400, code: 'bad_request', message: 'Duplicate Host header' };
    }
  } else if (Array.isArray(req.rawHeaders)) {
    let seen = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (String(req.rawHeaders[i]).toLowerCase() === 'host') seen++;
    }
    if (seen > 1) {
      return { ok: false, status: 400, code: 'bad_request', message: 'Duplicate Host header' };
    }
  }

  const rawHost = req.headers?.host;
  if (Array.isArray(rawHost)) {
    return { ok: false, status: 400, code: 'bad_request', message: 'Duplicate Host header' };
  }
  const parsed = parseHostHeader(rawHost);
  if (!parsed) {
    return { ok: false, status: 400, code: 'bad_request', message: 'Missing or malformed Host header' };
  }

  // Exact comparison, including port. A Host carrying an explicit port must
  // match an allow-list entry WITH that port — never fall back to the
  // bare-hostname entry, or "127.0.0.1:9999" would be accepted by a server
  // listening on 8642, defeating the point of pinning the port at all. A
  // Host with no port (proxied on 80/443) matches only a bare entry.
  const candidate = parsed.port === null
    ? parsed.hostname
    : `${parsed.hostname}:${parsed.port}`;

  if (policy.allowedHosts.has(candidate)) return { ok: true };

  // Loopback mode only: also accept the port this socket is ACTUALLY
  // listening on. The configured ADMIN_PORT and the real port always agree
  // in production (bootstrap.js/bin listen on exactly the resolved port),
  // but they diverge whenever a caller binds port 0 for an ephemeral port —
  // every test server, and any embedder that lets the OS choose. Reading the
  // real port from the socket keeps the check exact rather than forcing
  // those callers to either pre-compute the port or disable the check.
  // Never applied in remote mode: there the operator's explicit
  // ADMIN_ALLOWED_HOSTS is the whole policy, and a proxied deployment's
  // public port legitimately differs from the local listener's.
  if (!policy.allowRemote && parsed.port !== null && LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    const localPort = req.socket?.localPort;
    if (localPort !== undefined && String(localPort) === parsed.port) return { ok: true };
  }

  return {
    ok: false,
    status: 403,
    code: 'forbidden_host',
    message: 'Request rejected: Host header is not in the allowed host list.',
  };
}

/**
 * Cross-site request rejection for non-safe methods.
 *
 * Treatment of missing headers is the crux, so it is spelled out explicitly:
 *
 *   - `Sec-Fetch-Site` present  -> authoritative. Only `same-origin` and
 *     `none` (a user-initiated navigation) are accepted; `cross-site` and
 *     `same-site` are rejected. Browsers set this header themselves and it
 *     cannot be overridden by page JavaScript (it is a forbidden header
 *     name), which is why it is preferred over Origin when available.
 *   - `Sec-Fetch-Site` absent, `Origin` present -> fall back to exact-match
 *     Origin comparison against the request's own scheme+Host. `Origin: null`
 *     (sandboxed iframe, some redirect flows, `file://`) is REJECTED rather
 *     than treated as same-origin.
 *   - BOTH absent -> allowed. This is the non-browser case: curl, a
 *     server-to-server backend, an SDK. No browser omits both on a
 *     cross-origin non-safe request, so this does not open the vector this
 *     module closes, and requiring them would break every documented
 *     server-to-server integration.
 *
 * `Referer` is never consulted as a primary mechanism — it is stripped by
 * privacy tooling often enough to be unreliable, and is not a security
 * control.
 */
function checkCrossSite(req, policy) {
  const headers = req.headers ?? {};
  const fetchSite = headers['sec-fetch-site'];
  const origin = headers.origin;

  const hasFetchSite = typeof fetchSite === 'string' && fetchSite !== '';
  const hasOrigin = typeof origin === 'string' && origin !== '';

  const blocked = (message) => ({ ok: false, status: 403, code: 'cross_site_blocked', message });

  // BOTH signals are evaluated whenever both are present, and either one
  // failing rejects the request. An earlier revision returned early on
  // `Sec-Fetch-Site: same-origin|none` WITHOUT ever looking at Origin, which
  // meant any client able to set that one header (trivial for a non-browser
  // attacker, and `none` is also what some redirect/navigation flows carry)
  // bypassed Origin validation entirely. Fetch Metadata is unforgeable *by
  // page JavaScript* — it is not unforgeable by an arbitrary HTTP client, so
  // it may narrow a decision but must never widen one.
  if (hasFetchSite) {
    if (fetchSite !== 'same-origin' && fetchSite !== 'none') {
      return blocked(`Request rejected: cross-site requests are not permitted (Sec-Fetch-Site: ${fetchSite}).`);
    }
    // A browser that reports same-origin/none never attaches a foreign
    // Origin. If it did, the two signals contradict each other and the
    // request is forged — reject rather than trusting the friendlier one.
    // Falls through to the Origin validation below, which enforces exactly
    // that: a same-origin claim paired with a non-matching Origin is
    // rejected by the same comparison every other request goes through.
  }

  if (!hasOrigin) {
    // No Origin at all: a non-browser client (curl, backend, SDK). Browsers
    // always send Origin on cross-origin non-safe requests, so this does not
    // reopen the vector this module closes. See the function docstring.
    return { ok: true };
  }

  if (origin === 'null') {
    return blocked('Request rejected: opaque origin (Origin: null) is not permitted.');
  }

  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    return blocked('Request rejected: malformed Origin header.');
  }

  // Exact origin comparison: scheme + host + port, never host alone.
  // Comparing only the host accepted "https://127.0.0.1:8642" against a
  // plaintext HTTP server — a different origin by the web's own definition,
  // and a real downgrade/confusion vector behind a TLS-terminating proxy.
  const originValue = originUrl.origin.toLowerCase();
  if (policy?.allowedOrigins instanceof Set && policy.allowedOrigins.has(originValue)) {
    return { ok: true };
  }

  const host = headers.host;
  if (typeof host !== 'string' || host === '') {
    return blocked('Request rejected: Origin cannot be validated without a Host header.');
  }

  // Reconstruct this request's own origin. `req.socket.encrypted` is set by
  // node's TLS server; absent it, the connection is plaintext HTTP. A
  // TLS-terminating reverse proxy therefore needs an explicit
  // ADMIN_ALLOWED_ORIGINS entry rather than X-Forwarded-Proto, which is
  // attacker-controlled on a directly reachable listener (same reasoning as
  // X-Forwarded-Host in checkHost()).
  const scheme = req.socket?.encrypted ? 'https' : 'http';
  const selfOrigin = `${scheme}://${host}`.toLowerCase();

  if (originValue === selfOrigin) return { ok: true };

  return blocked('Request rejected: Origin does not match this server.');
}

/**
 * The full pre-dispatch verdict. Call this BEFORE route matching and BEFORE
 * reading any request body.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {ReturnType<typeof createRequestSecurityPolicy>} policy
 * @returns {{ ok: true } | { ok: false, status: number, code: string, message: string }}
 */
export function evaluateRequestSecurity(req, policy) {
  const hostVerdict = checkHost(req, policy);
  if (!hostVerdict.ok) return hostVerdict;

  if (SAFE_METHODS.has(req.method)) return { ok: true };

  return checkCrossSite(req, policy);
}

/**
 * Content-Type enforcement for JSON-body routes (Part C).
 *
 * Accepts `application/json` with an optional charset/other parameter
 * (`application/json; charset=utf-8`). Also accepts the structured-suffix
 * form (`application/vnd.foo+json`) since it is unambiguously JSON.
 *
 * A genuinely EMPTY body needs no Content-Type — several routes here are
 * body-less POSTs (sync-schema, job cancel, folder pick) and requiring a
 * header they have no body for would be pointless friction. Emptiness is
 * determined from Content-Length/Transfer-Encoding, never by reading the
 * stream (this must stay a pre-parse check).
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ ok: true } | { ok: false, status: 415, code: string, message: string }}
 */
export function checkJsonContentType(req) {
  const headers = req.headers ?? {};
  const contentLength = headers['content-length'];
  const hasChunkedBody = typeof headers['transfer-encoding'] === 'string'
    && headers['transfer-encoding'].toLowerCase().includes('chunked');
  const declaresEmpty = (contentLength === undefined || contentLength === '0') && !hasChunkedBody;

  const raw = headers['content-type'];
  if (declaresEmpty && (raw === undefined || raw === '')) return { ok: true };

  if (typeof raw !== 'string' || raw === '') {
    return {
      ok: false,
      status: 415,
      code: 'unsupported_media_type',
      message: `Unsupported Media Type: this endpoint requires Content-Type: ${JSON_MEDIA_TYPE}.`,
    };
  }

  const mediaType = raw.split(';')[0].trim().toLowerCase();
  const isJson = mediaType === JSON_MEDIA_TYPE || mediaType.endsWith('+json');
  if (!isJson) {
    return {
      ok: false,
      status: 415,
      code: 'unsupported_media_type',
      message: `Unsupported Media Type "${mediaType}": this endpoint requires Content-Type: ${JSON_MEDIA_TYPE}.`,
    };
  }

  return { ok: true };
}

/**
 * The ONE response-header security policy for every response this process
 * sends — API JSON (success, error, 404), and the static Admin UI shell
 * (HTML/JS/CSS/SVG/ICO, success and error). Applied uniformly across Full and
 * Lite so the two compositions cannot drift (docs/security/
 * semidex-lite-public-api-audit-2026-08.md §10 step 10).
 *
 * `style-src 'self' 'unsafe-inline'`: the built dashboard genuinely ships
 * static `style="..."` attributes (delete/operation modal backdrops'
 * `display:none` default state, a handful of spacing tweaks in the Lite
 * settings/index partials — see src/shared/admin/ui-src/partials/shared/
 * templates/{delete,operation}-modal.html and src/shared/admin/ui-src/
 * partials/lite/{settings-shell,index-view}.html). CSP's style-src covers
 * the `style` attribute, not only `<style>`/`<link>`, so a strict
 * `style-src 'self'` would silently break those elements' default-hidden
 * state and layout. `script-src` carries NO `unsafe-inline`/`unsafe-eval`:
 * the built bundle (`dist/admin-ui/assets/*.js`) is confirmed to ship zero
 * inline `<script>` tags or `javascript:` URIs — every script is the one
 * `type="module"` tag loading the hashed bundle — so script-src stays
 * strict. No CDN/external origin is loaded by the shipped HTML/CSS/JS (no
 * external `<link>`, `@font-face`, `url()`, or `fetch()` target other than
 * this same origin), so `default-src 'self'` covers connect/img/font
 * without a wildcard.
 *
 * No `Strict-Transport-Security`: this server is plain HTTP by default
 * (loopback or an operator-fronted reverse proxy that terminates TLS
 * itself) — HSTS on a listener that is not itself serving HTTPS is either a
 * no-op or, if ever bound to a name a browser also reaches over HTTP,
 * actively wrong. A TLS-terminating deployment should set HSTS at the
 * proxy, which is the layer that actually holds the certificate.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Response headers that must accompany every response this process sends —
 * API and static UI alike, success and error alike. Applying this once, as
 * early as possible (before route matching / before the static-vs-API
 * branch), means a rejected or 500'd request carries the same protections as
 * a successful one; nothing here depends on which branch produced the
 * response.
 */
export function applySecurityResponseHeaders(res) {
  if (typeof res?.setHeader !== 'function' || res.headersSent) return;
  // Vary: this process's handling of BOTH the API and the static UI can
  // differ by Origin/Sec-Fetch-Site (cross-site rejection) and by Host
  // (rebinding rejection), so a cache must never conflate two requests that
  // differ only in those headers.
  res.setHeader('Vary', 'Origin, Sec-Fetch-Site');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
}
