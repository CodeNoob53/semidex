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
import { AUDIENCE, OPERATION, COST_CLASS, COLLECTION_SOURCE } from '../../http/route-audience.js';
import { authorizeCollectionAccess } from '../../http/authorize.js';
import { createAskRequestBudget } from '../../ask/budget-ledger.js';
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
  // Spend/token budget ceiling — see v1/route.js's identical entries for
  // the full reasoning (this call path shares the exact same askCore, so
  // the same denial shapes apply).
  budget_exceeded: 429,
  budget_limit_exceeded: 429,
  budget_unenforceable: 503,
};

/**
 * @param {Object} router
 * @param {import('../../storage/adapter.js').StorageAdapter} adapter
 * @param {{
 *   askCoordinatorV2: ReturnType<typeof import('../../ask/coordinator-v2.js').createAskCoordinatorV2>,
 *   budgetTracker?: ReturnType<typeof import('../../auth/token-budget.js').createTokenBudgetTracker>,
 *   settingsService?: Object,
 * }} deps budgetTracker/settingsService are optional (spend/token ceiling
 *   feature) — see v1/route.js's identical note and
 *   core/ask/budget-ledger.js's createAskRequestBudget().
 */
export function registerAskRoutesV2(router, adapter, { askCoordinatorV2, budgetTracker, settingsService }) {
  router.post(ASK_PATH, async ({ req, res, auth }) => {
    let streamed = false;
    try {
      let collection;
      let question;
      let conversation;
      try {
        const body = await readJsonBody(req);
        ({ collection, question, conversation } = parseAskRequestV2(body));

        // Stage 2 — object-level authorization (OWASP API1:2023). The
        // collection identifier is client-supplied and only known now that
        // the body is parsed, which is exactly why the router's pre-body
        // seam cannot perform this check. Runs BEFORE adapter.getCollection()
        // so a denied request costs no Qdrant round-trip, and before any
        // Gemini call. Fail-closed when a hook is configured; a no-op when
        // one is not. Throws HttpError, which the enclosing catch maps to
        // this endpoint's versioned error body.
        // `auth` carries the stage-1 principal, the matched route metadata
        // and the configured hook — all explicitly, never via a mutated
        // request object. The operation comes from route metadata
        // (OPERATION.GENERATE, declared at registration), so it cannot drift
        // from the registry the way a re-declared literal could.
        await authorizeCollectionAccess(auth, { req, collection });

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

      // Spend/token budget ledger — ONE per request, shared across every
      // generation call this v2 request may make (rewrite, answer,
      // compaction). See v1/route.js's identical note and
      // createAskRequestBudget()'s own header comment.
      const budget = createAskRequestBudget({ auth, tracker: budgetTracker, settingsService });

      const result = await askCoordinatorV2.ask({
        collection, question, conversation, signal: controller.signal, budget, onSources, onToken,
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
        // Retry-After — see v1/route.js's identical note (spend/token
        // budget ceiling, transient per-key-aggregate denials only).
        const headers = Number.isFinite(result.retryAfterSeconds) ? { 'Retry-After': String(Math.max(1, Math.ceil(result.retryAfterSeconds))) } : {};
        sendJson(res, statusCode, projectErrorResponseBody(result.code ?? ERROR_CODES.INTERNAL_ERROR, safeMessage(result.message)), headers);
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
        compactedMessageCount: result.compactedMessageCount,
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
  }, { audience: AUDIENCE.INTEGRATION, operation: OPERATION.GENERATE, resourceType: 'collection', collectionSource: COLLECTION_SOURCE.BODY, costClass: COST_CLASS.LLM });
}
