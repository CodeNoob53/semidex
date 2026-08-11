// Conversation history trimming / token budgeting (Ask v2) — pure,
// injectable, no I/O beyond the countTokens/settingsService callbacks it is
// given. This is the ONE module that owns the "how much history fits"
// algorithm; both the answer path (coordinator-v2.js) and the compaction
// path (summary-compaction.js) call it with different `purpose` values
// rather than each re-implementing their own trimming logic.
//
// `question` is passed in ONLY so the degenerate-context-window error case
// (step 8 below) can be detected — it is NEVER rendered into the returned
// {summary, recentMessages} view, and this module never itself constructs
// an "augmented question." That responsibility belongs entirely to
// prompt.js's buildConversationBlock()/buildPromptParts() — conversation
// history is threaded as its own object, never folded into `question`.
import { RESERVED_HEADROOM_TOKENS } from './prompt.js';
import { MIN_EVIDENCE_RESERVATION_TOKENS } from './evidence.js';

const DEFAULT_MAX_MESSAGES = 20;
const DEFAULT_MAX_CHARS = 12000;
const DEFAULT_MAX_TOKENS = 2000;

function resolveHistoryCaps(settingsService) {
  if (!settingsService) {
    return { maxMessages: DEFAULT_MAX_MESSAGES, maxChars: DEFAULT_MAX_CHARS, maxTokens: DEFAULT_MAX_TOKENS };
  }
  return {
    maxMessages: settingsService.getActiveValue('ASK_HISTORY_MAX_MESSAGES'),
    maxChars: settingsService.getActiveValue('ASK_HISTORY_MAX_CHARS'),
    maxTokens: settingsService.getActiveValue('ASK_HISTORY_MAX_TOKENS'),
  };
}

async function truncateSummaryToBudget(summary, tokenBudget, countTokens) {
  // Char-safe binary search, mirroring evidence.js's own truncateToBudget()
  // — guarantees the returned prefix's real token count is <= tokenBudget,
  // never overshoots from a naive ratio-based char slice.
  if (tokenBudget <= 0) return '';
  let lo = 0;
  let hi = summary.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const prefix = summary.slice(0, mid);
    const prefixCount = await countTokens(prefix);
    if (prefixCount <= tokenBudget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return summary.slice(0, lo);
}

/**
 * @param {{
 *   conversation?: { id?: string, summary?: string, recentMessages?: Array<{role,content}> },
 *   question: string,       // '' for purpose:'compaction' — see below
 *   countTokens: (text: string) => number | Promise<number>,
 *   numCtx: number, // from generationProvider.ready().numCtx — the ACTUAL
 *     provider-honored context size, never a client-supplied value (there
 *     is no client-supplied numCtx anywhere in the v2 wire contract). For
 *     purpose:'compaction', the caller (summary-compaction.js) passes a
 *     SYNTHETIC numCtx derived from its own remaining budget after
 *     accounting for its own fixed overhead/current-turn cost — see that
 *     module's own header comment for the exact derivation.
 *   settingsService?: ReturnType<typeof createSettingsService>,
 *   purpose?: 'answer' | 'compaction', // default 'answer'
 * }} args
 * @returns {Promise<
 *   | { error: 'context_budget_exceeded', message: string }
 *   | {
 *       summary?: string,
 *       recentMessages: Array<{role,content}>,   // trimmed, newest-in, oldest-dropped
 *       droppedMessageCount: number,               // for observability/logging only, not client-visible
 *     }
 * >}
 *   No longer returns a separate history-token reservation figure (code
 *   review finding, P1) — the caller (coordinator-v2.js) threads the
 *   returned {summary, recentMessages} straight into conversationContext,
 *   and fitEvidenceToContextBudget() (evidence.js) counts that rendered
 *   text directly against numCtx - RESERVED_HEADROOM_TOKENS; there is no
 *   separate reservation left to report or subtract, since subtracting one
 *   on top of the real rendered count would double-count history.
 */
export async function budgetConversationContext({ conversation, question, countTokens, numCtx, settingsService, purpose = 'answer' }) {
  const { maxMessages, maxChars, maxTokens } = resolveHistoryCaps(settingsService);

  // Step 2-4: resolve availableForHistory / historyTokenCap.
  const availableForHistory = purpose === 'compaction'
    ? Math.max(0, numCtx - RESERVED_HEADROOM_TOKENS)
    : Math.max(0, numCtx - RESERVED_HEADROOM_TOKENS - MIN_EVIDENCE_RESERVATION_TOKENS);
  let historyTokenCap = Math.min(maxTokens, availableForHistory);

  // Step 8: the one genuinely-degenerate error case — numCtx, after
  // subtracting RESERVED_HEADROOM_TOKENS (and, for purpose:'answer',
  // MIN_EVIDENCE_RESERVATION_TOKENS), is not even large enough to hold the
  // bare original question text. purpose:'compaction' never returns this
  // error — a failed/oversized compaction must degrade to "continue
  // without an updated summary," never fail the request; the caller
  // (summary-compaction.js) treats a degenerate outcome as "skip
  // compaction this turn."
  if (purpose === 'answer') {
    const questionTokens = await countTokens(question ?? '');
    if (availableForHistory < questionTokens) {
      return { error: 'context_budget_exceeded', message: 'The model context window is too small to answer this question at all, independent of any conversation history.' };
    }
  }

  const conv = conversation ?? {};
  let summary = conv.summary ?? undefined;
  const rawMessages = Array.isArray(conv.recentMessages) ? conv.recentMessages : [];

  // Step 7: summary is included in full but counted against a separate
  // reservation carved out of the MESSAGE-WALK budget before the walk
  // starts; hard-truncate (never fail) if it alone exceeds historyTokenCap.
  let messageWalkBudget = historyTokenCap;
  if (summary) {
    const summaryTokens = await countTokens(summary);
    if (summaryTokens > historyTokenCap) {
      summary = await truncateSummaryToBudget(summary, historyTokenCap, countTokens);
      messageWalkBudget = 0;
    } else {
      messageWalkBudget = historyTokenCap - summaryTokens;
    }
  }

  // Step 5-6: newest-first greedy walk under THREE independent, simultaneously-
  // enforced caps (count/chars/tokens). Stops (does not skip-and-continue) at
  // the first older message that would violate ANY cap — contiguous newest-N
  // retained, never a sparse/gapped selection. A message that doesn't fit its
  // own individual token limit in isolation (already char-capped at parse
  // time by request.js's PROTOCOL_MAX_MESSAGE_CHARS) is excluded, not a
  // request-failing error — the walk simply STOPS there (break, not
  // continue): everything kept is always a contiguous newest-N suffix of
  // the original array, never a sparse/gapped selection.
  const kept = [];
  let runningChars = 0;
  let runningTokens = 0;
  let droppedMessageCount = 0;

  for (let i = rawMessages.length - 1; i >= 0; i -= 1) {
    const message = rawMessages[i];
    const content = message?.content ?? '';
    if (kept.length >= maxMessages) { droppedMessageCount = i + 1; break; }
    if (runningChars + content.length > maxChars) { droppedMessageCount = i + 1; break; }
    const messageTokens = await countTokens(content);
    if (runningTokens + messageTokens > messageWalkBudget) { droppedMessageCount = i + 1; break; }
    kept.unshift(message);
    runningChars += content.length;
    runningTokens += messageTokens;
  }

  return {
    ...(summary !== undefined ? { summary } : {}),
    recentMessages: kept,
    droppedMessageCount,
  };
}
