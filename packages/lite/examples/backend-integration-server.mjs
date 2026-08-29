#!/usr/bin/env node
// A minimal backend that demonstrates the intended integration
// architecture for `semidex-lite/client`:
//
//   browser (public, no secrets) --> YOUR backend --> Semidex Lite
//
// Run this, then open http://127.0.0.1:8787/ in a browser (or curl it —
// see the usage comment at the bottom) with a real `semidex-lite serve`
// instance reachable and a key already created:
//
//   semidex-lite key add --name demo-backend --collection my-docs --operation search --operation generate
//   SEMIDEX_TOKEN=sdx_v1_... SEMIDEX_BASE_URL=http://127.0.0.1:8642 \
//     node packages/lite/examples/backend-integration-server.mjs
//
// WHAT THIS EXAMPLE DEMONSTRATES (and nothing more — no framework, no
// database, no auth for the browser<->backend leg, which a real app must
// add for itself):
//
// 1. The Semidex bearer key lives ONLY in this process's environment
//    (SEMIDEX_TOKEN) and is read once, at startup. It is never sent to the
//    browser in a response body, header, or embedded script — grep this
//    file: `token` only ever appears as an argument to createSemidexClient()
//    and is never written to `res.write()`/`res.end()` for the BROWSER-facing
//    handlers below.
// 2. The browser never learns the real Semidex collection name. It sends an
//    application-level `assistantId`; this backend owns the explicit mapping
//    from assistantId -> Semidex collection (COLLECTION_BY_ASSISTANT below)
//    and rejects anything not in it. A real app would resolve this from the
//    authenticated user's own permissions, not a hardcoded object — the
//    point is that the MAPPING is server-side, explicit, and closed, not
//    that this specific map is production code.
// 3. Search: a plain JSON proxy endpoint (POST /api/search) — the browser
//    calls this backend, the backend calls semidex.search(), the backend
//    returns the (already-safe, already-projected) result to the browser
//    unchanged.
// 4. Ask v2: a STREAMED proxy endpoint (POST /api/chat) — the backend
//    iterates semidex.askV2()'s async generator and re-emits each event to
//    the browser as its own Server-Sent Events stream. This is the "one
//    streamed Ask path" required by the integration example: the browser
//    gets real token-by-token streaming without ever holding a Semidex
//    credential itself.
// 5. Conversation persistence: Ask v2's `conversation.summary`/
//    `recentMessages` are CALLER-OWNED — Semidex Lite never remembers
//    anything between requests (see README.md's "Ask v2" section). This
//    example stores conversation state in a plain in-process `Map`
//    (CONVERSATIONS below), which is lost on restart and not shared across
//    replicas — *** DEMO ONLY, NOT PRODUCTION PERSISTENCE ***. A real
//    backend would replace this with whatever it already uses for user
//    data (PostgreSQL, Redis, SQLite, ...), keyed by its own
//    user/session/conversation identifiers — see
//    packages/lite/examples/conversation-manager.mjs for a fuller worked
//    example of the same ownership boundary against the raw HTTP contract
//    (this file demonstrates it against the `semidex-lite/client` package
//    instead).
//
// STREAMING VS CONVENIENCE: this file is the STREAMED variant — it uses
// askV2() so the browser gets token-by-token output. If your UI does not
// need that (a tool call, a batch job, a webhook, a native client happy with
// a spinner), packages/lite/examples/backend-chat-server.mjs shows the same
// architecture with askText() and a single JSON response per turn, which is
// meaningfully less code. Everything else — key handling, the
// assistantId->collection mapping, caller-owned conversation state — is
// identical between the two.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createSemidexClient } from '../lite-src/client/index.js';

const PORT = Number(process.env.PORT ?? 8787);
const SEMIDEX_BASE_URL = process.env.SEMIDEX_BASE_URL ?? 'http://127.0.0.1:8642';
const SEMIDEX_TOKEN = process.env.SEMIDEX_TOKEN;

// Whether this module was RUN as a script (as opposed to imported by the
// unit test, which exercises the pure mapping helpers and the request
// handler against a FAKE upstream, needing no real token and no bound port).
const RUN_AS_SCRIPT = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (RUN_AS_SCRIPT && !SEMIDEX_TOKEN) {
  console.error('Error: SEMIDEX_TOKEN is not set. Create a key with:');
  console.error('  semidex-lite key add --name demo-backend --collection <your-collection> --operation search --operation generate');
  console.error('and pass the printed token as SEMIDEX_TOKEN.');
  process.exit(1);
}

// The Semidex client is constructed ONCE, server-side. `semidex` (and the
// token it closes over) never leaves this module. Built on first use so
// that importing this file (the unit test does) needs no token and reaches
// no network.
let semidexClient = null;
function semidex() {
  if (semidexClient === null) semidexClient = createSemidexClient({ baseUrl: SEMIDEX_BASE_URL, apiKey: SEMIDEX_TOKEN });
  return semidexClient;
}

// Point (2) above: the browser sends an `assistantId`, never a raw
// collection name.
const COLLECTION_BY_ASSISTANT = Object.freeze({
  docs: process.env.SEMIDEX_DOCS_COLLECTION ?? 'my-docs',
});

// Point (5) above: *** DEMO ONLY *** — see this file's own header comment.
const CONVERSATIONS = new Map(); // conversationId -> { summary, recentMessages }

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

// A hasOwnProperty guard, not a bare lookup: a prototype-chain key
// ("constructor", "toString", "__proto__") would otherwise resolve to a
// truthy non-collection value and be passed straight to the API.
function resolveCollection(assistantId) {
  if (typeof assistantId !== 'string' || !Object.prototype.hasOwnProperty.call(COLLECTION_BY_ASSISTANT, assistantId)) {
    throw Object.assign(new Error(`Unknown assistantId "${assistantId}"`), { status: 400 });
  }
  return COLLECTION_BY_ASSISTANT[assistantId];
}

// POST /api/search — { assistantId, query, top? } -> the raw semidex.search() result.
async function handleSearch(req, res) {
  const { assistantId, query, top } = await readJsonBody(req);
  const collection = resolveCollection(assistantId);
  const result = await semidex().search({ collection, query, ...(top !== undefined ? { top } : {}) });
  sendJson(res, 200, result);
}

// POST /api/chat — { assistantId, question, conversationId? } -> a browser-facing
// SSE stream (this backend's OWN framing, not a byte-for-byte passthrough of
// Semidex's wire format — a real app is free to reshape it however its
// frontend wants; this example keeps the same event names for clarity).
async function handleChat(req, res) {
  const { assistantId, question, conversationId } = await readJsonBody(req);
  const collection = resolveCollection(assistantId);

  const existing = conversationId ? CONVERSATIONS.get(conversationId) : undefined;
  const conversation = existing || conversationId
    ? { conversationId: conversationId ?? cryptoRandomId(), ...(existing ?? {}) }
    : undefined; // first turn: omit conversation entirely, matching the wire contract's own "optional" shape

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  let finalConversationId = conversation?.conversationId ?? null;
  const disconnect = abortOnDisconnect(res);
  try {
    for await (const event of semidex().askV2({ collection, question, conversation, signal: disconnect.signal })) {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'done') {
        // Persist whatever Semidex confirmed this turn — the caller-owned
        // half of the ownership boundary described in this file's header.
        const id = event.conversation?.id ?? finalConversationId ?? cryptoRandomId();
        finalConversationId = id;
        const prior = CONVERSATIONS.get(id) ?? { summary: undefined, recentMessages: [] };
        const nextSummary = event.conversation?.summaryChanged ? event.conversation.updatedSummary : prior.summary;
        const nextRecentMessages = [...(prior.recentMessages ?? []), { role: 'user', content: question }, { role: 'assistant', content: event.answer }];
        CONVERSATIONS.set(id, { summary: nextSummary, recentMessages: nextRecentMessages });
      }
    }
  } catch (err) {
    // A SemidexApiError (or a network failure) reaching here means the
    // stream had already started (headers sent) — the only safe remaining
    // write is a terminal SSE `error` event, mirroring how Semidex's own
    // /api/v1/ask and /api/v2/ask never send a second res.writeHead() after
    // streaming begins. If the disconnect above is WHY we got here, this
    // write is a harmless no-op onto a socket nobody is reading anymore.
    if (!disconnect.signal.aborted && !res.destroyed) {
      res.write(`event: error\ndata: ${JSON.stringify({ code: err.code ?? 'backend_error', message: err.message, retryable: Boolean(err.retryable) })}\n\n`);
    }
  } finally {
    disconnect.stopWatching();
    if (!res.destroyed) res.end();
  }
}

function cryptoRandomId() {
  return `conv_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

// Aborts the upstream Semidex request the moment the DOWNSTREAM browser
// goes away — without tripping on a normal, successful completion.
//
// WHY `res`, NOT `req`: `req`'s own 'close' event fires on ORDINARY
// completion too — by the time a listener could be attached here,
// readJsonBody() above has already fully drained `req`, so watching IT
// cannot tell "the browser hung up" apart from "the request finished fine"
// (see Node's http docs on IncomingMessage's 'close' event, which fires in
// both cases). `res` instead stays open for the WHOLE lifetime of the
// reply, so a 'close' on `res` that fires BEFORE `res.writableEnded` is
// unambiguous: the underlying connection tore down before this backend
// finished writing, which is exactly a downstream disconnect. A 'close'
// AFTER `res.end()` is just the ordinary teardown of a request that already
// succeeded and must never abort a generation this backend already
// finished with.
function abortOnDisconnect(res) {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);
  return {
    signal: controller.signal,
    // MUST be called once the handler is done with `res` (success or
    // failure) so a LATER 'close' — the ordinary teardown of an
    // already-finished response — never re-enters this listener.
    stopWatching() { res.removeListener('close', onClose); },
  };
}

export const requestHandler = async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/search') return await handleSearch(req, res);
    if (req.method === 'POST' && req.url === '/api/chat') return await handleChat(req, res);
    sendJson(res, 404, { error: 'not_found' });
  } catch (err) {
    if (res.destroyed || res.closed) return;
    if (res.headersSent) { res.end(); return; }
    sendJson(res, err.status ?? 500, { error: err.message ?? 'internal_error' });
  }
};

// Only listen when RUN as a script — importing this module (the unit test
// does) must never bind a port or print a banner.
if (RUN_AS_SCRIPT) {
  const server = createServer(requestHandler);
  server.listen(PORT, '127.0.0.1', () => {
    // Read back the resolved port (PORT=0 asks the OS for an ephemeral one —
    // the printed URL must reflect what actually got bound, not the literal
    // input).
    const port = server.address().port;
    console.log(`[backend-integration-server] listening on http://127.0.0.1:${port}`);
    console.log(`[backend-integration-server] proxies to Semidex Lite at ${SEMIDEX_BASE_URL}`);
    console.log('Try:');
    console.log(`  curl -s -X POST http://127.0.0.1:${port}/api/search -d '{"assistantId":"docs","query":"how does auth work?"}' -H 'Content-Type: application/json'`);
    console.log(`  curl -N -X POST http://127.0.0.1:${port}/api/chat -d '{"assistantId":"docs","question":"how does auth work?"}' -H 'Content-Type: application/json'`);
  });
}

// Exported for tests (tests/unit/lite/client/backend-example.test.js and
// backend-disconnect.test.js) — the collection-mapping rule and the
// disconnect-vs-normal-completion boundary above are worth pinning with real
// assertions, not just prose.
export { COLLECTION_BY_ASSISTANT, resolveCollection, abortOnDisconnect };
