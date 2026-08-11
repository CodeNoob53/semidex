import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { budgetConversationContext } from '../../../../src/core/ask/conversation-context.js';
import { RESERVED_HEADROOM_TOKENS } from '../../../../src/core/ask/prompt.js';
import { MIN_EVIDENCE_RESERVATION_TOKENS } from '../../../../src/core/ask/evidence.js';

const countTokens = (text) => (text ?? '').split(/\s+/).filter(Boolean).length;

function words(n, prefix = 'w') {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
}

function messages(n) {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `msg${i} ${words(5)}`,
  }));
}

describe('budgetConversationContext', () => {
  test('deterministic history trimming — newest complete messages kept, oldest dropped, relative order preserved', async () => {
    const msgs = messages(10); // indices 0..9, newest is index 9
    const result = await budgetConversationContext({
      conversation: { id: 'c', recentMessages: msgs },
      question: 'q',
      countTokens,
      numCtx: RESERVED_HEADROOM_TOKENS + MIN_EVIDENCE_RESERVATION_TOKENS + 40, // small history budget
    });
    assert.ok(result.recentMessages.length > 0);
    assert.ok(result.recentMessages.length < msgs.length, 'expected some messages to be trimmed');
    // Kept messages must be a contiguous newest-N suffix, in original order.
    const keptContents = result.recentMessages.map(m => m.content);
    const expectedSuffix = msgs.slice(msgs.length - result.recentMessages.length).map(m => m.content);
    assert.deepEqual(keptContents, expectedSuffix);
  });

  test('never cuts a message mid-way — trimming always drops whole messages, never truncates a kept message content', async () => {
    const msgs = messages(10);
    const result = await budgetConversationContext({
      conversation: { id: 'c', recentMessages: msgs },
      question: 'q',
      countTokens,
      numCtx: RESERVED_HEADROOM_TOKENS + MIN_EVIDENCE_RESERVATION_TOKENS + 40,
    });
    for (const kept of result.recentMessages) {
      const original = msgs.find(m => m.content === kept.content);
      assert.ok(original, 'every kept message must be byte-identical to an original message, never a truncated fragment');
    }
  });

  test('independent enforcement of the three caps — maxMessages alone determines the trim point', async () => {
    const msgs = messages(5);
    // settingsService stub: tiny maxMessages, generous chars/tokens
    const settingsService = {
      getActiveValue: (key) => ({
        ASK_HISTORY_MAX_MESSAGES: 2,
        ASK_HISTORY_MAX_CHARS: 1_000_000,
        ASK_HISTORY_MAX_TOKENS: 1_000_000,
      })[key],
    };
    const result = await budgetConversationContext({
      conversation: { id: 'c', recentMessages: msgs },
      question: 'q', countTokens, numCtx: 100_000, settingsService,
    });
    assert.equal(result.recentMessages.length, 2);
  });

  test('independent enforcement of the three caps — maxChars alone determines the trim point', async () => {
    const msgs = [
      { role: 'user', content: 'a'.repeat(50) },
      { role: 'assistant', content: 'b'.repeat(50) },
      { role: 'user', content: 'c'.repeat(50) },
    ];
    const settingsService = {
      getActiveValue: (key) => ({
        ASK_HISTORY_MAX_MESSAGES: 1_000_000,
        ASK_HISTORY_MAX_CHARS: 60, // fits only the newest message (50 chars)
        ASK_HISTORY_MAX_TOKENS: 1_000_000,
      })[key],
    };
    const result = await budgetConversationContext({
      conversation: { id: 'c', recentMessages: msgs },
      question: 'q', countTokens, numCtx: 100_000, settingsService,
    });
    assert.equal(result.recentMessages.length, 1);
    assert.equal(result.recentMessages[0].content, 'c'.repeat(50));
  });

  test('independent enforcement of the three caps — maxTokens alone determines the trim point', async () => {
    const msgs = [
      { role: 'user', content: words(20) },
      { role: 'assistant', content: words(20) },
      { role: 'user', content: words(5) },
    ];
    const settingsService = {
      getActiveValue: (key) => ({
        ASK_HISTORY_MAX_MESSAGES: 1_000_000,
        ASK_HISTORY_MAX_CHARS: 1_000_000,
        ASK_HISTORY_MAX_TOKENS: 6, // fits only the newest message (5 tokens)
      })[key],
    };
    const result = await budgetConversationContext({
      conversation: { id: 'c', recentMessages: msgs },
      question: 'q', countTokens, numCtx: 100_000, settingsService,
    });
    assert.equal(result.recentMessages.length, 1);
    assert.equal(result.recentMessages[0].content, words(5));
  });

  test('history-reduction-before-evidence-reduction ordering — the RETURNED history\'s own real token cost never exceeds numCtx - RESERVED_HEADROOM_TOKENS - MIN_EVIDENCE_RESERVATION_TOKENS tokens for purpose:answer', async () => {
    // No longer asserted via a separate historyPromptBudgetTokens field
    // (removed — code review finding, P1: that field was a SEPARATE
    // reservation amount that fitEvidenceToContextBudget() used to
    // subtract on TOP OF the real rendered history text it already
    // counted, double-charging history). The real invariant this test
    // protects — history can never consume more than the answer path's
    // own reserved ceiling — is now verified directly against the actual
    // returned {summary, recentMessages}' own token cost.
    const msgs = messages(50);
    const numCtx = RESERVED_HEADROOM_TOKENS + MIN_EVIDENCE_RESERVATION_TOKENS + 500;
    const result = await budgetConversationContext({
      conversation: { id: 'c', recentMessages: msgs },
      question: 'q', countTokens, numCtx,
    });
    let actualHistoryTokens = 0;
    if (result.summary) actualHistoryTokens += countTokens(result.summary);
    for (const m of result.recentMessages) actualHistoryTokens += countTokens(m.content);
    assert.ok(actualHistoryTokens <= numCtx - RESERVED_HEADROOM_TOKENS - MIN_EVIDENCE_RESERVATION_TOKENS);
  });

  test('does not trust client-provided token counts — always calls the injected countTokens on real message content', async () => {
    const calls = [];
    const spyCountTokens = (text) => { calls.push(text); return countTokens(text); };
    const msgs = messages(3);
    await budgetConversationContext({
      conversation: { id: 'c', recentMessages: msgs }, question: 'q', countTokens: spyCountTokens, numCtx: 4096,
    });
    for (const m of msgs) {
      assert.ok(calls.includes(m.content), `expected countTokens to be called on real message content: ${m.content}`);
    }
  });

  test('CONTEXT_BUDGET_EXCEEDED typed error case — pathological numCtx, purpose:answer only', async () => {
    const result = await budgetConversationContext({
      conversation: {}, question: words(50), countTokens, numCtx: 10,
    });
    assert.equal(result.error, 'context_budget_exceeded');
    assert.equal(typeof result.message, 'string');
    assert.ok(result.message.length > 0);
    // Never leaks secret-shaped content.
    assert.ok(!/key|token|password/i.test(result.message) || /token window/i.test(result.message) === false);
  });

  test('purpose:compaction — no MIN_EVIDENCE_RESERVATION_TOKENS carve-out applied', async () => {
    const msgs = messages(3);
    // A numCtx that would be context_budget_exceeded-eligible under the
    // answer-path carve-out (numCtx - RESERVED_HEADROOM_TOKENS - MIN_EVIDENCE_RESERVATION_TOKENS < questionTokens)
    // but yields a normal, non-error trimmed result under purpose:compaction
    // (numCtx - RESERVED_HEADROOM_TOKENS alone is comfortably positive).
    const numCtx = RESERVED_HEADROOM_TOKENS + 50; // < RESERVED_HEADROOM_TOKENS + MIN_EVIDENCE_RESERVATION_TOKENS
    const compactionResult = await budgetConversationContext({
      conversation: { id: 'c', recentMessages: msgs }, question: '', countTokens, numCtx, purpose: 'compaction',
    });
    assert.equal(compactionResult.error, undefined);
    assert.ok(Array.isArray(compactionResult.recentMessages));
  });

  test('purpose:compaction never returns context_budget_exceeded, even for a pathologically tiny numCtx', async () => {
    const result = await budgetConversationContext({
      conversation: {}, question: '', countTokens, numCtx: 1, purpose: 'compaction',
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.recentMessages, []);
  });

  test('purpose:compaction result shape matches purpose:answer result shape (same trimming algorithm)', async () => {
    const msgs = messages(3);
    const numCtx = RESERVED_HEADROOM_TOKENS + MIN_EVIDENCE_RESERVATION_TOKENS + 200;
    const answerResult = await budgetConversationContext({
      conversation: { id: 'c', recentMessages: msgs }, question: 'q', countTokens, numCtx,
    });
    const compactionResult = await budgetConversationContext({
      conversation: { id: 'c', recentMessages: msgs }, question: '', countTokens, numCtx, purpose: 'compaction',
    });
    assert.deepEqual(Object.keys(answerResult).sort(), Object.keys(compactionResult).sort());
  });

  test('compaction-path {summary, recentMessages} is directly consumable as conversationContext, no reshaping needed at all', async () => {
    const msgs = messages(3);
    const result = await budgetConversationContext({
      conversation: { id: 'c', summary: 'a summary', recentMessages: msgs },
      question: '', countTokens, numCtx: RESERVED_HEADROOM_TOKENS + 500, purpose: 'compaction',
    });
    const conversationContext = { summary: result.summary, recentMessages: result.recentMessages };
    assert.equal(typeof conversationContext.summary, 'string');
    assert.ok(Array.isArray(conversationContext.recentMessages));
  });

  test('summary included in full when it fits, counted against a reservation carved out before the message walk', async () => {
    const summary = words(10);
    const result = await budgetConversationContext({
      conversation: { id: 'c', summary, recentMessages: [] },
      question: 'q', countTokens, numCtx: RESERVED_HEADROOM_TOKENS + MIN_EVIDENCE_RESERVATION_TOKENS + 100,
    });
    assert.equal(result.summary, summary);
  });

  test('summary alone exceeding historyTokenCap is hard-truncated, never fails the request', async () => {
    const summary = words(500);
    const settingsService = {
      getActiveValue: (key) => ({
        ASK_HISTORY_MAX_MESSAGES: 20, ASK_HISTORY_MAX_CHARS: 1_000_000, ASK_HISTORY_MAX_TOKENS: 10,
      })[key],
    };
    const result = await budgetConversationContext({
      conversation: { id: 'c', summary, recentMessages: [] },
      question: 'q', countTokens, numCtx: RESERVED_HEADROOM_TOKENS + MIN_EVIDENCE_RESERVATION_TOKENS + 1000, settingsService,
    });
    assert.equal(result.error, undefined);
    assert.ok(result.summary.length < summary.length, 'expected the summary to be truncated');
  });

  test('empty conversation (no id) still returns a valid, empty-history result — never errors', async () => {
    const result = await budgetConversationContext({
      conversation: undefined, question: 'q', countTokens, numCtx: 4096,
    });
    assert.deepEqual(result.recentMessages, []);
    assert.equal(result.error, undefined);
  });
});
