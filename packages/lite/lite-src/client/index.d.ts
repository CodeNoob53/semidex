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
}

export interface CreateSemidexClientOptions {
  /** Bare origin (+ optional path prefix), e.g. "http://127.0.0.1:8642". No query string, no fragment, no userinfo. */
  baseUrl: string;
  /** An Integration API bearer token from `semidex-lite key add` (e.g. "sdx_v1_..."). Sent as `Authorization: Bearer <apiKey>`, never in a URL. */
  apiKey: string;
  /** Default per-call wall-clock timeout in milliseconds. @default 60000 */
  timeoutMs?: number;
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
  timeoutMs?: number;
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
}

export interface AskV1Args {
  collection: string;
  question: string;
  scope?: { sourceFile?: string };
  signal?: AbortSignal;
  timeoutMs?: number;
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
  timeoutMs?: number;
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

export interface AskSourcesEvent {
  type: 'sources';
  apiVersion: 'v1';
  searchMode: string | null;
  sources: AskSource[];
}

export interface AskAnswerDeltaEvent {
  type: 'answer_delta';
  apiVersion: 'v1';
  text: string;
}

export interface AskDoneEvent {
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
  /** v2 only — present when the request included `conversation`. */
  conversation?: {
    id: string;
    summaryChanged: boolean;
    updatedSummary: string | null;
    compactedMessageCount: number | null;
  };
}

/** Any event this client doesn't recognize yet — forward-compatible passthrough (never crashes on an unknown type or an unknown field on a known type). */
export interface AskUnknownEvent {
  type: string;
  [key: string]: unknown;
}

export type AskEvent = AskSourcesEvent | AskAnswerDeltaEvent | AskDoneEvent | AskUnknownEvent;

export interface SemidexClient {
  /** POST /api/v1/search — resolves with the parsed, deep-frozen response body. Rejects with SemidexApiError on any failure. */
  search(args: SearchArgs): Promise<SearchResponse>;
  /**
   * POST /api/v1/ask — an async generator yielding `sources`, zero or more
   * `answer_delta`, then exactly one `done` event. A terminal SSE `error`
   * event (or any pre-stream failure) throws SemidexApiError instead of
   * yielding a final event — iterate with `for await` inside a try/catch.
   */
  askV1(args: AskV1Args): AsyncGenerator<AskEvent, void, void>;
  /** POST /api/v2/ask — same event/error contract as askV1(), with caller-owned `conversation` in and a `conversation` block on the terminal `done` event. */
  askV2(args: AskV2Args): AsyncGenerator<AskEvent, void, void>;
}

/**
 * Creates a Semidex Integration API client. Validates `baseUrl`/`apiKey` at
 * construction time (throws TypeError synchronously for a malformed input —
 * never a rejected Promise). Intended for backend/server-side use — never
 * ship an `apiKey` to browser JavaScript.
 */
export function createSemidexClient(options: CreateSemidexClientOptions): SemidexClient;
