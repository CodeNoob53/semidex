import { makePointId } from '../../core/point-id.js';

export default async function ({ ok }) {
  console.log('\n[32] Deterministic point IDs');

  const base = { collection: 'test-col', sourceFile: 'docs/intro.md', chunkIndex: 0, embeddingSchemaVersion: 2 };

  // Stability
  ok('same inputs → same ID',
    makePointId(base) === makePointId(base));

  ok('result is a UUID string',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(makePointId(base)));

  ok('version nibble is 5',
    makePointId(base)[14] === '5');

  ok('variant bits are set (8, 9, a, or b)',
    '89ab'.includes(makePointId(base)[19]));

  // Identity axes — each dimension must produce a different ID
  ok('different chunkIndex → different ID',
    makePointId(base) !== makePointId({ ...base, chunkIndex: 1 }));

  ok('different sourceFile → different ID',
    makePointId(base) !== makePointId({ ...base, sourceFile: 'docs/other.md' }));

  ok('different collection → different ID',
    makePointId(base) !== makePointId({ ...base, collection: 'other-col' }));

  ok('different embeddingSchemaVersion → different ID',
    makePointId(base) !== makePointId({ ...base, embeddingSchemaVersion: 3 }));

  // Excluded fields must NOT change the ID
  ok('file_hash excluded — does not affect ID',
    (() => {
      const id1 = makePointId(base);
      const id2 = makePointId(base); // same call; file_hash is never an input
      // Verify by calling with explicit extra field via the same spread — makePointId
      // ignores unknown fields, so passing a fabricated hash must not change output.
      const id3 = makePointId({ ...base, file_hash: 'deadbeef' });
      return id1 === id2 && id1 === id3;
    })());

  ok('tags excluded — does not affect ID',
    makePointId({ ...base, tags: ['a', 'b'] }) === makePointId(base));

  ok('context excluded — does not affect ID',
    makePointId({ ...base, context: 'some context text' }) === makePointId(base));

  // Path separator normalisation — Windows backslash must equal forward slash
  ok('backslash path == forward-slash path (Windows normalisation)',
    makePointId({ ...base, sourceFile: 'docs\\intro.md' }) === makePointId(base));
}
