// Agent API v3 — POST /api/v3/ask.
//
// This route AUTHORIZES, VALIDATES and PROJECTS. It contains no agent logic:
// deciding, stepping the model, storing continuations and enforcing run
// ceilings all live in src/core/agent/runtime.js, which knows nothing about
// HTTP. That split is what lets a future embedded SDK reuse the same runtime
// with no transport at all.
//
// NO COLLECTION IN THE BODY — AND WHY THAT IS NOT A HOLE
// -----------------------------------------------------
// Unlike Ask v1/v2, an agent request names no collection: agent mode does no
// retrieval of its own. Retrieval reaches a run only when the APPLICATION
// declares a retrieval tool and calls it, and every such call is an ordinary
// Search/Content API request that passes through its own stage-2 collection
// authorization. So `collectionSource: none` here is accurate, not a
// weakening: a collection name appearing inside tool arguments grants
// nothing, because Semidex never acts on it.
//
// SCOPE
// -----
// `operation: AGENT` (not GENERATE). Agent mode hands the caller control of
// the model's system instructions and tool surface, which is materially
// wider than grounded Ask. A key must be explicitly scoped `--operation
// agent`; existing Ask keys do not silently gain it.
import { sendJson, readJsonBody, HttpError } from '../../http/http.js';
import { startSse, writeSseEvent, waitForDrain } from '../../http/sse.js';
import { sanitiseErrorMessage } from '../../../shared/core/doctor-checks.js';
import { AUDIENCE, OPERATION, COST_CLASS, COLLECTION_SOURCE } from '../../http/route-audience.js';
import { createAskRequestBudget } from '../../ask/budget-ledger.js';
import { parseAgentRequestV3 } from './request.js';
import {
  AGENT_PATH, SSE_EVENTS, AGENT_STATUS, ERROR_CODES,
  statusForCode, projectAnswerDeltaEvent, projectDoneEvent, projectErrorPayload, projectErrorResponseBody,
} from './contract.js';

export { AGENT_PATH };

function safeMessage(message) {
  return sanitiseErrorMessage(message ?? '', [process.env.QDRANT_KEY, process.env.GEMINI_API_KEY]);
}

/**
 * The identity a continuation is bound to. A run created by one key may only
 * ever be continued by that same key — see continuation-store.js's own
 * constant-time identity check.
 *
 * Falls back to a fixed sentinel ONLY when no integration policy is
 * configured at all (the same "unchanged behavior" branch every other
 * integration route has). In that deployment there is no multi-tenant
 * boundary to enforce in the first place.
 */
function runIdentity(auth) {
  const keyId = auth?.principal?.keyId;
  return (typeof keyId === 'string' && keyId.length > 0) ? keyId : 'anonymous-local';
}

/**
 * @param {Object} router
 * @param {{
 *   agentRuntime: ReturnType<typeof import('../../agent/runtime.js').createAgentRuntime>,
 *   budgetTracker?: Object,
 *   settingsService?: Object,
 * }} deps
 */
export function registerAgentRoutesV3(router, { agentRuntime, budgetTracker, settingsService }) {
  if (!agentRuntime) {
    throw new TypeError('registerAgentRoutesV3: agentRuntime is required.');
  }

  router.post(AGENT_PATH, async ({ req, res, auth }) => {
    let streamed = false;
    let continuationId = null;
    const identity = runIdentity(auth);

    // Declared here so the abort handler can free a pending run: a client
    // that disconnects mid-step must not leave state behind.
    const controller = new AbortController();

    try {
      let request;
      try {
        request = parseAgentRequestV3(await readJsonBody(req));
      } catch (err) {
        if (err instanceof HttpError) {
          sendJson(res, err.statusCode, projectErrorResponseBody(err.code, safeMessage(err.message)));
          return;
        }
        throw err;
      }

      res.on('close', () => controller.abort());

      // ONE ledger per request, exactly as Ask v1/v2 build theirs — the same
      // per-key aggregate bucket and the same per-request ceilings. Agent
      // mode does not get a second, hidden budget.
      const budget = createAskRequestBudget({ auth, tracker: budgetTracker, settingsService });

      const onText = (text) => {
        if (!streamed) {
          streamed = true;
          startSse(res);
        }
        const ok = writeSseEvent(res, SSE_EVENTS.ANSWER_DELTA, projectAnswerDeltaEvent(text));
        if (!ok) return waitForDrain(res);
        return undefined;
      };

      let result;
      if (request.kind === 'start') {
        result = await agentRuntime.start({
          identity,
          input: request.input,
          systemInstructions: request.systemInstructions,
          tools: request.tools,
          model: request.model,
          maxModelSteps: request.maxModelSteps,
          maxToolCalls: request.maxToolCalls,
          maxOutputTokens: request.maxOutputTokens,
          budget,
          signal: controller.signal,
          onText,
        });
      } else {
        continuationId = request.continuationId;
        result = await agentRuntime.continue({
          identity,
          continuationId: request.continuationId,
          toolResults: request.toolResults,
          budget,
          signal: controller.signal,
          onText,
        });
      }

      // A stream that has not started yet still ends as SSE — the contract
      // has exactly one success shape, so a caller never has to handle "a
      // JSON success sometimes, an SSE success other times".
      if (!streamed) {
        streamed = true;
        startSse(res);
      }
      writeSseEvent(res, SSE_EVENTS.DONE, projectDoneEvent(result));
      res.end();
    } catch (err) {
      // A typed runtime/store/provider failure carries its own code; anything
      // else is an internal error. Either way, once streaming has begun the
      // failure is a terminal SSE `error` event and NEVER becomes a
      // successful `done`.
      const code = typeof err?.code === 'string' && statusForCode(err.code) !== 500
        ? err.code
        : ERROR_CODES.INTERNAL_ERROR;
      const message = safeMessage(err?.message ?? String(err));

      // Free a run whose step failed or whose client vanished. The runtime
      // already closes a run on a failed step; this covers the abort path.
      if (continuationId && controller.signal.aborted) {
        agentRuntime.close({ identity, continuationId });
      }

      if (res.destroyed || res.writableEnded) return;

      if (!streamed) {
        const headers = Number.isFinite(err?.retryAfterSeconds)
          ? { 'Retry-After': String(Math.max(1, Math.ceil(err.retryAfterSeconds))) }
          : {};
        sendJson(res, statusForCode(code), projectErrorResponseBody(code, message), headers);
        return;
      }
      writeSseEvent(res, SSE_EVENTS.ERROR, projectErrorPayload(
        controller.signal.aborted ? ERROR_CODES.STREAM_ABORTED : code,
        controller.signal.aborted ? 'The request was cancelled.' : message,
      ));
      res.end();
    }
  }, {
    audience: AUDIENCE.INTEGRATION,
    operation: OPERATION.AGENT,
    resourceType: 'none',
    collectionSource: COLLECTION_SOURCE.NONE,
    costClass: COST_CLASS.LLM,
  });
}

export { AGENT_STATUS };
