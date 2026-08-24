// A real streaming Server-Sent Events parser — handles arbitrary chunk
// boundaries (an `event:`/`data:` pair is never assumed to arrive in one
// single read), CRLF and LF line endings, comment/keepalive lines (a line
// starting with `:`, or any other SSE field this wire contract doesn't use
// — `id:`, `retry:` — which are silently ignored, not treated as an
// error, matching a real EventSource implementation), and a final frame
// that arrives with no trailing blank line (flushed once the stream ends).
//
// Ownership rule: every frame this generator yields is a freshly built
// plain object from freshly sliced strings — nothing here holds a
// reference into the internal decode buffer, so a caller mutating a
// yielded frame can never corrupt parsing of the NEXT frame, and one
// yielded frame's `data` object is never the same reference as another's
// even when the payloads are textually identical.
//
// The server's own framing (src/core/http/sse.js) writes each event as
// `event: <name>\ndata: <json>\n\n` — this parser only ever splits on a
// complete blank-line boundary (`\n\n` after CRLF normalization), so a
// `data:` line landing at the edge of two network reads is never
// mis-parsed as two partial events.

/**
 * @typedef {{ event: string, data: any }} SseFrame
 */

/**
 * Parses one raw (blank-line-delimited) frame's text into `{ event, data }`.
 * Returns null for a frame that carried no `data:` line at all (e.g. one
 * that was only comments/keepalives) — nothing to yield.
 * @param {string} rawFrame
 * @returns {SseFrame|null}
 */
function parseFrame(rawFrame) {
  let eventName = 'message';
  const dataLines = [];
  for (const rawLine of rawFrame.split('\n')) {
    // CRLF normalization: strip a trailing \r left over from a CRLF stream
    // (the \n\n boundary split below already handles \r\n\r\n correctly
    // since \r is just an ordinary character up to that point — this only
    // needs to strip \r from the START of each individual line's content).
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    if (line.startsWith(':')) continue; // comment/keepalive — ignored, not an error
    if (line.startsWith('event: ')) {
      eventName = line.slice('event: '.length);
    } else if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trimStart();
    } else if (line.startsWith('data: ')) {
      dataLines.push(line.slice('data: '.length));
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
    // Other SSE fields (id:, retry:) are not used by this wire contract and
    // are intentionally ignored, not treated as an error — forward
    // compatible with a future field this client doesn't know about yet.
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  try {
    return Object.freeze({ event: eventName, data: JSON.parse(raw) });
  } catch {
    // A malformed data payload is malformed PROTOCOL data — fail clearly
    // (a synthetic frame the caller recognizes and turns into a typed
    // error) rather than silently dropping it or throwing deep inside the
    // pump loop.
    return Object.freeze({ event: '__parse_error__', data: Object.freeze({ raw }) });
  }
}

/**
 * Async-generator SSE parser. Consumes a `ReadableStream<Uint8Array>` (the
 * `body` of a `fetch()` Response) and yields one frame at a time, as soon
 * as its trailing blank line has actually arrived — never buffering the
 * whole stream first.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {AbortSignal} signal — checked before/raced against every read, so
 *   an abort mid-read (not just before the next read starts) stops the pump
 *   promptly rather than waiting for the next network byte that may never
 *   come.
 * @returns {AsyncGenerator<SseFrame>}
 */
export async function* parseSseStream(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

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

      // A frame boundary is a blank line: \n\n after CRLF normalization
      // above would already be handled inside parseFrame per-line, but the
      // BOUNDARY itself must also tolerate \r\n\r\n — normalize CRLF pairs
      // to LF pairs at the buffer level before searching, so both endings
      // split identically regardless of which one a given network hop used.
      buffer = buffer.replace(/\r\n/g, '\n');

      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawFrame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseFrame(rawFrame);
        if (frame) yield frame;
      }
    }
    // Flush the decoder's own held-back partial multi-byte sequence.
    decoder.decode();
    // A final frame with NO trailing blank line — the stream ended right
    // after its last `data:` line. Still a complete, valid frame; parse
    // whatever is left in the buffer exactly once.
    const rest = buffer.trim();
    if (rest.length > 0) {
      const frame = parseFrame(rest);
      if (frame) yield frame;
    }
  } finally {
    reader.releaseLock?.();
  }
}
