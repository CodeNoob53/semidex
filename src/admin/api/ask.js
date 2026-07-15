// POST /api/ask — SSE route over the Ask coordinator (src/core/ask/coordinator.js).
//
// This file owns only HTTP/SSE framing: body validation, translating
// coordinator results into the sources/token/done/error event sequence,
// and wiring client disconnect to an AbortSignal. All retrieval/prompt/
// generation/citation logic lives in core/ask/* — nothing here imports
// core/ollama.js or a StorageAdapter method directly.
//
// Contract (docs/design/ask-chat.md §4):
// - validation/unknown-collection errors -> plain JSON 400/404, no stream
// - provider not ready -> plain JSON 503, no stream
// - a second concurrent ask -> plain JSON 429, no stream
// - once streaming starts: `sources` first (exactly once), then 0..N
//   `token`, then exactly one of `done` or `error` (never both)
import { badRequest, notFound, dependencyUnavailable, tooManyRequests, readJsonBody, HttpError } from '../http.js';
import { startSse, writeSseEvent, waitForDrain } from '../sse.js';
import { sanitiseErrorMessage } from '../../core/doctor-checks.js';

// Provider readiness reasons and mid-stream generation-failure messages
// originate from src/core/ollama.js / ollama-provider.js and can embed a
// raw Ollama base URL or request/response body text (e.g. "Ollama is not
// reachable at http://host:port", or a raw fetch error body) — the
// router's own catch-all only redacts uncaught exceptions, NOT a
// deliberately-thrown HttpError or an SSE `error` event payload, so both
// paths below must redact explicitly before the message leaves this
// process (code review finding).
function safeMessage(message) {
  return sanitiseErrorMessage(message ?? '', process.env.QDRANT_KEY);
}

// Maps a pre-stream retrieval failure (from core/retrieval/search.js, as
// surfaced by evidence.js/coordinator.js) to an HTTP status — mirrors how
// /api/search itself reports the same error codes (see api/search.js).
const RETRIEVAL_ERROR_STATUS = {
  not_implemented: 501,
  collection_not_found: 404,
  embedding_failed: 500,
};

const TOP_DEFAULT = 5;
const TOP_MIN = 1;
const TOP_MAX = 10;

export function parseAskRequest(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }
  const { collection, question, sourceFile, top } = body;
  if (typeof collection !== 'string' || collection.trim() === '') {
    throw badRequest('Body field "collection" is required and must be a non-empty string');
  }
  if (typeof question !== 'string' || question.trim() === '') {
    throw badRequest('Body field "question" is required and must be a non-empty string');
  }
  if (sourceFile !== undefined && sourceFile !== null && (typeof sourceFile !== 'string' || sourceFile.trim() === '')) {
    throw badRequest('Body field "sourceFile" must be a non-empty string when provided');
  }
  let topValue = TOP_DEFAULT;
  if (top !== undefined && top !== null) {
    if (!Number.isInteger(top) || top < TOP_MIN || top > TOP_MAX) {
      throw badRequest(`Body field "top" must be an integer between ${TOP_MIN} and ${TOP_MAX}, got ${JSON.stringify(top)}`);
    }
    topValue = top;
  }
  return { collection, question, sourceFile: sourceFile ?? undefined, top: topValue };
}

/**
 * @param {Object} router
 * @param {import('../../core/storage/adapter.js').StorageAdapter} adapter
 * @param {{
 *   askCoordinator: ReturnType<typeof import('../../core/ask/coordinator.js').createAskCoordinator>,
 * }} deps askCoordinator is required DI — createApp() supplies the real one,
 *   tests supply a stub that never touches Qdrant/Ollama/ONNX.
 */
export function registerAskRoutes(router, adapter, { askCoordinator }) {
  router.post('/api/ask', async ({ req, res }) => {
    const body = await readJsonBody(req);
    const { collection, question, sourceFile, top } = parseAskRequest(body);

    const existing = await adapter.getCollection(collection);
    if (!existing) throw notFound(`Collection "${collection}" not found`);

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

    let streamed = false;
    // Returns the drain-wait promise, same as onToken below — the sources
    // payload can itself be large (evidence snippets for up to `top`
    // sources), so a slow client can leave this write's data buffered
    // exactly like a token write can; the coordinator awaits both
    // identically, and waitForDrain() no longer hangs forever on a
    // disconnect that happens before it drains (see sse.js).
    const onSources = (payload) => {
      streamed = true;
      startSse(res);
      const ok = writeSseEvent(res, 'sources', payload);
      if (!ok) return waitForDrain(res);
      return undefined;
    };
    // Returns the drain-wait promise (not fire-and-forget) — ollama.js's
    // generateStream() now awaits onToken() before reading the next frame
    // from the model, so this promise is the actual backpressure signal: a
    // slow client makes generateStream() pause reading from Ollama instead
    // of letting res's internal write buffer grow unbounded (code review
    // finding — the previous fire-and-forget wait meant this coroutine
    // never actually paused anything).
    const onToken = (text) => {
      const ok = writeSseEvent(res, 'token', { text });
      if (!ok) return waitForDrain(res);
      return undefined;
    };

    const result = await askCoordinator.ask({
      collection, question, sourceFile, top, signal: controller.signal, onSources, onToken,
    });

    if (result.status === 'busy') {
      throw tooManyRequests('Another Ask request is already in progress. Only one generation may run at a time.');
    }
    if (result.status === 'provider_unavailable') {
      throw dependencyUnavailable(safeMessage(result.reason));
    }
    if (result.status === 'error' && !streamed) {
      const statusCode = RETRIEVAL_ERROR_STATUS[result.code] ?? 500;
      throw new HttpError(statusCode, result.code ?? 'internal_error', safeMessage(result.message));
    }

    // From here on the stream has started (sources was emitted, or a
    // zero-evidence refusal emitted an empty sources event) — every
    // remaining exit path must end with exactly one terminal SSE event,
    // never a thrown HttpError (the router's catch-all would try to call
    // res.writeHead again on an already-started response).
    if (!streamed) {
      startSse(res);
      writeSseEvent(res, 'sources', { searchMode: null, sources: [] });
    }

    if (result.status === 'refused') {
      writeSseEvent(res, 'done', {
        citations: [], invalidCitations: [], entityRefs: [], strippedMarkers: [],
        refused: true, refusalReason: result.reason, evidenceCount: result.evidenceCount,
      });
      res.end();
      return;
    }

    if (result.status === 'aborted') {
      writeSseEvent(res, 'error', { code: 'stream_aborted', message: 'The request was cancelled.' });
      res.end();
      return;
    }

    if (result.status === 'error') {
      writeSseEvent(res, 'error', { code: 'generation_failed', message: safeMessage(result.message) });
      res.end();
      return;
    }

    // status === 'done'
    writeSseEvent(res, 'done', {
      citations: result.citations,
      invalidCitations: result.invalidCitations,
      entityRefs: result.nodeReferences,
      strippedMarkers: result.strippedMarkers,
      refused: result.refused,
      provider: result.provider,
      model: result.model,
      elapsedMs: result.elapsedMs,
      promptTokens: result.tokensIn,
      completionTokens: result.tokensOut,
      evidenceCount: result.evidenceCount,
    });
    res.end();
  });
}
