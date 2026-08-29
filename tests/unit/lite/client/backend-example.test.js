// packages/lite/examples/backend-chat-server.mjs — the shipped backend
// integration example.
//
// An example that demonstrates a SECURITY boundary earns real assertions,
// not just prose: the two rules this file pins are "the browser can never
// name a collection" and "the bearer token never reaches the browser".
// Both are claims the example makes in its own header comment, and both
// would silently rot if only a comment guarded them.
//
// The example is imported, not spawned — it exports its pure helpers and
// its request handler, and only binds a port when RUN as a script, so this
// test needs no token, no port, and no live Semidex.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXAMPLE_URL = new URL('../../../../packages/lite/examples/backend-chat-server.mjs', import.meta.url);
const STREAMING_EXAMPLE_URL = new URL('../../../../packages/lite/examples/backend-integration-server.mjs', import.meta.url);

const {
  ASSISTANTS, resolveAssistant, saveConversation, loadConversation, CONVERSATIONS, MAX_RECENT_MESSAGES,
} = await import(EXAMPLE_URL.href);

beforeEach(() => { CONVERSATIONS.clear(); });

describe('backend example — assistantId to collection mapping', () => {
  it('maps a known assistantId to its configured collection', () => {
    const assistant = resolveAssistant('support');
    assert.equal(typeof assistant.collection, 'string');
    assert.ok(assistant.collection.length > 0);
    assert.equal(assistant.label, 'Customer support');
  });

  it('rejects an unknown assistantId with a 400 rather than passing it through', () => {
    assert.throws(() => resolveAssistant('not-a-real-assistant'), (err) => {
      assert.equal(err.status, 400);
      return true;
    });
  });

  it('NEVER accepts a raw collection name from the browser — an arbitrary string is not a valid assistantId', () => {
    // The whole point of the mapping: a caller who knows (or guesses) a real
    // collection name still cannot reach it.
    for (const attempt of ['my-docs', 'other-tenant-kb', 'acme-support-kb-v3']) {
      assert.throws(() => resolveAssistant(attempt), (err) => {
        assert.equal(err.status, 400);
        return true;
      }, `a raw collection name (${attempt}) must never resolve`);
    }
  });

  it('is not fooled by prototype-chain keys', () => {
    // A bare `ASSISTANTS[assistantId]` lookup would return a truthy
    // non-collection value for each of these and pass it to the API.
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.throws(() => resolveAssistant(key), (err) => {
        assert.equal(err.status, 400);
        return true;
      }, `prototype key ${key} must not resolve to a collection`);
    }
  });

  it('rejects non-string assistantIds instead of coercing them', () => {
    for (const bad of [undefined, null, 42, {}, [], true]) {
      assert.throws(() => resolveAssistant(bad), (err) => {
        assert.equal(err.status, 400);
        return true;
      });
    }
  });

  it('the mapping object is frozen — a request handler cannot add an assistant at runtime', () => {
    assert.ok(Object.isFrozen(ASSISTANTS));
    assert.throws(() => { ASSISTANTS.injected = { collection: 'x' }; }, TypeError);
  });

  it('the error message never discloses the real collection names it is protecting', () => {
    try {
      resolveAssistant('nope');
      assert.fail('should have thrown');
    } catch (err) {
      for (const { collection } of Object.values(ASSISTANTS)) {
        assert.ok(!err.message.includes(collection), 'a rejection must not leak the collection name to the browser');
      }
    }
  });
});

describe('backend example — caller-owned conversation persistence', () => {
  it('stores the user/assistant turn pair and reads it back', () => {
    saveConversation('c1', {
      question: 'What is the return window?',
      answer: 'Thirty days [1].',
      doneConversation: null,
      prior: null,
    });
    const stored = loadConversation('c1');
    assert.deepEqual(stored.recentMessages, [
      { role: 'user', content: 'What is the return window?' },
      { role: 'assistant', content: 'Thirty days [1].' },
    ]);
  });

  it('adopts an updated summary only when the server says it changed', () => {
    saveConversation('c2', {
      question: 'q1', answer: 'a1',
      doneConversation: { id: 'c2', summaryChanged: true, updatedSummary: 'A rolling summary.' },
      prior: { summary: 'stale', recentMessages: [] },
    });
    assert.equal(loadConversation('c2').summary, 'A rolling summary.');

    saveConversation('c3', {
      question: 'q1', answer: 'a1',
      doneConversation: { id: 'c3', summaryChanged: false, updatedSummary: null },
      prior: { summary: 'still valid', recentMessages: [] },
    });
    assert.equal(loadConversation('c3').summary, 'still valid', 'an unchanged summary must not be clobbered with null');
  });

  it('bounds the recent-message window — every stored message is re-sent on every turn', () => {
    let prior = null;
    for (let turn = 0; turn < 40; turn += 1) {
      saveConversation('c4', { question: `q${turn}`, answer: `a${turn}`, doneConversation: null, prior });
      prior = loadConversation('c4');
    }
    const stored = loadConversation('c4');
    assert.equal(stored.recentMessages.length, MAX_RECENT_MESSAGES);
    assert.equal(stored.recentMessages.at(-1).content, 'a39', 'the window keeps the most RECENT messages');
    assert.equal(stored.recentMessages.at(-2).content, 'q39');
  });

  it('returns null for an unknown or absent conversationId (a first turn sends no conversation state)', () => {
    assert.equal(loadConversation('never-seen'), null);
    assert.equal(loadConversation(undefined), null);
    assert.equal(loadConversation(''), null);
  });

  it('keeps conversations independent of one another', () => {
    saveConversation('a', { question: 'qa', answer: 'aa', doneConversation: null, prior: null });
    saveConversation('b', { question: 'qb', answer: 'ab', doneConversation: null, prior: null });
    assert.equal(loadConversation('a').recentMessages[0].content, 'qa');
    assert.equal(loadConversation('b').recentMessages[0].content, 'qb');
  });
});

describe('backend example — token handling (source-level guarantees)', () => {
  // These are deliberately SOURCE assertions. The claim being protected —
  // "the token never reaches the browser" — is about code that is never
  // written, so the only way to catch a regression is to check that the
  // dangerous shapes are absent from the file itself.
  const source = readFileSync(fileURLToPath(EXAMPLE_URL), 'utf-8');
  const streamingSource = readFileSync(fileURLToPath(STREAMING_EXAMPLE_URL), 'utf-8');

  it('reads the token from the environment, never from a request body or query string', () => {
    assert.match(source, /process\.env\.SEMIDEX_TOKEN/);
    assert.ok(!/req\.headers\[['"]authorization/i.test(source), 'must not forward a browser-supplied Authorization header upstream');
  });

  // Distinguishes a USE of the token value from a mention of its NAME. The
  // only place the bare name appears as text is the "SEMIDEX_TOKEN is not
  // set" startup help message, so quoted strings are blanked — but NOT
  // template literals: `${SEMIDEX_TOKEN}` inside one is a real leak, and
  // trying to blank template text while preserving interpolations
  // desynchronizes on the backtick-heavy banner strings further down the
  // file. Instead, a `${` immediately before the name always counts as a
  // use, and quoted-string blanking handles the rest.
  const tokenValueUses = (src) => src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .filter((line) => {
      if (/\$\{[^}]*SEMIDEX_TOKEN/.test(line)) return true; // interpolated: always a use
      const withoutQuoted = line
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
      return withoutQuoted.includes('SEMIDEX_TOKEN');
    });

  it('passes the token ONLY to createSemidexClient()', () => {
    // Every use of the token VALUE, other than its own definition, the
    // startup guard, and the client construction, is a potential leak.
    const mentions = tokenValueUses(source);
    assert.ok(mentions.length > 0, 'sanity: the token must be used somewhere');
    for (const line of mentions) {
      const ok = /const SEMIDEX_TOKEN =/.test(line)
        || /!SEMIDEX_TOKEN/.test(line)
        || /apiKey: SEMIDEX_TOKEN/.test(line);
      assert.ok(ok, `unexpected use of the SEMIDEX_TOKEN value outside construction/guard: ${line.trim()}`);
    }
  });

  it('never writes the token into a browser-facing response', () => {
    for (const [name, src] of [['chat', source], ['streaming', streamingSource]]) {
      assert.ok(!/sendJson\([^)]*SEMIDEX_TOKEN/.test(src), `${name}: token must never be sent in a JSON response`);
      assert.ok(!/res\.(write|end)\([^)]*SEMIDEX_TOKEN/.test(src), `${name}: token must never be written to a response stream`);
    }
  });

  it('never logs the token value, not even truncated', () => {
    // `console.error('... SEMIDEX_TOKEN is not set ...')` prints the
    // variable NAME in a help message and is fine; passing or interpolating
    // the VALUE is not.
    for (const [name, src] of [['chat', source], ['streaming', streamingSource]]) {
      const logged = tokenValueUses(src).filter((line) => /console\.(log|warn|error|info|debug)\(/.test(line));
      assert.deepEqual(logged, [], `${name}: the token value must never be logged`);
    }
  });

  it('the browser-facing error path does not forward raw upstream error details', () => {
    // A SemidexApiError is projected to a safe shape rather than serialized
    // wholesale into the response.
    assert.ok(!/sendJson\([^)]*\berr\b\s*\)/.test(source), 'must not serialize the raw error object to the browser');
    assert.match(source, /upstream_error/, 'projects upstream failures to a generic browser-facing code');
  });
});

describe('backend example — collection is never taken from the browser', () => {
  const source = readFileSync(fileURLToPath(EXAMPLE_URL), 'utf-8');

  it('the request body is destructured for assistantId, never for collection', () => {
    assert.match(source, /const \{ assistantId, question, conversationId: incomingId \} = await readJsonBody\(req\)/);
    assert.ok(
      !/readJsonBody\(req\)[\s\S]{0,200}\bcollection\b\s*[,}]/.test(source),
      'a `collection` field must never be read out of the browser request body',
    );
  });

  it('the collection passed to askText() comes from the resolved assistant', () => {
    assert.match(source, /collection: assistant\.collection/);
  });

  it('the streaming sibling example follows the same rule', () => {
    const streaming = readFileSync(fileURLToPath(STREAMING_EXAMPLE_URL), 'utf-8');
    assert.match(streaming, /const \{ assistantId, question, conversationId \} = await readJsonBody\(req\)/);
    assert.match(streaming, /resolveCollection\(assistantId\)/);
  });
});
