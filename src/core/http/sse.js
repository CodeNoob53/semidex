// Minimal Server-Sent Events framing — node:http primitives only, no
// framework, matching the rest of src/core/http/http.js. Used by the
// versioned application-facing Ask API for its sources/answer_delta/done/
// error event sequence. Provider/transport-neutral: nothing here knows
// about Qdrant, Ollama, Gemini, or the Admin UI.

/**
 * Writes SSE response headers. Must be called before any writeSseEvent()
 * call and before any JSON error response on the same res — once this
 * fires, the response is committed to the event-stream format.
 */
export function startSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Node buffers small writes internally; flushHeaders forces the status
  // line + headers out immediately so a client sees the stream open
  // without waiting for the first event.
  res.flushHeaders?.();
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
