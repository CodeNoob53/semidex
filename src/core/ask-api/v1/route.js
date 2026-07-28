// Ask API v1 — the canonical, application-facing Ask endpoint:
// POST /api/v1/ask.
//
// This is the ONE public Ask contract module. It owns:
//   - the route registration itself (mounted by whatever HTTP server the
//     caller supplies — today that's the Node HTTP server in src/admin/,
//     but nothing here depends on Admin UI implementation details);
//   - request parsing/validation (request.js);
//   - public event/error projection (contract.js);
//   - SSE framing and coordinator wiring (this file).
//
// It does NOT duplicate retrieval, prompt, citation, or provider logic —
// all of that stays in src/core/ask/coordinator.js (transport- and
// provider-neutral) and the modules it composes. This module never imports
// Qdrant, Ollama, Gemini, or any src/admin/ module — only the generic
// core/http/* transport primitives and the coordinator's own public
// interface.
import { sendJson, notFound, readJsonBody, HttpError } from '../../http/http.js';
import { startSse, writeSseEvent, waitForDrain } from '../../http/sse.js';
import { sanitiseErrorMessage } from '../../doctor-checks.js';
import { parseAskRequestV1 } from './request.js';
import {
  ASK_PATH, SSE_EVENTS, ERROR_CODES,
  projectSourcesEvent, projectAnswerDeltaEvent, projectDoneEvent, projectErrorPayload, projectErrorResponseBody,
} from './contract.js';

export { ASK_PATH };

// Provider readiness reasons and mid-stream generation-failure messages
// originate from src/core/ollama.js / ollama-provider.js (or, for the
// gemini backend, gemini-provider.js) and can embed a raw Ollama base URL
// or request/response body text (e.g. "Ollama is not reachable at
// http://host:port", or a raw fetch error body) — a deliberately-thrown
// HttpError or an SSE `error` event payload is never passed through the
// caller's own generic uncaught-exception redaction, so this route must
// redact explicitly before any such message leaves this process.
// gemini-provider.js already redacts GEMINI_API_KEY out of any message it
// produces — this is a second, defense-in-depth layer at the route
// boundary, matching how QDRANT_KEY is handled here.
function safeMessage(message) {
  return sanitiseErrorMessage(sanitiseErrorMessage(message ?? '', process.env.QDRANT_KEY), process.env.GEMINI_API_KEY);
}

// Maps a pre-stream retrieval failure (from core/retrieval/search.js, as
// surfaced by evidence.js/coordinator.js) to an HTTP status — mirrors how
// /api/search itself reports the same error codes.
const RETRIEVAL_ERROR_STATUS = {
  not_implemented: 501,
  collection_not_found: 404,
  embedding_failed: 500,
  // Embedding-profile resolution outcomes (src/core/embedding-profile/
  // resolve.js, surfaced through runHybridSearch) — distinct from a
  // generic embedding_failed: the collection's identity itself could not
  // be resolved, or its profile declares an execution mode this codebase
  // does not implement yet.
  embedding_unresolved: 503,
  embedding_unsupported: 501,
};

/**
 * @param {Object} router — anything exposing router.post(path, handler),
 *   e.g. src/admin/router.js's createRouter() return value. This module
 *   does not construct or depend on any particular router implementation.
 * @param {import('../../storage/adapter.js').StorageAdapter} adapter
 * @param {{
 *   askCoordinator: ReturnType<typeof import('../../ask/coordinator.js').createAskCoordinator>,
 * }} deps askCoordinator is required DI — the caller supplies the real one;
 *   tests supply a stub that never touches Qdrant/Ollama/ONNX.
 */
export function registerAskRoutesV1(router, adapter, { askCoordinator }) {
  router.post(ASK_PATH, async ({ req, res }) => {
    // `streamed` is shared between the try block and the catch below: it is
    // the one signal that tells the catch whether `sources` has already
    // gone out, and therefore whether a caught exception must be reported
    // as a fresh pre-stream JSON error or as a terminal mid-stream SSE
    // `error` event on the response already in progress.
    let streamed = false;
    try {
      // Every failure up to the first SSE write is a pre-stream failure: no
      // bytes of the response have been sent yet, so it is always safe to
      // reply with a single v1-shaped JSON error body here instead of
      // throwing for the shared router's generic (non-v1) catch-all to
      // serialize — that catch-all is intentionally used by every other
      // admin route and must stay unaware of this endpoint's versioned
      // contract.
      let collection;
      let question;
      let sourceFile;
      try {
        const body = await readJsonBody(req);
        ({ collection, question, sourceFile } = parseAskRequestV1(body));

        const existing = await adapter.getCollection(collection);
        if (!existing) throw notFound(`Collection "${collection}" not found`);
      } catch (err) {
        if (err instanceof HttpError) {
          sendJson(res, err.statusCode, projectErrorResponseBody(err.code, safeMessage(err.message)));
          return;
        }
        throw err;
      }

      // res (not req) 'close' is the client-disconnect signal here: req's
      // readable stream ends (and reports closed) as soon as its body is
      // fully consumed by readJsonBody() above — that happens long before
      // generation finishes and is unrelated to whether the client is still
      // connected. res stays open for the life of the SSE response, so its
      // 'close' event (fired when the underlying socket is actually torn
      // down, e.g. the client aborting mid-stream) is the real disconnect
      // signal to forward into the provider's AbortSignal.
      const controller = new AbortController();
      res.on('close', () => controller.abort());

      // Returns the drain-wait promise, same as onToken below — the sources
      // payload can itself be large (evidence snippets for every source), so
      // a slow client can leave this write's data buffered exactly like an
      // answer_delta write can; the coordinator awaits both identically.
      const onSources = (payload) => {
        streamed = true;
        startSse(res);
        const ok = writeSseEvent(res, SSE_EVENTS.SOURCES, projectSourcesEvent(payload));
        if (!ok) return waitForDrain(res);
        return undefined;
      };
      // Returns the drain-wait promise (not fire-and-forget) — the
      // coordinator/provider await onToken() before reading the next frame,
      // so this promise is the actual backpressure signal: a slow client
      // makes generation pause instead of letting res's internal write
      // buffer grow unbounded.
      const onToken = (text) => {
        const ok = writeSseEvent(res, SSE_EVENTS.ANSWER_DELTA, projectAnswerDeltaEvent(text));
        if (!ok) return waitForDrain(res);
        return undefined;
      };

      const result = await askCoordinator.ask({
        collection, question, sourceFile, signal: controller.signal, onSources, onToken,
      });

      if (result.status === 'busy') {
        sendJson(res, 429, projectErrorResponseBody(ERROR_CODES.BUSY, 'Another Ask request is already in progress. Only one generation may run at a time.'));
        return;
      }
      if (result.status === 'provider_unavailable') {
        sendJson(res, 503, projectErrorResponseBody(ERROR_CODES.DEPENDENCY_UNAVAILABLE, safeMessage(result.reason)));
        return;
      }
      if (result.status === 'error' && !streamed) {
        const statusCode = RETRIEVAL_ERROR_STATUS[result.code] ?? 500;
        sendJson(res, statusCode, projectErrorResponseBody(result.code ?? ERROR_CODES.INTERNAL_ERROR, safeMessage(result.message)));
        return;
      }

      // From here on the stream has started (sources was emitted, or a
      // zero-evidence refusal emitted an empty sources event) — every
      // remaining exit path must end with exactly one terminal SSE event,
      // never a thrown HttpError (the router's catch-all would try to call
      // res.writeHead again on an already-started response).
      if (!streamed) {
        streamed = true;
        startSse(res);
        writeSseEvent(res, SSE_EVENTS.SOURCES, projectSourcesEvent({ searchMode: null, sources: [] }));
      }

      if (result.status === 'refused') {
        writeSseEvent(res, SSE_EVENTS.DONE, projectDoneEvent({
          text: '', citations: [], nodeReferences: [], refused: true,
          refusalReason: result.reason, evidenceCount: result.evidenceCount,
        }));
        res.end();
        return;
      }

      if (result.status === 'aborted') {
        writeSseEvent(res, SSE_EVENTS.ERROR, projectErrorPayload(ERROR_CODES.STREAM_ABORTED, 'The request was cancelled.'));
        res.end();
        return;
      }

      if (result.status === 'error') {
        writeSseEvent(res, SSE_EVENTS.ERROR, projectErrorPayload(ERROR_CODES.GENERATION_FAILED, safeMessage(result.message)));
        res.end();
        return;
      }

      // status === 'done'
      writeSseEvent(res, SSE_EVENTS.DONE, projectDoneEvent({
        text: result.text,
        citations: result.citations,
        nodeReferences: result.nodeReferences,
        refused: result.refused,
        provider: result.provider,
        model: result.model,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        evidenceCount: result.evidenceCount,
        elapsedMs: result.elapsedMs,
      }));
      res.end();
    } catch (err) {
      // Last-resort safety net: an unexpected (non-HttpError) exception —
      // e.g. adapter.getCollection() throwing a plain Error, or
      // askCoordinator.ask() rejecting — must still resolve to a v1-shaped
      // response, and must never attempt a second, conflicting write.
      //
      // - Client already gone: writing anything would throw again (or
      //   silently no-op at best) — do nothing.
      // - Nothing streamed yet: this is still a pre-stream failure, safe to
      //   answer with one JSON error body.
      // - Already streaming: headers are sent and `sources` may already be
      //   on the wire — the ONLY valid remaining write is one terminal SSE
      //   `error` event, never a second res.writeHead()/JSON body (that is
      //   exactly the ERR_HTTP_HEADERS_SENT crash this catch exists to
      //   prevent).
      if (res.destroyed || res.writableEnded) return;
      const message = safeMessage(err?.message ?? String(err));
      if (!streamed) {
        sendJson(res, 500, projectErrorResponseBody(ERROR_CODES.INTERNAL_ERROR, message));
        return;
      }
      writeSseEvent(res, SSE_EVENTS.ERROR, projectErrorPayload(ERROR_CODES.INTERNAL_ERROR, message));
      res.end();
    }
  });
}
