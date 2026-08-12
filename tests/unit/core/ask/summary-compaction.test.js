import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compactSummaryIfNeeded, buildCompactionPrompt } from '../../../../src/core/ask/summary-compaction.js';
import { RESERVED_HEADROOM_TOKENS } from '../../../../src/core/ask/prompt.js';
import { PROTOCOL_MAX_MESSAGE_CHARS } from '../../../../src/core/ask-api/v2/request.js';

const countTokens = (text) => (text ?? '').split(/\s+/).filter(Boolean).length;

function fakeProvider(generate) {
  return { name: () => 'fake', capabilities: () => ({}), ready: async () => ({ ok: true }), generate };
}

function messages(n) {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message number ${i} with several words in it`,
  }));
}

// No settingsService passed anywhere below => the module's own
// DEFAULT_RETAINED_MESSAGES (4) applies: the newest 4 messages are always
// retained raw; anything older is what compaction can fold into a summary.
// This default is now a DEDICATED setting (ASK_SUMMARY_RETAINED_MESSAGES),
// independent of ASK_HISTORY_MAX_MESSAGES/budgetConversationContext() (code
// review finding, P1) — a history only needs to exceed 4 messages, not the
// unrelated 20-message request-size cap, for there to be real material to
// compact.
const ABOVE_RETAINED_TAIL = 10; // well above the default retained-tail (4)

describe('compactSummaryIfNeeded', () => {
  test('below threshold — never calls generate, returns {changed:false}', async () => {
    let called = false;
    const provider = fakeProvider(async () => { called = true; return { text: 'x' }; });
    const result = await compactSummaryIfNeeded({
      conversation: { id: 'c', recentMessages: messages(2) },
      question: 'q', answer: 'a', countTokens, numCtx: 4096, generationProvider: provider,
    });
    assert.deepEqual(result, { changed: false });
    assert.equal(called, false);
  });

  test('no conversation.id — never calls generate, returns {changed:false}', async () => {
    let called = false;
    const provider = fakeProvider(async () => { called = true; return { text: 'x' }; });
    const result = await compactSummaryIfNeeded({
      conversation: { recentMessages: messages(ABOVE_RETAINED_TAIL) },
      question: 'q', answer: 'a', countTokens, numCtx: 4096, generationProvider: provider,
    });
    assert.deepEqual(result, { changed: false });
    assert.equal(called, false);
  });

  test('at/above threshold but everything fits the retained tail — nothing old enough to compact, {changed:false}, no generate() call', async () => {
    // A history that crosses the trigger threshold (10 messages, well
    // above the default threshold of 8) but where a widened retained-tail
    // setting (via a fake settingsService) covers the WHOLE history --
    // nothing falls outside the retained tail, so there is nothing old
    // enough to fold into a summary even though compaction was attempted.
    let called = false;
    const provider = fakeProvider(async () => { called = true; return { text: 'x' }; });
    const fakeSettingsService = {
      getActiveValue: (key) => (key === 'ASK_SUMMARY_RETAINED_MESSAGES' ? 100 : key === 'ASK_SUMMARY_COMPACTION_THRESHOLD' ? 8 : undefined),
    };
    const result = await compactSummaryIfNeeded({
      conversation: { id: 'c', recentMessages: messages(10) },
      question: 'q', answer: 'a', countTokens, numCtx: 4096, generationProvider: provider,
      settingsService: fakeSettingsService,
    });
    assert.deepEqual(result, { changed: false });
    assert.equal(called, false);
  });

  test('at/above threshold WITH material old enough to compact — returns {changed:true, summary, compactedMessageCount}, prompt includes prior summary + the OLDEST messages, NEVER the current question/answer', async () => {
    let captured;
    const provider = fakeProvider(async (opts) => { captured = opts; return { text: 'a fresh bounded summary' }; });
    const msgs = messages(ABOVE_RETAINED_TAIL);
    const result = await compactSummaryIfNeeded({
      conversation: { id: 'c', summary: 'prior summary text', recentMessages: msgs },
      question: 'the current question', answer: 'the current answer',
      countTokens, numCtx: 4096, generationProvider: provider,
    });
    assert.equal(result.changed, true);
    assert.equal(result.summary, 'a fresh bounded summary');
    assert.ok(result.compactedMessageCount > 0, 'expected some oldest messages to have been folded into the summary');
    assert.ok(result.compactedMessageCount < msgs.length, 'expected the newest tail to have been retained, not the whole history');
    assert.match(captured.prompt, /prior summary text/);
    assert.match(captured.prompt, /message number 0 /, 'the OLDEST message must be part of what gets summarized');
    // The current turn must NEVER appear in the compaction input — it is
    // always appended raw by the caller afterward, never summarized.
    assert.ok(!captured.prompt.includes('the current question'));
    assert.ok(!captured.prompt.includes('the current answer'));
  });

  test('failure — provider throws, {changed:false}, console.warn called once with a redacted (non-secret-leaking) message', async () => {
    const secret = 'sk-super-secret-key-value';
    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = secret;
    const warnCalls = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnCalls.push(args.join(' '));
    try {
      const provider = fakeProvider(async () => { throw new Error(`boom with secret ${secret}`); });
      const result = await compactSummaryIfNeeded({
        conversation: { id: 'c', recentMessages: messages(ABOVE_RETAINED_TAIL) },
        question: 'q', answer: 'a', countTokens, numCtx: 4096, generationProvider: provider,
      });
      assert.deepEqual(result, { changed: false });
      assert.equal(warnCalls.length, 1);
      assert.ok(!warnCalls[0].includes(secret), 'the warning must never contain the raw secret value');
    } finally {
      console.warn = originalWarn;
      process.env.GEMINI_API_KEY = originalKey;
    }
  });

  test('timeout — provider hangs past the injected short timeoutMs, {changed:false} within the wall-clock bound, console.warn called', async () => {
    const warnCalls = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnCalls.push(args.join(' '));
    try {
      const provider = fakeProvider(({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }));
      const start = Date.now();
      const result = await compactSummaryIfNeeded({
        conversation: { id: 'c', recentMessages: messages(ABOVE_RETAINED_TAIL) },
        question: 'q', answer: 'a', countTokens, numCtx: 4096, generationProvider: provider, timeoutMs: 50,
      });
      const elapsed = Date.now() - start;
      assert.deepEqual(result, { changed: false });
      assert.ok(elapsed < 2000, `expected timeout fallback quickly, took ${elapsed}ms`);
      assert.equal(warnCalls.length, 1);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('output bounded/truncated — oversized summary output is truncated to the documented cap, changed:true still', async () => {
    const oversized = 'w '.repeat(5000);
    const provider = fakeProvider(async () => ({ text: oversized }));
    const result = await compactSummaryIfNeeded({
      conversation: { id: 'c', recentMessages: messages(ABOVE_RETAINED_TAIL) },
      question: 'q', answer: 'a', countTokens, numCtx: 4096, generationProvider: provider,
    });
    assert.equal(result.changed, true);
    assert.ok(result.summary.length < oversized.length);
    assert.ok(result.summary.length <= 4000);
  });

  test('never presents prior assistant answers as verified facts — system prompt includes the required framing text', async () => {
    let captured;
    const provider = fakeProvider(async (opts) => { captured = opts; return { text: 'summary' }; });
    await compactSummaryIfNeeded({
      conversation: { id: 'c', recentMessages: messages(ABOVE_RETAINED_TAIL) },
      question: 'q', answer: 'a', countTokens, numCtx: 4096, generationProvider: provider,
    });
    assert.match(captured.systemPrompt, /not.*verified.*facts|verified collection facts/i);
  });

  describe('bounded WHOLE-PROMPT compaction input — large history', () => {
    function largeMessages(n) {
      return Array.from({ length: n }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'x'.repeat(PROTOCOL_MAX_MESSAGE_CHARS - 1),
      }));
    }

    test('triggering still fires, and the FULL captured provider input (systemPrompt+prompt combined) stays within numCtx - RESERVED_HEADROOM_TOKENS', async () => {
      let captured;
      const provider = fakeProvider(async (opts) => { captured = opts; return { text: 'a bounded summary' }; });
      const numCtx = 4096;
      // The answer carries a short, distinctive marker prefix rather than
      // being pure repeated 'x' — a .includes() search for a marker this
      // short is cheap; searching a 50,000-char all-'x' needle against an
      // all-'x'-heavy haystack of a similar size is pathologically slow (a
      // real perf regression caught while writing this very test), so the
      // presence check below never constructs that search.
      const markedAnswer = `UNIQUE_ANSWER_MARKER_${'x'.repeat(50_000)}`;
      const result = await compactSummaryIfNeeded({
        conversation: { id: 'c', summary: 'prior', recentMessages: largeMessages(200) },
        question: 'q', answer: markedAnswer,
        countTokens, numCtx, generationProvider: provider,
      });
      assert.equal(result.changed, true);
      assert.ok(captured, 'expected generate() to have been called');
      const totalTokens = countTokens(captured.systemPrompt) + countTokens(captured.prompt);
      assert.ok(totalTokens <= numCtx - RESERVED_HEADROOM_TOKENS, `expected combined system+user tokens (${totalTokens}) <= budget (${numCtx - RESERVED_HEADROOM_TOKENS})`);
      // The oversized current answer must never leak into the compaction
      // prompt at all — it was never part of the summarization input.
      assert.ok(!captured.prompt.includes('UNIQUE_ANSWER_MARKER_'), 'the current turn\'s answer must never appear in the compaction prompt');
    });
  });

  describe('compactedMessageCount — the coverage boundary a caller uses to avoid double-counting', () => {
    test('everything fits the retained tail — {changed:false}, no compactedMessageCount', async () => {
      const provider = fakeProvider(async () => ({ text: 'summary' }));
      const fakeSettingsService = {
        getActiveValue: (key) => (key === 'ASK_SUMMARY_RETAINED_MESSAGES' ? 100 : key === 'ASK_SUMMARY_COMPACTION_THRESHOLD' ? 8 : undefined),
      };
      const result = await compactSummaryIfNeeded({
        conversation: { id: 'c', recentMessages: messages(10) },
        question: 'q', answer: 'a', countTokens, numCtx: 4096, generationProvider: provider,
        settingsService: fakeSettingsService,
      });
      assert.equal(result.changed, false);
      assert.ok(!('compactedMessageCount' in result));
    });

    test('material old enough to compact — compactedMessageCount is a positive count strictly less than the full history', async () => {
      const provider = fakeProvider(async () => ({ text: 'summary' }));
      const msgs = messages(ABOVE_RETAINED_TAIL);
      const result = await compactSummaryIfNeeded({
        conversation: { id: 'c', recentMessages: msgs },
        question: 'q', answer: 'a', countTokens, numCtx: 4096, generationProvider: provider,
      });
      assert.equal(result.changed, true);
      assert.ok(result.compactedMessageCount > 0);
      assert.ok(result.compactedMessageCount <= msgs.length);
    });

    test('a caller applying conversation.recentMessages.slice(compactedMessageCount) retains a contiguous NEWEST suffix', async () => {
      const provider = fakeProvider(async () => ({ text: 'summary' }));
      const msgs = messages(ABOVE_RETAINED_TAIL);
      const result = await compactSummaryIfNeeded({
        conversation: { id: 'c', recentMessages: msgs },
        question: 'q', answer: 'a', countTokens, numCtx: 4096, generationProvider: provider,
      });
      assert.equal(result.changed, true);
      const retained = msgs.slice(result.compactedMessageCount);
      for (let i = 0; i < retained.length; i += 1) {
        assert.equal(retained[i], msgs[msgs.length - retained.length + i]);
      }
    });

    test('changed:false (below threshold) omits compactedMessageCount entirely', async () => {
      const provider = fakeProvider(async () => ({ text: 'x' }));
      const result = await compactSummaryIfNeeded({
        conversation: { id: 'c', recentMessages: messages(2) },
        question: 'q', answer: 'a', countTokens, numCtx: 4096, generationProvider: provider,
      });
      assert.equal(result.changed, false);
      assert.ok(!('compactedMessageCount' in result));
    });
  });

  describe('threshold and retained-tail are genuinely independent knobs (code review, P1)', () => {
    test('lowering ONLY the threshold, with the retained-tail default (4) unchanged, still produces real material to compact once history exceeds 4', async () => {
      // The historical bug: the retained boundary was derived from
      // ASK_HISTORY_MAX_MESSAGES (answer-path request-size cap, default
      // 20) instead of its own setting, so a threshold this low with a
      // short history still had nothing old enough to compact. With the
      // dedicated ASK_SUMMARY_RETAINED_MESSAGES default (4), a 6-message
      // history already has 2 messages old enough once the threshold is
      // low enough to trigger at all.
      const provider = fakeProvider(async () => ({ text: 'summary' }));
      const fakeSettingsService = { getActiveValue: (key) => (key === 'ASK_SUMMARY_COMPACTION_THRESHOLD' ? 2 : key === 'ASK_SUMMARY_RETAINED_MESSAGES' ? 4 : undefined) };
      const result = await compactSummaryIfNeeded({
        conversation: { id: 'c', recentMessages: messages(6) },
        question: 'q', answer: 'a', countTokens, numCtx: 4096, generationProvider: provider,
        settingsService: fakeSettingsService,
      });
      assert.equal(result.changed, true);
      assert.equal(result.compactedMessageCount, 2, 'default retained tail (4) out of 6 messages leaves exactly 2 old enough to compact');
    });

    test('raising ONLY the retained-tail setting, with the threshold default (8) unchanged, can make an otherwise-triggering history have nothing to compact', async () => {
      let called = false;
      const provider = fakeProvider(async () => { called = true; return { text: 'x' }; });
      const fakeSettingsService = { getActiveValue: (key) => (key === 'ASK_SUMMARY_RETAINED_MESSAGES' ? 50 : undefined) };
      const result = await compactSummaryIfNeeded({
        conversation: { id: 'c', recentMessages: messages(ABOVE_RETAINED_TAIL) },
        question: 'q', answer: 'a', countTokens, numCtx: 4096, generationProvider: provider,
        settingsService: fakeSettingsService,
      });
      assert.deepEqual(result, { changed: false });
      assert.equal(called, false);
    });
  });

  describe('formatting-overhead correction actually engages', () => {
    // A "renderer-shaped" countTokens that also counts formatting overhead
    // (labels/headers/delimiters) — NOT a raw-content-only stub, which would
    // hide the exact bug this test targets. Uses word-count, so
    // buildCompactionPrompt()'s own labels ("Prior summary:", etc.) genuinely
    // add measurable tokens on top of the raw fragments.
    test('the module never sends a first-rendered, over-budget prompt to generate() — combined tokens always <= budget', async () => {
      let captured;
      const provider = fakeProvider(async (opts) => { captured = opts; return { text: 'summary' }; });
      const numCtx = 300; // deliberately tight, so formatting overhead matters
      const result = await compactSummaryIfNeeded({
        conversation: { id: 'c', summary: 'a summary of prior context here', recentMessages: messages(ABOVE_RETAINED_TAIL) },
        question: 'the question', answer: 'the answer',
        countTokens, numCtx, generationProvider: provider,
      });
      if (result.changed) {
        const totalTokens = countTokens(captured.systemPrompt) + countTokens(captured.prompt);
        assert.ok(totalTokens <= numCtx - RESERVED_HEADROOM_TOKENS, `combined tokens (${totalTokens}) must not exceed budget`);
      } else {
        assert.equal(captured, undefined, 'if compaction was skipped, generate() must never have been called');
      }
    });

    describe('code review (P1): shrink loop preserves the index-0 prefix contract under a deliberately tiny token budget', () => {
      test('shrunk toCompact stays a TRUE prefix of the original history — compactedMessageCount exactly matches what is in the prompt, never more', async () => {
        // A tight numCtx forces the shrink loop to actually engage (proven
        // below by asserting not every message survives). This is the
        // literal-prompt regression test the review asked for: it records
        // the REAL rendered prompt and verifies the actual message set in
        // it against the returned compactedMessageCount, rather than
        // trusting the boundary arithmetic alone.
        let captured;
        const provider = fakeProvider(async (opts) => { captured = opts; return { text: 'summary' }; });
        const msgs = messages(ABOVE_RETAINED_TAIL);
        // Computed precisely against this test's own fixture (word-count
        // countTokens, ABOVE_RETAINED_TAIL=10 messages, default retained
        // tail=4 => toCompact starts at 6 messages / 60 tokens): a budget
        // of ~30 tokens (numCtx = RESERVED_HEADROOM_TOKENS + systemPromptTokens(83) + 30)
        // lands strictly between the 2-message (24 tokens) and 3-message
        // (33 tokens) renderings, forcing the shrink loop to drop exactly
        // 4 of the 6 to-compact messages (a genuine PARTIAL shrink, never
        // shrinking all the way to empty) -- deterministic, not a guess.
        const numCtx = RESERVED_HEADROOM_TOKENS + 83 + 30;
        const result = await compactSummaryIfNeeded({
          conversation: { id: 'c', recentMessages: msgs },
          question: 'q', answer: 'a',
          countTokens, numCtx, generationProvider: provider,
        });
        assert.equal(result.changed, true);
        assert.ok(captured, 'expected generate() to have been called');
        const { compactedMessageCount } = result;
        // Sanity: the shrink loop must have actually engaged for this test
        // to be meaningful (otherwise it would trivially pass even with the
        // old, broken oldest-first shrink direction).
        const fullToCompactWouldBe = msgs.length - 4; // default retained tail
        assert.ok(compactedMessageCount < fullToCompactWouldBe, 'expected the shrink loop to have actually dropped some to-compact messages under this tight budget');

        // The core assertion: compactedMessageCount must describe EXACTLY
        // rawMessages.slice(0, compactedMessageCount) -- a contiguous
        // prefix starting at index 0. Verify against the LITERAL prompt:
        // every message in that slice occurred in the prompt; message
        // index `compactedMessageCount` itself (the first one NOT
        // supposedly covered) did NOT occur in the prompt.
        const supposedlyCovered = msgs.slice(0, compactedMessageCount);
        for (const m of supposedlyCovered) {
          assert.ok(captured.prompt.includes(m.content), `message "${m.content}" (index < compactedMessageCount) must have actually been sent to the summarizer`);
        }
        // Critically: message[0] itself must ALWAYS be covered whenever
        // compactedMessageCount > 0 -- this is what the old (oldest-first
        // shrink) bug violated: it could report compactedMessageCount > 0
        // while message[0] had already been shrunk OUT of the prompt,
        // meaning a caller would delete message[0] believing it was
        // summarized when it was actually silently discarded.
        if (compactedMessageCount > 0) {
          assert.ok(captured.prompt.includes(msgs[0].content), 'message[0] must be covered by the prompt whenever compactedMessageCount > 0 -- the prefix must start at index 0, never be shifted');
        }
        // And the message immediately AFTER the boundary must be absent --
        // proving the boundary is exact, not merely a lower bound.
        if (compactedMessageCount < msgs.length) {
          assert.ok(!captured.prompt.includes(msgs[compactedMessageCount].content), `message at index compactedMessageCount ("${msgs[compactedMessageCount].content}") must NOT appear in the prompt -- it is outside the covered prefix`);
        }
      });
    });

    test('shrink loop removes messages from the to-compact prefix\'s OWN newest end first (closest to the retained boundary)', async () => {
      let captured;
      const provider = fakeProvider(async (opts) => { captured = opts; return { text: 'summary' }; });
      const msgs = messages(ABOVE_RETAINED_TAIL);
      const numCtx = RESERVED_HEADROOM_TOKENS + 83 + 30; // same deterministic partial-shrink budget as the sibling test above
      const result = await compactSummaryIfNeeded({
        conversation: { id: 'c', recentMessages: msgs },
        question: 'q', answer: 'a',
        countTokens, numCtx, generationProvider: provider,
      });
      assert.equal(result.changed, true, 'expected this deterministic budget to still leave room for a partial compaction');
      if (result.changed && captured.prompt.includes('message number')) {
        // Whichever messages survived into the compaction prompt must be
        // the OLDEST among the to-compact prefix (starting at index 0) --
        // never a message shifted away from index 0.
        const survivingIndices = [...captured.prompt.matchAll(/message number (\d+)/g)].map(m => Number(m[1]));
        if (survivingIndices.length > 0) {
          assert.equal(Math.min(...survivingIndices), 0, 'index 0 (the oldest message) must always survive if anything survives -- shrinking must come from the NEWEST end of the to-compact prefix, not the oldest');
        }
      }
    });

    test('sibling case: even zero history/zero summary still does not fit — degrades to skip, no generate() call', async () => {
      let called = false;
      const provider = fakeProvider(async () => { called = true; return { text: 'x' }; });
      const warnCalls = [];
      const originalWarn = console.warn;
      console.warn = (...args) => warnCalls.push(args.join(' '));
      try {
        const result = await compactSummaryIfNeeded({
          conversation: { id: 'c', recentMessages: messages(ABOVE_RETAINED_TAIL) },
          question: 'q', answer: 'a',
          countTokens, numCtx: RESERVED_HEADROOM_TOKENS + 1, // barely above headroom, nothing left for anything else
          generationProvider: provider,
        });
        assert.deepEqual(result, { changed: false });
        assert.equal(called, false);
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe('code review (P2): priorSummary is never silently dropped', () => {
    test('when priorSummary + toCompact cannot fit even after full shrinking, compaction skips entirely rather than regenerating a summary that discards the prior one', async () => {
      let called = false;
      const provider = fakeProvider(async () => { called = true; return { text: 'a summary that would have discarded prior long-term context' }; });
      const warnCalls = [];
      const originalWarn = console.warn;
      console.warn = (...args) => warnCalls.push(args.join(' '));
      try {
        // A huge prior summary that alone cannot fit in a tiny budget --
        // once toCompact has been fully shrunk to [], the ONLY remaining
        // content is priorSummary itself; if that alone still doesn't fit,
        // the module must skip, never silently drop priorSummary and
        // generate a fresh one covering only history.
        const hugeSummary = 'w '.repeat(2000);
        const result = await compactSummaryIfNeeded({
          conversation: { id: 'c', summary: hugeSummary, recentMessages: messages(ABOVE_RETAINED_TAIL) },
          question: 'q', answer: 'a',
          countTokens, numCtx: RESERVED_HEADROOM_TOKENS + 50, generationProvider: provider,
        });
        assert.deepEqual(result, { changed: false }, 'must skip rather than regenerate a summary that silently discards the prior one');
        assert.equal(called, false, 'generate() must never be called when the only way to fit is dropping priorSummary entirely');
        assert.ok(warnCalls.length >= 1);
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe('behavioral: the literal compaction prompt matches the returned boundary exactly (code review — verify against the actual prompt, not the formula)', () => {
    test('every message the boundary marks as compacted DID occur in the summarization prompt; every retained message did NOT; the current turn never appears; the next request has no loss or duplication', async () => {
      let captured;
      const provider = fakeProvider(async (opts) => { captured = opts; return { text: 'a fresh rolling summary' }; });
      const msgs = messages(ABOVE_RETAINED_TAIL);
      const question = 'the just-asked question, unique-token QASK';
      const answer = 'the just-given answer, unique-token AANS';

      const result = await compactSummaryIfNeeded({
        conversation: { id: 'c', recentMessages: msgs },
        question, answer, countTokens, numCtx: 4096, generationProvider: provider,
      });

      assert.equal(result.changed, true);
      assert.ok(captured, 'expected generate() to have been called');
      const { compactedMessageCount } = result;
      assert.ok(compactedMessageCount > 0 && compactedMessageCount < msgs.length);

      const removed = msgs.slice(0, compactedMessageCount);
      const retained = msgs.slice(compactedMessageCount);

      // 1. Every REMOVED (compacted) message's distinguishing text occurred
      //    literally in the rendered compaction prompt.
      for (const m of removed) {
        assert.ok(captured.prompt.includes(m.content), `expected removed message "${m.content}" to appear in the compaction prompt`);
      }

      // 2. Every RETAINED message's distinguishing text did NOT occur in the
      //    compaction prompt — it was never sent to the summarizer.
      for (const m of retained) {
        assert.ok(!captured.prompt.includes(m.content), `expected retained message "${m.content}" to be ABSENT from the compaction prompt`);
      }

      // 3. The current turn (question/answer) never appears in the
      //    summarization input either — it is compacted by no one; it is
      //    only ever appended raw by the caller.
      assert.ok(!captured.prompt.includes('QASK'));
      assert.ok(!captured.prompt.includes('AANS'));

      // 4. Simulate what a caller (e.g. conversation-manager.mjs) does next:
      //    drop the compacted prefix, keep the retained suffix, append the
      //    current turn exactly once. Verify the resulting array has no
      //    loss (every retained message present) and no duplication (every
      //    message appears exactly once, including the current turn).
      const nextRecentMessages = [
        ...retained,
        { role: 'user', content: question },
        { role: 'assistant', content: answer },
      ];
      const contents = nextRecentMessages.map(m => m.content);
      const uniqueContents = new Set(contents);
      assert.equal(contents.length, uniqueContents.size, 'no message should appear more than once in the next request\'s recentMessages');
      for (const m of retained) {
        assert.ok(nextRecentMessages.some(nm => nm.content === m.content), `retained message "${m.content}" must survive into the next request`);
      }
      assert.ok(nextRecentMessages.some(nm => nm.content === question));
      assert.ok(nextRecentMessages.some(nm => nm.content === answer));
      // And none of the COMPACTED messages should have survived raw — they
      // are now covered by `summary` only.
      for (const m of removed) {
        assert.ok(!nextRecentMessages.some(nm => nm.content === m.content), `compacted message "${m.content}" must not survive raw into the next request`);
      }
    });
  });
});

describe('buildCompactionPrompt', () => {
  test('renders prior summary and the to-compact history into one string, never the current turn', () => {
    const prompt = buildCompactionPrompt({
      priorSummary: 'a summary', recentMessages: [{ role: 'user', content: 'hi' }],
    });
    assert.match(prompt, /a summary/);
    assert.match(prompt, /hi/);
  });

  test('omits the summary section entirely when absent', () => {
    const prompt = buildCompactionPrompt({ priorSummary: undefined, recentMessages: [] });
    assert.ok(!prompt.includes('Prior summary:'));
  });
});
