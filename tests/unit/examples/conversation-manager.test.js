import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createConversationManager } from '../../../packages/lite/examples/conversation-manager.mjs';

let originalFetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

function sseFrame(event, dataObj) {
  return `event: ${event}\ndata: ${JSON.stringify(dataObj)}\n\n`;
}

function fakeSseFetch(handler) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    const frames = handler(body);
    return {
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null) },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frames));
          controller.close();
        },
      }),
      json: async () => ({}),
    };
  };
}

describe('createConversationManager — first turn', () => {
  test('a first turn (no conversationId) omits `conversation` from the wire request entirely', async () => {
    let capturedBody;
    globalThis.fetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        status: 200,
        headers: { get: () => 'text/event-stream; charset=utf-8' },
        body: new ReadableStream({
          start(c) { c.enqueue(new TextEncoder().encode(sseFrame('done', { answer: 'ok', citations: [] }))); c.close(); },
        }),
        json: async () => ({}),
      };
    };
    const manager = createConversationManager();
    const turn = await manager.ask({ baseUrl: 'http://x', collection: 'c', question: 'q1' });
    assert.ok(!('conversation' in capturedBody));
    assert.equal(turn.ok, true);
    assert.ok(turn.conversationId, 'a conversationId must be generated for a fresh conversation');
  });
});

describe('createConversationManager — multi-turn accumulation', () => {
  test('turn 2 sends the FULL history accumulated from turn 1, using the SAME conversationId', async () => {
    let capturedBodies = [];
    globalThis.fetch = fakeSseFetch((body) => {
      capturedBodies.push(body);
      const answer = `answer-${capturedBodies.length}`;
      return sseFrame('answer_delta', { text: answer }) + sseFrame('done', { answer, citations: [] });
    });

    const manager = createConversationManager();
    const turn1 = await manager.ask({ baseUrl: 'http://x', collection: 'c', question: 'question one' });
    const turn2 = await manager.ask({ baseUrl: 'http://x', collection: 'c', conversationId: turn1.conversationId, question: 'question two' });

    assert.equal(turn2.conversationId, turn1.conversationId);
    assert.ok(!('conversation' in capturedBodies[0]), 'turn 1 has no context yet');
    assert.equal(capturedBodies[1].conversation.id, turn1.conversationId);
    assert.deepEqual(capturedBodies[1].conversation.recentMessages, [
      { role: 'user', content: 'question one' },
      { role: 'assistant', content: 'answer-1' },
    ]);
  });

  test('two different conversationIds never share state', async () => {
    globalThis.fetch = fakeSseFetch(() => sseFrame('done', { answer: 'ok', citations: [] }));
    const manager = createConversationManager();
    const a1 = await manager.ask({ baseUrl: 'http://x', collection: 'c', question: 'A question' });
    const b1 = await manager.ask({ baseUrl: 'http://x', collection: 'c', question: 'B question' });
    assert.notEqual(a1.conversationId, b1.conversationId);

    let capturedBody;
    globalThis.fetch = async (url, opts) => { capturedBody = JSON.parse(opts.body); return fakeSseFetch(() => sseFrame('done', { answer: 'ok2', citations: [] }))(url, opts); };
    await manager.ask({ baseUrl: 'http://x', collection: 'c', conversationId: b1.conversationId, question: 'B follow-up' });
    assert.ok(!JSON.stringify(capturedBody).includes('A question'), 'conversation B must show no trace of conversation A');
  });
});

describe('createConversationManager — no speculative client-side pruning', () => {
  test('history grows without a fixed client-side cap — never drops messages the server has not confirmed as compacted (code review, P1)', async () => {
    // A prior version of this demo truncated recentMessages to a fixed
    // count BEFORE Semidex ever got a chance to compact the dropped tail
    // into a summary, permanently losing that history. The corrected
    // behavior: with compaction never firing (summaryChanged:false on
    // every turn below), the manager must keep EVERY message — it has no
    // basis to discard anything on its own.
    globalThis.fetch = fakeSseFetch(() => sseFrame('done', { answer: 'ok', citations: [], conversation: { id: 'x', summaryChanged: false } }));
    const manager = createConversationManager();
    let conversationId;
    for (let i = 0; i < 10; i += 1) {
      const turn = await manager.ask({ baseUrl: 'http://x', collection: 'c', conversationId, question: `q${i}` });
      conversationId = turn.conversationId;
    }
    const state = manager._debugGetState(conversationId);
    assert.equal(state.recentMessages.length, 20, 'every turn (10 user + 10 assistant messages) must survive when the server never confirms any compaction');
    assert.equal(state.recentMessages[0].content, 'q0', 'the OLDEST message must still be present — never speculatively dropped');
    assert.equal(state.recentMessages[state.recentMessages.length - 2].content, 'q9');
  });

  test('createConversationManager() takes no size-based pruning option any more', () => {
    // The old {maxRecentMessages} constructor option is gone entirely —
    // passing it must be silently ignored (not throw), since the manager
    // no longer has any notion of a client-side size cap to configure.
    assert.doesNotThrow(() => createConversationManager({ maxRecentMessages: 4 }));
  });
});

describe('createConversationManager — summary handling', () => {
  test('persists updatedSummary only when summaryChanged:true', async () => {
    globalThis.fetch = fakeSseFetch(() => sseFrame('done', {
      answer: 'ok', citations: [],
      conversation: { id: 'x', summaryChanged: true, updatedSummary: 'a fresh summary' },
    }));
    const manager = createConversationManager();
    const turn = await manager.ask({ baseUrl: 'http://x', collection: 'c', question: 'q' });
    const state = manager._debugGetState(turn.conversationId);
    assert.equal(state.summary, 'a fresh summary');
  });

  test('does not overwrite the existing summary when summaryChanged:false', async () => {
    let callCount = 0;
    globalThis.fetch = fakeSseFetch(() => {
      callCount += 1;
      if (callCount === 1) {
        return sseFrame('done', { answer: 'ok', citations: [], conversation: { id: 'x', summaryChanged: true, updatedSummary: 'summary A' } });
      }
      return sseFrame('done', { answer: 'ok2', citations: [], conversation: { id: 'x', summaryChanged: false } });
    });
    const manager = createConversationManager();
    const turn1 = await manager.ask({ baseUrl: 'http://x', collection: 'c', question: 'q1' });
    await manager.ask({ baseUrl: 'http://x', collection: 'c', conversationId: turn1.conversationId, question: 'q2' });
    const state = manager._debugGetState(turn1.conversationId);
    assert.equal(state.summary, 'summary A', 'the prior summary must survive an unchanged turn');
  });

  test('uses compactedMessageCount to drop the covered prefix instead of duplicating it in the next request', async () => {
    // Turn 1 and 2 build up 4 recentMessages with no compaction. Turn 3
    // triggers compaction covering the first 2 of those 4 (compactedMessageCount:2)
    // — the manager must drop exactly those 2 before appending turn 3's own
    // question/answer, so turn 4's request body carries the NEW summary plus
    // only the 2 uncovered messages + turn 3's pair, never the covered ones
    // again.
    let callCount = 0;
    let capturedBody;
    globalThis.fetch = fakeSseFetch((body) => {
      callCount += 1;
      capturedBody = body;
      if (callCount === 3) {
        return sseFrame('answer_delta', { text: 'answer-3' }) + sseFrame('done', {
          answer: 'answer-3', citations: [],
          conversation: { id: 'x', summaryChanged: true, updatedSummary: 'covers first two turns', compactedMessageCount: 2 },
        });
      }
      return sseFrame('answer_delta', { text: `answer-${callCount}` }) + sseFrame('done', { answer: `answer-${callCount}`, citations: [], conversation: { id: 'x', summaryChanged: false } });
    });
    const manager = createConversationManager();
    const turn1 = await manager.ask({ baseUrl: 'http://x', collection: 'c', question: 'q1' });
    await manager.ask({ baseUrl: 'http://x', collection: 'c', conversationId: turn1.conversationId, question: 'q2' });
    await manager.ask({ baseUrl: 'http://x', collection: 'c', conversationId: turn1.conversationId, question: 'q3' });

    const state = manager._debugGetState(turn1.conversationId);
    assert.equal(state.summary, 'covers first two turns');
    assert.deepEqual(state.recentMessages, [
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'answer-2' },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'answer-3' },
    ], 'the q1/answer-1 pair covered by the new summary must be dropped, not duplicated');

    await manager.ask({ baseUrl: 'http://x', collection: 'c', conversationId: turn1.conversationId, question: 'q4' });
    assert.equal(capturedBody.conversation.summary, 'covers first two turns');
    assert.ok(
      !JSON.stringify(capturedBody.conversation.recentMessages).includes('q1'),
      'the next request must never re-send a message already folded into the summary',
    );
  });

  test('clamps an out-of-range compactedMessageCount instead of slicing past the array bounds', async () => {
    globalThis.fetch = fakeSseFetch(() => sseFrame('answer_delta', { text: 'ok' }) + sseFrame('done', {
      answer: 'ok', citations: [],
      conversation: { id: 'x', summaryChanged: true, updatedSummary: 's', compactedMessageCount: 999 },
    }));
    const manager = createConversationManager();
    const turn = await manager.ask({ baseUrl: 'http://x', collection: 'c', question: 'q1' });
    const state = manager._debugGetState(turn.conversationId);
    assert.deepEqual(state.recentMessages, [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'ok' },
    ], 'an out-of-range compactedMessageCount must never drop messages beyond what actually exists');
  });

  test('compaction never prunes the ARCHIVE — only the bounded request view narrows; every message the user/assistant ever sent stays physically present in archive', async () => {
    // The archive is the source-of-truth history. Compaction narrows what
    // gets SENT (via summarizedThroughArchiveIndex), never what is
    // RETAINED locally — a real backend with durable storage would keep
    // the same archive table indefinitely for its own audit/analytics
    // purposes, only ever narrowing the outbound request.
    globalThis.fetch = fakeSseFetch(() => sseFrame('answer_delta', { text: 'ok' }) + sseFrame('done', {
      answer: 'ok', citations: [],
      conversation: { id: 'x', summaryChanged: true, updatedSummary: 'covers turn 1', compactedMessageCount: 2 },
    }));
    const manager = createConversationManager();
    const turn1 = await manager.ask({ baseUrl: 'http://x', collection: 'c', question: 'q1' });
    await manager.ask({ baseUrl: 'http://x', collection: 'c', conversationId: turn1.conversationId, question: 'q2' });

    const state = manager._debugGetState(turn1.conversationId);
    // The bounded VIEW no longer includes turn 1 (it's covered by the summary).
    assert.ok(!state.recentMessages.some((m) => m.content === 'q1'));
    // But the ARCHIVE still has it — nothing is ever deleted from it.
    assert.ok(state.archive.some((m) => m.content === 'q1'), 'the archive must retain q1 even after it was folded into a summary and dropped from the request view');
    assert.equal(state.archive.length, 4, 'archive holds all 4 messages (2 turns x user+assistant), unlike the narrower view');
    assert.equal(state.summarizedThroughArchiveIndex, 2, 'the boundary index must reflect exactly the 2 messages compaction confirmed as covered');
  });
});

describe('createConversationManager — bounded-context error when compaction keeps failing (code review)', () => {
  test('repeated compaction failures grow the unsummarized view past the wire-protocol limit — ask() refuses to send and returns client_bounded_context_exceeded instead of silently truncating or forwarding a generic server error', async () => {
    // Every turn answers successfully but compaction NEVER confirms any
    // coverage (summaryChanged:false always) — simulating a generation
    // provider that is up for the main answer but persistently failing (or
    // simply never triggered) for the compaction call specifically. Each
    // successful turn still appends 2 messages to the archive/view, so the
    // view grows without bound turn after turn.
    const PROTOCOL_MAX_RECENT_MESSAGES = 200; // mirrors the manager's own internal constant (duplicated intentionally — see that module's header)
    let callCount = 0;
    globalThis.fetch = fakeSseFetch(() => {
      callCount += 1;
      return sseFrame('answer_delta', { text: `answer-${callCount}` })
        + sseFrame('done', { answer: `answer-${callCount}`, citations: [], conversation: { id: 'x', summaryChanged: false } });
    });

    const manager = createConversationManager();
    let conversationId;
    let lastResult;
    // Each successful turn adds 2 messages. A view of EXACTLY 200 is still
    // legal (guard is `>`, not `>=`) and must still reach fetch() -- that
    // happens on turn 101 (outgoing view: 200), after which the view
    // becomes 202. Turn 102's OUTGOING view is then 202 (> 200), which the
    // guard must reject before ever calling fetch() -- so 102 turns are
    // needed to actually observe the rejection inside this loop.
    const turnsNeeded = Math.ceil(PROTOCOL_MAX_RECENT_MESSAGES / 2) + 2;
    for (let i = 0; i < turnsNeeded; i += 1) {
      lastResult = await manager.ask({ baseUrl: 'http://x', collection: 'c', conversationId, question: `q${i}` });
      conversationId = lastResult.conversationId;
      if (!lastResult.ok) break; // stop as soon as the manager itself refuses to send
    }

    assert.equal(lastResult.ok, false, 'the manager must eventually refuse to send once the unsummarized view crosses the protocol limit');
    assert.equal(lastResult.error.code, 'client_bounded_context_exceeded');
    assert.equal(lastResult.error.retryable, true);
    // The message must be honest that retry alone cannot recover this
    // state (no request reaches Semidex any more) and must point at a
    // real recovery path (new conversation / manual recovery), never
    // imply "retry once the provider is back" works here.
    assert.match(lastResult.error.message, /new conversation/i);
    assert.match(lastResult.error.message, /cannot fix this|cannot recover/i);
    assert.ok(!/retry once|retry after/i.test(lastResult.error.message), 'must never claim a plain retry-after-recovery fixes this state');

    // The refusal must have happened BEFORE the view actually exceeded the
    // limit got sent over the wire at all — i.e. fetch() was called
    // strictly fewer times than the number of loop iterations attempted,
    // proving the LAST attempt short-circuited locally rather than
    // reaching the network and being rejected by the server instead.
    assert.ok(callCount < turnsNeeded, 'the final over-limit turn must never have reached fetch() at all');

    // The archive itself must still hold everything successfully answered
    // up to the point of refusal — the guard rejects SENDING, it does not
    // retroactively delete anything already recorded.
    const state = manager._debugGetState(conversationId);
    assert.ok(state.archive.length >= PROTOCOL_MAX_RECENT_MESSAGES, 'the archive must have kept growing right up to the point the guard tripped, never silently trimmed');
  });

  test('boundary: a view of EXACTLY 200 still reaches fetch() (legal under the wire contract); 202 is rejected locally without ever calling fetch()', async () => {
    // The server itself only rejects recentMessages.length >
    // PROTOCOL_MAX_RECENT_MESSAGES (strictly greater than 200) -- a request
    // carrying exactly 200 is valid and is also the conversation's LAST
    // legal opportunity for a turn that could let compaction confirm
    // coverage and shrink the view back down. The local guard must match
    // that boundary exactly, not be stricter than the protocol itself.
    // Messages are appended in user+assistant PAIRS, so the view can only
    // ever land on even counts (198, 200, 202, ...) -- 201 is never a real
    // value this manager produces; the first illegal value actually
    // reached is 202, which is what this test drives to and asserts on.
    let fetchCalls = 0;
    globalThis.fetch = fakeSseFetch(() => {
      fetchCalls += 1;
      return sseFrame('answer_delta', { text: 'ok' }) + sseFrame('done', { answer: 'ok', citations: [], conversation: { id: 'x', summaryChanged: false } });
    });

    const manager = createConversationManager();
    let conversationId;
    // 99 turns = 198 messages -- one turn short of the 200-message boundary.
    for (let i = 0; i < 99; i += 1) {
      const turn = await manager.ask({ baseUrl: 'http://x', collection: 'c', conversationId, question: `q${i}` });
      conversationId = turn.conversationId;
      assert.equal(turn.ok, true, `turn ${i} must succeed while priming the conversation`);
    }
    assert.equal(fetchCalls, 99);

    // Turn 100: sent with a view of 198 (still under 200), grows the
    // archive/view to exactly 200 after this turn completes.
    const turn100 = await manager.ask({ baseUrl: 'http://x', collection: 'c', conversationId, question: 'q99' });
    assert.equal(turn100.ok, true, 'the turn that grows the view to exactly 200 must still succeed');
    assert.equal(fetchCalls, 100);
    assert.equal(manager._debugGetState(conversationId).recentMessages.length, 200, 'the view must now be exactly at the boundary');

    // Turn 101: the OUTGOING view for this call is the 200-message view
    // from turn 100 -- exactly at the ceiling, not over it. This must
    // still reach fetch() (200 is legal), proving the guard is `>`, not
    // `>=`.
    const turn101 = await manager.ask({ baseUrl: 'http://x', collection: 'c', conversationId, question: 'the 200-message turn' });
    assert.equal(turn101.ok, true, 'a request carrying exactly 200 recentMessages must still be sent -- it is legal under the wire contract');
    assert.equal(fetchCalls, 101, 'the exactly-200 request must have reached fetch()');

    // After turn 101 (still no compaction confirmed), the view is now 202
    // -- turn 102's OUTGOING view would be 202, over the ceiling. This
    // must be rejected locally, WITHOUT incrementing fetchCalls.
    const turn102 = await manager.ask({ baseUrl: 'http://x', collection: 'c', conversationId, question: 'one too many' });
    assert.equal(turn102.ok, false, 'a view of 202 (> 200) must be rejected locally');
    assert.equal(turn102.error.code, 'client_bounded_context_exceeded');
    assert.equal(fetchCalls, 101, 'the over-the-ceiling turn must never have reached fetch()');
  });
});

describe('createConversationManager — failure handling', () => {
  test('a failed turn is never appended to history', async () => {
    globalThis.fetch = async () => ({
      status: 400,
      headers: { get: () => 'application/json; charset=utf-8' },
      body: new ReadableStream({ start(c) { c.close(); } }),
      json: async () => ({ error: { code: 'invalid_message_role', message: 'bad', retryable: false } }),
    });
    const manager = createConversationManager();
    const turn = await manager.ask({ baseUrl: 'http://x', collection: 'c', question: 'q' });
    assert.equal(turn.ok, false);
    const state = manager._debugGetState(turn.conversationId);
    assert.equal(state.recentMessages.length, 0, 'a failed turn must not pollute history');
  });
});

describe('createConversationManager — ownership boundary documentation', () => {
  test('the module never claims to be production persistence (header comment check)', async () => {
    const fs = await import('node:fs/promises');
    const url = new URL('../../../packages/lite/examples/conversation-manager.mjs', import.meta.url);
    const source = await fs.readFile(url, 'utf-8');
    assert.match(source, /DEMONSTRATION ONLY|NOT PRODUCTION/i);
  });
});
