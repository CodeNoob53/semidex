import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readUiSource } from './ui-test-helpers.js';

function rules(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 'g'))].map((match) => match[1]);
}

describe('admin shell scroll ownership', () => {
  it('prevents the document from becoming a scroll container', () => {
    const css = readUiSource('app.css');
    const [documentRule = ''] = rules(css, 'html, body');
    assert.match(documentRule, /height:\s*100%/);
    assert.match(documentRule, /overflow:\s*hidden/);
  });

  it('keeps scrolling inside the sidebar and main content only', () => {
    const css = readUiSource('app.css');
    const layoutRule = rules(css, '.layout').find((body) => /overflow:\s*hidden/.test(body)) ?? '';
    assert.match(layoutRule, /min-height:\s*0/);
    assert.match(layoutRule, /overflow:\s*hidden/);

    for (const selector of ['.sidebar', '.main']) {
      const scrollRule = rules(css, selector).find((body) => /overflow-y:\s*auto/.test(body)) ?? '';
      assert.match(scrollRule, /min-height:\s*0/);
      assert.match(scrollRule, /overflow-y:\s*auto/);
    }
  });
});
