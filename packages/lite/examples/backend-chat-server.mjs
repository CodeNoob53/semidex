#!/usr/bin/env node
// A minimal, NON-STREAMING chat backend built on `semidex-lite/client`'s
// askText() convenience helper — the companion to
// backend-integration-server.mjs, which demonstrates the same architecture
// with a STREAMED (SSE) proxy endpoint instead.
//
//   browser (public, no secrets) --> YOUR backend --> Semidex Lite
//
// WHICH OF THE TWO EXAMPLES DO YOU WANT?
//   - This file (askText(), one JSON response per turn): simplest possible
//     integration. Right for a tool call, a batch job, a webhook, a
//     mobile/native client, or any UI that is happy to show a spinner and
//     then the finished answer.
//   - backend-integration-server.mjs (askV2(), re-emitted as SSE): right
//     when you want token-by-token output in a browser chat UI.
// Everything ELSE about the two is identical: same key handling, same
// server-side collection mapping, same caller-owned conversation ownership.
//
// RUN IT:
//   semidex-lite key add --name demo-chat --collection my-docs --operation search --operation generate
//   SEMIDEX_TOKEN=sdx_v1_... SEMIDEX_BASE_URL=http://127.0.0.1:8642 \
//     SEMIDEX_SUPPORT_COLLECTION=my-docs \
//     node packages/lite/examples/backend-chat-server.mjs
//
// ENVIRONMENT VARIABLES:
//   SEMIDEX_TOKEN                 (required) Integration API bearer token.
//   SEMIDEX_BASE_URL              (optional) default http://127.0.0.1:8642
//   PORT                          (optional) default 8788
//   SEMIDEX_SUPPORT_COLLECTION    (optional) collection behind assistantId "support"
//   SEMIDEX_HANDBOOK_COLLECTION   (optional) collection behind assistantId "handbook"
//
// THE THREE RULES THIS EXAMPLE EXISTS TO DEMONSTRATE:
//
// 1. THE BEARER KEY IS BACKEND-ONLY. SEMIDEX_TOKEN is read once, here, from
//    this process's environment. It is never sent to the browser in a
//    response body, a header, or an embedded script, and never logged — not
//    even truncated, not even at startup. If you find yourself putting a
//    Semidex key in front-end code, an environment variable prefixed for a
//    bundler (VITE_*, NEXT_PUBLIC_*, ...), or a mobile app binary, stop:
//    anyone who opens devtools then owns your whole collection's read and
//    generation budget. The browser talks to THIS backend; only this backend
//    talks to Semidex.
//
// 2. THE BROWSER NEVER NAMES A COLLECTION. It sends an application-level
//    `assistantId`; this backend owns the explicit assistantId -> collection
//    mapping (ASSISTANTS below) and rejects anything not in it. Accepting a
//    raw `collection` from the browser would let a caller read every
//    collection the key is scoped to, which is a data-exposure bug even with
//    a perfectly secret key. A real app resolves this from the
//    AUTHENTICATED user's own permissions rather than a hardcoded map — the
//    point is that the mapping is server-side, explicit, and closed.
//
// 3. CONVERSATION STATE IS CALLER-OWNED. Semidex Lite stores nothing between
//    requests: Ask v2's `summary`/`recentMessages` come from YOU on every
//    turn and the `done` event hands back what to store for the next one.
//    CONVERSATIONS below is a plain in-process Map — *** DEMO ONLY, NOT
//    PRODUCTION PERSISTENCE ***: it is lost on restart, never shared across
//    replicas, and grows without bound. In production, replace it with
//    whatever already holds your user data (PostgreSQL, Redis, SQLite,
//    DynamoDB, ...), keyed by your own user/session identifiers, with your
//    own retention and deletion policy. Nothing else in this file changes
//    when you do — the swap is genuinely just this one Map.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createSemidexClient, SemidexApiError } from '../lite-src/client/index.js';

const PORT = Number(process.env.PORT ?? 8788);
const SEMIDEX_BASE_URL = process.env.SEMIDEX_BASE_URL ?? 'http://127.0.0.1:8642';
const SEMIDEX_TOKEN = process.env.SEMIDEX_TOKEN;

// Whether this module was RUN as a script (as opposed to imported by the
// unit test, which exercises the pure mapping/persistence helpers below
// without a token, a port, or a live Semidex).
const RUN_AS_SCRIPT = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (RUN_AS_SCRIPT && !SEMIDEX_TOKEN) {
  console.error('Error: SEMIDEX_TOKEN is not set. Create a key with:');
  console.error('  semidex-lite key add --name demo-chat --collection <your-collection> --operation search --operation generate');
  console.error('and pass the printed token as SEMIDEX_TOKEN.');
  process.exit(1);
}

const SEMIDEX_CLIENT_OPTIONS = {
  baseUrl: SEMIDEX_BASE_URL,
  apiKey: SEMIDEX_TOKEN,
  // Conservative, opt-in retries for transient upstream trouble (429/502/
  // 503/504 and connection failures) BEFORE any generation has started. A
  // generation that has already begun streaming is never retried — see the
  // README's "Retries" section. Three attempts with bounded, jittered
  // backoff is a reasonable default for a user-facing request; a background
  // job could afford more.
  retry: {
    attempts: 3,
    initialDelayMs: 250,
    maxDelayMs: 4000,
    // Retry activity is observable without exposing anything sensitive —
    // this record carries status/code/delay only, never headers or the token.
    onRetry: (info) => {
      console.warn(`[semidex] attempt ${info.attempt} failed (status=${info.status} code=${info.code}); retrying in ${info.delayMs}ms`);
    },
  },
  // A total wall-clock budget for the WHOLE call, retries and backoff
  // included — opting into retries can never make a request outlive this.
  timeoutMs: 45_000,
};

// Rule (1): constructed ONCE, server-side. The client — and the token it
// closes over privately — never leaves this module. Built on first use so
// that importing this file (the unit test does, to exercise the pure
// mapping/persistence helpers below) needs no token and reaches no network.
let semidexClient = null;
function semidex() {
  if (semidexClient === null) semidexClient = createSemidexClient(SEMIDEX_CLIENT_OPTIONS);
  return semidexClient;
}

// Rule (2): the closed, server-side assistantId -> collection mapping. The
// browser sends "support"; it never learns that the real collection is
// called "acme-support-kb-v3".
const ASSISTANTS = Object.freeze({
  support: Object.freeze({
    collection: process.env.SEMIDEX_SUPPORT_COLLECTION ?? 'my-docs',
    label: 'Customer support',
  }),
  handbook: Object.freeze({
    collection: process.env.SEMIDEX_HANDBOOK_COLLECTION ?? 'my-docs',
    label: 'Employee handbook',
  }),
});

/**
 * Resolves a browser-supplied assistantId to a real collection name.
 *
 * Uses a hasOwnProperty guard rather than a bare `ASSISTANTS[assistantId]`
 * lookup: a prototype-chain key ("constructor", "toString", "__proto__")
 * would otherwise resolve to a truthy non-collection value and be passed
 * straight to the API. Object.freeze() + a null-prototype-style guard keeps
 * the mapping genuinely closed.
 */
function resolveAssistant(assistantId) {
  if (typeof assistantId !== 'string' || !Object.prototype.hasOwnProperty.call(ASSISTANTS, assistantId)) {
    throw Object.assign(
      new Error(`Unknown assistantId. Known ids: ${Object.keys(ASSISTANTS).join(', ')}.`),
      { status: 400 },
    );
  }
  return ASSISTANTS[assistantId];
}

// Rule (3): *** DEMO ONLY *** — see this file's header. conversationId ->
// { summary, recentMessages }.
const CONVERSATIONS = new Map();

// A bound on the caller-owned recent-message window. The server enforces its
// own ceiling (200 entries) and will reject more, but a backend should keep
// its own tighter bound: every message here is re-sent on every single turn,
// so an unbounded window silently grows each request's prompt cost.
const MAX_RECENT_MESSAGES = 20;

function loadConversation(conversationId) {
  if (!conversationId) return null;
  return CONVERSATIONS.get(conversationId) ?? null;
}

/**
 * Persists the turn that just completed. In production this is the ONE
 * function that changes: same inputs, same outputs, a real datastore behind
 * it instead of a Map.
 */
function saveConversation(conversationId, { question, answer, doneConversation, prior }) {
  const nextSummary = doneConversation?.summaryChanged
    ? doneConversation.updatedSummary
    : prior?.summary;
  const recentMessages = [
    ...(prior?.recentMessages ?? []),
    { role: 'user', content: question },
    { role: 'assistant', content: answer },
  ].slice(-MAX_RECENT_MESSAGES);
  CONVERSATIONS.set(conversationId, { summary: nextSummary, recentMessages });
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 256 * 1024) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// POST /chat
//   -> { assistantId, question, conversationId? }
//   <- { conversationId, answer, citations, sources, refused, usage }
//
// One request, one JSON answer — no SSE framing on either leg. This is the
// whole point of askText(): the accumulation of `sources` + N `answer_delta`
// + `done` into a finished result is done for you, correctly, including the
// error cases (a terminal SSE `error` event still throws SemidexApiError).
async function handleChat(req, res) {
  const { assistantId, question, conversationId: incomingId } = await readJsonBody(req);

  if (typeof question !== 'string' || question.trim() === '') {
    throw Object.assign(new Error('Body field "question" is required.'), { status: 400 });
  }
  // Rule (2): note what is NOT read from the body — `collection`. A browser
  // cannot reach a collection this backend did not choose for it.
  const assistant = resolveAssistant(assistantId);

  // Rule (3): load the caller-owned state, send it, store what comes back.
  const conversationId = typeof incomingId === 'string' && incomingId !== '' ? incomingId : randomUUID();
  const prior = loadConversation(conversationId);

  const disconnect = abortOnDisconnect(res);
  let result;
  try {
    result = await semidex().askText({
      version: 'v2',
      collection: assistant.collection,
      question,
      conversation: {
        conversationId,
        ...(prior?.summary !== undefined ? { summary: prior.summary } : {}),
        ...(prior?.recentMessages ? { recentMessages: prior.recentMessages } : {}),
      },
      // If the browser hangs up, stop paying for a generation nobody will read.
      signal: disconnect.signal,
    });
  } finally {
    disconnect.stopWatching();
  }

  saveConversation(conversationId, {
    question,
    answer: result.answer,
    doneConversation: result.conversation,
    prior,
  });

  // Note what is returned to the browser: the answer and its evidence — not
  // the collection name, not the token, not the raw upstream `done` event.
  sendJson(res, 200, {
    conversationId,
    assistant: assistant.label,
    answer: result.answer,
    citations: result.citations,
    sources: result.sources.map((s) => ({ n: s.n, section: s.section, snippet: s.snippet })),
    refused: Boolean(result.done.refused),
    usage: result.done.usage ?? null,
  });
}

// GET /assistants — the browser discovers which assistants exist WITHOUT
// ever learning a collection name.
function handleAssistants(res) {
  sendJson(res, 200, {
    assistants: Object.entries(ASSISTANTS).map(([id, a]) => ({ assistantId: id, label: a.label })),
  });
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
// AFTER the response is sent is just the ordinary teardown of a request
// that already succeeded and must never abort a generation this backend
// already finished with.
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
    if (req.method === 'GET' && req.url === '/assistants') return handleAssistants(res);
    if (req.method === 'POST' && req.url === '/chat') return await handleChat(req, res);
    sendJson(res, 404, { error: 'not_found' });
  } catch (err) {
    if (res.destroyed || res.closed) return;
    if (res.headersSent) { res.end(); return; }
    // A SemidexApiError is projected to a SAFE browser-facing shape: its
    // code/message are already secret-free by construction (the client never
    // puts the key or a raw header in an error), but the upstream STATUS is
    // deliberately not forwarded verbatim — a 401/403 from Semidex is a
    // misconfiguration of THIS backend, not something the browser caller did
    // wrong, and telling the browser "401" would be actively misleading.
    if (err instanceof SemidexApiError) {
      console.error(`[chat] semidex error status=${err.status} code=${err.code} requestId=${err.requestId}`);
      const clientFacing = err.status === 429
        ? { status: 429, body: { error: 'rate_limited', retryable: true } }
        : { status: 502, body: { error: 'upstream_error', retryable: Boolean(err.retryable) } };
      sendJson(res, clientFacing.status, clientFacing.body);
      return;
    }
    sendJson(res, err.status ?? 500, { error: err.message ?? 'internal_error' });
  }
};

// Only listen when RUN as a script — importing this module (the unit test
// below does) must never bind a port or print a banner.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const server = createServer(requestHandler);
  server.listen(PORT, '127.0.0.1', () => {
    const port = server.address().port;
    console.log(`[backend-chat-server] listening on http://127.0.0.1:${port}`);
    console.log(`[backend-chat-server] proxies to Semidex Lite at ${SEMIDEX_BASE_URL}`);
    console.log(`[backend-chat-server] assistants: ${Object.keys(ASSISTANTS).join(', ')}`);
    console.log('Try:');
    console.log(`  curl -s http://127.0.0.1:${port}/assistants`);
    console.log(`  curl -s -X POST http://127.0.0.1:${port}/chat -H 'Content-Type: application/json' \\`);
    console.log('    -d \'{"assistantId":"support","question":"What is the return window?"}\'');
    console.log('  # then pass the returned conversationId back on the next turn:');
    console.log(`  curl -s -X POST http://127.0.0.1:${port}/chat -H 'Content-Type: application/json' \\`);
    console.log('    -d \'{"assistantId":"support","question":"Any exceptions?","conversationId":"<id>"}\'');
  });
}

// Exported for tests (tests/unit/lite/client/backend-example.test.js and
// backend-disconnect.test.js) — the collection-mapping/persistence rules and
// the disconnect-vs-normal-completion boundary above are worth pinning with
// real assertions, not just prose.
export {
  ASSISTANTS, resolveAssistant, saveConversation, loadConversation, CONVERSATIONS, MAX_RECENT_MESSAGES, abortOnDisconnect,
};
