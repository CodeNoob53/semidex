import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaProvider } from '../../../../src/core/generation/ollama-provider.js';
import { validateGenerationProvider } from '../../../../src/core/generation/provider.js';

describe('createOllamaProvider', () => {
  test('conforms to the GenerationProvider shape', () => {
    const provider = createOllamaProvider({ isOllamaReachableFn: async () => true, listOllamaModelsFn: async () => [] });
    assert.equal(validateGenerationProvider(provider), true);
    assert.equal(provider.name(), 'ollama');
    assert.deepEqual(provider.capabilities(), { streaming: true, clientAbort: true, upstreamCancellation: true });
  });

  test('ready() reports not ok when Ollama is unreachable', async () => {
    const provider = createOllamaProvider({
      model: 'gemma3:4b',
      isOllamaReachableFn: async () => false,
      listOllamaModelsFn: async () => { throw new Error('should not be called'); },
    });
    const result = await provider.ready();
    assert.equal(result.ok, false);
    assert.match(result.reason, /not reachable/);
    assert.equal(result.model, 'gemma3:4b');
  });

  test('ready() reports not ok when the required model is missing', async () => {
    const provider = createOllamaProvider({
      model: 'gemma3:4b',
      isOllamaReachableFn: async () => true,
      listOllamaModelsFn: async () => ['llama3.2:3b'],
    });
    const result = await provider.ready();
    assert.equal(result.ok, false);
    assert.match(result.reason, /not installed/);
  });

  test('ready() reports ok when reachable and model present, including numCtx', async () => {
    const provider = createOllamaProvider({
      model: 'gemma3:4b',
      isOllamaReachableFn: async () => true,
      listOllamaModelsFn: async () => ['gemma3:4b', 'other:1b'],
      getModelContextLengthFn: async () => 8192,
    });
    const result = await provider.ready();
    assert.deepEqual(result, { ok: true, model: 'gemma3:4b', numCtx: 8192 });
  });

  test('ready() caps numCtx at the model\'s own architectural maximum when it is smaller than the Ask default', async () => {
    // A small model (e.g. a 4k-context model) must not be asked for more
    // context than it architecturally supports.
    const provider = createOllamaProvider({
      model: 'small:1b',
      isOllamaReachableFn: async () => true,
      listOllamaModelsFn: async () => ['small:1b'],
      getModelContextLengthFn: async () => 4096, // smaller than DEFAULT_ASK_NUM_CTX (8192)
    });
    const result = await provider.ready();
    assert.equal(result.numCtx, 4096);
  });

  test('ready() caps numCtx at the Ask default when the model supports a much larger context', async () => {
    const provider = createOllamaProvider({
      model: 'big:70b',
      isOllamaReachableFn: async () => true,
      listOllamaModelsFn: async () => ['big:70b'],
      getModelContextLengthFn: async () => 131072, // far larger than DEFAULT_ASK_NUM_CTX
    });
    const result = await provider.ready();
    assert.equal(result.numCtx, 8192);
  });

  test('ready() queries getModelContextLengthFn with this provider\'s own baseUrl, not the module default', async () => {
    let capturedBaseUrl;
    const provider = createOllamaProvider({
      model: 'gemma3:4b',
      baseUrl: 'http://custom-host:11500',
      isOllamaReachableFn: async () => true,
      listOllamaModelsFn: async () => ['gemma3:4b'],
      getModelContextLengthFn: async (_model, _fallback, baseUrl) => { capturedBaseUrl = baseUrl; return 8192; },
    });
    await provider.ready();
    assert.equal(capturedBaseUrl, 'http://custom-host:11500');
  });

  test('ready() never calls getModelContextLengthFn when unreachable or model missing (no wasted network call)', async () => {
    let called = false;
    const getModelContextLengthFn = async () => { called = true; return 8192; };

    const unreachable = createOllamaProvider({
      isOllamaReachableFn: async () => false, listOllamaModelsFn: async () => [], getModelContextLengthFn,
    });
    await unreachable.ready();
    assert.equal(called, false);

    const missingModel = createOllamaProvider({
      model: 'gemma3:4b', isOllamaReachableFn: async () => true, listOllamaModelsFn: async () => ['other:1b'], getModelContextLengthFn,
    });
    await missingModel.ready();
    assert.equal(called, false);
  });

  test('ready() surfaces a listOllamaModels failure without throwing', async () => {
    const provider = createOllamaProvider({
      isOllamaReachableFn: async () => true,
      listOllamaModelsFn: async () => { throw new Error('boom'); },
    });
    const result = await provider.ready();
    assert.equal(result.ok, false);
    assert.match(result.reason, /boom/);
  });

  test('generate() delegates to generateStreamFn with the resolved model, baseUrl, prompt, options, signal, onToken', async () => {
    let captured;
    const provider = createOllamaProvider({
      model: 'gemma3:4b',
      baseUrl: 'http://example.invalid:9999',
      generateStreamFn: async (model, prompt, opts) => {
        captured = { model, prompt, opts };
        return { text: 'hello', tokensIn: 10, tokensOut: 2, aborted: false };
      },
    });
    const signal = new AbortController().signal;
    const onToken = () => {};
    const result = await provider.generate({ prompt: 'hi', options: { num_ctx: 8192 }, signal, onToken });
    assert.equal(captured.model, 'gemma3:4b');
    assert.equal(captured.prompt, 'hi');
    assert.equal(captured.opts.baseUrl, 'http://example.invalid:9999');
    assert.equal(captured.opts.options.num_ctx, 8192);
    assert.equal(captured.opts.signal, signal);
    assert.equal(captured.opts.onToken, onToken);
    assert.deepEqual(result, { text: 'hello', tokensIn: 10, tokensOut: 2, aborted: false });
  });

  test('generate() forwards systemPrompt to generateStreamFn as the native "system" option — never concatenated into prompt', async () => {
    let captured;
    const provider = createOllamaProvider({
      model: 'gemma3:4b',
      generateStreamFn: async (model, prompt, opts) => {
        captured = { model, prompt, opts };
        return { text: 'ok', aborted: false };
      },
    });
    await provider.generate({ systemPrompt: 'Answer using only the evidence.', prompt: 'Evidence:\n...\n\nQuestion: q' });
    assert.equal(captured.opts.system, 'Answer using only the evidence.');
    assert.equal(captured.prompt, 'Evidence:\n...\n\nQuestion: q');
    assert.ok(!captured.prompt.includes('Answer using only the evidence.'), 'systemPrompt must never be prepended to the user prompt');
  });

  test('generate() passes system: undefined through to generateStreamFn when no systemPrompt is supplied (backward-compatible, non-Ask caller)', async () => {
    let captured;
    const provider = createOllamaProvider({
      model: 'gemma3:4b',
      generateStreamFn: async (model, prompt, opts) => { captured = opts; return { text: 'ok', aborted: false }; },
    });
    await provider.generate({ prompt: 'hi' });
    assert.equal(captured.system, undefined);
  });

  test('generate() always passes the provider\'s own baseUrl, not the module-level default, to generateStreamFn', async () => {
    // Regression: generate() used to omit baseUrl entirely, so
    // generateStream() silently fell back to the OLLAMA_URL module
    // constant regardless of what baseUrl this provider was constructed
    // with — a provider configured for a non-default Ollama instance would
    // generate against the wrong one.
    let capturedBaseUrl;
    const provider = createOllamaProvider({
      baseUrl: 'http://custom-host:11500',
      generateStreamFn: async (_model, _prompt, opts) => { capturedBaseUrl = opts.baseUrl; return { text: '' }; },
    });
    await provider.generate({ prompt: 'hi' });
    assert.equal(capturedBaseUrl, 'http://custom-host:11500');
  });

  test('generate() defaults options.num_ctx when the caller passes no options at all', async () => {
    let capturedOptions;
    const provider = createOllamaProvider({
      generateStreamFn: async (_model, _prompt, opts) => { capturedOptions = opts.options; return { text: '' }; },
    });
    await provider.generate({ prompt: 'hi' });
    assert.equal(capturedOptions.num_ctx, 8192);
  });

  test('generate() lets an explicit options.num_ctx override the default (e.g. the coordinator\'s readiness.numCtx)', async () => {
    let capturedOptions;
    const provider = createOllamaProvider({
      generateStreamFn: async (_model, _prompt, opts) => { capturedOptions = opts.options; return { text: '' }; },
    });
    await provider.generate({ prompt: 'hi', options: { num_ctx: 4096, temperature: 0.2 } });
    assert.equal(capturedOptions.num_ctx, 4096);
    assert.equal(capturedOptions.temperature, 0.2);
  });

  test('generate() lets an explicit request-level model override the provider default', async () => {
    let capturedModel;
    const provider = createOllamaProvider({
      model: 'gemma3:4b',
      generateStreamFn: async (model) => { capturedModel = model; return { text: '' }; },
    });
    await provider.generate({ prompt: 'hi', model: 'llama3.2:3b' });
    assert.equal(capturedModel, 'llama3.2:3b');
  });
});
