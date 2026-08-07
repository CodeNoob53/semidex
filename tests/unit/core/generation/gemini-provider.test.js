import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createGeminiProvider } from '../../../../src/cloud/generation/gemini-provider.js';
import { validateGenerationProvider } from '../../../../src/core/generation/provider.js';

function stubClient({ getFn, streamFn } = {}) {
  return () => ({
    models: {
      get: getFn ?? (async ({ model }) => ({ name: model, inputTokenLimit: 1_000_000, supportedActions: ['generateContent'] })),
      generateContentStream: streamFn ?? (async () => {
        async function* gen() {
          yield { text: 'hello ' };
          yield { text: 'world', usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } };
        }
        return gen();
      }),
    },
  });
}

describe('createGeminiProvider', () => {
  test('conforms to the GenerationProvider shape', () => {
    const provider = createGeminiProvider({ apiKey: 'k', createClientFn: stubClient() });
    assert.equal(validateGenerationProvider(provider), true);
    assert.equal(provider.name(), 'gemini');
    // upstreamCancellation is honestly false here — Gemini's
    // config.abortSignal is SDK-documented as client-only (see
    // gemini-provider.js's own capabilities() comment); only Ollama's
    // fetch-based abort genuinely tears down the upstream connection.
    assert.deepEqual(provider.capabilities(), { streaming: true, clientAbort: true, upstreamCancellation: false });
  });

  test('never reads process.env directly', async () => {
    const src = await readFile(new URL('../../../../src/cloud/generation/gemini-provider.js', import.meta.url), 'utf-8');
    assert.ok(!/process\.env\./.test(src), 'gemini-provider.js must not read any process.env.* value');
  });

  describe('ready()', () => {
    test('reports not ok when GEMINI_API_KEY is missing — never crashes', async () => {
      const provider = createGeminiProvider({ apiKey: '', createClientFn: stubClient() });
      const result = await provider.ready();
      assert.equal(result.ok, false);
      assert.match(result.reason, /GEMINI_API_KEY is not set/);
    });

    test('reports not ok when no model is configured', async () => {
      const provider = createGeminiProvider({ apiKey: 'k', model: '', createClientFn: stubClient() });
      const result = await provider.ready();
      assert.equal(result.ok, false);
      assert.match(result.reason, /No Gemini model is configured/);
    });

    test('reports not ok when the model is not available to this API key', async () => {
      const provider = createGeminiProvider({
        apiKey: 'k', model: 'gemini-2.5-flash',
        createClientFn: stubClient({ getFn: async () => { throw new Error('404 model not found'); } }),
      });
      const result = await provider.ready();
      assert.equal(result.ok, false);
      assert.match(result.reason, /is not available to this Gemini API key/);
    });

    test('reports not ok when the model does not support generateContent', async () => {
      const provider = createGeminiProvider({
        apiKey: 'k', model: 'embedding-only-model',
        createClientFn: stubClient({ getFn: async ({ model }) => ({ name: model, supportedActions: ['embedContent'] }) }),
      });
      const result = await provider.ready();
      assert.equal(result.ok, false);
      assert.match(result.reason, /does not support text generation/);
    });

    test('fails open (does not guess unsupported) when supportedActions is absent from the response', async () => {
      const provider = createGeminiProvider({
        apiKey: 'k', model: 'gemini-2.5-flash',
        createClientFn: stubClient({ getFn: async ({ model }) => ({ name: model, inputTokenLimit: 1000 }) }),
      });
      const result = await provider.ready();
      assert.equal(result.ok, true);
    });

    test('reports ok with numCtx capped by the model\'s real inputTokenLimit', async () => {
      const provider = createGeminiProvider({
        apiKey: 'k', model: 'small-context-model', askNumCtx: 8192,
        createClientFn: stubClient({ getFn: async ({ model }) => ({ name: model, inputTokenLimit: 2048, supportedActions: ['generateContent'] }) }),
      });
      const result = await provider.ready();
      assert.deepEqual(result, { ok: true, model: 'small-context-model', numCtx: 2048 });
    });

    test('reports ok with numCtx capped by askNumCtx when the model supports far more', async () => {
      const provider = createGeminiProvider({
        apiKey: 'k', model: 'gemini-2.5-flash', askNumCtx: 8192,
        createClientFn: stubClient({ getFn: async ({ model }) => ({ name: model, inputTokenLimit: 1_000_000, supportedActions: ['generateContent'] }) }),
      });
      const result = await provider.ready();
      assert.equal(result.numCtx, 8192);
    });

    test('falls back to askNumCtx (never guesses) when inputTokenLimit is missing from the model response', async () => {
      const provider = createGeminiProvider({
        apiKey: 'k', model: 'gemini-2.5-flash', askNumCtx: 4096,
        createClientFn: stubClient({ getFn: async ({ model }) => ({ name: model, supportedActions: ['generateContent'] }) }),
      });
      const result = await provider.ready();
      assert.equal(result.numCtx, 4096);
    });

    test('redacts the API key out of a client-initialization failure reason', async () => {
      const provider = createGeminiProvider({
        apiKey: 'super-secret-key-123',
        createClientFn: () => { throw new Error('bad request with super-secret-key-123 embedded'); },
      });
      const result = await provider.ready();
      assert.equal(result.ok, false);
      assert.ok(!result.reason.includes('super-secret-key-123'), 'reason must not contain the raw API key');
      assert.match(result.reason, /\[REDACTED\]/);
    });

    test('redacts the API key out of a models.get() failure reason', async () => {
      const provider = createGeminiProvider({
        apiKey: 'my-real-key-999', model: 'gemini-2.5-flash',
        createClientFn: stubClient({ getFn: async () => { throw new Error('401: key my-real-key-999 is invalid'); } }),
      });
      const result = await provider.ready();
      assert.ok(!result.reason.includes('my-real-key-999'));
      assert.match(result.reason, /\[REDACTED\]/);
    });
  });

  describe('generate()', () => {
    test('streams text deltas via onToken and returns the full accumulated text', async () => {
      const provider = createGeminiProvider({ apiKey: 'k', model: 'gemini-2.5-flash', createClientFn: stubClient() });
      const tokens = [];
      const result = await provider.generate({ prompt: 'hi', onToken: (t) => tokens.push(t) });
      assert.deepEqual(tokens, ['hello ', 'world']);
      assert.equal(result.text, 'hello world');
      assert.equal(result.aborted, false);
    });

    test('onToken is called only for chunks with actual text (never for empty/undefined deltas)', async () => {
      const provider = createGeminiProvider({
        apiKey: 'k', model: 'gemini-2.5-flash',
        createClientFn: stubClient({
          streamFn: async () => {
            async function* gen() {
              yield { text: 'a' };
              yield {}; // no text field — must not fire onToken or corrupt accumulation
              yield { text: '' }; // empty string — falsy, must not fire onToken
              yield { text: 'b' };
            }
            return gen();
          },
        }),
      });
      const tokens = [];
      const result = await provider.generate({ prompt: 'hi', onToken: (t) => tokens.push(t) });
      assert.deepEqual(tokens, ['a', 'b']);
      assert.equal(result.text, 'ab');
    });

    test('returns usage metadata (tokensIn/tokensOut) when the API exposes it', async () => {
      const provider = createGeminiProvider({ apiKey: 'k', model: 'gemini-2.5-flash', createClientFn: stubClient() });
      const result = await provider.generate({ prompt: 'hi' });
      assert.equal(result.tokensIn, 5);
      assert.equal(result.tokensOut, 2);
    });

    test('a requested model overrides the provider default', async () => {
      let capturedModel;
      const provider = createGeminiProvider({
        apiKey: 'k', model: 'default-model',
        createClientFn: stubClient({
          streamFn: async ({ model }) => {
            capturedModel = model;
            async function* gen() { yield { text: 'x' }; }
            return gen();
          },
        }),
      });
      await provider.generate({ prompt: 'hi', model: 'requested-model' });
      assert.equal(capturedModel, 'requested-model');
    });

    test('passes only Gemini-relevant options through (temperature/maxOutputTokens), never an Ollama-shaped num_ctx', async () => {
      let capturedConfig;
      const provider = createGeminiProvider({
        apiKey: 'k', model: 'gemini-2.5-flash',
        createClientFn: stubClient({
          streamFn: async ({ config }) => {
            capturedConfig = config;
            async function* gen() { yield { text: 'x' }; }
            return gen();
          },
        }),
      });
      await provider.generate({ prompt: 'hi', options: { temperature: 0.5, maxOutputTokens: 100, num_ctx: 8192 } });
      assert.equal(capturedConfig.temperature, 0.5);
      assert.equal(capturedConfig.maxOutputTokens, 100);
      assert.equal(capturedConfig.num_ctx, undefined, 'num_ctx is an Ollama-only concept and must never reach Gemini');
    });

    describe('systemInstruction (native system-instruction mapping)', () => {
      test('systemPrompt maps to config.systemInstruction — never appears in contents', async () => {
        let capturedCall;
        const provider = createGeminiProvider({
          apiKey: 'k', model: 'gemini-2.5-flash',
          createClientFn: stubClient({
            streamFn: async (call) => {
              capturedCall = call;
              async function* gen() { yield { text: 'x' }; }
              return gen();
            },
          }),
        });
        await provider.generate({ systemPrompt: 'Answer using only the evidence.', prompt: 'Evidence:\n...\n\nQuestion: q' });
        assert.equal(capturedCall.config.systemInstruction, 'Answer using only the evidence.');
        assert.equal(capturedCall.contents, 'Evidence:\n...\n\nQuestion: q');
        assert.ok(!String(capturedCall.contents).includes('Answer using only the evidence.'), 'the system instruction text must never appear inside contents');
      });

      test('contents never contains the fake "System:" prefix — it carries only the user prompt', async () => {
        let capturedCall;
        const provider = createGeminiProvider({
          apiKey: 'k', model: 'gemini-2.5-flash',
          createClientFn: stubClient({
            streamFn: async (call) => {
              capturedCall = call;
              async function* gen() { yield { text: 'x' }; }
              return gen();
            },
          }),
        });
        await provider.generate({ systemPrompt: 'You are a grounded QA assistant.', prompt: 'Evidence:\n[1] (a.md)\ntext\n\nQuestion: q' });
        assert.ok(!/^System:/m.test(capturedCall.contents), 'contents must never contain a "System:" section — that instruction lives only in config.systemInstruction');
      });

      test('omits config.systemInstruction entirely when no systemPrompt is supplied (backward-compatible, non-Ask caller)', async () => {
        let capturedCall;
        const provider = createGeminiProvider({
          apiKey: 'k', model: 'gemini-2.5-flash',
          createClientFn: stubClient({
            streamFn: async (call) => {
              capturedCall = call;
              async function* gen() { yield { text: 'x' }; }
              return gen();
            },
          }),
        });
        await provider.generate({ prompt: 'hi' });
        // No config object at all is sent when no generationConfig fields
        // were set (matches the existing "no options at all" behavior) —
        // either way, systemInstruction must not appear.
        assert.equal(capturedCall.config?.systemInstruction, undefined);
      });

      test('systemInstruction coexists with temperature/maxOutputTokens/abortSignal in the same config object', async () => {
        let capturedCall;
        const provider = createGeminiProvider({
          apiKey: 'k', model: 'gemini-2.5-flash',
          createClientFn: stubClient({
            streamFn: async (call) => {
              capturedCall = call;
              async function* gen() { yield { text: 'x' }; }
              return gen();
            },
          }),
        });
        const controller = new AbortController();
        await provider.generate({
          systemPrompt: 'sys', prompt: 'hi', signal: controller.signal,
          options: { temperature: 0.3, maxOutputTokens: 50 },
        });
        assert.equal(capturedCall.config.systemInstruction, 'sys');
        assert.equal(capturedCall.config.temperature, 0.3);
        assert.equal(capturedCall.config.maxOutputTokens, 50);
        assert.equal(capturedCall.config.abortSignal, controller.signal);
      });

      test('never leaks the API key when systemPrompt is supplied and generateContentStream fails', async () => {
        const provider = createGeminiProvider({
          apiKey: 'do-not-leak-777', model: 'gemini-2.5-flash',
          createClientFn: stubClient({ streamFn: async () => { throw new Error('upstream error mentioning do-not-leak-777'); } }),
        });
        await assert.rejects(async () => {
          try {
            await provider.generate({ systemPrompt: 'sys', prompt: 'hi' });
          } catch (err) {
            assert.ok(!err.message.includes('do-not-leak-777'));
            assert.match(err.message, /\[REDACTED\]/);
            throw err;
          }
        });
      });
    });

    test('throws when called without a configured API key', async () => {
      const provider = createGeminiProvider({ apiKey: '', model: 'gemini-2.5-flash', createClientFn: stubClient() });
      await assert.rejects(() => provider.generate({ prompt: 'hi' }), /GEMINI_API_KEY/);
    });

    test('redacts the API key out of a generateContentStream() failure message', async () => {
      const provider = createGeminiProvider({
        apiKey: 'leak-me-not-42', model: 'gemini-2.5-flash',
        createClientFn: stubClient({ streamFn: async () => { throw new Error('quota exceeded for key leak-me-not-42'); } }),
      });
      await assert.rejects(async () => {
        try {
          await provider.generate({ prompt: 'hi' });
        } catch (err) {
          assert.ok(!err.message.includes('leak-me-not-42'));
          assert.match(err.message, /\[REDACTED\]/);
          throw err;
        }
      });
    });

    describe('cancellation', () => {
      test('returns aborted:true with no text when the signal is already aborted before the call', async () => {
        const provider = createGeminiProvider({ apiKey: 'k', model: 'gemini-2.5-flash', createClientFn: stubClient() });
        const controller = new AbortController();
        controller.abort();
        const result = await provider.generate({ prompt: 'hi', signal: controller.signal });
        assert.deepEqual(result, { text: '', aborted: true });
      });

      test('stops consuming the stream and returns accumulated text when aborted mid-stream', async () => {
        const provider = createGeminiProvider({
          apiKey: 'k', model: 'gemini-2.5-flash',
          createClientFn: stubClient({
            streamFn: async () => {
              async function* gen() {
                yield { text: 'a' };
                yield { text: 'b' };
                yield { text: 'c' };
              }
              return gen();
            },
          }),
        });
        const controller = new AbortController();
        let count = 0;
        const result = await provider.generate({
          prompt: 'hi',
          signal: controller.signal,
          onToken: () => { count += 1; if (count === 1) controller.abort(); },
        });
        assert.equal(result.aborted, true);
        assert.equal(result.text, 'a');
        assert.equal(count, 1, 'must stop consuming further chunks once aborted — not claim to abort upstream, just stop listening');
      });

      test('passes the caller\'s signal through as config.abortSignal (the SDK\'s real, documented, client-only cancellation hook)', async () => {
        let capturedSignal;
        const provider = createGeminiProvider({
          apiKey: 'k', model: 'gemini-2.5-flash',
          createClientFn: stubClient({
            streamFn: async ({ config }) => {
              capturedSignal = config?.abortSignal;
              async function* gen() { yield { text: 'x' }; }
              return gen();
            },
          }),
        });
        const controller = new AbortController();
        await provider.generate({ prompt: 'hi', signal: controller.signal });
        assert.equal(capturedSignal, controller.signal);
      });
    });
  });
});
