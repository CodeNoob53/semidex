// Minimal Server-Sent Events framing — node:http primitives only, no
// framework, matching the rest of src/core/http/http.js. Used by the
// versioned application-facing Ask API for its sources/answer_delta/done/
// error event sequence. Provider/transport-neutral: nothing here knows
// about Qdrant, Ollama, Gemini, or the Admin UI.

export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Keeps a valid SSE response active while an upstream provider is waiting
 * for its first token. SSE comments carry no application data and are
 * ignored by conforming clients, but they prevent HTTP clients/proxies from
 * treating a quiet, still-live stream as an idle response body.
 *
 * The timer never writes while Node is already applying backpressure and is
 * removed on both the normal `finish` path and the disconnected `close`
 * path. The returned function is idempotent for tests/manual cleanup.
 */
export function startSseHeartbeat(res, {
  intervalMs = SSE_HEARTBEAT_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearIntervalFn(timer);
    res.removeListener?.('finish', stop);
    res.removeListener?.('close', stop);
  };
  const timer = setIntervalFn(() => {
    if (res.destroyed || res.writableEnded) {
      stop();
      return;
    }
    if (res.writableNeedDrain) return;
    try {
      res.write(': keep-alive\n\n');
    } catch {
      stop();
    }
  }, intervalMs);
  timer?.unref?.();
  res.once?.('finish', stop);
  res.once?.('close', stop);
  return stop;
}

/**
 * Writes SSE response headers. Must be called before any writeSseEvent()
 * call and before any JSON error response on the same res — once this
 * fires, the response is committed to the event-stream format.
 *
 * Cache-Control carries `no-store` alongside the usual SSE directives:
 * this is an /api/** response (POST /api/v1|v2/ask), and the router already
 * sets `no-store` before dispatch (core/http/cache-policy.js) — but
 * `res.writeHead()`'s headers argument REPLACES, not merges with, any
 * individual header of the same name set earlier via `res.setHeader()`, so
 * omitting it here would have silently dropped the router's `no-store` for
 * every streamed Ask response. `no-cache, no-transform` stay for their own
 * reasons: `no-cache` is the conventional EventSource-compatible directive,
 * `no-transform` stops an intermediary proxy from buffering/rewriting the
 * chunked stream.
 */
export function startSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Node buffers small writes internally; flushHeaders forces the status
  // line + headers out immediately so a client sees the stream open
  // without waiting for the first event.
  res.flushHeaders?.();
  startSseHeartbeat(res);
}

/**
 * Writes one SSE event. `data` is JSON-serialized. Returns the boolean
 * res.write() gives back so a caller that wants to respect backpressure
 * (wait for 'drain' before writing more) can — for tightly-looped
 * answer_delta events, checking this avoids unbounded internal buffering
 * when a client reads slower than the provider generates.
 */
export function writeSseEvent(res, event, data) {
  return res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Awaits the stream 'drain' event — call after a writeSseEvent() that
 * returned false to respect backpressure before writing the next event.
 *
 * Resolves (never hangs) on 'close' or 'error' too, not just 'drain' — a
 * client that disconnects WHILE the write buffer is full never fires
 * 'drain' (nothing is draining a dead socket), so listening for 'drain'
 * alone left this promise pending forever. That hung the awaiting
 * onToken()/onSources() call in the provider's generation loop, which in
 * turn meant generate() never resolved, the coordinator's `finally { busy =
 * false }` never ran, and the coordinator was stuck busy=true for the rest
 * of the process (code review finding, confirmed at runtime:
 * drain_after_close stayed pending). All three listeners are removed once
 * one of them fires, so this never leaks listeners across repeated calls on
 * the same long-lived `res`. Also resolves immediately, without attaching
 * any listener, if the response is already closed/ended by the time this
 * is called — a disconnect that happened between the write and this call
 * must not create a promise that then waits for an event that already
 * happened.
 */
export function waitForDrain(res) {
  if (res.destroyed || res.writableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    const cleanup = () => {
      res.removeListener('drain', onDrain);
      res.removeListener('close', onSettle);
      res.removeListener('error', onSettle);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onSettle = () => { cleanup(); resolve(); };
    res.once('drain', onDrain);
    res.once('close', onSettle);
    res.once('error', onSettle);
  });
}
