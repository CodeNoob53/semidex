// Shared test helper: an integration policy that authenticates nothing.
//
// Integration API authentication is ON by default in both composition roots
// (createApp / createLiteApp resolve a real key-store-backed policy when the
// caller injects none). That is the correct production default — a server
// with no key store returns 503 for Ask — but it means any test that
// exercises Ask WITHOUT caring about authentication must opt out explicitly.
//
// This helper is that opt-out. It is deliberately a single shared object
// rather than an inline literal per test file, so "which tests bypass auth"
// is one greppable import instead of a dozen hand-written policies that could
// each drift into something subtly different.
//
// Tests that are ABOUT authentication build their own policy from a real
// key store instead — see integration-auth-http.test.js.

/**
 * Allows every request, with a fixed anonymous principal scoped to all
 * collections. Satisfies the atomic-policy contract (both halves supplied)
 * and the plain-JSON principal contract.
 */
export const OPEN_INTEGRATION_POLICY = Object.freeze({
  authorizeRequest: () => ({
    ok: true,
    principal: { keyId: 'test-open-policy', name: 'test', operations: ['generate'], collections: ['*'], expiresAt: null },
  }),
  authorizeCollection: () => ({ ok: true }),
});
