// Tests for src/admin/ui-src/topbar.js's active-operation chip. Phase 3S:
// the chip no longer polls /api/jobs on its own timer — it subscribes to
// the shared operation-store.js (one poller for the whole app) and clicking
// it opens the global operation modal in place, instead of navigating to
// #/index (which is collection-creation only now — the jobs list that used
// to live there is gone; see ui-jobs.test.js).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTopbarHelpers, readUiSource, withServer } from './ui-test-helpers.js';

describe('topbar operation chip — subscribes to the shared store, never polls on its own', () => {
  it('initJobChip() subscribes to the store instead of calling api(\'/api/jobs\') itself', () => {
    const js = readUiSource('topbar.js');
    assert.match(js, /import\s*\{\s*subscribe,\s*getActiveOperation\s*\}\s*from ['"]\.\/operation-store\.js['"]/);
    assert.ok(!/api\(['"]\/api\/jobs['"]\)/.test(js), 'topbar.js must not poll /api/jobs directly — operation-store.js owns that');
    assert.ok(!/setTimeout/.test(js), 'no independent poll-scheduling timer should exist in this module at all');
  });

  it('stays hidden when the store reports no active operation', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initJobChip, __emitUpdate } = loadTopbarHelpers(html);
      initJobChip();
      __emitUpdate();
      assert.equal(document.getElementById('job-chip').hidden, true);
    });
  });

  it('becomes visible and shows the collection name + kind label with an active operation', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initJobChip, __emitUpdate, __setActive } = loadTopbarHelpers(html);
      initJobChip();
      __setActive({ id: 'op1', kind: 'index', collection: 'my-docs', state: 'running', progress: null });
      __emitUpdate();
      const chip = document.getElementById('job-chip');
      assert.equal(chip.hidden, false);
      assert.match(chip.textContent, /my-docs/);
      assert.match(chip.textContent, /Indexing/);
    });
  });

  it('shows a percentage when the operation has known progress', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initJobChip, __emitUpdate, __setActive } = loadTopbarHelpers(html);
      initJobChip();
      __setActive({ id: 'op1', kind: 'index', collection: 'my-docs', state: 'running', progress: { percent: 42.7 } });
      __emitUpdate();
      assert.match(document.getElementById('job-chip').textContent, /43%/);
    });
  });

  it('shows no fabricated percentage when progress is unknown (indeterminate) — the dot alone signals activity', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initJobChip, __emitUpdate, __setActive } = loadTopbarHelpers(html);
      initJobChip();
      __setActive({ id: 'op1', kind: 'repair', collection: 'my-docs', state: 'running', progress: null });
      __emitUpdate();
      assert.doesNotMatch(document.getElementById('job-chip').textContent, /%/);
    });
  });

  it('labels a reindex operation distinctly from a fresh index', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initJobChip, __emitUpdate, __setActive } = loadTopbarHelpers(html);
      initJobChip();
      __setActive({ id: 'op1', kind: 'reindex', collection: 'my-docs', state: 'running', progress: null });
      __emitUpdate();
      assert.match(document.getElementById('job-chip').textContent, /Reindexing/);
    });
  });

  it('labels a repair operation distinctly', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initJobChip, __emitUpdate, __setActive } = loadTopbarHelpers(html);
      initJobChip();
      __setActive({ id: 'op1', kind: 'repair', collection: 'my-docs', state: 'running', progress: null });
      __emitUpdate();
      assert.match(document.getElementById('job-chip').textContent, /Repairing/);
    });
  });

  it('clicking the chip opens the operation modal on the active operation, without navigating anywhere', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let openedWith = null;
      const { document, initJobChip, __emitUpdate, __setActive } = loadTopbarHelpers(html, {
        openOperationModalImpl: (id) => { openedWith = id; },
      });
      initJobChip();
      __setActive({ id: 'op1', kind: 'index', collection: 'my-docs', state: 'running', progress: null });
      __emitUpdate();
      document.getElementById('job-chip').click();
      assert.equal(openedWith, 'op1');
      assert.equal(document.location, undefined, 'topbar.js has no location import at all — it must never navigate');
    });
  });

  it('never writes to location.hash anywhere in source (regression: used to navigate to #/index on chip click)', () => {
    const js = readUiSource('topbar.js');
    assert.ok(!/location\.hash\s*=/.test(js), 'topbar.js must never navigate — clicking the chip only opens the modal in place');
  });

  it('renderJobChip escapes an untrusted collection name (XSS-safe)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const malicious = '<img src=x onerror="window.__pwned=true">';
      const { document, renderJobChip } = loadTopbarHelpers(html);
      const chip = document.getElementById('job-chip');
      renderJobChip(chip, { id: 'op1', kind: 'index', collection: malicious, state: 'running', progress: null });
      assert.equal(chip.querySelectorAll('img').length, 0, 'malicious collection name must never be parsed into a real element');
      assert.match(chip.textContent, /<img/, 'the malicious text must render as inert text, not markup');
    });
  });
});

// ── Phase 4A.5b: global runtime settings gear link ─────────────────────────
// Full behavioral coverage (readiness/unavailable/provenance rendering,
// hostile-string handling) lives in ui-global-settings.test.js — these
// tests cover the specific piece that lives in topbar.js itself: rendering
// the shared iconGear() SVG into the real, served link element.
describe('topbar — global settings gear link (#/settings)', () => {
  it('initGlobalSettingsLink() renders the real iconGear() SVG into #nav-global-settings', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initGlobalSettingsLink } = loadTopbarHelpers(html);
      const link = document.getElementById('nav-global-settings');
      assert.ok(link, 'index.html must serve a #nav-global-settings element');
      initGlobalSettingsLink();
      assert.ok(link.querySelector('svg[data-icon="gear"]'), 'the real iconGear() SVG must be rendered into the link');
    });
  });

  it('the served link points at #/settings and carries accessible name + title', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document } = loadTopbarHelpers(html);
      const link = document.getElementById('nav-global-settings');
      assert.equal(link.getAttribute('href'), '#/settings');
      assert.equal(link.getAttribute('aria-label'), 'Semidex settings');
      assert.equal(link.getAttribute('title'), 'Semidex settings');
    });
  });

  it('is a real <a> element, keyboard-focusable and activatable like any other nav link', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document } = loadTopbarHelpers(html);
      const link = document.getElementById('nav-global-settings');
      assert.equal(link.tagName.toLowerCase(), 'a');
    });
  });
});

// ── Phase 3D: CSS actually honors the "hidden" attribute (browser-verified) ─
describe('app.css — .job-chip[hidden] actually hides the chip', () => {
  it('has an explicit [hidden] override rule, not just an unconditional "display: flex"', () => {
    const css = readUiSource('app.css');
    assert.match(css, /\.job-chip\[hidden\]\s*\{\s*display:\s*none;?\s*\}/,
      '.job-chip must have an explicit [hidden] rule that actually hides it');
  });
});

// ── Phase 4A.5b code review: the topbar previously had no narrow-viewport
// handling at all (the sole existing media query only ever touched
// .layout/.main) — adding the settings gear link left zero slack in a
// fixed-height, non-wrapping flex row. These assertions can't replace a
// real rendered-pixel check (no headless browser is installed in this
// project — see the Phase 4A.5b report's documented limitation), but they
// do pin the actual CSS mechanism a real narrow viewport depends on: the
// brand text can shrink/truncate instead of refusing to shrink, decorative
// content sheds at a defined breakpoint, the health-status text is bounded
// so it can never alone force the row wider than the viewport, and (round
// 2 — the first pass missed this) the active-job chip's own dynamic,
// user-controlled collection-name text is independently bounded too, since
// .topbar-status's flex-shrink: 0 only protects the row from shrinking
// itself, not from one of its own children growing unboundedly.
describe('app.css — topbar does not force horizontal overflow at narrow viewports', () => {
  it('.brand can shrink below its natural content width (min-width: 0) and truncates instead of overflowing', () => {
    const css = readUiSource('app.css');
    const brandRule = css.match(/\.brand\s*\{[^}]*\}/)?.[0] ?? '';
    assert.match(brandRule, /min-width:\s*0/);
    assert.match(brandRule, /text-overflow:\s*ellipsis/);
  });

  it('has a narrow-viewport rule that hides decorative topbar content (.brand-sub, .cap-summary)', () => {
    const css = readUiSource('app.css');
    const mediaBlock = css.match(/@media[^{]*\{[^}]*\.brand-sub[^}]*\}/s)?.[0] ?? '';
    assert.match(mediaBlock, /\.brand-sub/);
    assert.match(mediaBlock, /\.cap-summary/);
    assert.match(mediaBlock, /display:\s*none/);
  });

  it('#health-text is bounded (max-width + truncation), never allowed to grow unbounded', () => {
    const css = readUiSource('app.css');
    const rule = css.match(/#health-text\s*\{[^}]*\}/)?.[0] ?? '';
    assert.match(rule, /max-width/);
    assert.match(rule, /text-overflow:\s*ellipsis/);
  });

  it('.topbar-status itself does not shrink relative to .brand (the row keeps its controls, .brand gives way first)', () => {
    const css = readUiSource('app.css');
    const rule = css.match(/\.topbar-status\s*\{[^}]*\}/)?.[0] ?? '';
    assert.match(rule, /flex-shrink:\s*0/);
  });

  // Round-2 code review: .topbar-status having flex-shrink: 0 does NOT
  // bound an unboundedly long *active-operation collection name* inside
  // the job chip — that chip has its own dynamic, user-controlled text
  // content (topbar.js's renderJobChip()) with no length limit enforced
  // anywhere (the API only rejects "/" and "\"). Without its own
  // max-width + truncation, a long collection name could grow the chip
  // (and therefore the whole topbar row) past the viewport on its own,
  // independent of whatever the brand/health-text side was doing.
  it('.job-chip is bounded by a max-width, not just an unbounded flex child of .topbar-status', () => {
    const css = readUiSource('app.css');
    const rule = css.match(/\.job-chip\s*\{[^}]*\}/)?.[0] ?? '';
    assert.match(rule, /max-width/);
    assert.match(rule, /min-width:\s*0/, '.job-chip must be able to actually shrink to its max-width inside the flex row, not just declare one');
  });

  it('the job chip\'s label/collection/percent text truncates with ellipsis instead of growing the chip unboundedly', () => {
    const css = readUiSource('app.css');
    const rule = css.match(/\.job-chip-text\s*\{[^}]*\}/)?.[0] ?? '';
    assert.match(rule, /overflow:\s*hidden/);
    assert.match(rule, /text-overflow:\s*ellipsis/);
    assert.match(rule, /white-space:\s*nowrap/);
  });

  it('narrows the job chip further at the narrow-viewport breakpoint, same as the rest of the topbar', () => {
    const css = readUiSource('app.css');
    const mediaBlock = css.match(/@media[^{]*max-width:\s*640px[^{]*\{[^}]*\.job-chip[^}]*\}/s)?.[0] ?? '';
    assert.match(mediaBlock, /\.job-chip/);
    assert.match(mediaBlock, /max-width/);
  });
});

describe('renderJobChip() — long collection name is wrapped for CSS truncation, not raw text', () => {
  it('wraps label/collection/percent in a .job-chip-text element (not bare text nodes) so app.css can truncate it', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const longName = 'a-very-long-collection-name-that-would-otherwise-overflow-the-topbar-chip-and-the-page-itself';
      const { document, renderJobChip } = loadTopbarHelpers(html);
      const chip = document.getElementById('job-chip');
      renderJobChip(chip, { id: 'op1', kind: 'index', collection: longName, state: 'running', progress: null });
      const textEl = chip.querySelector('.job-chip-text');
      assert.ok(textEl, 'renderJobChip must wrap its text content in .job-chip-text for CSS truncation to apply');
      assert.match(textEl.textContent, /a-very-long-collection-name/);
    });
  });
});

describe('topbar operation chip — renderJobChip() pure rendering', () => {
  it('hides and clears the chip for no active operation (null)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, renderJobChip } = loadTopbarHelpers(html);
      const chip = document.getElementById('job-chip');
      chip.hidden = false;
      chip.textContent = 'stale';
      renderJobChip(chip, null);
      assert.equal(chip.hidden, true);
      assert.equal(chip.textContent, '');
    });
  });

  it('reuses the existing job-progress visual language via a small pulsing dot element', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, renderJobChip } = loadTopbarHelpers(html);
      const chip = document.getElementById('job-chip');
      renderJobChip(chip, { id: 'op1', kind: 'index', collection: 'my-docs', state: 'running', progress: null });
      assert.ok(chip.querySelector('.job-chip-dot'), 'chip must render its indicator dot element');
    });
  });
});
