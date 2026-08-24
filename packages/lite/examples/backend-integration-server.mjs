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
//    application-level "topic" identifier; this backend owns the explicit
//    mapping from topic -> Semidex collection (COLLECTION_BY_TOPIC below).
//    A real app would resolve this from the authenticated user's own
//    permissions, not a hardcoded object — the point is that the MAPPING is
//    server-side and explicit, not that this specific map is production code.
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
import { createServer } from 'node:http';
import { createSemidexClient } from '../lite-src/client/index.js';

const PORT = Number(process.env.PORT ?? 8787);
const SEMIDEX_BASE_URL = process.env.SEMIDEX_BASE_URL ?? 'http://127.0.0.1:8642';
const SEMIDEX_TOKEN = process.env.SEMIDEX_TOKEN;

if (!SEMIDEX_TOKEN) {
  console.error('Error: SEMIDEX_TOKEN is not set. Create a key with:');
  console.error('  semidex-lite key add --name demo-backend --collection <your-collection> --operation search --operation generate');
  console.error('and pass the printed token as SEMIDEX_TOKEN.');
  process.exit(1);
}

// The Semidex client is constructed ONCE, here, server-side. `semidex` (and
// the token it closes over) never leaves this module.
const semidex = createSemidexClient({ baseUrl: SEMIDEX_BASE_URL, apiKey: SEMIDEX_TOKEN });

// Point (2) above: the browser sends a "topic", never a raw collection name.
const COLLECTION_BY_TOPIC = Object.freeze({
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

function resolveCollection(topic) {
  const collection = COLLECTION_BY_TOPIC[topic];
  if (!collection) throw Object.assign(new Error(`Unknown topic "${topic}"`), { status: 400 });
  return collection;
}

// POST /api/search — { topic, query, top? } -> the raw semidex.search() result.
async function handleSearch(req, res) {
  const { topic, query, top } = await readJsonBody(req);
  const collection = resolveCollection(topic);
  const result = await semidex.search({ collection, query, ...(top !== undefined ? { top } : {}) });
  sendJson(res, 200, result);
}

// POST /api/chat — { topic, question, conversationId? } -> a browser-facing
// SSE stream (this backend's OWN framing, not a byte-for-byte passthrough of
// Semidex's wire format — a real app is free to reshape it however its
// frontend wants; this example keeps the same event names for clarity).
async function handleChat(req, res) {
  const { topic, question, conversationId } = await readJsonBody(req);
  const collection = resolveCollection(topic);

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
  try {
    for await (const event of semidex.askV2({ collection, question, conversation, signal: abortOnClose(req) })) {
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
    // streaming begins.
    res.write(`event: error\ndata: ${JSON.stringify({ code: err.code ?? 'backend_error', message: err.message, retryable: Boolean(err.retryable) })}\n\n`);
  } finally {
    res.end();
  }
}

function cryptoRandomId() {
  return `conv_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

// Composes the browser's own connection-close signal into an AbortSignal so
// a client that navigates away mid-answer stops the upstream Semidex
// request too, instead of letting generation run to completion for no one.
function abortOnClose(req) {
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  return controller.signal;
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/search') return await handleSearch(req, res);
    if (req.method === 'POST' && req.url === '/api/chat') return await handleChat(req, res);
    sendJson(res, 404, { error: 'not_found' });
  } catch (err) {
    if (res.headersSent) { res.end(); return; }
    sendJson(res, err.status ?? 500, { error: err.message ?? 'internal_error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  // Read back the resolved port (PORT=0 asks the OS for an ephemeral one —
  // the printed URL must reflect what actually got bound, not the literal
  // input).
  const port = server.address().port;
  console.log(`[backend-integration-server] listening on http://127.0.0.1:${port}`);
  console.log(`[backend-integration-server] proxies to Semidex Lite at ${SEMIDEX_BASE_URL}`);
  console.log('Try:');
  console.log(`  curl -s -X POST http://127.0.0.1:${port}/api/search -d '{"topic":"docs","query":"how does auth work?"}' -H 'Content-Type: application/json'`);
  console.log(`  curl -N -X POST http://127.0.0.1:${port}/api/chat -d '{"topic":"docs","question":"how does auth work?"}' -H 'Content-Type: application/json'`);
});
