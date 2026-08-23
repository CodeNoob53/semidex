// sink.js — withEditionTag()/ensureEditionTag() contract. ensureEditionTag()
// is what createApp()/createLiteApp()/startLite() call on a CALLER-SUPPLIED
// auditSink (see docs/security/audit-logging-design-2026-08.md §7) — this
// file proves the wrapping/override mechanism itself, independent of any
// composition root, including the specific trap withEditionTag()'s own
// header comment warns about: naively wrapping an ALREADY-wrapped sink a
// second time does NOT override its tag (the inner wrap — the one closest
// to the real sink — touches the event last and wins), which is exactly
// why ensureEditionTag() unwraps down to the original base sink and
// re-wraps THAT, rather than stacking a second wrapper on top.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withEditionTag, ensureEditionTag } from '../../../../src/core/audit/sink.js';
import { AUDIT_EVENT_TYPE, buildAuditEvent } from '../../../../src/core/audit/event.js';

function captureSink() {
  const sink = { events: [], closeCount: 0 };
  sink.record = (e) => sink.events.push(e);
  sink.flush = async () => {};
  sink.close = async () => { sink.closeCount += 1; };
  return sink;
}

const buildEvent = () => buildAuditEvent(AUDIT_EVENT_TYPE.ADMIN_KEY_CREATED, { outcome: 'created', keyId: 'k1' });

describe('ensureEditionTag()', () => {
  it('wraps an untagged (plain/raw) sink exactly once', () => {
    const raw = captureSink();
    const tagged = ensureEditionTag(raw, 'full');
    tagged.record(buildEvent());
    assert.equal(raw.events.length, 1);
    assert.equal(raw.events[0].edition, 'full');
  });

  it('is idempotent: re-ensuring the SAME edition on an already-tagged sink returns the identical instance — no double wrap', () => {
    const raw = captureSink();
    const tagged = ensureEditionTag(raw, 'lite');
    const again = ensureEditionTag(tagged, 'lite');
    assert.equal(again, tagged, 'must return the exact same wrapper, not a new one');
    again.record(buildEvent());
    assert.equal(raw.events.length, 1, 'exactly one write must reach the base sink even after re-ensuring the tag');
    assert.equal(raw.events[0].edition, 'lite');
  });

  it('overrides a WRONG existing tag by unwrapping to the original base sink and re-wrapping it — the spoof-override contract', () => {
    const raw = captureSink();
    const spoofed = ensureEditionTag(raw, 'full'); // e.g. a caller hands Lite a sink some other composition root already tagged 'full'
    const corrected = ensureEditionTag(spoofed, 'lite'); // Lite's own composition root insists on its own edition
    corrected.record(buildEvent());
    assert.equal(raw.events.length, 1, 'must not create a second, independent write path — exactly one wrap layer reaches the base sink');
    assert.equal(raw.events[0].edition, 'lite', 'the composition root\'s own edition must win, not the caller-supplied tag');
  });

  it('documents why the override must unwrap rather than stack: naively wrapping an already-tagged sink (withEditionTag directly, NOT ensureEditionTag) fails to override it', () => {
    const raw = captureSink();
    const fullTagged = withEditionTag(raw, 'full');
    const naiveOuter = withEditionTag(fullTagged, 'lite'); // the broken pattern ensureEditionTag exists to avoid
    naiveOuter.record(buildEvent());
    assert.equal(raw.events[0].edition, 'full', 'sanity: the wrap closest to the base sink wins over a naive outer wrap — exactly the trap ensureEditionTag() is designed around');
  });

  it('passes through null/undefined unchanged', () => {
    assert.equal(ensureEditionTag(null, 'full'), null);
    assert.equal(ensureEditionTag(undefined, 'lite'), undefined);
  });

  it('flush()/close() forward to the underlying base sink, regardless of how many times the tag was corrected', async () => {
    const raw = captureSink();
    const spoofed = ensureEditionTag(raw, 'full');
    const corrected = ensureEditionTag(spoofed, 'lite');
    await corrected.close();
    assert.equal(raw.closeCount, 1);
  });

  it('never mutates the event object passed to record()', () => {
    const raw = captureSink();
    const tagged = ensureEditionTag(raw, 'full');
    const event = buildEvent();
    assert.ok(Object.isFrozen(event));
    tagged.record(event);
    assert.equal(event.edition, null, 'the caller-owned, frozen event must remain untouched');
    assert.notEqual(raw.events[0], event, 'a new object must be recorded downstream');
  });
});
