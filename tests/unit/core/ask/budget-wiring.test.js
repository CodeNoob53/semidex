// Direct unit coverage that query-rewrite.js's rewriteFollowUpQuery() and
// summary-compaction.js's compactSummaryIfNeeded() genuinely consume the
// SAME budget-ledger contract coordinator.js's askCore does — task
// requirement #2 ("query rewrite, final answer, and summary compaction
// must consume the same ledger"), tested here at the smallest possible
// unit (no HTTP, no real coordinator wiring) so the assertions are exact:
// reserve() is called with the right label/tokens, a denial skips the
// provider call entirely (never invoked), and reconcile() is called on
// success with the real reported usage.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteFollowUpQuery, REWRITE_MAX_OUTPUT_TOKENS } from '../../../../src/core/ask/query-rewrite.js';
import { compactSummaryIfNeeded, SUMMARY_MAX_OUTPUT_TOKENS } from '../../../../src/core/ask/summary-compaction.js';

const countTokensStub = () => 50; // fixed, so cost arithmetic is exact regardless of prompt text length

function fakeLedger({ reserveResult = { ok: true, reservationId: 1, maxOutputTokens: 999 } } = {}) {
  const calls = { reserve: [], reconcile: [] };
  return {
    calls,
    ledger: {
      reserve(args) { calls.reserve.push(args); return reserveResult; },
      reconcile(id, usage) { calls.reconcile.push({ id, usage }); },
    },
  };
}

function fakeProvider(overrides = {}) {
  let generateCalls = 0;
  return {
    capabilities: () => ({ hardOutputCap: true }),
    generate: async (opts) => { generateCalls++; return overrides.generate ? overrides.generate(opts) : { text: 'fallback text', tokensIn: 10, tokensOut: 5 }; },
    get generateCallCount() { return generateCalls; },
  };
}

describe('rewriteFollowUpQuery — budget wiring', () => {
  const followUpArgs = { question: 'and that?', summary: 'prior context', recentMessages: [] };

  it('reserves label:"rewrite" with REWRITE_MAX_OUTPUT_TOKENS before calling generate()', async () => {
    const { ledger, calls } = fakeLedger();
    const provider = fakeProvider({ generate: async () => ({ text: 'rewritten', tokensIn: 20, tokensOut: 5 }) });
    const result = await rewriteFollowUpQuery({ ...followUpArgs, generationProvider: provider, countTokens: countTokensStub, budget: ledger });
    assert.equal(calls.reserve.length, 1);
    assert.equal(calls.reserve[0].label, 'rewrite');
    assert.equal(calls.reserve[0].estimatedInputTokens, 50);
    assert.equal(calls.reserve[0].maxOutputTokens, REWRITE_MAX_OUTPUT_TOKENS);
    assert.equal(provider.generateCallCount, 1, 'generate() runs only after a successful reservation');
    assert.equal(result.rewritten, true);
  });

  it('a DENIED reservation skips generate() entirely and degrades to the original question (never fails the request)', async () => {
    const { ledger, calls } = fakeLedger({ reserveResult: { ok: false, code: 'key_budget_exceeded', message: 'exhausted' } });
    const provider = fakeProvider();
    const result = await rewriteFollowUpQuery({ ...followUpArgs, generationProvider: provider, countTokens: countTokensStub, budget: ledger });
    assert.equal(provider.generateCallCount, 0, 'the provider fake is never invoked for a denied reservation');
    assert.deepEqual(result, { query: followUpArgs.question, rewritten: false });
    assert.equal(calls.reconcile.length, 0, 'nothing to reconcile — the call never ran');
  });

  it('reconciles with the REAL reported usage on success', async () => {
    const { ledger, calls } = fakeLedger({ reserveResult: { ok: true, reservationId: 42, maxOutputTokens: REWRITE_MAX_OUTPUT_TOKENS } });
    const provider = fakeProvider({ generate: async () => ({ text: 'rewritten', tokensIn: 33, tokensOut: 7 }) });
    await rewriteFollowUpQuery({ ...followUpArgs, generationProvider: provider, countTokens: countTokensStub, budget: ledger });
    assert.equal(calls.reconcile.length, 1);
    assert.deepEqual(calls.reconcile[0], { id: 42, usage: { tokensIn: 33, tokensOut: 7 } });
  });

  it('fails closed (skips, never calls generate) when the provider cannot enforce an output cap', async () => {
    const { ledger, calls } = fakeLedger();
    const provider = { capabilities: () => ({ hardOutputCap: false }), generate: async () => { throw new Error('must not be called'); } };
    const result = await rewriteFollowUpQuery({ ...followUpArgs, generationProvider: provider, countTokens: countTokensStub, budget: ledger });
    assert.equal(calls.reserve.length, 0, 'never even attempts a reservation for a provider that cannot honor it');
    assert.deepEqual(result, { query: followUpArgs.question, rewritten: false });
  });

  it('passes reservation.maxOutputTokens through to generate() as options.maxOutputTokens (provider-neutral output cap)', async () => {
    const { ledger } = fakeLedger({ reserveResult: { ok: true, reservationId: 1, maxOutputTokens: 231 } });
    let capturedOptions;
    const provider = fakeProvider({ generate: async (opts) => { capturedOptions = opts.options; return { text: 'x' }; } });
    await rewriteFollowUpQuery({ ...followUpArgs, generationProvider: provider, countTokens: countTokensStub, budget: ledger });
    assert.deepEqual(capturedOptions, { maxOutputTokens: 231 });
  });

  it('omitting budget entirely preserves the prior unbudgeted behavior (no reserve/reconcile calls, generate() still runs)', async () => {
    const provider = fakeProvider({ generate: async () => ({ text: 'rewritten' }) });
    const result = await rewriteFollowUpQuery({ ...followUpArgs, generationProvider: provider, countTokens: countTokensStub });
    assert.equal(provider.generateCallCount, 1);
    assert.equal(result.rewritten, true);
  });

  for (const [name, overrides] of [
    ['capabilities', { provider: { capabilities: () => { throw new Error('capability failure'); }, generate: async () => { throw new Error('must not run'); } } }],
    ['countTokens', { countTokens: async () => { throw new Error('tokenizer failure'); } }],
    ['reserve', { ledger: { reserve() { throw new Error('ledger failure'); }, reconcile() {} } }],
  ]) {
    it(`${name} failure degrades to the original question without invoking generation`, async () => {
      const provider = overrides.provider ?? fakeProvider();
      const { ledger } = fakeLedger();
      const result = await rewriteFollowUpQuery({
        ...followUpArgs,
        generationProvider: provider,
        countTokens: overrides.countTokens ?? countTokensStub,
        budget: overrides.ledger ?? ledger,
      });
      assert.deepEqual(result, { query: followUpArgs.question, rewritten: false });
      if ('generateCallCount' in provider) assert.equal(provider.generateCallCount, 0);
    });
  }

  it('reconcile failure remains best-effort after a successful provider call', async () => {
    const provider = fakeProvider({ generate: async () => ({ text: 'rewritten', tokensIn: 1, tokensOut: 1 }) });
    const budget = { reserve: () => ({ ok: true, reservationId: 1, maxOutputTokens: 10 }), reconcile: () => { throw new Error('reconcile failure'); } };
    const result = await rewriteFollowUpQuery({ ...followUpArgs, generationProvider: provider, countTokens: countTokensStub, budget });
    assert.deepEqual(result, { query: followUpArgs.question, rewritten: false });
  });
});

describe('compactSummaryIfNeeded — budget wiring', () => {
  const recentMessages = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `message ${i}` }));
  const baseArgs = {
    conversation: { id: 'c1', summary: 'old summary', recentMessages },
    question: 'q', answer: 'a', countTokens: countTokensStub, numCtx: 8192,
  };

  it('reserves label:"compaction" with SUMMARY_MAX_OUTPUT_TOKENS before calling generate()', async () => {
    const { ledger, calls } = fakeLedger();
    const provider = fakeProvider({ generate: async () => ({ text: 'new summary', tokensIn: 40, tokensOut: 10 }) });
    const result = await compactSummaryIfNeeded({ ...baseArgs, generationProvider: provider, budget: ledger });
    assert.equal(calls.reserve.length, 1);
    assert.equal(calls.reserve[0].label, 'compaction');
    assert.equal(calls.reserve[0].maxOutputTokens, SUMMARY_MAX_OUTPUT_TOKENS);
    assert.equal(provider.generateCallCount, 1);
    assert.equal(result.changed, true);
  });

  it('a DENIED reservation skips generate() entirely and degrades to changed:false (never fails the already-successful answer)', async () => {
    const { ledger, calls } = fakeLedger({ reserveResult: { ok: false, code: 'request_token_ceiling_exceeded', message: 'too much' } });
    const provider = fakeProvider();
    const result = await compactSummaryIfNeeded({ ...baseArgs, generationProvider: provider, budget: ledger });
    assert.equal(provider.generateCallCount, 0);
    assert.deepEqual(result, { changed: false });
    assert.equal(calls.reconcile.length, 0);
  });

  it('reconciles with the REAL reported usage on success', async () => {
    const { ledger, calls } = fakeLedger({ reserveResult: { ok: true, reservationId: 7, maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS } });
    const provider = fakeProvider({ generate: async () => ({ text: 'new summary', tokensIn: 60, tokensOut: 20 }) });
    await compactSummaryIfNeeded({ ...baseArgs, generationProvider: provider, budget: ledger });
    assert.equal(calls.reconcile.length, 1);
    assert.deepEqual(calls.reconcile[0], { id: 7, usage: { tokensIn: 60, tokensOut: 20 } });
  });

  it('fails closed (skips, never calls generate) when the provider cannot enforce an output cap', async () => {
    const { calls } = fakeLedger();
    const provider = { capabilities: () => ({ hardOutputCap: false }), generate: async () => { throw new Error('must not be called'); } };
    const { ledger } = fakeLedger();
    const result = await compactSummaryIfNeeded({ ...baseArgs, generationProvider: provider, budget: ledger });
    assert.deepEqual(result, { changed: false });
  });

  it('omitting budget entirely preserves the prior unbudgeted behavior', async () => {
    const provider = fakeProvider({ generate: async () => ({ text: 'new summary' }) });
    const result = await compactSummaryIfNeeded({ ...baseArgs, generationProvider: provider });
    assert.equal(provider.generateCallCount, 1);
    assert.equal(result.changed, true);
  });

  for (const [name, overrides] of [
    ['capabilities', { provider: { capabilities: () => { throw new Error('capability failure'); }, generate: async () => { throw new Error('must not run'); } } }],
    ['countTokens', { countTokens: async () => { throw new Error('tokenizer failure'); } }],
    ['reserve', { ledger: { reserve() { throw new Error('ledger failure'); }, reconcile() {} } }],
  ]) {
    it(`${name} failure degrades to changed:false without invoking generation`, async () => {
      const provider = overrides.provider ?? fakeProvider();
      const { ledger } = fakeLedger();
      const result = await compactSummaryIfNeeded({
        ...baseArgs,
        generationProvider: provider,
        countTokens: overrides.countTokens ?? countTokensStub,
        budget: overrides.ledger ?? ledger,
      });
      assert.deepEqual(result, { changed: false });
      if ('generateCallCount' in provider) assert.equal(provider.generateCallCount, 0);
    });
  }

  it('reconcile failure remains best-effort after a successful provider call', async () => {
    const provider = fakeProvider({ generate: async () => ({ text: 'new summary', tokensIn: 1, tokensOut: 1 }) });
    const budget = { reserve: () => ({ ok: true, reservationId: 1, maxOutputTokens: 10 }), reconcile: () => { throw new Error('reconcile failure'); } };
    const result = await compactSummaryIfNeeded({ ...baseArgs, generationProvider: provider, budget });
    assert.deepEqual(result, { changed: false });
  });
});
