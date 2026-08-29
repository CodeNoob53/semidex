// Type declarations for semidex-lite/client — hand-written, package-native
// (no build tool, no TypeScript compilation step; this file is shipped
// as-is alongside index.js so an editor/tsc consumer gets real types while
// the runtime stays plain ESM/JSDoc).

export interface SemidexApiErrorDetails {
  status: number | null;
  code: string | null;
  retryable: boolean;
  retryAfterSeconds: number | null;
  requestId: string | null;
  apiVersion: string | null;
}

/**
 * The one typed error this client ever throws for a request-level failure —
 * a non-2xx JSON response, or a terminal SSE `error` event. Never carries
 * the API key or any other secret.
 */
export class SemidexApiError extends Error implements SemidexApiErrorDetails {
  readonly name: 'SemidexApiError';
  readonly status: number | null;
  readonly code: string | null;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  readonly requestId: string | null;
  readonly apiVersion: string | null;
  /**
   * How many retries were spent before this failure (0 when the first
   * attempt failed and was not retried). Non-enumerable, so the error's
   * serialized shape is unchanged.
   */
  readonly retries?: number;
}

/**
 * A single retry, reported to `retry.onRetry`. Carries only safe,
 * serializable fields — never the API key, a header, or a request body.
 */
export interface RetryInfo {
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  /** 1-based index of the attempt about to be made. */
  nextAttempt: number;
  /** How long the client will wait before the next attempt. */
  delayMs: number;
  /** Whether `delayMs` came from the server's `Retry-After` or the client's own backoff schedule. */
  delaySource: 'retry-after' | 'backoff';
  status: number | null;
  code: string | null;
  retryAfterSeconds: number | null;
  /** The failed attempt's error message. */
  reason: string;
}

/**
 * Bounded retry policy. Applies ONLY to pre-stream failures, and the
 * eligibility rule is DIFFERENT for `search()` versus `askV1()`/`askV2()`/
 * `askText()`, because Ask is not idempotent and Search is:
 *
 * - `search()`: network errors before any response, and HTTP
 *   `429`/`502`/`503`/`504`.
 * - `askV1()`/`askV2()`/`askText()`: ONLY a genuinely received pre-stream
 *   Semidex JSON error body whose own payload explicitly says
 *   `retryable: true`. A network error before any response is NEVER
 *   retried for Ask — a lost connection before headers cannot be told
 *   apart from "the server already started generating", and retrying would
 *   risk a duplicate generation. A generic reverse-proxy `502`/`504` with
 *   no recognized `retryable: true` Semidex envelope does not qualify
 *   either.
 *
 * Neither is ever applied to `400`/`401`/`403`/`404`, to a validation
 * error, or to ANY failure once an Ask SSE stream has begun (a started
 * generation is never re-run).
 */
export interface RetryOptions {
  /**
   * Total attempts, not extra attempts — `1` means no retry.
   * Conservative by default so upgrading never silently multiplies requests.
   * Must be an integer in 1..10.
   * @default 1
   */
  attempts?: number;
  /** Base delay for the exponential schedule. @default 250 */
  initialDelayMs?: number;
  /** Hard ceiling on any single wait, including one derived from `Retry-After`. @default 8000 */
  maxDelayMs?: number;
  /** Exponential growth factor; must be >= 1. @default 2 */
  backoffFactor?: number;
  /** Randomize each delay over [half, full] of the computed value. @default true */
  jitter?: boolean;
  /** Called before each retry with a secret-free record. Errors thrown here are ignored. */
  onRetry?: (info: RetryInfo) => void;
}

/** The built-in retry defaults (`attempts: 1` — retries are opt-in). */
export const DEFAULT_RETRY: Required<Omit<RetryOptions, 'onRetry'>>;

export interface CreateSemidexClientOptions {
  /** Bare origin (+ optional path prefix), e.g. "http://127.0.0.1:8642". No query string, no fragment, no userinfo. */
  baseUrl: string;
  /** An Integration API bearer token from `semidex-lite key add` (e.g. "sdx_v1_..."). Sent as `Authorization: Bearer <apiKey>`, never in a URL. */
  apiKey: string;
  /**
   * Default TOTAL wall-clock budget per call, in milliseconds — covering
   * every retry attempt and every backoff sleep, never per-attempt. Opting
   * into retries can therefore not make a call outlive this.
   * @default 60000
   */
  timeoutMs?: number;
  /** Default retry policy for every call. Per-call `retry` layers onto this. @default { attempts: 1 } */
  retry?: RetryOptions;
  /**
   * HTTP implementation used for every Search and Ask request. Defaults to
   * the platform `globalThis.fetch`, captured once at construction (so a
   * later reassignment of the global cannot hijack an existing client).
   *
   * Inject your own for a proxy/mTLS agent, request logging or tracing, a
   * test double, or a runtime whose fetch is not on `globalThis`. Must be
   * callable — anything else throws `TypeError` synchronously, including
   * `null` (which signals an unresolved config value, not "use the default";
   * only omission or `undefined` selects the platform fetch).
   *
   * Injection changes only WHO performs the request. Every call still
   * receives `redirect: 'error'` and the client's composed `AbortSignal`,
   * and the URL is still built from the pinned `baseUrl` origin — the client
   * neither drops nor relaxes those for a custom implementation, and never
   * falls back to the global once an implementation is resolved.
   */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

export interface SearchArgs {
  collection: string;
  query: string;
  /** @default 3 */
  top?: number;
  /** @default 0 */
  window?: number;
  windowFormat?: 'compact' | 'full';
  sourceFile?: string;
  tags?: string[];
  signal?: AbortSignal;
  /** TOTAL wall-clock budget for this call, retries and backoff included. */
  timeoutMs?: number;
  /** Retry policy for this call; layers onto the client-level `retry`. */
  retry?: RetryOptions;
}

export interface SearchResultWindowChunk {
  sourceFile: string;
  chunkIndex: number;
  section: string;
  isMatch: boolean;
  textSnippet?: string;
  text?: string | null;
}

export interface SearchResult {
  sourceFile: string | null;
  chunkIndex: number | null;
  totalChunks: number | null;
  section: string;
  text: string | null;
  context: string | null;
  tags: string[];
  score: number | null;
  nodeId: string | null;
  nodePath: string | null;
  nodeType: string | null;
  isMatch: boolean;
  windowChunks?: SearchResultWindowChunk[];
}

export interface SearchResponse {
  apiVersion: 'v1';
  collection: string;
  query: string;
  searchMode: string | null;
  top: number;
  window: number;
  windowFormat: 'compact' | 'full' | null;
  results: SearchResult[];
  /**
   * How many retries this call cost (0 when the first attempt succeeded).
   * Non-enumerable: absent from `Object.keys()` and `JSON.stringify()`, so
   * the Search response contract is byte-for-byte unchanged.
   */
  readonly retries?: number;
}

export interface AskV1Args {
  collection: string;
  question: string;
  scope?: { sourceFile?: string };
  signal?: AbortSignal;
  /** TOTAL wall-clock budget for this call, retries and backoff included. */
  timeoutMs?: number;
  /**
   * Retry policy for this call; layers onto the client-level `retry`.
   * Applies to the PRE-STREAM leg only — once the SSE stream begins, the
   * generation is never re-run. Within the pre-stream leg, eligibility is
   * narrower than `search()`'s: a network failure before any response is
   * NEVER retried (Ask is not idempotent), only a received Semidex JSON
   * error that itself says `retryable: true` — see `RetryOptions`.
   */
  retry?: RetryOptions;
}

export interface AskConversationInput {
  /** Caller-owned conversation identifier. Required whenever `conversation` is supplied at all — Semidex never generates or stores this. */
  conversationId: string;
  /** The caller's own previously-stored rolling summary, if any (first turn: omit). */
  summary?: string;
  /** The caller's own bounded recent-message window (server-enforced ceiling: 200 entries). */
  recentMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface AskV2Args {
  collection: string;
  question: string;
  conversation?: AskConversationInput;
  signal?: AbortSignal;
  /** TOTAL wall-clock budget for this call, retries and backoff included. */
  timeoutMs?: number;
  /**
   * Retry policy for this call; layers onto the client-level `retry`.
   * Applies to the PRE-STREAM leg only — once the SSE stream begins, the
   * generation is never re-run. Within the pre-stream leg, eligibility is
   * narrower than `search()`'s: a network failure before any response is
   * NEVER retried (Ask is not idempotent), only a received Semidex JSON
   * error that itself says `retryable: true` — see `RetryOptions`.
   */
  retry?: RetryOptions;
}

export interface AskSource {
  n: number;
  sourceFile: string | null;
  chunkIndex: number | null;
  section: string | null;
  nodeId: string | null;
  nodePath: string | null;
  nodeType: string | null;
  snippet: string;
  truncated: boolean;
}

// ── Ask v1 events ────────────────────────────────────────────────────────
// apiVersion is pinned to the 'v1' literal here — src/core/ask-api/v1/
// contract.js's projectSourcesEvent()/projectAnswerDeltaEvent()/
// projectDoneEvent() all set apiVersion: API_VERSION = 'v1' unconditionally,
// so every event askV1() yields actually carries this value on the wire.

export interface AskSourcesEventV1 {
  type: 'sources';
  apiVersion: 'v1';
  searchMode: string | null;
  sources: AskSource[];
}

export interface AskAnswerDeltaEventV1 {
  type: 'answer_delta';
  apiVersion: 'v1';
  text: string;
}

/** Ask v1's `done` event. Deliberately has NO `conversation` field at all — v1 has no conversation concept, and modeling one here (even as always-undefined) would falsely promise v2 data on a v1 response. */
export interface AskDoneEventV1 {
  type: 'done';
  apiVersion: 'v1';
  answer: string;
  citations: number[];
  entityRefs: string[];
  refused: boolean;
  refusalReason: string | null;
  provider: string | null;
  model: string | null;
  usage: { promptTokens: number | null; completionTokens: number | null };
  timing: { elapsedMs: number | null };
  evidenceCount: number;
}

/** Every event askV1() can yield with a statically known shape (excludes AskUnknownEvent). */
export type KnownAskEventV1 = AskSourcesEventV1 | AskAnswerDeltaEventV1 | AskDoneEventV1;

// ── Ask v2 events ────────────────────────────────────────────────────────
// Mirrors v1 above, with apiVersion pinned to 'v2' and the `done` event's
// additive `conversation` block (src/core/ask-api/v2/contract.js's
// projectDoneEvent()).

export interface AskSourcesEventV2 {
  type: 'sources';
  apiVersion: 'v2';
  searchMode: string | null;
  sources: AskSource[];
}

export interface AskAnswerDeltaEventV2 {
  type: 'answer_delta';
  apiVersion: 'v2';
  text: string;
}

/**
 * The v2 `done` event's conversation confirmation block, echoed exactly as
 * the server projects it (src/core/ask-api/v2/contract.js's
 * projectDoneEvent()). `id`/`summaryChanged` are present whenever this block
 * exists at all (i.e. the request included `conversation`). `updatedSummary`
 * and `compactedMessageCount` are each added ONLY when `summaryChanged` is
 * true AND the coordinator actually supplied that field — the server spreads
 * them in conditionally, it never sends them as an explicit `null`. Treat a
 * missing key, not a `null` value, as "not provided this turn".
 */
export interface AskConversationDoneBlock {
  id: string;
  summaryChanged: boolean;
  updatedSummary?: string;
  compactedMessageCount?: number;
}

export interface AskDoneEventV2 {
  type: 'done';
  apiVersion: 'v2';
  answer: string;
  citations: number[];
  entityRefs: string[];
  refused: boolean;
  refusalReason: string | null;
  provider: string | null;
  model: string | null;
  usage: { promptTokens: number | null; completionTokens: number | null };
  timing: { elapsedMs: number | null };
  evidenceCount: number;
  /** Present only when the request supplied `conversation` at all; OMITTED (not `null`) on a first-turn request that sent none. */
  conversation?: AskConversationDoneBlock;
}

/** Every event askV2() can yield with a statically known shape (excludes AskUnknownEvent). */
export type KnownAskEventV2 = AskSourcesEventV2 | AskAnswerDeltaEventV2 | AskDoneEventV2;

// ── Forward-compatible unknown events + narrowing ───────────────────────

/**
 * Any event this client doesn't recognize yet — forward-compatible
 * passthrough (never crashes on an unknown type or an unknown field on a
 * known type).
 *
 * `type: string`, not a literal, is unavoidable here: a future SSE event
 * name is by definition not one of today's known literals, so this field
 * cannot be typed any narrower without lying about what the runtime can
 * actually receive. The consequence is that `AskUnknownEvent` structurally
 * OVERLAPS every known event ('sources'/'answer_delta'/'done' are all valid
 * `string`s), so it is never soundly excludable from a union by comparing
 * `.type` to a known literal — there is no TypeScript expression of "every
 * string except these three literals" (`Exclude<string, 'done'>` collapses
 * back to plain `string`, not a narrower type). Use `isKnownAskV1Event()`/
 * `isKnownAskV2Event()` below to narrow away this member instead of relying
 * on a `.type` check alone.
 */
export interface AskUnknownEvent {
  type: string;
  [key: string]: unknown;
}

/** Everything askV1() can yield: statically known v1 events, or a future/unrecognized one. */
export type AskEventV1 = KnownAskEventV1 | AskUnknownEvent;
/** Everything askV2() can yield: statically known v2 events, or a future/unrecognized one. */
export type AskEventV2 = KnownAskEventV2 | AskUnknownEvent;

/**
 * Narrows an askV1() event to its known-shape union (`KnownAskEventV1`),
 * excluding `AskUnknownEvent`. This is the sound alternative to narrowing
 * `AskEventV1` directly on `.type`: because `AskUnknownEvent.type` is
 * `string` rather than a literal, a plain `event.type === 'done'` check does
 * not eliminate that member from the union (TypeScript has no way to type
 * "string, but not these three literals"). Call this FIRST, then switch on
 * `.type` for full narrowing to one specific known event — at that point
 * every remaining member has a literal `type`, so the switch narrows
 * soundly:
 *
 * ```ts
 * for await (const event of semidex.askV1(args)) {
 *   if (!isKnownAskV1Event(event)) continue; // forward-compat: ignore a future event type
 *   if (event.type === 'done') event.answer; // narrowed to AskDoneEventV1 — no cast
 * }
 * ```
 *
 * Deliberately a SEPARATE name from `isKnownAskV2Event` rather than one
 * overloaded `isKnownAskEvent(event: AskEventV1 | AskEventV2)`: because
 * `AskUnknownEvent` carries a `[key: string]: unknown` index signature,
 * every concrete known event (v1 or v2) is structurally assignable to it —
 * which makes `AskEventV1` and `AskEventV2` structurally assignable to
 * EACH OTHER through that arm, so an overloaded single name could resolve
 * to the wrong version's overload for some inputs. Two distinct names avoid
 * asking the compiler to pick between two candidate signatures at all; each
 * still narrows correctly for the version it is actually documented and
 * intended for (the value a `for await` loop over `askV1()`/`askV2()`
 * actually hands you).
 */
export function isKnownAskV1Event(event: AskEventV1): event is KnownAskEventV1;

/** v2 counterpart of `isKnownAskV1Event()` — see its doc comment for the full narrowing pattern and why this is a separate name rather than an overload. */
export function isKnownAskV2Event(event: AskEventV2): event is KnownAskEventV2;

/** Arguments for `askText()` against Ask v1 — `version` is optional and defaults to `'v1'`. */
export type AskTextArgsV1 = { version?: 'v1' } & AskV1Args;
/** Arguments for `askText()` against Ask v2 — `version: 'v2'` is required to select it. */
export type AskTextArgsV2 = { version: 'v2' } & AskV2Args;
/** Arguments for `askText()`. `version` selects the endpoint; the rest match AskV1Args/AskV2Args. */
export type AskTextArgs = AskTextArgsV1 | AskTextArgsV2;

/** The finished, deep-frozen result of an `askText()` call against Ask v1. */
export interface AskTextResultV1 {
  /** The complete answer: the `done` event's own `answer`, or the concatenated `answer_delta` text when the server sent none. */
  answer: string;
  /** The evidence the answer was grounded in (empty when the stream carried no `sources` event). */
  sources: AskSource[];
  /** 1-based indices into `sources` that the answer cited. */
  citations: number[];
  /** The full terminal `done` event, for fields this result does not lift out (usage, timing, provider, refused, ...). */
  done: AskDoneEventV1;
  /** Ask v1 has no conversation concept at all — always `null`. */
  conversation: null;
}

/** The finished, deep-frozen result of an `askText()` call against Ask v2. */
export interface AskTextResultV2 {
  /** The complete answer: the `done` event's own `answer`, or the concatenated `answer_delta` text when the server sent none. */
  answer: string;
  /** The evidence the answer was grounded in (empty when the stream carried no `sources` event). */
  sources: AskSource[];
  /** 1-based indices into `sources` that the answer cited. */
  citations: number[];
  /** The full terminal `done` event, for fields this result does not lift out (usage, timing, provider, refused, ...). */
  done: AskDoneEventV2;
  /** The `done` event's conversation confirmation — `null` when the request sent no `conversation` at all. */
  conversation: AskConversationDoneBlock | null;
}

// ── Backward-compatible aliases (pre-version-split names) ──────────────────
//
// These are the public type names this module exported BEFORE the
// version-aware split above (AskSourcesEventV1/V2 etc.) — kept, not removed,
// so an existing consumer's `import type { AskEvent } from 'semidex-lite/
// client'` still resolves. Each alias is defined IN TERMS OF the new,
// accurate v1/v2 types (never hand-duplicated), so it can never drift back
// out of sync with the real wire contract the way the original,
// non-version-aware declarations did (see docs/sdk-client-review-2026-08-28
// .md). `tests/types/lite-client.types.ts` imports and exercises every name
// below so a future edit cannot silently delete one of them.

/** @deprecated Use `AskSourcesEventV1`/`AskSourcesEventV2` for a version-specific type. This alias covers both — accurate, not a lie, just less precise. */
export type AskSourcesEvent = AskSourcesEventV1 | AskSourcesEventV2;

/** @deprecated Use `AskAnswerDeltaEventV1`/`AskAnswerDeltaEventV2` for a version-specific type. This alias covers both. */
export type AskAnswerDeltaEvent = AskAnswerDeltaEventV1 | AskAnswerDeltaEventV2;

/** @deprecated Use `AskDoneEventV1`/`AskDoneEventV2` for a version-specific type. This alias covers both — note it now correctly omits `conversation` for v1 rather than declaring a v2-only field unconditionally. */
export type AskDoneEvent = AskDoneEventV1 | AskDoneEventV2;

/** @deprecated Use `AskEventV1`/`AskEventV2` for a version-specific type (`apiVersion` pinned to a single literal, matching what askV1()/askV2() actually yield). This alias covers both. */
export type AskEvent = AskEventV1 | AskEventV2;

/** @deprecated Use `AskConversationDoneBlock` — same shape, the new name matches `AskDoneEventV2.conversation`'s own field name. `updatedSummary`/`compactedMessageCount` are correctly optional here (OMITTED, never `null`, when not recomputed), unlike this alias's original nullable-required declaration. */
export type AskDoneConversation = AskConversationDoneBlock;

/** @deprecated Use `AskTextResultV1`/`AskTextResultV2` for a version-specific type (precise `done`/`conversation` shape). This alias covers both. */
export type AskTextResult = AskTextResultV1 | AskTextResultV2;

export interface SemidexClient {
  /** POST /api/v1/search — resolves with the parsed, deep-frozen response body. Rejects with SemidexApiError on any failure. */
  search(args: SearchArgs): Promise<SearchResponse>;
  /**
   * POST /api/v1/ask — an async generator yielding `sources`, zero or more
   * `answer_delta`, then exactly one `done` event. A terminal SSE `error`
   * event (or any pre-stream failure) throws SemidexApiError instead of
   * yielding a final event — iterate with `for await` inside a try/catch.
   */
  askV1(args: AskV1Args): AsyncGenerator<AskEventV1, void, void>;
  /** POST /api/v2/ask — same event/error contract as askV1(), with caller-owned `conversation` in and a `conversation` block on the terminal `done` event. */
  askV2(args: AskV2Args): AsyncGenerator<AskEventV2, void, void>;
  /**
   * Convenience wrapper over askV1()/askV2(): consumes the SSE stream to
   * completion and resolves with one structured result instead of making
   * you run a `for await` loop and accumulate deltas by hand.
   *
   * Choose this when you only want the finished answer (a tool call, a
   * batch job, a non-streaming HTTP handler). Choose askV1()/askV2() when
   * you want token-by-token output (a chat UI, a proxied SSE endpoint) —
   * they are unchanged and remain the streaming API.
   *
   * Identical error contract to the streaming methods: a terminal SSE
   * `error` event, a pre-stream failure, a timeout, an abort, or a
   * malformed frame all reject with SemidexApiError. A failed generation
   * never resolves with a partial answer.
   *
   * Overloaded on `version` so the resolved result type tracks the endpoint
   * actually called: omitting `version` (or passing `'v1'`) resolves
   * `AskTextResultV1` (`conversation` statically `null`); passing
   * `version: 'v2'` resolves `AskTextResultV2` (`conversation` may be a real
   * `AskConversationDoneBlock`). This is why `{ version: 'v1' } as const`
   * cannot silently produce v2-shaped data, and why a v2 result's
   * `conversation.updatedSummary` cannot be read without first checking it
   * is present.
   *
   * The precise `AskTextArgsV1`/`AskTextArgsV2` overloads above are tried
   * FIRST and cover every call site with a literal (or no) `version` — which
   * is the common case and gets the precise result type. They are listed
   * before the general `AskTextArgs` overload below on purpose: overload
   * resolution picks the first structural match, so a plain
   * `askText({ collection, question })` still resolves `AskTextResultV1`,
   * never the wider union. The general overload exists for a caller that
   * already holds a value STATICALLY typed as the `AskTextArgs` union —
   * e.g. built by a helper that picks v1 or v2 at runtime — which is NOT
   * assignable to either precise overload's parameter type on its own (a
   * `AskTextArgsV1 | AskTextArgsV2` union is not assignable to just
   * `AskTextArgsV1`, nor just `AskTextArgsV2`) and would otherwise be
   * rejected by both, even though it is exactly the shape `askText()`
   * actually accepts.
   */
  askText(args: AskTextArgsV1): Promise<AskTextResultV1>;
  askText(args: AskTextArgsV2): Promise<AskTextResultV2>;
  askText(args: AskTextArgs): Promise<AskTextResultV1 | AskTextResultV2>;
}

/**
 * Creates a Semidex Integration API client. Validates `baseUrl`/`apiKey`/
 * `timeoutMs`/`retry`/`fetch` at construction time (throws TypeError
 * synchronously for a malformed input — never a rejected Promise). Intended
 * for backend/server-side use — never ship an `apiKey` to browser
 * JavaScript.
 */
export function createSemidexClient(options: CreateSemidexClientOptions): SemidexClient;
