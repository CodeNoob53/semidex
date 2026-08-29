// Pure unit tests for isKnownAskV1Event()/isKnownAskV2Event() — the runtime
// counterpart of index.d.ts's KnownAskEventV1/KnownAskEventV2 type guards
// (see that file's own doc comment on isKnownAskV1Event() for why these are
// two separate exported names rather than one overloaded isKnownAskEvent()).
// No HTTP; these never read `apiVersion`, only `type`, so both guards are
// exercised together below to prove they share one allow-list check.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isKnownAskV1Event, isKnownAskV2Event } from '../../../../packages/lite/lite-src/client/index.js';

for (const [name, guard] of [
  ['isKnownAskV1Event', isKnownAskV1Event],
  ['isKnownAskV2Event', isKnownAskV2Event],
]) {
  describe(`${name}()`, () => {
    it('returns true for a sources event', () => {
      assert.equal(guard({ type: 'sources', apiVersion: 'v1', searchMode: null, sources: [] }), true);
    });

    it('returns true for an answer_delta event', () => {
      assert.equal(guard({ type: 'answer_delta', apiVersion: 'v1', text: 'hi' }), true);
    });

    it('returns true for a done event', () => {
      assert.equal(guard({ type: 'done', apiVersion: 'v1', answer: 'hi', citations: [] }), true);
    });

    it('returns false for an unrecognized/future event type', () => {
      assert.equal(guard({ type: 'reasoning_delta', text: 'partial' }), false);
    });

    it('returns false for a terminal "error" event (thrown by streamAsk(), never yielded — not a "known" passthrough event)', () => {
      assert.equal(guard({ type: 'error', code: 'generation_failed', message: 'boom' }), false);
    });

    it('returns false for null', () => {
      assert.equal(guard(null), false);
    });

    it('returns false for undefined', () => {
      assert.equal(guard(undefined), false);
    });

    it('returns false for non-object primitives (string, number, boolean)', () => {
      assert.equal(guard('sources'), false);
      assert.equal(guard(42), false);
      assert.equal(guard(true), false);
    });

    it('returns false for a plain object with no `type` field', () => {
      assert.equal(guard({}), false);
    });
  });
}

describe('isKnownAskV1Event()/isKnownAskV2Event() — one shared check', () => {
  it('agree on every input — neither reads `apiVersion`, so a v2 shape is judged identically to a v1 one', () => {
    const inputs = [
      { type: 'sources', apiVersion: 'v2' },
      { type: 'answer_delta', apiVersion: 'v2' },
      { type: 'done', apiVersion: 'v2', conversation: { id: 'c1', summaryChanged: false } },
      { type: 'error' },
      { type: 'unknown_future_event' },
      {},
      null,
      undefined,
      'x',
      1,
    ];
    for (const input of inputs) {
      assert.equal(isKnownAskV1Event(input), isKnownAskV2Event(input), `mismatch for input ${JSON.stringify(input)}`);
    }
  });
});
