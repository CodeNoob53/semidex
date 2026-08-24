// Request-scoped billable-generation-work ledger for Ask v1/v2 — the P0
// "spend/token cost ceiling" gap this feature closes (see
// docs/security/ask-spend-token-budget-design-2026-08.md for the full
// design record; this module is the ledger half of it, mirroring how
// core/audit/event.js is the schema half of audit logging).
//
// ONE ledger is constructed per HTTP request (src/core/ask-api/v1/route.js,
// v2/route.js) and threaded through EVERY generation call that request may
// make: v1/v2's final answer (core/ask/coordinator.js), v2's query rewrite
// (query-rewrite.js), and v2's summary compaction (summary-compaction.js).
// No module along that path may construct an independent, hidden budget —
// they all reserve against and reconcile with this SAME object.
//
// RESERVE BEFORE, RECONCILE AFTER (never the reverse)
// -----------------------------------------------------
// reserve() is called BEFORE a provider call, with a CONSERVATIVE
// worst-case estimate (estimated input tokens + the maximum output tokens
// that call is allowed to produce). This is what "reject or stop work
// before knowingly exceeding a configured ceiling" means concretely: the
// provider is never invoked at all when the worst case wouldn't fit.
// reconcile() runs AFTER a call completes successfully, and may only ever
// REFUND the delta between the reservation and trustworthy real usage — it
// can never retroactively un-deny an already-rejected reserve() call (there
// is nothing to reconcile for a call that never ran), and it never charges
// MORE than was already reserved (the reservation was already the
// worst-case ceiling for that call). When usage is absent, non-finite, or
// negative — a provider that omitted usage metadata, or reported something
// nonsensical — NO refund happens and the full conservative reservation
// stays charged. This module never treats an estimated/reported token count
// as exact billing; see the design doc for why.
//
// TWO CEILINGS, ONE RESERVE() CALL
// ----------------------------------
// Every reserve() call is checked against BOTH:
//   1. This ledger's own PER-REQUEST ceilings (maxCallsPerRequest,
//      maxReservedTokensPerRequest) — a purely local, in-memory counter
//      that bounds how much billable work ONE Ask request (v2's up-to-3
//      calls included) may ever attempt, regardless of any key's aggregate
//      budget. Protects against one pathological request, independent of
//      how much headroom the calling key otherwise has.
//   2. The per-key AGGREGATE rolling budget (core/auth/token-budget.js),
//      via `tracker.reserve(keyId, cost, limits)` — this is what makes two
//      concurrent requests sharing one key unable to both reserve the same
//      remaining aggregate headroom: token-budget.js's bucket arithmetic is
//      synchronous (no `await` inside reserve()), so JS's single-threaded
//      event loop makes the check-and-decrement atomic by construction,
//      exactly like rate-limiter.js's own consume().
// The per-request check runs FIRST (cheap, local, no shared state touched)
// and only calls into the shared tracker if it passes — so a request that
// would blow its OWN ceiling never touches the per-key aggregate bucket at
// all, and a request that passes its own ceiling but loses the race for
// aggregate headroom leaves the per-request counters untouched by the
// portion of cost that was never actually granted (reserve() only
// increments `calls`/`totalReserved` on the branch that returns `ok:true`).
import { recordAuditEvent } from '../audit/sink.js';
import { AUDIT_EVENT_TYPE } from '../audit/event.js';

const DEFAULT_MAX_CALLS_PER_REQUEST = 5;
const DEFAULT_MAX_RESERVED_TOKENS_PER_REQUEST = 60_000;
// Matches core/ask/prompt.js's own RESERVED_HEADROOM_TOKENS (1024) — that
// constant is what the EXISTING context-budget math already reserves as
// generation headroom when fitting evidence to the model's context window
// (see evidence.js's fitEvidenceToContextBudget()). Defaulting the final
// answer's hard output-token cap to the SAME number means the new spend
// ceiling does not, by default, cap answers any tighter than the space the
// prompt-budgeting logic already assumed was available for them.
const DEFAULT_ANSWER_MAX_OUTPUT_TOKENS = 1024;

/**
 * Conservative chars->tokens conversion for deriving a PRE-CALL provider
 * output-token cap from an EXISTING post-hoc char-truncation limit (e.g.
 * query-rewrite.js's own MAX_OUTPUT_CHARS, summary-compaction.js's own
 * SUMMARY_OUTPUT_CAP_CHARS — each module computes its OWN
 * *_MAX_OUTPUT_TOKENS constant from this function directly, rather than
 * importing one from here, to avoid a circular import between this module
 * and theirs). Uses a conservative 3-chars-per-token ratio (denser than
 * shared/core/token-count.js's own 4-chars-per-token heuristicTokenCount()
 * fallback) plus a fixed token margin, so real tokenizer variance — many
 * non-English scripts and punctuation-heavy text average FEWER than 4 chars
 * per token — never causes the existing char limit's intended output to be
 * truncated by the provider's own maxOutputTokens/num_predict cap before
 * that module's own char check would have allowed it to finish.
 * @param {number} maxChars
 * @param {number} [marginTokens]
 */
export function outputTokenCapFromCharLimit(maxChars, marginTokens = 64) {
  return Math.ceil(maxChars / 3) + marginTokens;
}

function settingOr(settingsService, key, fallback) {
  return settingsService ? settingsService.getActiveValue(key) : fallback;
}

/** The final-answer call's provider-side output-token reservation (ASK_MAX_OUTPUT_TOKENS, operator-tunable). */
export function resolveAnswerMaxOutputTokens(settingsService) {
  return settingOr(settingsService, 'ASK_MAX_OUTPUT_TOKENS', DEFAULT_ANSWER_MAX_OUTPUT_TOKENS);
}

function resolveMaxCallsPerRequest(settingsService) {
  return settingOr(settingsService, 'ASK_MAX_CALLS_PER_REQUEST', DEFAULT_MAX_CALLS_PER_REQUEST);
}

function resolveMaxReservedTokensPerRequest(settingsService) {
  return settingOr(settingsService, 'ASK_MAX_RESERVED_TOKENS_PER_REQUEST', DEFAULT_MAX_RESERVED_TOKENS_PER_REQUEST);
}

/**
 * Constructs one request-scoped ledger. `keyId`/`limits` identify and size
 * the caller's per-key aggregate bucket on `tracker`
 * (core/auth/token-budget.js) — production callers (src/core/ask-api/v1/
 * route.js, v2/route.js) always supply the authenticated principal's
 * `keyId` and its effective `tokensPerHour`/`burstTokens` limits, since
 * every route this ledger protects is `audience: integration` and therefore
 * always has an authenticated principal by the time its handler runs.
 *
 * @param {{
 *   tracker: ReturnType<typeof import('../auth/token-budget.js').createTokenBudgetTracker>,
 *   keyId: string,
 *   limits?: { tokensPerHour?: number, burstTokens?: number },
 *   settingsService?: ReturnType<typeof import('../settings/service.js').createSettingsService>,
 *   maxCallsPerRequest?: number,
 *   maxReservedTokensPerRequest?: number,
 *   onDenied?: (info: { label: string, code: string, message: string, keyId: string, calls: number, totalReserved: number, retryAfterSeconds?: number }) => void,
 * }} opts
 */
export function createRequestBudgetLedger({
  tracker,
  keyId,
  limits = {},
  settingsService,
  maxCallsPerRequest = resolveMaxCallsPerRequest(settingsService),
  maxReservedTokensPerRequest = resolveMaxReservedTokensPerRequest(settingsService),
  onDenied,
} = {}) {
  if (!tracker || typeof tracker.reserve !== 'function' || typeof tracker.release !== 'function') {
    throw new TypeError('createRequestBudgetLedger requires a tracker with reserve()/release() (see core/auth/token-budget.js).');
  }
  if (typeof keyId !== 'string' || keyId.length === 0) {
    throw new TypeError('createRequestBudgetLedger requires a non-empty string keyId.');
  }

  let calls = 0;
  let totalReserved = 0;
  let nextReservationId = 1;
  /** @type {Map<number, { cost: number, label: string }>} */
  const outstanding = new Map();

  function deny(label, code, message, extra = {}) {
    onDenied?.({ label, code, message, keyId, calls, totalReserved, ...extra });
    return { ok: false, code, message, ...extra };
  }

  return {
    /**
     * Reserves budget for ONE upcoming provider call. Returns
     * `{ ok:true, reservationId, maxOutputTokens }` (pass `maxOutputTokens`
     * straight through to `generationProvider.generate({ options: {
     * maxOutputTokens } })`) or `{ ok:false, code, message, retryAfterSeconds? }`
     * — a denial the caller must treat as "do not call the provider for
     * this label at all."
     *
     * @param {{ label: 'rewrite'|'answer'|'compaction', estimatedInputTokens: number, maxOutputTokens: number }} args
     */
    reserve({ label, estimatedInputTokens, maxOutputTokens }) {
      if (!Number.isFinite(estimatedInputTokens) || estimatedInputTokens < 0) {
        throw new TypeError('budget ledger reserve() requires a finite, non-negative estimatedInputTokens.');
      }
      if (!Number.isFinite(maxOutputTokens) || maxOutputTokens < 0) {
        throw new TypeError('budget ledger reserve() requires a finite, non-negative maxOutputTokens.');
      }

      if (calls >= maxCallsPerRequest) {
        return deny(label, 'request_call_ceiling_exceeded',
          `This Ask request would exceed the maximum of ${maxCallsPerRequest} generation calls allowed per request.`,
          { estimatedInputTokens, maxOutputTokens });
      }

      const cost = estimatedInputTokens + maxOutputTokens;
      if (totalReserved + cost > maxReservedTokensPerRequest) {
        return deny(label, 'request_token_ceiling_exceeded',
          `This Ask request would exceed the maximum of ${maxReservedTokensPerRequest} reserved tokens allowed per request.`,
          { estimatedInputTokens, maxOutputTokens });
      }

      const trackerResult = tracker.reserve(keyId, cost, limits);
      if (!trackerResult.allowed) {
        if (trackerResult.exceedsCapacity) {
          return deny(label, 'key_budget_ceiling_too_small',
            'A single required reservation exceeds this key\'s configured token budget ceiling. Increase the key\'s token budget to use this endpoint.',
            { estimatedInputTokens, maxOutputTokens });
        }
        const retryAfterSeconds = Math.max(1, Math.ceil(trackerResult.retryAfterMs / 1000));
        return deny(label, 'key_budget_exceeded',
          'This key has exhausted its token budget. Retry after the indicated delay.',
          { estimatedInputTokens, maxOutputTokens, retryAfterSeconds });
      }

      calls += 1;
      totalReserved += cost;
      const reservationId = nextReservationId++;
      outstanding.set(reservationId, { cost, label });
      return { ok: true, reservationId, maxOutputTokens };
    },

    /**
     * Reconciles a completed call's reservation against REPORTED usage.
     * Only ever REFUNDS (never charges more than was reserved, never
     * un-denies a prior rejection). No-op for an unknown/already-reconciled
     * reservationId (defensive — a caller must not double-reconcile, but a
     * defensive no-op here is safer than throwing mid-response).
     *
     * @param {number} reservationId
     * @param {{ tokensIn?: number, tokensOut?: number }} [usage] absent or
     *   non-finite/negative fields are treated as "usage unknown" for that
     *   side — the conservative reservation is retained, not partially
     *   refunded from a half-known number.
     */
    reconcile(reservationId, usage) {
      const entry = outstanding.get(reservationId);
      if (!entry) return;
      outstanding.delete(reservationId);

      const tokensIn = Number.isFinite(usage?.tokensIn) && usage.tokensIn >= 0 ? usage.tokensIn : null;
      const tokensOut = Number.isFinite(usage?.tokensOut) && usage.tokensOut >= 0 ? usage.tokensOut : null;
      if (tokensIn === null || tokensOut === null) return; // absent/ambiguous usage -- retain the full conservative reservation

      const actualCost = tokensIn + tokensOut;
      const refund = Math.max(0, entry.cost - actualCost);
      if (refund > 0) {
        totalReserved -= refund;
        tracker.release(keyId, refund);
      }
    },

    /** Test/diagnostic hook: this request's running totals. */
    snapshot() {
      return { calls, totalReserved, outstandingReservations: outstanding.size };
    },
  };
}

/**
 * Route-level convenience wrapper shared by src/core/ask-api/v1/route.js
 * and v2/route.js — builds the one ledger for THIS request from the
 * router's own frozen `auth` context (the same object stage 2's
 * authorizeCollectionAccess already reads), and wires denial audit events
 * through `auth.auditSink`/`auth.requestId`/`auth.route` exactly like
 * authorize.js's own recordCollectionDenied() does, so the two call sites
 * cannot drift into different ledger-construction or audit-field logic.
 *
 * Returns `undefined` (no enforcement) when there is no `tracker` or no
 * authenticated principal to key a bucket on — this mirrors
 * authorizeCollectionAccess()'s own "no policy configured — unchanged
 * behavior" contract: every route this ledger protects declares
 * `audience: integration`, so a real deployment always has a principal by
 * the time a route handler runs; the only way to reach this branch is a
 * test that deliberately constructs a router with no integration policy at
 * all, which must keep behaving exactly as it did before this feature
 * existed.
 *
 * @param {{
 *   auth: { principal: Object|null, route: Object|null, requestId: string|null, auditSink: import('../audit/sink.js').AuditSink|null },
 *   tracker: ReturnType<typeof import('../auth/token-budget.js').createTokenBudgetTracker>|null|undefined,
 *   settingsService?: Object,
 * }} args
 * @returns {ReturnType<typeof createRequestBudgetLedger>|undefined}
 */
export function createAskRequestBudget({ auth, tracker, settingsService }) {
  const keyId = auth?.principal?.keyId;
  if (!tracker || typeof keyId !== 'string' || keyId.length === 0) return undefined;

  return createRequestBudgetLedger({
    tracker,
    keyId,
    limits: {
      tokensPerHour: auth.principal.tokenBudgetPerHour,
      burstTokens: auth.principal.tokenBudgetBurst,
    },
    settingsService,
    onDenied: (info) => {
      recordAuditEvent(auth.auditSink, AUDIT_EVENT_TYPE.BUDGET_RESERVATION_DENIED, {
        outcome: 'denied',
        requestId: auth.requestId ?? null,
        route: auth.route ? { method: auth.route.method, path: auth.route.path } : null,
        audience: auth.route?.audience ?? null,
        operation: auth.route?.operation ?? null,
        reason: info.code,
        keyId: info.keyId,
        label: info.label,
        estimatedInputTokens: info.estimatedInputTokens,
        maxOutputTokens: info.maxOutputTokens,
        ...(Number.isFinite(info.retryAfterSeconds) ? { retryAfterSeconds: info.retryAfterSeconds } : {}),
      });
    },
  });
}
