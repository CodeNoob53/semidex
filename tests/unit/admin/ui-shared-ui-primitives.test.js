// Tests for the minimum shared v2 UI primitives (design plan §8.1, §13 S1):
// shared/ui/{status-badge,live-region,states,table}.js. Real ESM imports —
// these are DOM-producing functions, not classes, so a linkedom document
// assigned to globalThis.document (the same seam every primitive's own
// `document.createElement` call resolves against) is enough; no vm harness
// needed.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML, EventTarget, Event, Node } from 'linkedom';
import { createStatusBadge, updateStatusBadge } from '../../../src/shared/admin/ui-src/shared/ui/status-badge.js';
import { createLiveRegion } from '../../../src/shared/admin/ui-src/shared/ui/live-region.js';
import { createLoadingState, createEmptyState, createErrorState, createPartialState } from '../../../src/shared/admin/ui-src/shared/ui/states.js';
import { createDataTable } from '../../../src/shared/admin/ui-src/shared/ui/table.js';

const originalDocument = globalThis.document;
const originalNode = globalThis.Node;

beforeEach(() => {
  const { document } = parseHTML('<div id="root"></div>');
  globalThis.document = document;
  // table.js's `value instanceof Node` check needs a global Node
  // constructor — real browsers always have one; this Node process does
  // not by default, so the test environment supplies linkedom's own.
  globalThis.Node = Node;
});

afterEach(() => {
  globalThis.document = originalDocument;
  globalThis.Node = originalNode;
});

describe('createStatusBadge() — icon + text + colour, never colour alone', () => {
  it('renders both an icon element and a text element carrying the label', () => {
    const badge = createStatusBadge('ok', 'reachable');
    assert.ok(badge.querySelector('.status-badge-icon svg'), 'must render a real icon, not just a coloured dot');
    assert.equal(badge.querySelector('.status-badge-text').textContent, 'reachable');
    assert.ok(badge.classList.contains('status-badge-ok'));
  });

  it('falls back to the unknown tone/icon for an unrecognized tone string, rather than rendering nothing', () => {
    const badge = createStatusBadge('bogus', 'x');
    assert.ok(badge.classList.contains('status-badge-unknown'));
    assert.ok(badge.querySelector('.status-badge-icon svg'));
  });

  it('renders an untrusted label as inert text — never parsed as markup (XSS-safe)', () => {
    const malicious = '<img src=x onerror="window.__pwned=true">';
    const badge = createStatusBadge('fail', malicious);
    assert.equal(badge.querySelectorAll('img').length, 0, 'malicious label must never become a real element');
    assert.match(badge.querySelector('.status-badge-text').textContent, /<img/);
  });

  it('updateStatusBadge() replaces the element in place', () => {
    const host = document.getElementById('root');
    const badge = createStatusBadge('warn', 'checking');
    host.appendChild(badge);
    const next = updateStatusBadge(badge, 'ok', 'ready');
    assert.equal(host.children.length, 1);
    assert.equal(host.firstElementChild, next);
    assert.equal(next.querySelector('.status-badge-text').textContent, 'ready');
  });
});

describe('createLiveRegion()', () => {
  it('has role="status" and aria-live="polite" by default', () => {
    const live = createLiveRegion();
    assert.equal(live.el.getAttribute('role'), 'status');
    assert.equal(live.el.getAttribute('aria-live'), 'polite');
  });

  it('assertive mode uses role="alert" without aria-live', () => {
    const live = createLiveRegion({ assertive: true });
    assert.equal(live.el.getAttribute('role'), 'alert');
    assert.equal(live.el.hasAttribute('aria-live'), false);
  });

  it('announce() de-dupes an identical consecutive message', () => {
    const live = createLiveRegion();
    live.announce('Loaded 3 collections.');
    const first = live.el.textContent;
    live.announce('Loaded 3 collections.');
    assert.equal(live.el.textContent, first);
  });

  it('announce() updates on a genuinely new message', () => {
    const live = createLiveRegion();
    live.announce('one');
    live.announce('two');
    assert.equal(live.el.textContent, 'two');
  });
});

describe('loading/empty/error/partial state primitives', () => {
  it('createLoadingState() has role="status" and a default message', () => {
    const el = createLoadingState();
    assert.equal(el.getAttribute('role'), 'status');
    assert.match(el.textContent, /Loading/);
  });

  it('createEmptyState() renders the message and an optional action link', () => {
    const el = createEmptyState('No collections indexed yet.', { href: '#/index', label: 'Index a folder' });
    assert.match(el.textContent, /No collections indexed yet\./);
    const link = el.querySelector('a.state-action');
    assert.equal(link.getAttribute('href'), '#/index');
    assert.equal(link.textContent, 'Index a folder');
  });

  it('createEmptyState() omits the action entirely when none is given', () => {
    const el = createEmptyState('Nothing here.');
    assert.equal(el.querySelector('a'), null);
  });

  it('createErrorState() has role="alert" and renders err.message as text, never markup', () => {
    const malicious = new Error('<img src=x onerror="window.__pwned=true">');
    const el = createErrorState(malicious);
    assert.equal(el.getAttribute('role'), 'alert');
    assert.equal(el.querySelectorAll('img').length, 0);
    assert.match(el.textContent, /<img/);
  });

  it('createErrorState() renders a Retry control only when a retry callback is supplied', () => {
    assert.equal(createErrorState(new Error('x')).querySelector('button'), null);
    let retried = false;
    const el = createErrorState(new Error('x'), { retry: () => { retried = true; } });
    const btn = el.querySelector('button.state-retry');
    assert.ok(btn);
    btn.dispatchEvent(new Event('click', { bubbles: true }));
    assert.equal(retried, true);
  });

  it('createPartialState() has role="status" (a degraded reading is expected, not an alert)', () => {
    const el = createPartialState('Generation not ready.');
    assert.equal(el.getAttribute('role'), 'status');
    assert.match(el.textContent, /Generation not ready\./);
  });
});

describe('createDataTable() — semantic table surface with delegated row activation', () => {
  const columns = [
    { label: 'name', key: 'name', mono: true },
    { label: 'points', numeric: true, render: (r) => String(r.points) },
  ];

  it('renders a real <table> with <th scope="col"> headers', () => {
    const table = createDataTable({ columns, rows: [{ name: 'a', points: 1 }] });
    const th = table.querySelector('thead th');
    assert.equal(th.getAttribute('scope'), 'col');
    assert.equal(th.textContent, 'name');
  });

  it('renders untrusted row text via textContent, never innerHTML (XSS-safe)', () => {
    const malicious = '<img src=x onerror="window.__pwned=true">';
    const table = createDataTable({ columns, rows: [{ name: malicious, points: 1 }] });
    assert.equal(table.querySelectorAll('img').length, 0);
    assert.match(table.textContent, /<img/);
  });

  it('a column render() returning a Node is appended directly, not stringified', () => {
    const badgeColumns = [{ label: 'status', render: () => createStatusBadge('ok', 'ready') }];
    const table = createDataTable({ columns: badgeColumns, rows: [{}] });
    assert.ok(table.querySelector('td .status-badge'));
  });

  it('registers exactly ONE click listener on <tbody>, regardless of row count (delegation, not per-row)', () => {
    const original = EventTarget.prototype.addEventListener;
    let calls = 0;
    EventTarget.prototype.addEventListener = function patched(...args) {
      calls++;
      return original.apply(this, args);
    };
    try {
      const rows = Array.from({ length: 25 }, (_, i) => ({ name: `n${i}`, points: i }));
      createDataTable({ columns, rows, getRowKey: (r) => r.name, onActivateRow: () => {} });
      // Exactly 2 listeners total for the whole table (click + keydown on
      // tbody) — NOT one per row, and not scaling with the 25 rows above.
      assert.equal(calls, 2, `expected exactly 2 addEventListener calls (click+keydown on tbody), got ${calls}`);
    } finally {
      EventTarget.prototype.addEventListener = original;
    }
  });

  it('a delegated click on a row invokes onActivateRow with that row\'s key, even for a row added after the table was built', () => {
    let activated = null;
    const table = createDataTable({
      columns, rows: [{ name: 'a', points: 1 }], getRowKey: (r) => r.name,
      onActivateRow: (key) => { activated = key; },
    });
    const tbody = table.querySelector('tbody');
    // A row added to the DOM after construction — proves the listener lives
    // on <tbody> (delegation), not attached to the original row elements.
    const tr = document.createElement('tr');
    tr.dataset.rowKey = 'late-row';
    const td = document.createElement('td');
    td.textContent = 'late';
    tr.appendChild(td);
    tbody.appendChild(tr);
    td.dispatchEvent(new Event('click', { bubbles: true }));
    assert.equal(activated, 'late-row');
  });

  it('does not wire any activation listener when onActivateRow is omitted (a read-only table)', () => {
    const original = EventTarget.prototype.addEventListener;
    let calls = 0;
    EventTarget.prototype.addEventListener = function patched(...args) { calls++; return original.apply(this, args); };
    try {
      createDataTable({ columns, rows: [{ name: 'a', points: 1 }] });
      assert.equal(calls, 0);
    } finally {
      EventTarget.prototype.addEventListener = original;
    }
  });
});
