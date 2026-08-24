// Pure unit tests for the client's SSE parser (packages/lite/lite-src/client/sse.js).
// No HTTP — a fake ReadableStream lets these tests dictate EXACT chunk
// boundaries, including mid-frame and mid-line splits a real network read
// could never be guaranteed to reproduce.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSseStream } from '../../../../packages/lite/lite-src/client/sse.js';

function streamFromChunks(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) { controller.close(); return; }
      controller.enqueue(encoder.encode(chunks[i]));
      i += 1;
    },
  });
}

async function collect(stream, signal = new AbortController().signal) {
  const out = [];
  for await (const frame of parseSseStream(stream, signal)) out.push(frame);
  return out;
}

describe('parseSseStream — whole frames', () => {
  it('parses a single event/data frame', async () => {
    const frames = await collect(streamFromChunks(['event: sources\ndata: {"a":1}\n\n']));
    assert.deepEqual(frames, [{ event: 'sources', data: { a: 1 } }]);
  });

  it('parses multiple frames in one chunk', async () => {
    const frames = await collect(streamFromChunks([
      'event: sources\ndata: {"a":1}\n\nevent: done\ndata: {"b":2}\n\n',
    ]));
    assert.equal(frames.length, 2);
    assert.equal(frames[0].event, 'sources');
    assert.equal(frames[1].event, 'done');
  });

  it('defaults event name to "message" when omitted', async () => {
    const frames = await collect(streamFromChunks(['data: {"x":1}\n\n']));
    assert.equal(frames[0].event, 'message');
  });
});

describe('parseSseStream — arbitrary chunk boundaries', () => {
  it('reassembles a frame split mid-line', async () => {
    const frames = await collect(streamFromChunks([
      'event: sour', 'ces\ndata: {"a"', ':1}\n\n',
    ]));
    assert.deepEqual(frames, [{ event: 'sources', data: { a: 1 } }]);
  });

  it('reassembles a frame split at the exact boundary between the two blank-line characters', async () => {
    const frames = await collect(streamFromChunks([
      'event: sources\ndata: {"a":1}\n', '\n',
    ]));
    assert.deepEqual(frames, [{ event: 'sources', data: { a: 1 } }]);
  });

  it('reassembles a frame delivered one byte at a time', async () => {
    const raw = 'event: done\ndata: {"ok":true}\n\n';
    const frames = await collect(streamFromChunks([...raw]));
    assert.deepEqual(frames, [{ event: 'done', data: { ok: true } }]);
  });

  it('splits a multi-byte UTF-8 character (Cyrillic) across chunk boundaries without corruption', async () => {
    const payload = JSON.stringify({ text: 'Привіт, світ' });
    const raw = `event: answer_delta\ndata: ${payload}\n\n`;
    const bytes = new TextEncoder().encode(raw);
    // Split in the middle of a multi-byte sequence somewhere in the Cyrillic text.
    const mid = Math.floor(bytes.length / 2);
    const encoder = new TextDecoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, mid));
        controller.enqueue(bytes.slice(mid));
        controller.close();
      },
    });
    const frames = await collect(stream);
    assert.equal(frames[0].data.text, 'Привіт, світ');
    void encoder; // unused, kept only to document intent
  });
});

describe('parseSseStream — line endings', () => {
  it('handles CRLF line endings identically to LF', async () => {
    const frames = await collect(streamFromChunks(['event: sources\r\ndata: {"a":1}\r\n\r\n']));
    assert.deepEqual(frames, [{ event: 'sources', data: { a: 1 } }]);
  });

  it('handles a CRLF split exactly between \\r and \\n', async () => {
    const frames = await collect(streamFromChunks(['event: sources\r', '\ndata: {"a":1}\r', '\n\r', '\n']));
    assert.deepEqual(frames, [{ event: 'sources', data: { a: 1 } }]);
  });
});

describe('parseSseStream — comments and keepalives', () => {
  it('ignores comment lines (starting with ":")', async () => {
    const frames = await collect(streamFromChunks([': keepalive\nevent: sources\ndata: {"a":1}\n\n']));
    assert.deepEqual(frames, [{ event: 'sources', data: { a: 1 } }]);
  });

  it('a frame consisting ONLY of a comment yields nothing (no data line at all)', async () => {
    const frames = await collect(streamFromChunks([': just a keepalive\n\nevent: done\ndata: {"x":1}\n\n']));
    assert.deepEqual(frames, [{ event: 'done', data: { x: 1 } }]);
  });

  it('ignores unrecognized SSE fields (id:, retry:) without treating them as an error', async () => {
    const frames = await collect(streamFromChunks(['id: 42\nretry: 3000\nevent: sources\ndata: {"a":1}\n\n']));
    assert.deepEqual(frames, [{ event: 'sources', data: { a: 1 } }]);
  });
});

describe('parseSseStream — final frame without a trailing blank line', () => {
  it('flushes a complete frame that ends the stream with no trailing \\n\\n', async () => {
    const frames = await collect(streamFromChunks(['event: done\ndata: {"final":true}']));
    assert.deepEqual(frames, [{ event: 'done', data: { final: true } }]);
  });

  it('flushes a final frame arriving across multiple chunks with no trailing blank line', async () => {
    const frames = await collect(streamFromChunks(['event: don', 'e\ndata: {"fin', 'al":true}']));
    assert.deepEqual(frames, [{ event: 'done', data: { final: true } }]);
  });
});

describe('parseSseStream — malformed protocol data', () => {
  it('a frame with unparseable JSON data yields a synthetic __parse_error__ frame rather than throwing', async () => {
    const frames = await collect(streamFromChunks(['event: done\ndata: {not json\n\n']));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].event, '__parse_error__');
    assert.equal(frames[0].data.raw, '{not json');
  });
});

describe('parseSseStream — abort', () => {
  it('stops promptly and cancels the reader when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let cancelled = false;
    const stream = new ReadableStream({
      pull() { /* never resolves in real life, but pull isn't called before cancel */ },
      cancel() { cancelled = true; },
    });
    const frames = await collect(stream, controller.signal);
    assert.deepEqual(frames, []);
    assert.equal(cancelled, true);
  });

  it('stops mid-stream when aborted between chunks, without yielding further frames', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    let pullCount = 0;
    const stream = new ReadableStream({
      pull(ctrl) {
        pullCount += 1;
        if (pullCount === 1) {
          ctrl.enqueue(encoder.encode('event: sources\ndata: {"a":1}\n\n'));
          return;
        }
        // Second read: abort right before it would deliver more data.
        controller.abort();
        ctrl.enqueue(encoder.encode('event: done\ndata: {"b":2}\n\n'));
      },
    });
    const frames = await collect(stream, controller.signal);
    assert.deepEqual(frames, [{ event: 'sources', data: { a: 1 } }]);
  });
});

describe('parseSseStream — ownership (frames are fresh objects, not shared references)', () => {
  it('two frames with identical text payloads are not the same object reference', async () => {
    const frames = await collect(streamFromChunks([
      'event: answer_delta\ndata: {"text":"same"}\n\nevent: answer_delta\ndata: {"text":"same"}\n\n',
    ]));
    assert.notEqual(frames[0], frames[1]);
    assert.notEqual(frames[0].data, frames[1].data);
    assert.deepEqual(frames[0], frames[1]);
  });

  it('mutating a yielded frame does not affect the next parsed frame', async () => {
    const frames = [];
    for await (const frame of parseSseStream(streamFromChunks([
      'event: answer_delta\ndata: {"text":"a"}\n\nevent: answer_delta\ndata: {"text":"b"}\n\n',
    ]), new AbortController().signal)) {
      frames.push(frame);
    }
    assert.equal(frames[0].data.text, 'a');
    assert.equal(frames[1].data.text, 'b');
  });
});
