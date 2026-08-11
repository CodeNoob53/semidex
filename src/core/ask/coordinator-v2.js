// Ask v2 coordinator (bounded conversational context) — wraps the shared
// createAskCore() logic with query rewriting, token-budgeted history, and
// optional summary compaction, all under the SAME SingleFlightGate v1's
// coordinator uses. Never persists conversation state between requests —
// `conversation` is caller-supplied on every call and Semidex never reads
// or writes any store.
import { createAskCoordinator, createAskCore } from './coordinator.js';
import { createSingleFlightGate } from './single-flight-gate.js';
import { budgetConversationContext } from './conversation-context.js';
import { rewriteFollowUpQuery } from './query-rewrite.js';
import { compactSummaryIfNeeded } from './summary-compaction.js';

/**
 * @param {{
 *   core: ReturnType<typeof createAskCore>,
 *     REQUIRED — the SAME core instance passed into createAskCoordinator()
 *     for v1 (createAskCoordinatorBundle() below constructs both from one
 *     instance). v2 calls it directly, never through v1's gated ask()
 *     method, so there is no re-entrant gate acquisition and no ungated
 *     method exposed on v1's own coordinator object.
 *   gate: ReturnType<typeof createSingleFlightGate>,
 *     REQUIRED, and MUST be the exact same gate instance passed into
 *     createAskCoordinator()'s own construction for v1. This is what makes
 *     v1 and v2 traffic, and v2's rewrite/compaction steps that run OUTSIDE
 *     the core call, all contend on ONE lock instead of two independent
 *     ones.
 *   generationProvider: import('../generation/provider.js').GenerationProvider,
 *   countTokens: (text: string) => number | Promise<number>,
 *   settingsService?: ReturnType<typeof import('../settings/service.js').createSettingsService>,
 * }} deps
 * @returns {{ ask: Function, isBusy: () => boolean }}
 */
export function createAskCoordinatorV2({ core, gate, generationProvider, countTokens, settingsService }) {
  /**
   * @param {{
   *   collection: string,
   *   question: string,
   *   conversation?: { id?: string, summary?: string, recentMessages?: Array<{role,content}> },
   *   signal?: AbortSignal,
   *   onSources: Function,
   *   onToken: Function,
   * }} req
   * @returns {Promise<Object>} same shape as coordinator.js's askCore result,
   *   plus (only on status:'done') `updatedSummary`/`summaryChanged`.
   */
  async function ask({ collection, question, conversation, signal, onSources, onToken }) {
    const outcome = await gate.run(async () => {
      // 1. Resolve provider readiness once here — numCtx needed for
      //    budgeting, reused (not re-fetched) by compaction below.
      const readiness = await generationProvider.ready();
      if (!readiness.ok) {
        return { status: 'provider_unavailable', reason: readiness.reason ?? 'Generation provider is not ready.' };
      }

      const budgeted = await budgetConversationContext({
        conversation, question, countTokens, numCtx: readiness.numCtx, settingsService,
      });
      if (budgeted.error) {
        return { status: 'error', code: budgeted.error, message: budgeted.message };
      }

      // 2. Query rewrite (best-effort; own try/catch inside
      //    rewriteFollowUpQuery itself — never throws out of this
      //    function). Falls back to the original question on any
      //    failure/timeout/empty/invalid output; console.warn only.
      const { query: retrievalQuery } = await rewriteFollowUpQuery({
        question, summary: budgeted.summary, recentMessages: budgeted.recentMessages,
        generationProvider, signal,
      });

      // 3. `question` stays the ORIGINAL question. conversationContext (the
      //    trimmed summary+recentMessages view) is threaded through as its
      //    own argument, never folded into question. `core` is the SAME
      //    createAskCore() instance v1's coordinator wraps in its own gate
      //    — called directly here (never through v1's gated ask()), so
      //    this is a plain function call, not a second gate acquisition.
      //    `readiness` is the SAME object resolved once at step 1 above —
      //    code review finding (P1): core() must never re-resolve its own
      //    readiness here, since that could observe a different numCtx/
      //    model than the one history was just budgeted against (a
      //    settings change or provider restart mid-request), silently
      //    decoupling the budget decision from what evidence/generation
      //    actually run against.
      const result = await core({
        collection, question, retrievalQuery,
        conversationContext: { summary: budgeted.summary, recentMessages: budgeted.recentMessages },
        readiness, signal, onSources, onToken,
      });

      if (result.status !== 'done') return result; // provider_unavailable/refused/aborted/error pass through unchanged. ('busy' cannot occur — `core` has no gate of its own.)

      // 4. Summary compaction (best-effort, sequential, AFTER the main
      //    answer completes) — still inside THIS gate.run() callback, so
      //    still protected by the single shared lock end to end. A
      //    compaction failure/skip never turns this successful answer into
      //    an error — it only affects the trailing updatedSummary/
      //    summaryChanged fields merged onto the already-successful result.
      const compaction = await compactSummaryIfNeeded({
        conversation, question, answer: result.text, countTokens, numCtx: readiness.numCtx, generationProvider, settingsService,
      });

      return {
        ...result,
        ...(compaction.changed ? { updatedSummary: compaction.summary } : {}),
        summaryChanged: compaction.changed,
      };
    });
    return outcome.ok ? outcome.value : { status: 'busy' };
  }

  return { ask, isBusy: gate.isBusy };
}

/**
 * The RECOMMENDED way to construct a full v1+v2 Ask coordinator bundle
 * sharing one SingleFlightGate and one createAskCore() instance. Builds
 * `core` and `gate` internally, ONCE, and returns them already wired into
 * both coordinators — there is no parameter through which a caller could
 * pass a mismatched gate/core pairing, because the caller never constructs
 * gate/core themselves in this path at all.
 *
 * Default production construction and this recommended DI path cannot
 * produce a mismatched gate/core pair; a caller supplying its own raw,
 * hand-assembled bundle (register-neutral-routes.js's `askCoordinators`
 * override) remains responsible for wiring it correctly themselves —
 * ideally by calling this same factory, rather than hand-assembling
 * `{gate, core, v1, v2}` piece by piece.
 *
 * @param {{
 *   adapter, embedQuery, countTokens, generationProvider, settingsService, cloudEmbed,
 * }} deps — the same dependency set createAskCoordinator()/createAskCore()
 *   already take; this factory is a thin composition over them, not a new
 *   dependency surface.
 * @returns {{
 *   v1: ReturnType<typeof createAskCoordinator>,
 *   v2: ReturnType<typeof createAskCoordinatorV2>,
 *   gate: ReturnType<typeof createSingleFlightGate>,
 * }}
 */
export function createAskCoordinatorBundle({ adapter, embedQuery, countTokens, generationProvider, settingsService, cloudEmbed }) {
  const gate = createSingleFlightGate();
  const core = createAskCore({ adapter, embedQuery, countTokens, generationProvider, settingsService, cloudEmbed });
  const v1 = createAskCoordinator({ gate, core });
  const v2 = createAskCoordinatorV2({ gate, core, generationProvider, countTokens, settingsService });
  return { v1, v2, gate };
}
