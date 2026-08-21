// Shared, pure URL-shape validation for outbound capability-specific Qdrant
// and Ollama policies. This module holds no mutable state; each capability
// wraps the value-level check in its own instance-scoped policy factory.
//
// Scope is deliberately narrow: this
// only bounds what a configured URL VALUE may look like — scheme, userinfo,
// and a well-known cloud-metadata literal block list. It does not resolve
// DNS and does not implement generic private-network blocking
// (loopback/RFC1918/LAN/Docker hostnames are
// intentionally never rejected here — see METADATA_HOSTNAMES's own comment).
import { domainToASCII } from 'node:url';

export class EgressPolicyError extends Error {
  /**
   * @param {{ capability: string, reason: string }} opts
   */
  constructor({ capability, reason }) {
    // Deliberately generic: never interpolates the rejected URL itself, so
    // this message can never echo embedded userinfo/credentials or a
    // secret-bearing query string back to a caller or a log line.
    super(`${capability} URL rejected by egress policy (${reason}). Refusing to connect.`);
    this.name = 'EgressPolicyError';
    this.code = 'egress_policy_blocked';
    this.capability = capability;
    this.reason = reason;
  }
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

// Well-known cloud-metadata service literals. Every entry is the exact
// string `new URL(...).hostname`
// already produces for that address (lower-cased, IPv6 zero-compressed,
// IPv4-mapped-form canonicalized to the hex-group spelling, never the
// dotted-quad one — verified directly against this repo's installed Node
// runtime, not assumed from the RFC text) — compared with a Set.has() exact
// match, never a suffix/substring test. A suffix test on a DNS name is a
// bypass surface, not a safety net (request-security.js's own
// LOOPBACK_HOSTNAMES comment makes the same point for Host-header
// comparison) — "evil-metadata.google.internal.attacker.example" must
// never match "metadata.google.internal", and it does not, by construction,
// with an exact-match Set.
//
// Loopback, RFC1918 LAN ranges, and Docker-internal hostnames are
// deliberately ABSENT from this set: they are the documented, supported
// deployment shape (audit §5 — self-hosted Qdrant/Ollama on loopback/LAN/
// Docker is normal, not a finding) and must never be rejected by this
// policy.
const METADATA_HOSTNAMES = new Set([
  '169.254.169.254', // AWS/GCP/Azure IPv4 link-local metadata literal
  '[::ffff:a9fe:a9fe]', // IPv4-mapped IPv6 form of 169.254.169.254, exactly as WHATWG URL canonicalizes it (never the dotted-quad "::ffff:169.254.169.254" spelling)
  '[fd00:ec2::254]', // AWS-documented native IPv6 metadata address
  '[fd20:ce::254]', // GCP-documented native IPv6 metadata address
  'metadata.google.internal', // GCP metadata DNS name
]);

/**
 * @param {string} rawUrl
 * @param {{ allowMetadataAddresses?: boolean }} [opts] allowMetadataAddresses
 *   is the explicit, off-by-default escape hatch for a controlled test that
 *   deliberately targets a metadata-shaped mock — mirrors ADMIN_ALLOW_REMOTE's
 *   own single-flag shape elsewhere in this codebase. Never widens anything
 *   else this function checks.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function evaluateEgressUrl(rawUrl, { allowMetadataAddresses = false } = {}) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return { ok: false, reason: 'empty_url' };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'malformed_url' };
  }

  // Scheme allow-list: OWASP's own SSRF cheat sheet notes SSRF is not
  // limited to HTTP schemes (source-notes §OWASP) — file:/ftp:/gopher:/etc.
  // are all rejected outright, regardless of host.
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { ok: false, reason: 'scheme_not_allowed' };
  }

  // Userinfo-in-URL is never a legitimate QDRANT_URL/OLLAMA_URL shape in
  // this codebase (the API key travels as a separate field/header, never
  // embedded in the URL) and is a classic parser-confusion vector — different
  // HTTP clients/proxies can disagree about which host a URL with embedded
  // userinfo actually targets.
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'userinfo_not_allowed' };
  }

  // parsed.hostname is already lower-cased and IPv6-canonicalized by the
  // WHATWG URL parser itself. domainToASCII() is applied on top as the
  // explicit, documented Punycode-canonicalization step (source-notes' own
  // Node URL API citation), so a Unicode/IDN hostname spelling of a blocked
  // literal can never slip past a naive string check. domainToASCII()
  // returns '' for an invalid domain (Node's own documented behavior) —
  // treated here as malformed, not as "nothing to check".
  const canonicalHost = domainToASCII(parsed.hostname);
  if (canonicalHost === '') {
    return { ok: false, reason: 'malformed_url' };
  }

  if (!allowMetadataAddresses && METADATA_HOSTNAMES.has(canonicalHost)) {
    return { ok: false, reason: 'metadata_address_blocked' };
  }

  // Deliberately no further restriction: port, path, query, and fragment
  // are all left alone (Qdrant/Ollama deployments routinely use non-default
  // ports and path prefixes — audit §8.1's own "this policy's job is
  // destination-host validation, not URL-shape minimization" framing), and
  // no generic private-network/DNS-resolution check is performed (out of
  // scope for this pass — see the audit's §9/§10 item D).
  return { ok: true };
}
