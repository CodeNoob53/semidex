// Ask API v2 — reusable SSE client (Node.js, no dependencies).
//
// This is a THIN transport helper only: it opens the HTTP request, parses
// the Server-Sent Events wire format correctly across arbitrary network
// chunk boundaries (an `event:`/`data:` pair is never assumed to arrive in
// one single read), and hands parsed events to the caller one at a time.
// It has no opinion about conversation state, retries, or UI rendering —
// see conversation-manager.mjs for a stateful example built on top of this.
//
// Correctness notes:
// - The SSE framing itself (`src/core/http/sse.js`) writes each event as
//   `event: <name>\ndata: <json>\n\n` — this parser buffers raw bytes and
//   only ever splits on a complete `\n\n` boundary, so a `data:` line that
//   happens to land at the edge of two TCP reads is never mis-parsed as two
//   partial events.
// - Never assumes UTF-8 characters align with chunk boundaries either — a
//   TextDecoder is kept alive across chunks (`{ stream: true }`) instead of
//   decoding each Buffer independently, which would corrupt any multi-byte
//   character (e.g. Cyrillic) split across two reads.
// - Bounded by both a wall-clock overall timeout and a real AbortController
//   — a hung connection (server never closes, network stall) cannot leak
//   this call forever.
// - Never logs API keys, headers, or the full process environment — the
//   only thing this module ever reads from the environment is nothing at
//   all; the caller supplies `baseUrl` (and, since Integration API auth
//   became mandatory, `token`) explicitly. `token` is used exactly once, to
//   build the `Authorization` header on the outgoing request, and is never
//   written to a log, an error message, or the returned result object.

/**
 * @typedef {{ event: string, data: any }} SseEvent
 */

/**
 * Parses a readable stream of SSE bytes into discrete `{event, data}`
 * frames, calling `onEvent` for each one as soon as its trailing blank line
 * arrives — never waiting for the whole stream to buffer first (a real
 * streaming parser, not a post-hoc `text.split('\n\n')` over one fully
 * collected string).
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {(event: SseEvent) => void} onEvent
 * @param {AbortSignal} signal
 */
async function pumpSseBody(body, onEvent, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  // A stalled stream (server never sends another byte, never closes) means
  // reader.read() itself can stay pending forever — checking signal.aborted
  // only BEFORE each read() is not enough, since the abort can happen WHILE
  // a read() is already in flight and pending. Race the read against a
  // SINGLE abort promise, created once outside the loop — reused across
  // every iteration — rather than a fresh `{once:true}` listener per
  // read(). A fresh-per-iteration listener would only ever be removed when
  // ITS OWN race lost (the abort case), never when reader.read() itself
  // wins (the common case on every iteration but the last), leaking one
  // listener per SSE chunk on a long-lived stream.
  const ABORTED = Symbol('aborted');
  const abortPromise = new Promise((resolve) => {
    if (signal.aborted) { resolve(ABORTED); return; }
    signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
  });

  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        return;
      }
      const outcome = await Promise.race([reader.read(), abortPromise]);
      if (outcome === ABORTED) {
        await reader.cancel().catch(() => {});
        return;
      }
      const { done, value } = outcome;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split on the first complete blank-line-terminated frame at a time
      // -- never assumes the whole buffer is one event, and never discards
      // a trailing partial frame still waiting on more bytes.
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawFrame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseFrame(rawFrame);
        if (frame) onEvent(frame);
      }
    }
    // Flush any final partial multi-byte sequence the decoder was holding.
    decoder.decode();
  } finally {
    reader.releaseLock?.();
  }
}

function parseFrame(rawFrame) {
  let eventName = 'message';
  const dataLines = [];
  for (const line of rawFrame.split('\n')) {
    if (line.startsWith('event: ')) {
      eventName = line.slice('event: '.length);
    } else if (line.startsWith('data: ')) {
      dataLines.push(line.slice('data: '.length));
    }
    // Other SSE fields (id:, retry:, comments starting with ':') are not
    // used by this wire contract and are intentionally ignored, not
    // treated as an error -- a forward-compatible parser, matching how a
    // real EventSource implementation behaves.
  }
  if (dataLines.length === 0) return null;
  let data;
  try {
    data = JSON.parse(dataLines.join('\n'));
  } catch {
    // A malformed data payload is reported to the caller as a synthetic
    // parse-error event rather than silently dropped or thrown from deep
    // inside the pump loop -- the caller decides whether that's fatal.
    return { event: '__parse_error__', data: { raw: dataLines.join('\n') } };
  }
  return { event: eventName, data };
}

/**
 * @param {{
 *   baseUrl: string,               // e.g. 'http://127.0.0.1:8642' -- no path, no trailing slash
 *   collection: string,
 *   question: string,
 *   conversation?: { id: string, summary?: string, recentMessages?: Array<{role:'user'|'assistant', content:string}> },
 *   token?: string,                 // Integration API bearer token (`sdx_v1_...`, from `semidex-lite key add`) -- REQUIRED since Ask now returns 503/401 without one; sent as `Authorization: Bearer <token>`, never logged, never put in the returned result
 *   timeoutMs?: number,             // overall wall-clock bound, default 60_000
 *   signal?: AbortSignal,           // caller's own abort signal, composed with the internal timeout
 * }} args
 * @returns {Promise<{
 *   ok: boolean,                    // true iff a terminal `done` event was received (refused counts as ok:true -- it's a valid, non-error outcome)
 *   sources: Array<Object>,         // from the `sources` event, [] if none arrived
 *   answer: string,                 // concatenated answer_delta text
 *   done: Object|null,              // the full `done` event payload, or null if the stream ended in `error`/aborted/HTTP failure
 *   error: { code: string, message: string, retryable: boolean }|null,
 *   conversationId: string|null,
 *   summaryChanged: boolean,
 *   updatedSummary: string|null,
 *   compactedMessageCount: number|null, // count of oldest caller-supplied recentMessages now folded into updatedSummary -- see conversation-manager.mjs for how a caller uses this to drop exactly that prefix without losing or duplicating context; null unless summaryChanged
 *   httpStatus: number|null,        // set even for a pre-stream HTTP error (400/404/429/503/etc.)
 * }>}
 *   Never throws/rejects, period — every failure mode (validation error,
 *   busy, provider unavailable, generation failure, client/caller abort,
 *   timeout, a malformed SSE payload, a fetch()-level network error such as
 *   DNS failure or connection refused) resolves into the returned object's
 *   own `ok`/`error` fields, so a caller never needs a try/catch around
 *   this call to handle an ordinary failure.
 */
export async function askV2({ baseUrl, collection, question, conversation, token, timeoutMs = 60_000, signal: callerSignal }) {
  const internalController = new AbortController();
  const timer = setTimeout(() => internalController.abort(), timeoutMs);
  const onCallerAbort = () => internalController.abort();
  callerSignal?.addEventListener('abort', onCallerAbort);

  const result = {
    ok: false, sources: [], answer: '', done: null, error: null,
    conversationId: null, summaryChanged: false, updatedSummary: null, compactedMessageCount: null, httpStatus: null,
  };

  try {
    const response = await fetch(`${baseUrl}/api/v2/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Integration API auth is mandatory (see this file's own header
        // comment) -- omitted only when the caller genuinely has no token,
        // in which case the server's own 503/401 explains why, rather than
        // this client guessing or fabricating one.
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        collection, question,
        ...(conversation ? { conversation } : {}),
      }),
      signal: internalController.signal,
    });

    result.httpStatus = response.status;

    // A pre-stream failure (validation, 404, 429, 503, ...) is a plain
    // JSON body, never an SSE stream -- distinguished by Content-Type, not
    // by status code alone (some successful requests also complete with a
    // JSON-shaped error via a terminal SSE `error` event instead).
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      const body = await response.json().catch(() => ({}));
      const errPayload = body?.error ?? { code: 'unknown_error', message: `HTTP ${response.status}`, retryable: false };
      result.error = { code: errPayload.code, message: errPayload.message, retryable: Boolean(errPayload.retryable) };
      return result;
    }

    await pumpSseBody(response.body, (frame) => {
      if (frame.event === 'sources') {
        result.sources = frame.data.sources ?? [];
      } else if (frame.event === 'answer_delta') {
        result.answer += frame.data.text ?? '';
      } else if (frame.event === 'done') {
        result.done = frame.data;
        result.ok = true;
        result.conversationId = frame.data.conversation?.id ?? null;
        result.summaryChanged = Boolean(frame.data.conversation?.summaryChanged);
        result.updatedSummary = frame.data.conversation?.updatedSummary ?? null;
        result.compactedMessageCount = frame.data.conversation?.compactedMessageCount ?? null;
      } else if (frame.event === 'error') {
        result.error = { code: frame.data.code, message: frame.data.message, retryable: Boolean(frame.data.retryable) };
      } else if (frame.event === '__parse_error__') {
        result.error = { code: 'client_parse_error', message: 'Received a malformed SSE data payload.', retryable: false };
      }
    }, internalController.signal);

    if (!result.ok && !result.error && internalController.signal.aborted) {
      result.error = { code: 'client_timeout_or_abort', message: `Request aborted or timed out after ${timeoutMs}ms.`, retryable: true };
    }

    return result;
  } catch (err) {
    // fetch() itself can reject (not just resolve-then-stream-abort) when
    // its own signal aborts mid-flight -- both while the response headers
    // are still in transit AND, depending on the runtime's fetch/undici
    // implementation, while the response body is still being read. An
    // abort/timeout is an ORDINARY Ask-level outcome this function commits
    // to never throwing for (see this function's own header contract) --
    // so any AbortError here resolves into the same bounded error shape
    // the in-stream abort path already produces, rather than rejecting the
    // whole promise. A genuinely unexpected error (anything that is not
    // this function's own internal/caller abort) still resolves the same
    // way, since by this point in the function the caller already has a
    // real HTTP status/stream to reason about in every other branch --
    // rejecting only from this one specific catch would make error
    // handling inconsistent depending on exactly when in the request
    // lifecycle a failure happened, which is not something a caller should
    // have to know about this client's own internals to handle correctly.
    result.error = internalController.signal.aborted
      ? { code: 'client_timeout_or_abort', message: `Request aborted or timed out after ${timeoutMs}ms.`, retryable: true }
      : { code: 'client_request_failed', message: err?.message ?? String(err), retryable: true };
    return result;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}
