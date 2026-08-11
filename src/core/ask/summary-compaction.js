// Bounded summary compaction (Ask v2) — best-effort refresh of a
// conversation's rolling summary, attempted only when the caller-supplied
// history exceeds a configurable threshold. Never fails the request: any
// trigger-skip, budget-exceeded-skip, timeout, or generation failure
// degrades to { changed: false }, logged via console.warn() only. A
// compaction problem must never turn a successful answer into an error
// response — this module's own try/catch boundary (and every early
// `return { changed: false }`) is entirely internal; no exception ever
// crosses this module's own function boundary.
//
// Model input is built from a WHOLE-PROMPT token budget, computed in a
// fixed order: (1) fixed system-prompt overhead, (2) the just-completed
// current turn (question + answer — the highest-priority, least-negotiable
// content, since it's what triggered compaction being worth doing at all),
// with a deterministic char-safe truncation of `answer` if it doesn't fit
// on its own; (3) ONLY THEN is the remainder handed to
// budgetConversationContext({..., purpose:'compaction'}) for history — the
// SAME trimming algorithm the answer path uses, never a second,
// independently-implemented one, just fed a synthetic numCtx derived from
// the real remainder. Finally, (4) the actual SERIALIZED prompt (built via
// buildCompactionPrompt(), the same renderer that will be sent — never a
// hand-summed estimate) is measured with one real countTokens() call and,
// if formatting overhead pushed it over budget, deterministically shrunk
// (history first, then summary, then a hard skip) until the COMBINED
// systemPrompt + prompt tokens genuinely fit
// numCtx - RESERVED_HEADROOM_TOKENS — the real invariant the provider call
// itself must satisfy, not an estimate reconstructed from raw fragments.
import { RESERVED_HEADROOM_TOKENS } from './prompt.js';
import { budgetConversationContext } from './conversation-context.js';
import { sanitiseErrorMessage } from '../../shared/core/doctor-checks.js';

const DEFAULT_THRESHOLD = 8;
const DEFAULT_TIMEOUT_MS = 6000;
const ANSWER_COMPACTION_INPUT_CAP_CHARS = 4000;
const SUMMARY_OUTPUT_CAP_CHARS = 4000;

export const SUMMARY_COMPACTION_SYSTEM_PROMPT = [
  'You maintain a bounded rolling summary of an ongoing conversation between',
  'a user and an assistant answering questions from a document collection.',
  'Produce a concise summary that:',
  '- Preserves unresolved questions, relevant entities, user constraints, and established conversation state.',
  '- Does NOT present prior assistant answers as verified collection facts — they are conversation history, not retrieved evidence.',
  '- Replaces the previous summary entirely; do not append to it.',
  '- Stays bounded and concise — this is a rolling summary, not a transcript.',
].join('\n');

function resolveThreshold(settingsService) {
  return settingsService ? settingsService.getActiveValue('ASK_SUMMARY_COMPACTION_THRESHOLD') : DEFAULT_THRESHOLD;
}

function resolveTimeoutMs(settingsService) {
  return settingsService ? settingsService.getActiveValue('ASK_SUMMARY_COMPACTION_TIMEOUT_MS') : DEFAULT_TIMEOUT_MS;
}

function truncateChars(text, maxChars) {
  if ((text ?? '').length <= maxChars) return text ?? '';
  // Char-safe, not mid-word where avoidable.
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  return lastSpace > maxChars * 0.5 ? slice.slice(0, lastSpace) : slice;
}

function formatHistoryMessages(messages) {
  return (messages ?? []).map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n');
}

/**
 * Renders the LITERAL compaction prompt — the same text that will actually
 * be sent as `prompt` to generationProvider.generate(). This is the ONE
 * renderer used both for the real call and for every token-count
 * verification in this module, so a verification pass can never silently
 * drift from what's actually sent.
 *
 * @param {{ priorSummary?: string, recentMessages?: Array<{role,content}>, question: string, answer: string }} args
 * @returns {string}
 */
export function buildCompactionPrompt({ priorSummary, recentMessages, question, answer }) {
  const lines = [];
  if (priorSummary) {
    lines.push('Prior summary:', priorSummary, '');
  }
  if (recentMessages && recentMessages.length > 0) {
    lines.push('Conversation so far:', formatHistoryMessages(recentMessages), '');
  }
  lines.push('Current turn:', `Question: ${question}`, `Answer: ${answer}`);
  return lines.join('\n');
}

/**
 * @param {{
 *   conversation?: { id, summary?, recentMessages? },  // RAW, as received —
 *     used only for the trigger-threshold check, NEVER passed directly to
 *     generationProvider.generate().
 *   question: string, answer: string,
 *   countTokens: (text: string) => number | Promise<number>,
 *   numCtx: number,  // same generationProvider.ready().numCtx already
 *     resolved once in coordinator-v2.js — reused, not re-fetched.
 *   generationProvider, settingsService, timeoutMs?: number,
 * }} args
 * @returns {Promise<{ changed: boolean, summary?: string }>}
 *   Never throws. changed:false (no `summary` key) on: no conversation.id
 *   present, threshold not exceeded, the current turn alone doesn't fit,
 *   or ANY failure/timeout — each logged via console.warn() (only for the
 *   failure/doesn't-fit cases, not the "not needed" case, which is normal
 *   operation, not a warning-worthy event).
 */
export async function compactSummaryIfNeeded({ conversation, question, answer, countTokens, numCtx, generationProvider, settingsService, timeoutMs }) {
  if (!conversation || !conversation.id) {
    return { changed: false };
  }

  const threshold = resolveThreshold(settingsService);
  const rawCount = (conversation.recentMessages?.length ?? 0) + 2; // +2 for the just-completed user+assistant turn
  if (rawCount < threshold) {
    return { changed: false };
  }

  // Step 1 — fixed, structural overhead.
  const systemPromptTokens = await countTokens(SUMMARY_COMPACTION_SYSTEM_PROMPT);
  const availableAfterOverhead = Math.max(0, numCtx - RESERVED_HEADROOM_TOKENS - systemPromptTokens);

  // Step 2 — the current turn, budgeted BEFORE history.
  let effectiveAnswer = answer ?? '';
  let questionTokens = await countTokens(question ?? '');
  let answerTokens = await countTokens(effectiveAnswer);
  let currentTurnTokens = questionTokens + answerTokens;

  // Step 3 — if the current turn alone doesn't fit, try deterministic
  // truncation of the answer first; if it still doesn't fit, skip
  // compaction entirely rather than fail the request.
  if (currentTurnTokens > availableAfterOverhead) {
    effectiveAnswer = truncateChars(effectiveAnswer, ANSWER_COMPACTION_INPUT_CAP_CHARS);
    answerTokens = await countTokens(effectiveAnswer);
    currentTurnTokens = questionTokens + answerTokens;
  }
  if (currentTurnTokens > availableAfterOverhead) {
    console.warn(`[ask-v2] summary compaction skipped for conversation ${conversation.id}: current turn does not fit the model's context window`);
    return { changed: false };
  }

  // Step 4 — ONLY NOW is the remainder handed to history, via the SAME
  // shared trimming algorithm the answer path uses (conversation-context.js),
  // fed a synthetic numCtx chosen so that module's own
  // `numCtx - RESERVED_HEADROOM_TOKENS` subtraction reproduces
  // historyBudgetTokens exactly.
  const historyBudgetTokens = availableAfterOverhead - currentTurnTokens;
  const compactionView = await budgetConversationContext({
    conversation, question: '', countTokens,
    numCtx: historyBudgetTokens + RESERVED_HEADROOM_TOKENS,
    settingsService, purpose: 'compaction',
  });
  if (compactionView.error) {
    console.warn(`[ask-v2] summary compaction skipped for conversation ${conversation.id}: no room left for history after the current turn`);
    return { changed: false };
  }

  // Step 5 — final serialized-prompt verification, correctly including
  // the system prompt in the ceiling this compares against. Render the
  // REAL prompt via buildCompactionPrompt() (never a hand-summed
  // estimate), then verify with one countTokens() call, and
  // deterministically shrink on overflow — the invariant this section
  // guarantees is systemPromptTokens + modelInputTokens <=
  // numCtx - RESERVED_HEADROOM_TOKENS, matching what generate() actually
  // receives via generate({ systemPrompt, prompt }).
  let modelInput = buildCompactionPrompt({
    priorSummary: compactionView.summary, recentMessages: compactionView.recentMessages,
    question, answer: effectiveAnswer,
  });
  let modelInputTokens = await countTokens(modelInput);
  const modelInputBudget = numCtx - RESERVED_HEADROOM_TOKENS - systemPromptTokens;

  let shrinkableHistory = [...(compactionView.recentMessages ?? [])];
  while (modelInputTokens > modelInputBudget && shrinkableHistory.length > 0) {
    shrinkableHistory = shrinkableHistory.slice(1); // drop oldest first
    modelInput = buildCompactionPrompt({
      priorSummary: compactionView.summary, recentMessages: shrinkableHistory, question, answer: effectiveAnswer,
    });
    modelInputTokens = await countTokens(modelInput);
  }

  if (modelInputTokens > modelInputBudget) {
    modelInput = buildCompactionPrompt({ priorSummary: undefined, recentMessages: [], question, answer: effectiveAnswer });
    modelInputTokens = await countTokens(modelInput);
  }

  if (modelInputTokens > modelInputBudget) {
    console.warn(`[ask-v2] summary compaction skipped for conversation ${conversation.id}: serialized prompt exceeds the model's context window even with no history or summary retained`);
    return { changed: false };
  }

  // Timeout/failure handling — own internal AbortController, separate from
  // any caller signal (compaction runs after the main answer has already
  // completed; it is never itself abortable by the client's own request
  // signal, which by this point may already be in a settled state).
  const resolvedTimeoutMs = timeoutMs ?? resolveTimeoutMs(settingsService);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolvedTimeoutMs);

  try {
    const result = await generationProvider.generate({
      systemPrompt: SUMMARY_COMPACTION_SYSTEM_PROMPT,
      prompt: modelInput,
      signal: controller.signal,
    });
    const rawSummary = (result?.text ?? '').trim();
    if (rawSummary === '') {
      return { changed: false };
    }
    return { changed: true, summary: truncateChars(rawSummary, SUMMARY_OUTPUT_CAP_CHARS) };
  } catch (err) {
    const reason = sanitiseErrorMessage(err?.message ?? String(err), [process.env.QDRANT_KEY, process.env.GEMINI_API_KEY]);
    console.warn(`[ask-v2] summary compaction failed for conversation ${conversation.id}: ${reason}`);
    return { changed: false };
  } finally {
    clearTimeout(timer);
  }
}
