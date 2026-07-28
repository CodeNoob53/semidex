// Source-level regression guards for the embedding-profile-related
// additions to src/core/qdrant/store.js (updateCollectionMetadata,
// scrollFilteredPages, createCollection's metadata param) — no live Qdrant
// needed, matching this repo's existing store.js-level test convention
// (see qdrant-store-nav-exclusion.test.js's header comment). Real
// early-exit/pagination behavior is proven at the adapter level via the
// storeOverrides DI seam (tests/unit/core/storage/qdrant-adapter.test.js)
// and against the live dev cluster during verification.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  fileURLToPath(new URL('../../../src/core/qdrant/store.js', import.meta.url)),
  'utf-8',
);

describe('updateCollectionMetadata() — native metadata write primitive', () => {
  it('calls client.updateCollection with a metadata key, using the write client', () => {
    const start = src.indexOf('export async function updateCollectionMetadata');
    assert.ok(start > -1, 'updateCollectionMetadata must be defined');
    const end = src.indexOf('\n}\n', start);
    const fn = src.slice(start, end);
    assert.match(fn, /getQdrantClient\(\{\s*write:\s*true\s*\}\)/, 'must use the write client, not the read-only client');
    assert.match(fn, /updateCollection\(name,\s*\{\s*metadata\s*\}\)/);
  });
});

describe('scrollFilteredPages() — real early-exit pagination primitive', () => {
  it('is defined, accepts an onPage callback, and stops when onPage returns false', () => {
    const start = src.indexOf('export async function scrollFilteredPages');
    assert.ok(start > -1, 'scrollFilteredPages must be defined');
    const end = src.indexOf('\n}\n', start);
    const fn = src.slice(start, end);
    assert.match(fn, /onPage\(batch\)/);
    assert.match(fn, /keepGoing === false/, 'must actually check the onPage return value to decide whether to continue paginating');
    assert.match(fn, /with_vector:\s*false/, 'must never request vectors — this is an identity-field-only scan');
  });

  it('is a genuinely distinct function from scrollAllFiltered — not a thin alias', () => {
    const scrollAllStart = src.indexOf('export async function scrollAllFiltered');
    const scrollAllEnd = src.indexOf('\n}\n', scrollAllStart);
    const scrollAllFn = src.slice(scrollAllStart, scrollAllEnd);
    assert.ok(!/onPage/.test(scrollAllFn), 'scrollAllFiltered must remain the always-exhaust-every-page function, unmodified');
  });
});

describe('createCollection() — optional metadata + vectorSchema parameters, applied atomically via client.api().createCollection()', () => {
  it('uses the low-level client.api().createCollection() fetch wrapper, not the high-level client.createCollection() method', () => {
    // Live-cluster finding (Part H verification, v1.18.0 @qdrant/js-client-rest
    // against a real v1.17.1 Qdrant Cloud cluster): the SDK's HIGH-LEVEL
    // client.createCollection(name, {...}) wrapper destructures a fixed
    // parameter list that does NOT include `metadata` — passing metadata in
    // the request body is silently dropped before the HTTP request is even
    // built, even though the OpenAPI types and a raw REST call both accept
    // it. A first fix (create, then a separate updateCollectionMetadata()
    // call) was rejected on review: it makes collection creation
    // non-atomic — if the process dies between the two calls, an empty
    // collection with no profile is left behind, and a later run treats it
    // as an unmigrated legacy collection instead of a failed create.
    // client.api() — no argument; api-client.js's api() ignores whatever is
    // passed and always returns the same flat generated fetch-client object
    // (confirmed directly: client.api('collections') === client.api()) — is
    // the SDK's own generated LOW-LEVEL fetch wrapper (same layer
    // updateCollection() is built on). It passes the request body straight
    // through unfiltered, so metadata reaches Qdrant in the SAME atomic PUT
    // that creates the collection. Verified directly against the live
    // cluster.
    //
    // Fixed after a further review round: createCollection() gained a
    // fourth `vectorSchema` parameter — when the adapter's createCollection()
    // (Part B) builds the FULL vector schema from a profile
    // (buildQdrantVectorSchemaFromProfile(), qdrant-adapter.js), it's passed
    // through here as-is instead of always falling back to the hardcoded
    // Cosine+always-sparse default (collectionVectorSchema(size)) — this is
    // what makes a profile's real distance/sparse-presence/modifier actually
    // reach Qdrant, rather than being silently overridden by the default.
    const start = src.indexOf('export async function createCollection');
    assert.ok(start > -1, 'createCollection must be defined');
    const end = src.indexOf('\n}\n', start);
    const fn = src.slice(start, end);
    assert.match(fn, /createCollection\(name,\s*size\s*=\s*1024,\s*metadata,\s*vectorSchema\)/);
    assert.match(fn, /client\.api\(\)\.createCollection\(\{/, 'must use the low-level fetch wrapper that does not silently drop metadata — client.api() takes no argument');
    assert.ok(!/client\.api\(\s*['"]/.test(fn), 'client.api() must never be called with an argument — it takes none and any argument is silently ignored');
    assert.match(fn, /collection_name:\s*name/);
    assert.match(fn, /vectorSchema\s*\?\?\s*collectionVectorSchema\(size\)/, 'a caller-provided vectorSchema must win over the hardcoded default, not be ignored');
    assert.match(fn, /\.\.\.resolvedSchema/, 'the resolved schema (profile-derived or default) must be spread into the SAME create request');
    assert.match(fn, /metadata\s*!==\s*undefined\s*\?\s*\{\s*metadata\s*\}/, 'metadata must be spread into the SAME create request, not applied via a second call');
    const codeOnly = fn.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    assert.ok(!/\bclient\.createCollection\(/.test(codeOnly), 'must not use the high-level wrapper, which silently drops metadata');
    assert.ok(!/updateCollectionMetadata\(name/.test(fn), 'must not apply metadata via a follow-up call — creation must be a single atomic request');
  });
});
