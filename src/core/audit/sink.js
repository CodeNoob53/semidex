// The narrow AuditSink contract every implementation (no-op, JSONL,
// a future PostgreSQL adapter) satisfies, plus recordAuditEvent() — the one
// helper every call site (router.js, authorize.js, jobs.js, registry.js,
// settings.js, collections.js, key-cli.js) uses instead of calling
// buildAuditEvent()+sink.record() directly. See jsonl-sink.js for the real
// local implementation and resolve-sink.js for instance-scoped
// construction. Design record: docs/security/audit-logging-design-2026-08.md.
import { buildAuditEvent } from './event.js';

/**
 * @typedef {{
 *   record: (event: Readonly<Object>) => void,
 *   flush: () => Promise<void>,
 *   close: () => Promise<void>,
 * }} AuditSink
 *
 * record() NEVER throws and NEVER blocks the caller — it is called from
 * request-handling hot paths (router.js) and must degrade (drop the event,
 * warn the operator) rather than fail the request it is trying to audit.
 * flush() resolves once every event record() has accepted is durable.
 * close() is flush() plus releasing any resources (in particular: it must
 * make the process eligible to exit — no dangling timer/interval).
 */

/**
 * A sink that discards every event. The default whenever no real sink is
 * injected (createRouter()/createJobRegistry() without an explicit
 * auditSink, SEMIDEX_AUDIT_LOG_DISABLED=1) — every existing test/call site
 * built before this feature existed keeps working unchanged.
 * @returns {AuditSink}
 */
export function createNoopAuditSink() {
  return {
    record() {},
    async flush() {},
    async close() {},
  };
}

// Identifies a sink returned by withEditionTag() and records which edition
// it forces plus a reference to the ORIGINAL (pre-wrap) sink it wraps —
// this is what lets ensureEditionTag() below collapse repeated wrapping
// into at most one layer instead of nesting wrappers.
const EDITION_INFO = Symbol('auditSinkEditionInfo');

/**
 * Wraps `sink` so every event that flows through record() carries `edition`
 * fixed to the given value, regardless of what buildAuditEvent() defaulted
 * it to (always `null` today — no call site passes `edition` itself; see
 * router.js/registry.js/authorize.js/settings.js/collections.js/key-cli.js).
 * This is the one place resolveAuditSink({ edition }) actually takes effect:
 * a sink instance is constructed by exactly one composition root (Full or
 * Lite), so it alone knows which edition every event passing through it
 * belongs to — no per-call-site plumbing needed.
 *
 * Never mutates the event it was handed: buildAuditEvent() output is
 * frozen, and even an unfrozen event may be a reference the caller reuses.
 * A new, frozen object is recorded downstream instead.
 *
 * Composing two of these naively (wrapping an ALREADY-wrapped sink) would
 * NOT do what it looks like: record() here forwards a MODIFIED event
 * ({...event, edition}) into `sink.record()`, so whichever wrapper sits
 * closest to the real, physical sink is the one whose `edition` value
 * survives — an outer wrap can never override an inner one this way, it
 * would just be silently discarded downstream. Composition roots must
 * therefore never call withEditionTag() directly on a sink they did not
 * construct themselves; use ensureEditionTag() (below) instead, which
 * collapses any existing wrap rather than stacking a second one around it.
 * @param {import('./sink.js').AuditSink} sink
 * @param {'full'|'lite'} edition
 * @returns {AuditSink}
 */
export function withEditionTag(sink, edition) {
  const wrapped = {
    record(event) {
      if (!event || typeof event !== 'object') { sink.record(event); return; }
      sink.record(Object.freeze({ ...event, edition }));
    },
    flush: () => sink.flush(),
    close: () => sink.close(),
  };
  wrapped[EDITION_INFO] = { edition, base: sink };
  return wrapped;
}

/**
 * The composition-root-safe way to guarantee `sink` is tagged with exactly
 * `edition`, used by createApp()/createLiteApp()/startLite() on whatever
 * `auditSink` a caller injects — including a plain/custom sink that was
 * never built by resolveAuditSink() at all, and including a sink some OTHER
 * composition root already tagged with the opposite edition (accidentally,
 * or an attempt to override this composition root's own edition).
 *
 * - Untagged (plain) sink: wrapped once, exactly like calling
 *   withEditionTag(sink, edition) directly.
 * - Already tagged with `edition`: returned unchanged — no redundant wrap
 *   (this is what lets startLite() hand its own resolveAuditSink()-built
 *   sink into createLiteApp() without stacking a second wrapper on top).
 * - Tagged with a DIFFERENT edition: the stale tag is discarded and the
 *   ORIGINAL, pre-wrap sink (recorded on the existing wrapper via
 *   `EDITION_INFO.base`) is rewrapped with `edition` instead. Rewrapping
 *   the outside of the existing wrapper would silently fail here — see
 *   withEditionTag()'s own comment for why an outer wrap can never
 *   override an inner one — so this unwraps down to the real base sink
 *   first and applies exactly one fresh wrap around THAT. Either way the
 *   result carries at most one wrap layer, never a nested chain.
 * @param {import('./sink.js').AuditSink|null|undefined} sink
 * @param {'full'|'lite'} edition
 * @returns {AuditSink|null|undefined}
 */
export function ensureEditionTag(sink, edition) {
  if (!sink) return sink;
  const info = sink[EDITION_INFO];
  if (info && info.edition === edition) return sink;
  return withEditionTag(info ? info.base : sink, edition);
}

/**
 * Builds and records one event through `sink`, never letting a
 * construction failure (a call site passing a field buildAuditEvent()
 * rejects — a programmer error that SHOULD throw loudly in a unit test)
 * reach into and break the caller's own request/response flow in
 * production. This is deliberately a SEPARATE safety net from
 * `record()`'s own "never throws" contract: `record()` protects against a
 * bad EVENT reaching a sink; this protects every call site from a bad
 * BUILD reaching `record()` at all. `sink` may be `null`/`undefined` (a
 * caller that has no `auth.auditSink` — e.g. a context built by a test
 * that omits one) — a no-op in that case, same as if a no-op sink had been
 * supplied explicitly.
 * @param {import('./sink.js').AuditSink|null|undefined} sink
 * @param {string} type one of AUDIT_EVENT_TYPE
 * @param {Object} fields
 */
export function recordAuditEvent(sink, type, fields) {
  if (!sink) return;
  let event;
  try {
    event = buildAuditEvent(type, fields);
  } catch (err) {
    console.error(`[semidex] audit event construction failed for type "${type}" — event dropped, not written: ${err.message}`);
    return;
  }
  sink.record(event);
}
