// Gemini GenerationProvider (Stage B1) — the second generation backend
// alongside ollama-provider.js. Uses the official @google/genai SDK's
// ai.models.generateContentStream() (NOT the newer Interactions API — see
// docs/admin-api-phase4a5d-gemini-generation-provider-2026-07-18.md for why:
// generateContentStream has a confirmed, documented streaming/text-delta
// contract; the Interactions API's cancellation semantics could not be
// confirmed from official docs at implementation time).
//
// No process.env reads anywhere in this file (matches ollama-provider.js) —
// apiKey/model/askNumCtx are supplied by the caller (generation/runtime.js,
// via generation/registry.js's options passthrough).
//
// Cancellation: generateContentStream()'s config accepts an `abortSignal`
// field (confirmed directly against the installed @google/genai package's
// own .d.ts — GenerateContentConfig.abortSignal), which this provider
// passes the caller's signal through to. That field's own doc comment is
// explicit that it is CLIENT-ONLY: "Using it to cancel an operation will
// not cancel the request in the service. You will still be charged usage
// for any applicable operations." This provider's aborted:true therefore
// means "we stopped consuming/paying attention to the stream", never proof
// that upstream generation itself halted — a real, documented capability
// difference from Ollama (whose fetch-based stream genuinely aborts the
// underlying HTTP request via `signal`), reported honestly rather than
// papered over.
const FALLBACK_MODEL = 'gemini-2.5-flash';

// Same conservative default as Ollama's FALLBACK_ASK_NUM_CTX — only used
// when a caller constructs this provider without resolving real config
// first (tests, or a future caller). The real production caller
// (generation/runtime.js) always supplies askNumCtx from
// resolveGenerationRuntimeConfig()'s ASK_NUM_CTX.
const FALLBACK_ASK_NUM_CTX = 8192;

// Gemini's API has no request-level context-window-size parameter (no
// num_ctx equivalent — confirmed: GenerateContentConfig has no field that
// bounds the model's effective input window; the only relevant number is
// the model's own read-only inputTokenLimit metadata). This provider
// therefore never sends anything resembling num_ctx to Gemini — numCtx is
// used ONLY to report a capped `numCtx` in ready() so the Ask coordinator's
// context-budget math (fitEvidenceToContextBudget) has a number to bound
// the prompt against, exactly mirroring what Ollama's provider reports,
// without implying Gemini enforces it server-side the way Ollama does.
function redactApiKeyFromMessage(message, apiKey) {
  if (!message) return message;
  let out = String(message);
  if (apiKey) out = out.split(apiKey).join('[REDACTED]');
  return out;
}

/**
 * @param {{
 *   apiKey?: string,
 *   model?: string,
 *   askNumCtx?: number,
 *   createClientFn?: (opts: { apiKey: string }) => Object,
 * }} [opts] apiKey/model/askNumCtx fall back to safe, non-env-derived
 *   values ONLY so this factory remains callable in isolation (tests) —
 *   the real production path always supplies all three from
 *   resolveGenerationRuntimeConfig(). createClientFn is DI-only: unit tests
 *   inject a stub client so no real @google/genai network call is ever
 *   made; production callers never pass it, so the real SDK client is
 *   always constructed.
 * @returns {import('./provider.js').GenerationProvider}
 */
export function createGeminiProvider({
  apiKey = '',
  model = FALLBACK_MODEL,
  askNumCtx = FALLBACK_ASK_NUM_CTX,
  createClientFn,
} = {}) {
  // The client is constructed lazily (on first ready()/generate() call),
  // not eagerly here — constructing createGeminiProvider() must never throw
  // or attempt network/module work just because GEMINI_API_KEY is missing;
  // that state is reported as ready:false, matching the task's "missing
  // key/model produces ready:false, not an admin-server crash" requirement.
  let client = null;
  let clientInitError = null;

  async function getClient() {
    if (client || clientInitError) return client;
    if (!createClientFn) {
      try {
        const { GoogleGenAI } = await import('@google/genai');
        client = new GoogleGenAI({ apiKey });
      } catch (err) {
        clientInitError = err;
      }
    } else {
      try {
        client = createClientFn({ apiKey });
      } catch (err) {
        clientInitError = err;
      }
    }
    return client;
  }

  return {
    name: () => 'gemini',

    // upstreamCancellation: false — config.abortSignal (passed to
    // generateContentStream() below) is documented by the SDK itself as
    // client-only: aborting it stops THIS process from consuming further
    // output, but does not stop Google's servers from continuing to
    // generate or from billing for it. clientAbort:true is still honest
    // (this provider does genuinely stop reading/returning tokens on
    // abort) — the two must not be collapsed into one boolean, or a
    // caller has no way to know "cancel" here is weaker than Ollama's.
    capabilities: () => ({ streaming: true, clientAbort: true, upstreamCancellation: false }),

    async ready() {
      if (!apiKey) {
        return { ok: false, reason: 'GEMINI_API_KEY is not set. Generation via Gemini is unavailable until it is configured.', model };
      }
      if (!model) {
        return { ok: false, reason: 'No Gemini model is configured (ASK_MODEL).', model: null };
      }
      const c = await getClient();
      if (!c) {
        return {
          ok: false,
          reason: `Failed to initialize the Gemini client: ${redactApiKeyFromMessage(clientInitError?.message, apiKey)}`,
          model,
        };
      }
      let modelInfo;
      try {
        modelInfo = await c.models.get({ model });
      } catch (err) {
        return {
          ok: false,
          reason: `Model "${model}" is not available to this Gemini API key: ${redactApiKeyFromMessage(err.message, apiKey)}`,
          model,
        };
      }
      const supportsGenerate = Array.isArray(modelInfo?.supportedActions)
        ? modelInfo.supportedActions.includes('generateContent')
        : true; // fail open if the field isn't present — never guess a model is unsupported from its absence
      if (!supportsGenerate) {
        return { ok: false, reason: `Model "${model}" does not support text generation.`, model };
      }
      // Cap the reported numCtx by the model's real inputTokenLimit when
      // the API exposes it (it does, per models.get()'s documented
      // response shape) — mirrors Ollama's provider capping askNumCtx by
      // getModelContextLength()'s result, so the coordinator's
      // context-budget math is bounded by the SAME kind of real ceiling
      // regardless of backend. Falls back to the raw askNumCtx if the
      // field is missing rather than guessing a number.
      const modelMax = typeof modelInfo?.inputTokenLimit === 'number' ? modelInfo.inputTokenLimit : askNumCtx;
      const numCtx = Math.min(askNumCtx, modelMax);
      return { ok: true, model, numCtx };
    },

    async generate({ prompt, model: requestedModel, options, signal, onToken }) {
      const effectiveModel = requestedModel ?? model;
      if (!apiKey) {
        throw new Error('Gemini generate() called without a configured GEMINI_API_KEY.');
      }
      const c = await getClient();
      if (!c) {
        throw new Error(`Gemini client is not initialized: ${redactApiKeyFromMessage(clientInitError?.message, apiKey)}`);
      }
      if (signal?.aborted) return { text: '', aborted: true };

      // Only pass Gemini-relevant fields through — never forward an
      // Ollama-shaped `options.num_ctx` or similar (there is no Gemini
      // equivalent to send it as). temperature/maxOutputTokens are the
      // only generationConfig fields this provider recognizes today.
      const generationConfig = {};
      if (options?.temperature !== undefined) generationConfig.temperature = options.temperature;
      if (options?.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = options.maxOutputTokens;
      // config.abortSignal is the real, SDK-documented cancellation hook
      // (confirmed directly against the installed @google/genai package's
      // own type declarations: GenerateContentConfig.abortSignal exists).
      // Its own doc comment is explicit that this is CLIENT-ONLY: "Using it
      // to cancel an operation will not cancel the request in the service.
      // You will still be charged usage for any applicable operations." So
      // passing it through is strictly better than not (it stops the SDK
      // from doing any further work/buffering client-side the moment the
      // caller aborts) but this provider still reports aborted:true as "we
      // stopped consuming/paying attention", never as proof the upstream
      // generation itself halted — matching Ollama's provider is honest
      // about a genuine difference in capability, not pretending the two
      // backends behave identically.
      if (signal) generationConfig.abortSignal = signal;

      let stream;
      try {
        stream = await c.models.generateContentStream({
          model: effectiveModel,
          contents: prompt,
          ...(Object.keys(generationConfig).length > 0 ? { config: generationConfig } : {}),
        });
      } catch (err) {
        if (signal?.aborted) return { text: '', aborted: true };
        throw new Error(`Gemini generateContentStream failed: ${redactApiKeyFromMessage(err.message, apiKey)}`);
      }

      let text = '';
      let tokensIn;
      let tokensOut;
      try {
        for await (const chunk of stream) {
          // Belt-and-suspenders: config.abortSignal should already stop
          // the SDK from yielding further chunks once aborted, but this
          // loop also checks explicitly so an abort is honored even if a
          // chunk was already in flight when the signal fired.
          if (signal?.aborted) return { text, tokensIn, tokensOut, aborted: true };
          const delta = chunk?.text;
          if (delta) {
            text += delta;
            await onToken?.(delta);
          }
          const usage = chunk?.usageMetadata;
          if (usage) {
            if (typeof usage.promptTokenCount === 'number') tokensIn = usage.promptTokenCount;
            if (typeof usage.candidatesTokenCount === 'number') tokensOut = usage.candidatesTokenCount;
          }
        }
      } catch (err) {
        if (signal?.aborted) return { text, tokensIn, tokensOut, aborted: true };
        throw new Error(`Gemini generateContentStream failed while reading response: ${redactApiKeyFromMessage(err.message, apiKey)}`);
      }

      return { text, tokensIn, tokensOut, aborted: false };
    },
  };
}
