// Ask API v2 — POST /api/v2/ask. Mirrors v1's route.js
// (src/core/ask-api/v1/route.js) structurally — same readJsonBody/parse/
// collection-check/SSE-framing/error-mapping shape — with the additive
// v2-only concerns: `conversation` passed through to the coordinator, and
// `conversation`/`context_budget_exceeded` handling in the response.
//
// This module never duplicates retrieval/prompt/citation/budgeting logic —
// all of that lives in src/core/ask/coordinator-v2.js and the modules it
// composes (query-rewrite.js, summary-compaction.js, conversation-context.js).
import { sendJson, notFound, readJsonBody, HttpError } from '../../http/http.js';
import { startSse, writeSseEvent, waitForDrain } from '../../http/sse.js';
import { sanitiseErrorMessage } from '../../../shared/core/doctor-checks.js';
import { parseAskRequestV2 } from './request.js';
import {
  ASK_PATH, SSE_EVENTS, ERROR_CODES,
  projectSourcesEvent, projectAnswerDeltaEvent, projectDoneEvent, projectErrorPayload, projectErrorResponseBody,
} from './contract.js';

export { ASK_PATH };

function safeMessage(message) {
  return sanitiseErrorMessage(message ?? '', [process.env.QDRANT_KEY, process.env.GEMINI_API_KEY]);
}

// Maps a pre-stream retrieval failure to an HTTP status — mirrors v1's own
// RETRIEVAL_ERROR_STATUS table, plus context_budget_exceeded (a v2-only
// budgeting outcome — the model's context window is too small to answer at
// all, independent of any conversation history).
const RETRIEVAL_ERROR_STATUS = {
  not_implemented: 501,
  collection_not_found: 404,
  embedding_failed: 500,
  embedding_unresolved: 503,
  embedding_unsupported: 501,
  context_budget_exceeded: 422,
};

/**
 * @param {Object} router
 * @param {import('../../storage/adapter.js').StorageAdapter} adapter
 * @param {{
 *   askCoordinatorV2: ReturnType<typeof import('../../ask/coordinator-v2.js').createAskCoordinatorV2>,
 * }} deps
 */
export function registerAskRoutesV2(router, adapter, { askCoordinatorV2 }) {
  router.post(ASK_PATH, async ({ req, res }) => {
    let streamed = false;
    try {
      let collection;
      let question;
      let conversation;
      try {
        const body = await readJsonBody(req);
        ({ collection, question, conversation } = parseAskRequestV2(body));

        const existing = await adapter.getCollection(collection);
        if (!existing) throw notFound(`Collection "${collection}" not found`);
      } catch (err) {
        if (err instanceof HttpError) {
          sendJson(res, err.statusCode, projectErrorResponseBody(err.code, safeMessage(err.message)));
          return;
        }
        throw err;
      }

      const controller = new AbortController();
      res.on('close', () => controller.abort());

      const onSources = (payload) => {
        streamed = true;
        startSse(res);
        const ok = writeSseEvent(res, SSE_EVENTS.SOURCES, projectSourcesEvent(payload));
        if (!ok) return waitForDrain(res);
        return undefined;
      };
      const onToken = (text) => {
        const ok = writeSseEvent(res, SSE_EVENTS.ANSWER_DELTA, projectAnswerDeltaEvent(text));
        if (!ok) return waitForDrain(res);
        return undefined;
      };

      const result = await askCoordinatorV2.ask({
        collection, question, conversation, signal: controller.signal, onSources, onToken,
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

      if (!streamed) {
        streamed = true;
        startSse(res);
        writeSseEvent(res, SSE_EVENTS.SOURCES, projectSourcesEvent({ searchMode: null, sources: [] }));
      }

      // Every terminal `done`/`refused` payload for a request that included
      // a `conversation` block echoes conversation.id and the summary
      // recompute outcome — projectDoneEvent() omits `conversation`
      // entirely when conversationId is undefined (first-turn requests).
      const conversationId = conversation?.id;

      if (result.status === 'refused') {
        writeSseEvent(res, SSE_EVENTS.DONE, projectDoneEvent({
          text: '', citations: [], nodeReferences: [], refused: true,
          refusalReason: result.reason, evidenceCount: result.evidenceCount,
          conversationId, summaryChanged: false,
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
        const code = RETRIEVAL_ERROR_STATUS[result.code] !== undefined ? result.code : ERROR_CODES.GENERATION_FAILED;
        writeSseEvent(res, SSE_EVENTS.ERROR, projectErrorPayload(code, safeMessage(result.message)));
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
        conversationId,
        summaryChanged: result.summaryChanged,
        updatedSummary: result.updatedSummary,
      }));
      res.end();
    } catch (err) {
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
