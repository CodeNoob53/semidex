// Collection-naming UI copy — lives in jobs-view.js (create-collection form)
// + its ?raw-imported index-view.html partial.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readUiModuleWithPartial } from './ui-test-helpers.js';

describe('collection naming (ui-src source)', () => {
  it('does not suggest lowercase-hyphen slug names anywhere in the served UI', () => {
    const js = readUiModuleWithPartial('jobs-view.js', 'full/index-view.html'); // the collection-name field/placeholder lives in index-view.html
    assert.ok(!/my-docs/.test(js), 'jobs-view.js must not use the old slug placeholder "my-docs"');
    assert.ok(!/lowercase-hyphen|lowercase and hyphens|use lowercase/i.test(js), 'no lowercase-hyphen guidance should remain');
  });

  it('uses a human-readable example as the collection-name placeholder', () => {
    const js = readUiModuleWithPartial('jobs-view.js', 'full/index-view.html');
    assert.match(js, /idx-collection/);
    const start = js.indexOf('id="idx-collection"');
    const tag = js.slice(start - 20, start + 120);
    assert.match(tag, /placeholder="[^"]*[А-ЯҐЄІЇа-яґєії ][^"]*"/, 'placeholder should look like a human name, not a slug');
  });
});
