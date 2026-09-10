// gemini-model-probe.js — offline, against a FAKE @google/genai client.
//
// The error shapes asserted here are the REAL ones observed against the
// live API on 2026-09-10, not invented fixtures:
//   - gemini-2.5-flash  -> 404 "no longer available to new users …"
//   - unknown model     -> 404 "not found for API version v1beta …"
//   - deep-research-*   -> 400 "This model only supports Interactions API."
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { probeGeminiModel, classifyModelProbeError, MODEL_PROBE_STATUS } from '../../../../src/cloud/generation/gemini-model-probe.js';

/** Reproduces how @google/genai surfaces an upstream error: JSON body inside .message. */
function sdkError(code, message) {
  const body = JSON.stringify({ error: { message, code, status: 'ERROR' } });
  const err = new Error(JSON.stringify({ error: { message: body, code, status: 'ERROR' } }));
  err.status = code;
  return err;
}

function fakeClient({ onGenerate } = {}) {
  return () => ({ models: { generateContent: onGenerate ?? (async () => ({ text: 'ok' })) } });
}

describe('probeGeminiModel — success', () => {
  it('reports available when a real generateContent call succeeds', async () => {
    const result = await probeGeminiModel({ apiKey: 'k', model: 'gemini-3.6-flash', createClientFn: fakeClient() });
    assert.deepEqual(result, { model: 'gemini-3.6-flash', status: MODEL_PROBE_STATUS.AVAILABLE, detail: null });
  });

  it('sends a minimal 1-token request — a verification must not be an expensive generation', async () => {
    let captured;
    await probeGeminiModel({
      apiKey: 'k', model: 'm',
      createClientFn: fakeClient({ onGenerate: async (req) => { captured = req; return { text: '' }; } }),
    });
    assert.equal(captured.model, 'm');
    assert.equal(captured.config.maxOutputTokens, 1);
  });
});

describe('probeGeminiModel — classification', () => {
  it('a retired model (404 "no longer available") is reported retired, with the replacement preserved', async () => {
    const message = 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.6-flash for the latest features.';
    const result = await probeGeminiModel({
      apiKey: 'k', model: 'gemini-2.5-flash',
      createClientFn: fakeClient({ onGenerate: async () => { throw sdkError(404, message); } }),
    });
    assert.equal(result.status, MODEL_PROBE_STATUS.RETIRED);
    assert.match(result.detail, /no longer available to new users/);
    assert.match(result.detail, /gemini-3\.6-flash/,
      'the replacement the API names is the most useful part of the message and must survive');
  });

  it('an unknown model name (also 404) is reported the same way — both mean "you cannot use this"', async () => {
    const result = await probeGeminiModel({
      apiKey: 'k', model: 'no-such-model',
      createClientFn: fakeClient({ onGenerate: async () => { throw sdkError(404, 'models/no-such-model is not found for API version v1beta.'); } }),
    });
    assert.equal(result.status, MODEL_PROBE_STATUS.RETIRED);
  });

  it('a 400 (different API surface) is unsupported, NOT retired', async () => {
    const result = await probeGeminiModel({
      apiKey: 'k', model: 'deep-research-preview',
      createClientFn: fakeClient({ onGenerate: async () => { throw sdkError(400, 'This model only supports Interactions API.'); } }),
    });
    assert.equal(result.status, MODEL_PROBE_STATUS.UNSUPPORTED);
    assert.match(result.detail, /Interactions API/);
  });

  it('a 429 quota error is UNKNOWN — it says nothing about the model', async () => {
    const result = await probeGeminiModel({
      apiKey: 'k', model: 'gemini-3.6-flash',
      createClientFn: fakeClient({ onGenerate: async () => { throw sdkError(429, 'Resource has been exhausted (e.g. check quota).'); } }),
    });
    assert.equal(result.status, MODEL_PROBE_STATUS.UNKNOWN,
      'a throttled key must never be reported as a dead model — that would hide a working one');
  });

  it('a 5xx is UNKNOWN, not a verdict', async () => {
    const result = await probeGeminiModel({
      apiKey: 'k', model: 'm',
      createClientFn: fakeClient({ onGenerate: async () => { throw sdkError(503, 'The service is currently unavailable.'); } }),
    });
    assert.equal(result.status, MODEL_PROBE_STATUS.UNKNOWN);
  });

  it('a 401/403 is reported as a key problem, not a model problem', async () => {
    for (const code of [401, 403]) {
      const result = await probeGeminiModel({
        apiKey: 'k', model: 'm',
        createClientFn: fakeClient({ onGenerate: async () => { throw sdkError(code, 'API key not valid.'); } }),
      });
      assert.equal(result.status, MODEL_PROBE_STATUS.UNAUTHORIZED);
    }
  });

  it('an unrecognized error shape falls back to UNKNOWN rather than guessing a verdict', async () => {
    const result = await probeGeminiModel({
      apiKey: 'k', model: 'm',
      createClientFn: fakeClient({ onGenerate: async () => { throw new Error('socket hang up'); } }),
    });
    assert.equal(result.status, MODEL_PROBE_STATUS.UNKNOWN);
  });
});

describe('probeGeminiModel — inputs and secrecy', () => {
  it('reports unauthorized (never a model verdict) when no API key is configured, without calling the SDK', async () => {
    let called = false;
    const result = await probeGeminiModel({
      apiKey: '', model: 'm',
      createClientFn: fakeClient({ onGenerate: async () => { called = true; return {}; } }),
    });
    assert.equal(result.status, MODEL_PROBE_STATUS.UNAUTHORIZED);
    assert.equal(called, false);
  });

  it('reports unknown for a missing model name', async () => {
    const result = await probeGeminiModel({ apiKey: 'k', model: '', createClientFn: fakeClient() });
    assert.equal(result.status, MODEL_PROBE_STATUS.UNKNOWN);
  });

  it('never echoes the API key in a surfaced detail', async () => {
    const apiKey = 'super-secret-key-value';
    const result = await probeGeminiModel({
      apiKey, model: 'm',
      createClientFn: fakeClient({ onGenerate: async () => { throw sdkError(404, `request with key ${apiKey} failed`); } }),
    });
    assert.ok(!String(result.detail).includes(apiKey), 'the API key must never appear in an operator-facing message');
  });

  it('a client construction failure is UNKNOWN, not a model verdict', async () => {
    const result = await probeGeminiModel({
      apiKey: 'k', model: 'm',
      createClientFn: () => { throw new Error('cannot construct'); },
    });
    assert.equal(result.status, MODEL_PROBE_STATUS.UNKNOWN);
  });
});

describe('classifyModelProbeError', () => {
  it('reads the status code from the structured field and from the body as a fallback', () => {
    assert.equal(classifyModelProbeError({ status: 404, message: '' }, 'k').status, MODEL_PROBE_STATUS.RETIRED);
    assert.equal(classifyModelProbeError({ message: '{"error":{"code":429}}' }, 'k').status, MODEL_PROBE_STATUS.UNKNOWN);
    assert.equal(classifyModelProbeError({ message: '{"error":{"code":400}}' }, 'k').status, MODEL_PROBE_STATUS.UNSUPPORTED);
  });
});
