// Ask API v2 — stateless-Semidex demo conversation manager.
//
// *** DEMONSTRATION ONLY — NOT PRODUCTION PERSISTENCE ***
// This module stores conversation state in a plain in-process `Map`. That
// state is lost on every restart, is not shared across multiple server
// instances/replicas, and has no durability, backup, or access-control
// story whatsoever. A real backend integrating Semidex Lite MUST replace
// this with its own persistence (PostgreSQL, SQLite, Redis, MongoDB, or
// whatever store it already operates) — see the "ConversationStore" port
// sketched in docs/design/ask-v2-conversational-context.md for the shape a
// future durable implementation is designed to fit.
//
// Ownership boundary this example exists to demonstrate:
// - Semidex Lite (via POST /api/v2/ask) owns: retrieval, evidence
//   assembly, prompt construction, generation, citation validation, and
//   OPTIONALLY computing an updated rolling summary when asked — but never
//   remembers anything between HTTP requests.
// - THIS example (standing in for "your backend") owns: user accounts,
//   which conversation belongs to which user, the conversationId itself,
//   the full message history, WHEN to prune/summarize old messages, and
//   all access control. Semidex never sees or enforces any of that.
//
// Archive vs. request view (code review finding): a conversation's
// SOURCE-OF-TRUTH history (`archive`, below) is append-only and never
// pruned on speculation. The bounded array actually SENT to Semidex each
// turn is a derived VIEW — `archive.slice(summarizedThroughArchiveIndex)`
// — and `summarizedThroughArchiveIndex` only ever advances when Semidex
// itself confirms real coverage via `summaryChanged:true` +
// `compactedMessageCount`. If compaction never succeeds (provider down,
// generation failures, whatever), the archive keeps growing and the
// request view keeps growing right along with it — this module does NOT
// silently truncate the view to squeeze under the wire protocol's size
// ceiling. Instead, once the view would EXCEED that ceiling (a view of
// exactly the ceiling is still a legal request — see `ask()`'s own guard
// comment for why that boundary matters), `ask()` refuses to send the
// request at all and returns an explicit `client_bounded_context_exceeded`
// error — never a request that either gets rejected by the server with a
// generic `invalid_conversation`, or "succeeds" only because history was
// quietly thrown away first. Once that error fires, an ordinary retry
// cannot recover on its own (see the error's own message) — no request
// ever reaches Semidex again for this conversation until it is reset or
// manually repaired.
import { randomUUID } from 'node:crypto';
import { askV2 } from './ask-v2-sse-client.mjs';

// Mirrors src/core/ask-api/v2/request.js's own PROTOCOL_MAX_RECENT_MESSAGES
// — a FIXED, non-configurable wire-protocol ceiling on
// conversation.recentMessages.length, enforced server-side regardless of
// what any caller sends. This example has no import path into Semidex's
// own src/ tree (packages/lite/examples/ is meant to run standalone, the
// same way a real external integrator would use it, with no access to
// Semidex's internals beyond the public HTTP contract) — so the same
// literal is duplicated here, deliberately, as the client-side half of the
// SAME protocol boundary, not an independently-chosen local policy.
const PROTOCOL_MAX_RECENT_MESSAGES = 200;

/**
 * @param {{}} [opts]  // no size-based pruning knob — see the module header for why
 */
export function createConversationManager() {
  /**
   * @type {Map<string, {
   *   summary: string|undefined,
   *   archive: Array<{role:'user'|'assistant', content:string}>,   // append-only, NEVER pruned by this module
   *   summarizedThroughArchiveIndex: number,                        // server-confirmed coverage boundary into `archive`
   * }>}
   */
  const conversations = new Map();

  function getOrCreate(conversationId) {
    const id = conversationId ?? randomUUID();
    if (!conversations.has(id)) {
      conversations.set(id, { summary: undefined, archive: [], summarizedThroughArchiveIndex: 0 });
    }
    return { id, state: conversations.get(id) };
  }

  /**
   * The bounded VIEW of `archive` this turn would send to Semidex — the
   * unsummarized suffix only, never the whole archive once compaction has
   * confirmed coverage of some prefix.
   */
  function requestView(state) {
    return state.archive.slice(state.summarizedThroughArchiveIndex);
  }

  /**
   * @param {{
   *   baseUrl: string,
   *   collection: string,
   *   conversationId?: string,       // omit to start a new conversation
   *   question: string,
   *   timeoutMs?: number,
   *   signal?: AbortSignal,
   * }} args
   * @returns {Promise<{
   *   conversationId: string,
   *   ok: boolean,
   *   answer: string,
   *   sources: Array<Object>,
   *   citations: number[],
   *   refused: boolean,
   *   error: { code: string, message: string, retryable: boolean }|null,
   *   summaryChanged: boolean,
   * }>}
   */
  async function ask({ baseUrl, collection, conversationId, question, timeoutMs, signal }) {
    const { id, state } = getOrCreate(conversationId);
    const view = requestView(state);

    // Bounded-context guard (code review finding): if the view we are ABOUT
    // TO SEND already EXCEEDS the wire protocol's hard ceiling, sending it
    // would either be rejected outright by the server (`invalid_conversation`)
    // or — worse, if some other client silently truncated first — would
    // quietly drop real conversation history the user never asked to lose.
    // Detect this BEFORE sending and fail explicitly instead. This is the
    // direct, deterministic consequence of "compaction has not succeeded in
    // a long time" (provider down, repeated generation failures, etc.) —
    // the archive and its unsummarized view keep growing every turn that
    // doesn't successfully compact, and eventually the view crosses the
    // ceiling.
    //
    // Strictly `>`, not `>=` (code review finding): a view of EXACTLY
    // PROTOCOL_MAX_RECENT_MESSAGES is still valid under the server's own
    // wire contract (request.js rejects only `> PROTOCOL_MAX_RECENT_MESSAGES`)
    // — refusing to send it locally would be MORE restrictive than the
    // protocol itself, and would throw away the conversation's last real
    // chance at a request that both answers the question AND gives
    // compaction one more opportunity to confirm coverage and shrink the
    // view back down. Only once a turn has already gone out at exactly the
    // ceiling AND still failed to compact (so the view is now ceiling+1 or
    // more) is there no longer any legal request left to send.
    if (view.length > PROTOCOL_MAX_RECENT_MESSAGES) {
      return {
        conversationId: id, ok: false, answer: '', sources: [], citations: [],
        refused: false,
        error: {
          code: 'client_bounded_context_exceeded',
          // Deliberately does NOT suggest "retry" as a fix on its own —
          // once the view is already over the ceiling, an ordinary retry
          // sends the exact same oversized view and short-circuits locally
          // again every time; no request ever reaches Semidex, so a
          // provider recovering has no way to help. The only ways out from
          // THIS state are starting a fresh conversation (resets the view
          // to empty) or a manual/future recovery path that trims or
          // re-derives the archive out of band (not implemented by this
          // demo) — retryable:true reflects only that the ERROR ITSELF
          // isn't a permanent client bug, not that retrying this call
          // achieves anything by itself.
          message: `This conversation has ${view.length} unsummarized messages, over the wire protocol's limit of ${PROTOCOL_MAX_RECENT_MESSAGES}. The request was not sent, and it cannot be sent as-is — Semidex will never see it, so an ordinary retry (even after the generation provider recovers) cannot fix this: compaction had its last opportunity to confirm coverage before the view crossed the limit and did not take it. Start a new conversation, or use a manual/future compaction-recovery mechanism to reduce this conversation's unsummarized history out of band.`,
          retryable: true,
        },
        summaryChanged: false,
      };
    }

    // First turn: `conversation` is omitted entirely from the wire request
    // when there's neither a summary nor any history yet — matching the
    // v2 contract's own "conversation is optional" first-turn shape,
    // rather than sending an empty-but-present object.
    const hasContext = Boolean(state.summary) || view.length > 0;
    const result = await askV2({
      baseUrl, collection, question, timeoutMs, signal,
      ...(hasContext ? { conversation: { id, summary: state.summary, recentMessages: view } } : {}),
    });

    if (!result.ok) {
      // A failed turn is NOT appended to the archive — the user's question
      // was never actually answered, so recording a phantom exchange would
      // corrupt the next turn's own context. The caller can retry the same
      // question against the same conversationId. Note this is exactly why
      // repeated compaction failures can still grow the view unboundedly
      // even though failed ANSWER turns are never appended: compaction is
      // attempted only on already-successful answers (see coordinator-v2.js),
      // so a string of turns that each answer successfully but never
      // manage to compact still grows `archive` by 2 messages every time.
      return {
        conversationId: id, ok: false, answer: '', sources: [], citations: [],
        refused: false, error: result.error, summaryChanged: false,
      };
    }

    // If Semidex recomputed the summary this turn, `compactedMessageCount`
    // tells us exactly how many of the OLDEST messages in the VIEW we just
    // sent are now folded into `updatedSummary`. Advance
    // summarizedThroughArchiveIndex by exactly that many — never more
    // (which would lose context the summary never saw) and never less
    // (which would duplicate context the summary already covers). The
    // archive itself is NEVER sliced/truncated here — only the boundary
    // index moves; every message the user or assistant ever sent remains
    // physically present in `archive` for as long as this process runs,
    // even after it's been folded into a summary (a real backend with
    // durable storage would keep the same archive table indefinitely for
    // its own audit/analytics purposes, only ever narrowing what it SENDS).
    if (result.summaryChanged && result.updatedSummary) {
      state.summary = result.updatedSummary;
      const coveredInView = Math.max(0, Math.min(result.compactedMessageCount ?? 0, view.length));
      state.summarizedThroughArchiveIndex += coveredInView;
    }

    // Append the completed turn to the archive — always, unconditionally,
    // regardless of whether compaction happened this turn. This is the
    // ONLY mutation `archive` ever undergoes: append-only, never spliced,
    // never truncated by anything other than the server-confirmed
    // boundary advance above.
    state.archive.push(
      { role: 'user', content: question },
      { role: 'assistant', content: result.answer },
    );

    return {
      conversationId: id,
      ok: true,
      answer: result.answer,
      sources: result.sources,
      citations: result.done?.citations ?? [],
      refused: Boolean(result.done?.refused),
      error: null,
      summaryChanged: result.summaryChanged,
    };
  }

  /**
   * For tests/inspection only — never exposed over any network boundary.
   * Returns the FULL archive (not the bounded request view) plus the
   * current summary boundary, so a caller can assert on both what is
   * retained forever and what would actually be sent next.
   */
  function _debugGetState(conversationId) {
    const entry = conversations.get(conversationId);
    if (!entry) return undefined;
    return {
      summary: entry.summary,
      archive: [...entry.archive],
      summarizedThroughArchiveIndex: entry.summarizedThroughArchiveIndex,
      recentMessages: requestView(entry), // the bounded view, for convenience/back-compat with earlier test shape
    };
  }

  function _debugConversationCount() {
    return conversations.size;
  }

  return { ask, _debugGetState, _debugConversationCount };
}
