import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAskCoordinator } from '../../../../src/core/ask/coordinator.js';
import { REFUSAL_SENTINEL } from '../../../../src/core/ask/prompt.js';

const countTokens = (text) => (text ?? '').split(/\s+/).filter(Boolean).length;

const VALID_PROFILE = {
  schemaVersion: 1, managedBy: 'semidex',
  embedding: {
    dense: { provider: 'ollama', model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
    sparse: { provider: 'hashed-tf', model: 'hashed-tf', vectorName: 'sparse', execution: 'client' },
  },
  embeddingSchemaVersion: 2,
};

function fakeAdapter({ hits = [] } = {}) {
  return {
    capabilities: () => ({ hybridSearch: true, sparseVectors: true }),
    getCollection: async (name) => ({ name }),
    getEmbeddingProfile: async () => ({ state: 'valid', profile: VALID_PROFILE }),
    searchHybridVectors: async () => hits,
    getContentNode: async () => null,
    getSkeletonNode: async () => null,
    getSectionChunks: async () => [],
    getFileChunks: async () => [],
  };
}

const embedQuery = async () => ({ dense: [0.1], sparse: {} });

function fakeProvider({ ready, generate } = {}) {
  return {
    name: () => 'ollama',
    capabilities: () => ({ streaming: true, clientAbort: true, upstreamCancellation: true }),
    ready: ready ?? (async () => ({ ok: true, model: 'gemma3:4b' })),
    generate: generate ?? (async ({ onToken }) => { onToken?.('answer [1]'); return { text: 'answer [1]', tokensIn: 5, tokensOut: 2, aborted: false }; }),
  };
}

function oneHit() {
  return [{ sourceFile: 'a.md', chunkIndex: 0, section: 'Intro', text: 'evidence text', nodeId: null }];
}

describe('createAskCoordinator', () => {
  test('provider not ready -> provider_unavailable, never calls generate', async () => {
    let generateCalled = false;
    const provider = fakeProvider({
      ready: async () => ({ ok: false, reason: 'Ollama is not reachable' }),
      generate: async () => { generateCalled = true; return { text: '' }; },
    });
    const coordinator = createAskCoordinator({ adapter: fakeAdapter({ hits: oneHit() }), embedQuery, countTokens, generationProvider: provider });
    const result = await coordinator.ask({ collection: 'c', question: 'q', onSources: () => {}, onToken: () => {} });
    assert.equal(result.status, 'provider_unavailable');
    assert.equal(generateCalled, false);
  });

  test('zero evidence -> refused without calling the provider, onSources called with empty sources', async () => {
    let generateCalled = false;
    let sourcesPayload;
    const provider = fakeProvider({ generate: async () => { generateCalled = true; return { text: '' }; } });
    const coordinator = createAskCoordinator({ adapter: fakeAdapter({ hits: [] }), embedQuery, countTokens, generationProvider: provider });
    const result = await coordinator.ask({
      collection: 'c', question: 'q', onSources: (p) => { sourcesPayload = p; }, onToken: () => {},
    });
    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'no_evidence');
    assert.equal(generateCalled, false);
    assert.deepEqual(sourcesPayload.sources, []);
  });

  test('happy path: sources emitted before generate, done includes citations/provider/model/counts', async () => {
    const calls = [];
    const provider = fakeProvider({
      generate: async ({ onToken }) => { calls.push('generate'); onToken('answer [1]'); return { text: 'answer [1]', tokensIn: 10, tokensOut: 3, aborted: false }; },
    });
    const coordinator = createAskCoordinator({ adapter: fakeAdapter({ hits: oneHit() }), embedQuery, countTokens, generationProvider: provider });
    const tokens = [];
    const result = await coordinator.ask({
      collection: 'c', question: 'q',
      onSources: () => calls.push('sources'),
      onToken: (t) => tokens.push(t),
    });
    assert.deepEqual(calls, ['sources', 'generate']);
    assert.equal(result.status, 'done');
    assert.deepEqual(result.citations, [1]);
    assert.equal(result.provider, 'ollama');
    assert.equal(result.model, 'gemma3:4b');
    assert.equal(result.tokensIn, 10);
    assert.equal(result.tokensOut, 3);
    assert.equal(result.evidenceCount, 1);
    assert.deepEqual(tokens, ['answer [1]']);
    assert.equal(result.refused, false);
  });

  test('calls generate() with systemPrompt and prompt as separate fields — prompt never contains a "System:" section', async () => {
    let captured;
    const provider = fakeProvider({
      generate: async (opts) => { captured = opts; opts.onToken?.('answer [1]'); return { text: 'answer [1]', aborted: false }; },
    });
    const coordinator = createAskCoordinator({ adapter: fakeAdapter({ hits: oneHit() }), embedQuery, countTokens, generationProvider: provider });
    await coordinator.ask({ collection: 'c', question: 'q', onSources: () => {}, onToken: () => {} });
    assert.equal(typeof captured.systemPrompt, 'string');
    assert.ok(captured.systemPrompt.length > 0, 'systemPrompt must be a real, non-empty instruction string');
    assert.equal(typeof captured.prompt, 'string');
    assert.ok(!/^System:/m.test(captured.prompt), 'the coordinator must never send a fake "System:" section inside prompt — it belongs only in systemPrompt');
    assert.match(captured.prompt, /^Evidence:/);
    assert.match(captured.prompt, /Question: q$/);
  });

  test('model refusal sentinel -> done with refused: true', async () => {
    const provider = fakeProvider({ generate: async () => ({ text: REFUSAL_SENTINEL, aborted: false }) });
    const coordinator = createAskCoordinator({ adapter: fakeAdapter({ hits: oneHit() }), embedQuery, countTokens, generationProvider: provider });
    const result = await coordinator.ask({ collection: 'c', question: 'q', onSources: () => {}, onToken: () => {} });
    assert.equal(result.status, 'done');
    assert.equal(result.refused, true);
  });

  test('generation failure after streaming starts -> status error, not done', async () => {
    const provider = fakeProvider({ generate: async ({ onToken }) => { onToken('partial'); throw new Error('model crashed'); } });
    const coordinator = createAskCoordinator({ adapter: fakeAdapter({ hits: oneHit() }), embedQuery, countTokens, generationProvider: provider });
    const result = await coordinator.ask({ collection: 'c', question: 'q', onSources: () => {}, onToken: () => {} });
    assert.equal(result.status, 'error');
    assert.match(result.message, /model crashed/);
  });

  test('client abort -> status aborted, not error or done', async () => {
    const controller = new AbortController();
    const provider = fakeProvider({
      generate: async ({ signal }) => {
        controller.abort();
        if (signal.aborted) return { text: 'partial', aborted: true };
        return { text: '', aborted: false };
      },
    });
    const coordinator = createAskCoordinator({ adapter: fakeAdapter({ hits: oneHit() }), embedQuery, countTokens, generationProvider: provider });
    const result = await coordinator.ask({ collection: 'c', question: 'q', signal: controller.signal, onSources: () => {}, onToken: () => {} });
    assert.equal(result.status, 'aborted');
  });

  test('concurrent ask returns busy without touching the provider or adapter again', async () => {
    let resolveGenerate;
    const provider = fakeProvider({
      generate: () => new Promise((resolve) => { resolveGenerate = () => resolve({ text: 'done [1]', aborted: false }); }),
    });
    const coordinator = createAskCoordinator({ adapter: fakeAdapter({ hits: oneHit() }), embedQuery, countTokens, generationProvider: provider });

    const first = coordinator.ask({ collection: 'c', question: 'q1', onSources: () => {}, onToken: () => {} });
    // Let the first call proceed far enough to acquire the lock.
    await new Promise((r) => setImmediate(r));
    assert.equal(coordinator.isBusy(), true);

    const second = await coordinator.ask({ collection: 'c', question: 'q2', onSources: () => { throw new Error('must not run'); }, onToken: () => {} });
    assert.equal(second.status, 'busy');

    resolveGenerate();
    const firstResult = await first;
    assert.equal(firstResult.status, 'done');
    assert.equal(coordinator.isBusy(), false);
  });

  test('lock is released after a provider_unavailable exit, allowing a subsequent ask', async () => {
    let readyCall = 0;
    const provider = fakeProvider({
      ready: async () => { readyCall += 1; return readyCall === 1 ? { ok: false, reason: 'down' } : { ok: true, model: 'gemma3:4b' }; },
    });
    const coordinator = createAskCoordinator({ adapter: fakeAdapter({ hits: oneHit() }), embedQuery, countTokens, generationProvider: provider });
    const first = await coordinator.ask({ collection: 'c', question: 'q', onSources: () => {}, onToken: () => {} });
    assert.equal(first.status, 'provider_unavailable');
    assert.equal(coordinator.isBusy(), false);
    const second = await coordinator.ask({ collection: 'c', question: 'q', onSources: () => {}, onToken: () => {} });
    assert.equal(second.status, 'done');
  });

  test('lock is released after a generation error, allowing a subsequent ask', async () => {
    let attempt = 0;
    const provider = fakeProvider({
      generate: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('boom');
        return { text: 'ok [1]', aborted: false };
      },
    });
    const coordinator = createAskCoordinator({ adapter: fakeAdapter({ hits: oneHit() }), embedQuery, countTokens, generationProvider: provider });
    const first = await coordinator.ask({ collection: 'c', question: 'q', onSources: () => {}, onToken: () => {} });
    assert.equal(first.status, 'error');
    assert.equal(coordinator.isBusy(), false);
    const second = await coordinator.ask({ collection: 'c', question: 'q', onSources: () => {}, onToken: () => {} });
    assert.equal(second.status, 'done');
  });

  describe('refusal sentinel is never streamed to the client', () => {
    test('the sentinel emitted character-by-character never reaches onToken', async () => {
      // Regression: the live SSE check found 9 streamed fragments spelling
      // out "[[INSUFFICIENT_EVIDENCE]]" reaching the client before
      // citations.js had a chance to detect and strip it. Simulates Ollama
      // streaming the sentinel one character at a time (worst case for a
      // naive per-token forward).
      const provider = fakeProvider({
        generate: async ({ onToken }) => {
          for (const ch of REFUSAL_SENTINEL) await onToken(ch);
          return { text: REFUSAL_SENTINEL, aborted: false };
        },
      });
      const coordinator = createAskCoordinator({ adapter: fakeAdapter({ hits: oneHit() }), embedQuery, countTokens, generationProvider: provider });
      const tokens = [];
      const result = await coordinator.ask({
        collection: 'c', question: 'q', onSources: () => {}, onToken: (t) => tokens.push(t),
      });
      assert.equal(result.status, 'done');
      assert.equal(result.refused, true);
      assert.deepEqual(tokens, [], 'no fragment of the sentinel should ever reach onToken');
    });

    test('the sentinel emitted as one whole token never reaches onToken', async () => {
      const provider = fakeProvider({
        generate: async ({ onToken }) => { await onToken(REFUSAL_SENTINEL); return { text: REFUSAL_SENTINEL, aborted: false }; },
      });
      const coordinator = createAskCoordinator({ adapter: fakeAdapter({ hits: oneHit() }), embedQuery, countTokens, generationProvider: provider });
      const tokens = [];
      const result = await coordinator.ask({
        collection: 'c', question: 'q', onSources: () => {}, onToken: (t) => tokens.push(t),
      });
      assert.equal(result.refused, true);
      assert.deepEqual(tokens, []);
    });

    test('a real answer that happens to start with "[[" but is not the sentinel streams normally', async () => {
      const answer = '[[note]] the answer is 42 [1].';
      const provider = fakeProvider({
        generate: async ({ onToken }) => {
          for (const ch of answer) await onToken(ch);
          return { text: answer, aborted: false };
        },
      });
      const coordinator = createAskCoordinator({ adapter: fakeAdapter({ hits: oneHit() }), embedQuery, countTokens, generationProvider: provider });
      const tokens = [];
      const result = await coordinator.ask({
        collection: 'c', question: 'q', onSources: () => {}, onToken: (t) => tokens.push(t),
      });
      assert.equal(result.status, 'done');
      assert.equal(result.refused, false);
      // Held characters flush once divergence is detected, then stream
      // through normally — the full text is preserved even though it
      // wasn't forwarded one raw character at a time.
      assert.equal(tokens.join(''), answer);
    });

    test('a short real answer (shorter than the sentinel, never diverges mid-stream) flushes on finalize', async () => {
      const answer = 'Yes [1].'; // shorter than REFUSAL_SENTINEL, not a prefix of it after the first char
      const provider = fakeProvider({
        generate: async ({ onToken }) => { await onToken(answer); return { text: answer, aborted: false }; },
      });
      const coordinator = createAskCoordinator({ adapter: fakeAdapter({ hits: oneHit() }), embedQuery, countTokens, generationProvider: provider });
      const tokens = [];
      const result = await coordinator.ask({
        collection: 'c', question: 'q', onSources: () => {}, onToken: (t) => tokens.push(t),
      });
      assert.equal(result.status, 'done');
      assert.equal(tokens.join(''), answer);
    });

    test('onToken backpressure promise is awaited before generate() resolves (via a slow onToken)', async () => {
      let onTokenResolved = false;
      const slowOnToken = async (t) => {
        await new Promise((r) => setTimeout(r, 5));
        onTokenResolved = true;
      };
      const provider = fakeProvider({
        generate: async ({ onToken }) => {
          await onToken('answer [1]');
          // If the coordinator's guard didn't await onToken's returned
          // promise, this assertion would run before slowOnToken finished.
          assert.equal(onTokenResolved, true);
          return { text: 'answer [1]', aborted: false };
        },
      });
      const coordinator = createAskCoordinator({ adapter: fakeAdapter({ hits: oneHit() }), embedQuery, countTokens, generationProvider: provider });
      const result = await coordinator.ask({ collection: 'c', question: 'q', onSources: () => {}, onToken: slowOnToken });
      assert.equal(result.status, 'done');
    });

    test('a refusal wrapped in leading/trailing whitespace never leaks any part of the sentinel, streamed char-by-char', async () => {
      // Regression: the guard compared RAW held text against the sentinel
      // (REFUSAL_SENTINEL.startsWith(held)) — a leading "\n" is not a
      // prefix of "[[", so `diverged` was set true on the very first
      // character and the ENTIRE sentinel that followed streamed through
      // raw (code review finding, confirmed at runtime for the exact
      // response "\n[[INSUFFICIENT_EVIDENCE]]\n"). validateCitations()
      // already trims before comparing, so the guard must match that.
      const wrapped = `\n${REFUSAL_SENTINEL}\n`;
      const provider = fakeProvider({
        generate: async ({ onToken }) => {
          for (const ch of wrapped) await onToken(ch);
          return { text: wrapped, aborted: false };
        },
      });
      const coordinator = createAskCoordinator({ adapter: fakeAdapter({ hits: oneHit() }), embedQuery, countTokens, generationProvider: provider });
      const tokens = [];
      const result = await coordinator.ask({
        collection: 'c', question: 'q', onSources: () => {}, onToken: (t) => tokens.push(t),
      });
      assert.equal(result.status, 'done');
      assert.equal(result.refused, true);
      assert.deepEqual(tokens, [], 'no fragment (including the leading/trailing whitespace) should reach onToken');
    });

    test('a refusal with only trailing whitespace (leading char is real sentinel text) never leaks', async () => {
      const wrapped = `${REFUSAL_SENTINEL}\n\n`;
      const provider = fakeProvider({
        generate: async ({ onToken }) => {
          for (const ch of wrapped) await onToken(ch);
          return { text: wrapped, aborted: false };
        },
      });
      const coordinator = createAskCoordinator({ adapter: fakeAdapter({ hits: oneHit() }), embedQuery, countTokens, generationProvider: provider });
      const tokens = [];
      const result = await coordinator.ask({
        collection: 'c', question: 'q', onSources: () => {}, onToken: (t) => tokens.push(t),
      });
      assert.equal(result.refused, true);
      assert.deepEqual(tokens, []);
    });

    test('an all-whitespace stream that is never a refusal (never resolves to the sentinel) still flushes on finalize', async () => {
      const answer = '   ';
      const provider = fakeProvider({
        generate: async ({ onToken }) => { await onToken(answer); return { text: answer, aborted: false }; },
      });
      const coordinator = createAskCoordinator({ adapter: fakeAdapter({ hits: oneHit() }), embedQuery, countTokens, generationProvider: provider });
      const tokens = [];
      const result = await coordinator.ask({
        collection: 'c', question: 'q', onSources: () => {}, onToken: (t) => tokens.push(t),
      });
      assert.equal(result.status, 'done');
      assert.equal(result.refused, false);
      assert.equal(tokens.join(''), answer);
    });

    test('client disconnect while onToken is backpressure-blocked does not hang generate() forever', async () => {
      // Regression: waitForDrain() (src/core/http/sse.js) previously only
      // listened for 'drain' — a client that disconnects while the write
      // buffer is full never fires 'drain', so the promise the coordinator
      // was awaiting inside onToken() hung forever, generate() never
      // resolved, and the coordinator's finally{} never ran (busy stayed
      // true for the rest of the process). This test simulates onToken
      // itself hanging (as it would while awaiting a drain that never
      // comes) and asserts the coordinator's OWN signal-driven abort path
      // is what unblocks it — generate() must observe the abort and return
      // rather than depend on onToken ever resolving on its own.
      const controller = new AbortController();
      const provider = fakeProvider({
        generate: ({ signal, onToken }) => new Promise((resolve) => {
          // Simulate: onToken was called and is now hung (as a real
          // pre-fix waitForDrain() would hang after a disconnect) — but
          // the provider itself still observes the abort signal
          // independently (generateStream()'s fetch is aborted directly),
          // which is what actually breaks the deadlock in production.
          onToken('partial');
          signal.addEventListener('abort', () => resolve({ text: 'partial', aborted: true }));
        }),
      });
      const coordinator = createAskCoordinator({ adapter: fakeAdapter({ hits: oneHit() }), embedQuery, countTokens, generationProvider: provider });
      const askPromise = coordinator.ask({ collection: 'c', question: 'q', signal: controller.signal, onSources: () => {}, onToken: () => new Promise(() => {}) });
      await new Promise((r) => setImmediate(r));
      controller.abort();
      const result = await askPromise;
      assert.equal(result.status, 'aborted');
      assert.equal(coordinator.isBusy(), false);
    });
  });

  describe('context budget enforcement against the provider\'s numCtx', () => {
    function manyHits(n) {
      return Array.from({ length: n }, (_, i) => ({
        sourceFile: `doc${i}.md`, chunkIndex: i, section: `S${i}`,
        text: Array.from({ length: 40 }, (_, w) => `word${i}_${w}`).join(' '), nodeId: null,
      }));
    }

    test('drops lowest-ranked sources to fit a small numCtx, renumbers, and reports fewer sources to onSources', async () => {
      // RESERVED_HEADROOM_TOKENS is 1024, so numCtx must exceed that before
      // any evidence budget remains; each hit's text is ~40 words (~40
      // countTokens units), so a budget of a few hundred tokens above
      // headroom fits some but not all 5 sources plus system+user prompt
      // overhead (the system instruction's own token count grew when the
      // prompt-injection-resistance rules were added — this budget was
      // re-measured against the current buildPromptParts() output, not
      // guessed, so it stays a real "some but not all" case rather than an
      // arbitrary number that happens to pass).
      const provider = fakeProvider({
        ready: async () => ({ ok: true, model: 'gemma3:4b', numCtx: 1024 + 300 }),
        generate: async () => ({ text: 'ok [1].', aborted: false }),
      });
      const coordinator = createAskCoordinator({
        adapter: fakeAdapter({ hits: manyHits(5) }), embedQuery, countTokens, generationProvider: provider,
      });
      let sourcesPayload;
      const result = await coordinator.ask({
        collection: 'c', question: 'q', top: 5, onSources: (p) => { sourcesPayload = p; }, onToken: () => {},
      });
      assert.ok(sourcesPayload.sources.length < 5, `expected fewer than 5 sources to survive a tight budget, got ${sourcesPayload.sources.length}`);
      assert.deepEqual(sourcesPayload.sources.map(s => s.n), sourcesPayload.sources.map((_, i) => i + 1));
      assert.equal(result.status, 'done');
      assert.equal(result.evidenceCount, sourcesPayload.sources.length);
    });

    test('a numCtx too small for even one source results in a no_evidence refusal, never calling generate', async () => {
      let generateCalled = false;
      const provider = fakeProvider({
        ready: async () => ({ ok: true, model: 'gemma3:4b', numCtx: 10 }), // smaller than RESERVED_HEADROOM_TOKENS
        generate: async () => { generateCalled = true; return { text: '' }; },
      });
      const coordinator = createAskCoordinator({
        adapter: fakeAdapter({ hits: manyHits(3) }), embedQuery, countTokens, generationProvider: provider,
      });
      const result = await coordinator.ask({ collection: 'c', question: 'q', onSources: () => {}, onToken: () => {} });
      assert.equal(result.status, 'refused');
      assert.equal(generateCalled, false);
    });

    test('does not trim when numCtx is undefined (provider did not report one)', async () => {
      const provider = fakeProvider({
        ready: async () => ({ ok: true, model: 'gemma3:4b' }), // no numCtx field
        generate: async () => ({ text: 'ok [1].', aborted: false }),
      });
      const coordinator = createAskCoordinator({
        adapter: fakeAdapter({ hits: manyHits(5) }), embedQuery, countTokens, generationProvider: provider,
      });
      let sourcesPayload;
      await coordinator.ask({ collection: 'c', question: 'q', top: 5, onSources: (p) => { sourcesPayload = p; }, onToken: () => {} });
      assert.equal(sourcesPayload.sources.length, 5);
    });
  });

  test('searchMode reflects that hybrid search ran even when zero hits came back (not sourced from array length)', async () => {
    let sourcesPayload;
    const coordinator = createAskCoordinator({
      adapter: fakeAdapter({ hits: [] }), embedQuery, countTokens, generationProvider: fakeProvider(),
    });
    await coordinator.ask({ collection: 'c', question: 'q', onSources: (p) => { sourcesPayload = p; }, onToken: () => {} });
    assert.equal(sourcesPayload.searchMode, 'hybrid');
    assert.deepEqual(sourcesPayload.sources, []);
  });

  test('passes readiness.numCtx through to generate() as options.num_ctx — the same figure the context budget was computed against', async () => {
    let capturedOptions;
    const provider = fakeProvider({
      ready: async () => ({ ok: true, model: 'gemma3:4b', numCtx: 4096 }),
      generate: async ({ options }) => { capturedOptions = options; return { text: 'ok [1].', aborted: false }; },
    });
    const coordinator = createAskCoordinator({ adapter: fakeAdapter({ hits: oneHit() }), embedQuery, countTokens, generationProvider: provider });
    await coordinator.ask({ collection: 'c', question: 'q', onSources: () => {}, onToken: () => {} });
    assert.deepEqual(capturedOptions, { num_ctx: 4096 });
  });

  test('does not pass options at all when readiness.numCtx is undefined', async () => {
    let capturedOptions = 'not called';
    const provider = fakeProvider({
      ready: async () => ({ ok: true, model: 'gemma3:4b' }), // no numCtx
      generate: async ({ options }) => { capturedOptions = options; return { text: 'ok [1].', aborted: false }; },
    });
    const coordinator = createAskCoordinator({ adapter: fakeAdapter({ hits: oneHit() }), embedQuery, countTokens, generationProvider: provider });
    await coordinator.ask({ collection: 'c', question: 'q', onSources: () => {}, onToken: () => {} });
    assert.equal(capturedOptions, undefined);
  });
});
