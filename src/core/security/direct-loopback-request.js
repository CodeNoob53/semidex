// Narrow MVP trust boundary for sensitive destination-changing settings.
// PATCH /api/settings accepts a QDRANT_URL or OLLAMA_URL change only when
// evaluateDirectLoopbackConnection() returns ok:true.
//
// What this is NOT: authentication, and not a general request-trust
// mechanism. It answers exactly one narrow question — "did this TCP
// connection reach this process directly, from this same machine, with
// nothing relaying it?" A reverse proxy running on the same host connects
// to this process over its OWN loopback socket too, so a bare
// `req.socket.remoteAddress === '127.0.0.1'` check can NEVER by itself
// distinguish the operator from a caller the proxy is relaying — this is
// why forwarding headers are treated as a disqualifying signal rather than
// an authentication boundary.
//
// Consistent with that limitation, this module never TRUSTS a forwarding
// header's VALUE (an attacker or a misconfigured proxy can set any of them
// to anything) — it only treats a forwarding header's mere PRESENCE as a
// disqualifying signal, exactly the "may narrow a decision, must never
// widen one" discipline core/http/request-security.js's own Sec-Fetch-Site
// handling already uses. This closes the realistic, common shape (any
// proxy that behaves like a proxy — nginx, Caddy, a wrapper backend's own
// HTTP client library — adds at least one of these headers by default).
//
// Explicitly acknowledged residual gap, not silently assumed away: a bare
// TCP-level passthrough (a stream-mode/L4 proxy that relays bytes without
// adding ANY request header) is indistinguishable from a genuine local
// caller by this or any other means available to a plain node:http server
// Full Admin authentication or avoiding such a proxy is required to close
// that residual case; this narrow helper does not claim otherwise.

// Deliberately broader than request-security.js's own trustProxy-gated
// X-Forwarded-Host check (which only ever consults ONE header, and only
// when trustProxy is explicitly enabled — trustProxy is always false in
// this codebase today). Every one of these is checked here regardless of
// any trustProxy setting, because presence alone — never the value — is
// what this module reads.
const FORWARDING_HEADER_NAMES = Object.freeze([
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-server',
  'forwarded',
  'x-real-ip',
  'via',
  'client-ip',
  'true-client-ip',
  'cf-connecting-ip',
]);

// Exact-match / prefix-match against a raw socket address (never
// attacker-suppliable text — node's own TCP stack reports this), so there
// is no request-security.js-style "never suffix match" concern here. IPv4
// loopback is the whole 127.0.0.0/8 range per RFC 5735, not just
// 127.0.0.1; ::1 is IPv6 loopback; the ::ffff:127.x.x.x form is how a
// dual-stack listener reports an IPv4 client.
function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false;
  if (address === '::1') return true;
  const unmapped = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return unmapped.startsWith('127.');
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ ok: true } | { ok: false, reason: 'forwarding_headers_present' | 'not_loopback' }}
 */
export function evaluateDirectLoopbackConnection(req) {
  const headers = req?.headers ?? {};
  for (const name of FORWARDING_HEADER_NAMES) {
    // Own-property PRESENCE alone disqualifies — never the value. An empty
    // string, a string-array (Node's own dedup shape for a repeated header),
    // or any other normalized form a proxy/HTTP layer might produce are all
    // still "this header was present on the wire" and must not be trusted
    // away by inspecting what it contains.
    if (Object.prototype.hasOwnProperty.call(headers, name)) {
      return { ok: false, reason: 'forwarding_headers_present' };
    }
  }

  const remoteAddress = req?.socket?.remoteAddress;
  if (!isLoopbackAddress(remoteAddress)) {
    return { ok: false, reason: 'not_loopback' };
  }

  return { ok: true };
}

export function isDirectLoopbackConnection(req) {
  return evaluateDirectLoopbackConnection(req).ok;
}
