import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentRequestV3, PROTOCOL_LIMITS } from '../../../../src/core/agent-api/v3/request.js';

const TOOLS = [{ name: 't', inputSchema: { type: 'object', properties: {} } }];

function expectCode(body, code) {
  try {
    parseAgentRequestV3(body);
    assert.fail('expected an HttpError');
  } catch (err) {
    assert.equal(err.code, code, err.message);
    return err;
  }
}

describe('parseAgentRequestV3 — start requests', () => {
  it('accepts a minimal start request', () => {
    const parsed = parseAgentRequestV3({ input: 'hi', tools: TOOLS });
    assert.equal(parsed.kind, 'start');
    assert.equal(parsed.input, 'hi');
    assert.equal(parsed.tools, TOOLS);
  });

  it('passes tool definitions through UNVALIDATED — schema validation belongs to the runtime, so a future SDK caller gets identical rules', () => {
    const weird = [{ name: 'x', inputSchema: { type: 'object', properties: { a: { type: 'string', pattern: 'p' } } } }];
    const parsed = parseAgentRequestV3({ input: 'hi', tools: weird });
    assert.equal(parsed.tools, weird);
  });

  it('carries optional systemInstructions, model and the client-lowered ceilings', () => {
    const parsed = parseAgentRequestV3({
      input: 'hi', tools: TOOLS, systemInstructions: 'rules', model: 'gemini-x',
      maxModelSteps: 3, maxToolCalls: 4, maxOutputTokens: 128,
    });
    assert.equal(parsed.systemInstructions, 'rules');
    assert.equal(parsed.model, 'gemini-x');
    assert.equal(parsed.maxModelSteps, 3);
    assert.equal(parsed.maxToolCalls, 4);
    assert.equal(parsed.maxOutputTokens, 128);
  });

  it('rejects a non-object body', () => {
    for (const bad of [null, 'x', 42, []]) expectCode(bad, 'bad_request');
  });

  it('rejects a missing/blank/oversized input', () => {
    expectCode({ tools: TOOLS }, 'bad_request');
    expectCode({ input: '   ', tools: TOOLS }, 'bad_request');
    expectCode({ input: 'x'.repeat(PROTOCOL_LIMITS.maxInputChars + 1), tools: TOOLS }, 'bad_request');
  });

  it('rejects a start request with no tools and names the Ask endpoints instead', () => {
    const err = expectCode({ input: 'hi' }, 'invalid_tool');
    assert.match(err.message, /\/api\/v[12]\/ask/);
  });

  it('rejects oversized systemInstructions and a non-string model', () => {
    expectCode({ input: 'hi', tools: TOOLS, systemInstructions: 'x'.repeat(PROTOCOL_LIMITS.maxInstructionsChars + 1) }, 'bad_request');
    expectCode({ input: 'hi', tools: TOOLS, model: '' }, 'bad_request');
  });

  it('rejects a non-positive-integer ceiling', () => {
    for (const field of ['maxModelSteps', 'maxToolCalls', 'maxOutputTokens']) {
      expectCode({ input: 'hi', tools: TOOLS, [field]: 0 }, 'bad_request');
      expectCode({ input: 'hi', tools: TOOLS, [field]: 1.5 }, 'bad_request');
    }
  });

  it('rejects an unknown top-level key rather than ignoring it', () => {
    expectCode({ input: 'hi', tools: TOOLS, collection: 'docs' }, 'bad_request');
  });
});

describe('parseAgentRequestV3 — continuation requests', () => {
  const OK = { continuationId: 'run-1', toolResults: [{ callId: 'c1', ok: true, output: { a: 1 } }] };

  it('accepts a well-formed continuation', () => {
    const parsed = parseAgentRequestV3(OK);
    assert.equal(parsed.kind, 'continue');
    assert.equal(parsed.continuationId, 'run-1');
    assert.deepEqual(parsed.toolResults, [{ callId: 'c1', ok: true, output: { a: 1 } }]);
  });

  it('defaults a missing output to null for an ok result', () => {
    const parsed = parseAgentRequestV3({ continuationId: 'r', toolResults: [{ callId: 'c1', ok: true }] });
    assert.deepEqual(parsed.toolResults[0], { callId: 'c1', ok: true, output: null });
  });

  it('accepts an error result and keeps the error payload verbatim', () => {
    const parsed = parseAgentRequestV3({ continuationId: 'r', toolResults: [{ callId: 'c1', ok: false, error: { code: 'x' } }] });
    assert.deepEqual(parsed.toolResults[0], { callId: 'c1', ok: false, error: { code: 'x' } });
  });

  it('REJECTS a continuation that also carries instructions/tools/model/input — never silently ignores them', () => {
    for (const extra of [
      { systemInstructions: 'new rules' },
      { tools: TOOLS },
      { model: 'other' },
      { input: 'a new question' },
    ]) {
      const err = expectCode({ ...OK, ...extra }, 'bad_request');
      assert.match(err.message, /frozen for the life of a run|only "continuationId" and "toolResults"/);
    }
  });

  it('rejects a blank or oversized continuationId', () => {
    expectCode({ continuationId: '', toolResults: OK.toolResults }, 'bad_request');
    expectCode({ continuationId: 'x'.repeat(PROTOCOL_LIMITS.maxContinuationIdChars + 1), toolResults: OK.toolResults }, 'bad_request');
  });

  it('rejects an empty, non-array, or oversized toolResults', () => {
    expectCode({ continuationId: 'r', toolResults: [] }, 'bad_request');
    expectCode({ continuationId: 'r', toolResults: 'nope' }, 'bad_request');
    const many = Array.from({ length: PROTOCOL_LIMITS.maxToolResults + 1 }, (_, i) => ({ callId: `c${i}`, ok: true }));
    expectCode({ continuationId: 'r', toolResults: many }, 'bad_request');
  });

  it('rejects a result that is not discriminated on ok', () => {
    expectCode({ continuationId: 'r', toolResults: [{ callId: 'c1' }] }, 'bad_request');
    expectCode({ continuationId: 'r', toolResults: [{ callId: 'c1', ok: 'yes' }] }, 'bad_request');
  });

  it('rejects a self-contradictory result (ok with error, or error without one)', () => {
    expectCode({ continuationId: 'r', toolResults: [{ callId: 'c1', ok: true, error: { m: 1 } }] }, 'bad_request');
    expectCode({ continuationId: 'r', toolResults: [{ callId: 'c1', ok: false }] }, 'bad_request');
    expectCode({ continuationId: 'r', toolResults: [{ callId: 'c1', ok: false, error: {}, output: {} }] }, 'bad_request');
  });

  it('rejects duplicate callIds with the results_mismatch code', () => {
    expectCode({ continuationId: 'r', toolResults: [{ callId: 'c1', ok: true }, { callId: 'c1', ok: true }] }, 'results_mismatch');
  });

  it('rejects an unknown key inside a result', () => {
    expectCode({ continuationId: 'r', toolResults: [{ callId: 'c1', ok: true, extra: 1 }] }, 'bad_request');
  });
});
