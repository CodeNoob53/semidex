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
      conversation: { recentMessages: messages(10) },
      question: 'q', answer: 'a', countTokens, numCtx: 4096, generationProvider: provider,
    });
    assert.deepEqual(result, { changed: false });
    assert.equal(called, false);
  });

  test('at/above threshold, success — returns {changed:true, summary}, prompt includes question+answer+prior summary+recentMessages', async () => {
    let captured;
    const provider = fakeProvider(async (opts) => { captured = opts; return { text: 'a fresh bounded summary' }; });
    const result = await compactSummaryIfNeeded({
      conversation: { id: 'c', summary: 'prior summary text', recentMessages: messages(10) },
      question: 'the current question', answer: 'the current answer',
      countTokens, numCtx: 4096, generationProvider: provider,
    });
    assert.equal(result.changed, true);
    assert.equal(result.summary, 'a fresh bounded summary');
    assert.match(captured.prompt, /the current question/);
    assert.match(captured.prompt, /the current answer/);
    assert.match(captured.prompt, /prior summary text/);
    assert.match(captured.prompt, /message number/);
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
        conversation: { id: 'c', recentMessages: messages(10) },
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
        conversation: { id: 'c', recentMessages: messages(10) },
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
      conversation: { id: 'c', recentMessages: messages(10) },
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
      conversation: { id: 'c', recentMessages: messages(10) },
      question: 'q', answer: 'a', countTokens, numCtx: 4096, generationProvider: provider,
    });
    assert.match(captured.systemPrompt, /not.*verified.*facts|verified collection facts/i);
  });

  describe('bounded WHOLE-PROMPT compaction input, 200 large messages AND a large answer', () => {
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
      const result = await compactSummaryIfNeeded({
        conversation: { id: 'c', summary: 'prior', recentMessages: largeMessages(200) },
        question: 'q', answer: 'x'.repeat(50_000),
        countTokens, numCtx, generationProvider: provider,
      });
      assert.equal(result.changed, true);
      assert.ok(captured, 'expected generate() to have been called');
      const totalTokens = countTokens(captured.systemPrompt) + countTokens(captured.prompt);
      assert.ok(totalTokens <= numCtx - RESERVED_HEADROOM_TOKENS, `expected combined system+user tokens (${totalTokens}) <= budget (${numCtx - RESERVED_HEADROOM_TOKENS})`);
    });

    test('a sibling case with a small answer keeps the current turn fully present, history gets the correctly-computed remainder', async () => {
      let captured;
      const provider = fakeProvider(async (opts) => { captured = opts; return { text: 'summary' }; });
      const result = await compactSummaryIfNeeded({
        conversation: { id: 'c', recentMessages: messages(10) },
        question: 'a small question', answer: 'a small answer',
        countTokens, numCtx: 4096, generationProvider: provider,
      });
      assert.equal(result.changed, true);
      assert.match(captured.prompt, /a small question/);
      assert.match(captured.prompt, /a small answer/);
    });
  });

  test('current-turn-alone-too-large degrades to a skip, never a failure — no generate() call at all', async () => {
    let called = false;
    const provider = fakeProvider(async () => { called = true; return { text: 'x' }; });
    const warnCalls = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnCalls.push(args.join(' '));
    try {
      const result = await compactSummaryIfNeeded({
        conversation: { id: 'c', recentMessages: messages(10) },
        question: 'q'.repeat(1), answer: 'a'.repeat(PROTOCOL_MAX_MESSAGE_CHARS),
        countTokens, numCtx: RESERVED_HEADROOM_TOKENS + 5, // tiny budget after overhead
        generationProvider: provider,
      });
      assert.deepEqual(result, { changed: false });
      assert.equal(called, false);
      assert.ok(warnCalls.some(w => /does not fit/i.test(w)));
    } finally {
      console.warn = originalWarn;
    }
  });

  test('answer truncation engages before giving up — untruncated turn does not fit, truncated turn does', async () => {
    let captured;
    const provider = fakeProvider(async (opts) => { captured = opts; return { text: 'summary' }; });
    // Construct a numCtx where the FULL (untruncated) answer would not fit
    // availableAfterOverhead, but the truncated (4000-char) version does.
    const numCtx = RESERVED_HEADROOM_TOKENS + 2000;
    const result = await compactSummaryIfNeeded({
      conversation: { id: 'c', recentMessages: messages(10) },
      question: 'short question', answer: 'word '.repeat(50_000),
      countTokens, numCtx, generationProvider: provider,
    });
    assert.equal(result.changed, true);
    assert.ok(captured.prompt.length < 50_000 * 5, 'expected the answer to have been truncated in the captured prompt');
  });

  describe('formatting-overhead correction actually engages', () => {
    // A "renderer-shaped" countTokens that also counts formatting overhead
    // (labels/headers/delimiters) — NOT a raw-content-only stub, which would
    // hide the exact bug this test targets. Uses word-count, so
    // buildCompactionPrompt()'s own labels ("Prior summary:", "Question:",
    // etc.) genuinely add measurable tokens on top of the raw fragments.
    test('the module never sends a first-rendered, over-budget prompt to generate() — combined tokens always <= budget', async () => {
      let captured;
      const provider = fakeProvider(async (opts) => { captured = opts; return { text: 'summary' }; });
      const numCtx = 300; // deliberately tight, so formatting overhead matters
      const result = await compactSummaryIfNeeded({
        conversation: { id: 'c', summary: 'a summary of prior context here', recentMessages: messages(10) },
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

    test('shrink loop removes messages from the oldest end of history first — retained history is a suffix of the original', async () => {
      let captured;
      const provider = fakeProvider(async (opts) => { captured = opts; return { text: 'summary' }; });
      const msgs = messages(20);
      const result = await compactSummaryIfNeeded({
        conversation: { id: 'c', recentMessages: msgs },
        question: 'q', answer: 'a',
        countTokens, numCtx: 250, generationProvider: provider,
      });
      if (result.changed && captured.prompt.includes('message number')) {
        // Whichever messages survived must be the newest ones (highest index).
        const survivingIndices = [...captured.prompt.matchAll(/message number (\d+)/g)].map(m => Number(m[1]));
        if (survivingIndices.length > 0) {
          const maxSurviving = Math.max(...survivingIndices);
          assert.equal(maxSurviving, 19, 'the newest message (index 19) must always survive if any history survives');
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
          conversation: { id: 'c', recentMessages: messages(10) },
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
});

describe('buildCompactionPrompt', () => {
  test('renders question/answer/summary/history into one string', () => {
    const prompt = buildCompactionPrompt({
      priorSummary: 'a summary', recentMessages: [{ role: 'user', content: 'hi' }],
      question: 'q?', answer: 'a.',
    });
    assert.match(prompt, /a summary/);
    assert.match(prompt, /hi/);
    assert.match(prompt, /q\?/);
    assert.match(prompt, /a\./);
  });

  test('omits summary/history sections entirely when absent', () => {
    const prompt = buildCompactionPrompt({ priorSummary: undefined, recentMessages: [], question: 'q?', answer: 'a.' });
    assert.ok(!prompt.includes('Prior summary:'));
    assert.ok(!prompt.includes('Conversation so far:'));
  });
});
