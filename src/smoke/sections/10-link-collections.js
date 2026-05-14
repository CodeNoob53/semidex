export default async function ({ ok }) {
  console.log('\n[10] resolveLinkCollections (no Qdrant)');

  const { resolveLinkCollections } = await import('../../indexer/index.js');

  // 10a. Standard: qdrant has foreign; config knows a,b; current=a → {a,b}
  {
    const result = resolveLinkCollections(['a', 'b', 'foreign'], { a: {}, b: {} }, 'a', null);
    ok('qdrant {a,b,foreign}, config {a,b}, current a → {a,b}',
      result.length === 2 && result.includes('a') && result.includes('b') && !result.includes('foreign'));
  }

  // 10b. Config empty, current a → {a} (current always included)
  {
    const result = resolveLinkCollections(['a', 'b'], {}, 'a', null);
    ok('config empty, current a → includes a',  result.includes('a'));
    ok('config empty → no b',                   !result.includes('b'));
  }

  // 10c. Current collection missing from config → still included
  {
    const result = resolveLinkCollections(['a', 'b', 'c'], { b: {}, c: {} }, 'a', null);
    ok('current a missing from config → includes a',  result.includes('a'));
    ok('config-known b,c also included',              result.includes('b') && result.includes('c'));
    ok('no foreign beyond a,b,c',                     result.length === 3);
  }

  // 10d. LINK_COLLECTIONS=b with config {a,b,c}, current a → narrows to {b}
  {
    const result = resolveLinkCollections(['a', 'b', 'c'], { a: {}, b: {}, c: {} }, 'a', new Set(['b']));
    ok('LINK_COLLECTIONS=b, config {a,b,c}, current a → only b',
      result.length === 1 && result[0] === 'b');
  }

  // 10e. No Qdrant-only foreign collection ever included
  {
    const result = resolveLinkCollections(['a', 'external-1', 'external-2'], { a: {} }, 'a', null);
    ok('foreign Qdrant-only collections excluded',
      !result.includes('external-1') && !result.includes('external-2'));
  }

  // 10f. Current collection not yet in Qdrant list → still included
  {
    const result = resolveLinkCollections(['b', 'c'], { a: {}, b: {}, c: {} }, 'a', null);
    ok('current a not yet in qdrant list → still included', result.includes('a'));
  }

  // 10g. linkDisabled: true on a non-current collection → excluded
  {
    const result = resolveLinkCollections(
      ['a', 'b', 'legacy'],
      { a: {}, b: {}, legacy: { linkDisabled: true } },
      'a', null,
    );
    ok('linkDisabled entry excluded from link targets', !result.includes('legacy'));
    ok('non-disabled entries still included',           result.includes('a') && result.includes('b'));
  }

  // 10h. linkDisabled: true on the current collection → still included
  {
    const result = resolveLinkCollections(
      ['a', 'b'],
      { a: { linkDisabled: true }, b: {} },
      'a', null,
    );
    ok('current collection included even if linkDisabled', result.includes('a'));
  }

  // 10i. linkDisabled + LINK_COLLECTIONS allowlist: disabled entry stays excluded
  {
    const result = resolveLinkCollections(
      ['a', 'b', 'legacy'],
      { a: {}, b: {}, legacy: { linkDisabled: true } },
      'a', new Set(['a', 'legacy']),
    );
    ok('linkDisabled excluded even when named in LINK_COLLECTIONS allowlist',
      !result.includes('legacy'));
    ok('non-disabled allowlisted entry included', result.includes('a'));
  }

  // 10j. linkDisabled: false (explicit false) → not excluded
  {
    const result = resolveLinkCollections(
      ['a', 'b'],
      { a: {}, b: { linkDisabled: false } },
      'a', null,
    );
    ok('linkDisabled: false is not excluded', result.includes('b'));
  }
}
