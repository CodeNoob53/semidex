// Qdrant Cloud Inference model catalog + the two DISTINCT context-window
// compatibility checks — coarse settings-time (isCatalogCompatibleWithChunking,
// qdrant-cloud-models.js) vs. real embed-time (checkEmbedInputFits,
// qdrant-cloud-catalog.js, backed by a REAL per-model tokenizer, never the
// char/4 heuristic). The real-tokenizer regression tests use the tokenizer
// files already cached under models/intfloat/multilingual-e5-small/ (same
// files onnx-embed.js/bge-tokenizer.js already download for other
// purposes) via localFilesOnly — no network access, no ONNX weights, no
// Transformers.js runtime.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  QDRANT_CLOUD_DENSE_MODELS, QDRANT_CLOUD_SPARSE_MODELS,
  findDenseModel, findSparseModel, isDenseModelSupported, isCatalogCompatibleWithChunking,
} from '../../../../src/core/embedding-profile/qdrant-cloud-models.js';
import { checkEmbedInputFits, fitContextToBudget, buildCloudQueryInputs } from '../../../../src/core/embedding-profile/qdrant-cloud-catalog.js';
import { loadQdrantCloudTokenizer } from '../../../../src/core/embedding-profile/qdrant-cloud-tokenizer.js';

const E5 = findDenseModel('intfloat/multilingual-e5-small');
const MINILM = findDenseModel('sentence-transformers/all-minilm-l6-v2');
const BM25 = findSparseModel('qdrant/bm25');

// Skip the real-tokenizer tests gracefully (never fail the suite) when the
// tokenizer files aren't cached locally and there's no network access to
// fetch them — matches this repo's existing convention for tokenizer-file-
// dependent tests (see tests/unit/core/bge-tokenizer-parity.test.js).
let e5TokenizerAvailable = true;
try {
  await loadQdrantCloudTokenizer(E5.id, { localFilesOnly: true });
} catch {
  e5TokenizerAvailable = false;
}

describe('QDRANT_CLOUD_DENSE_MODELS / QDRANT_CLOUD_SPARSE_MODELS catalog', () => {
  it('E5 (intfloat/multilingual-e5-small) is marked supported, 384d, 512-token window', () => {
    assert.equal(E5.status, 'supported');
    assert.equal(E5.dimensions, 384);
    assert.equal(E5.contextWindow, 512);
    assert.equal(E5.reason, null);
  });

  it('BM25 (qdrant/bm25) is marked supported with modifier: idf', () => {
    assert.equal(BM25.status, 'supported');
    assert.equal(BM25.modifier, 'idf');
    assert.equal(BM25.contextWindow, null);
  });

  it('MiniLM (sentence-transformers/all-minilm-l6-v2) is marked unsupported with a stated reason', () => {
    assert.equal(MINILM.status, 'unsupported');
    assert.match(MINILM.reason, /256/);
    assert.match(MINILM.reason, /context window/i);
  });

  it('findDenseModel/findSparseModel return null for an unknown id', () => {
    assert.equal(findDenseModel('not-a-real-model'), null);
    assert.equal(findSparseModel('not-a-real-model'), null);
  });

  it('isDenseModelSupported is true only for a catalog-supported model', () => {
    assert.equal(isDenseModelSupported(E5.id), true);
    assert.equal(isDenseModelSupported(MINILM.id), false);
    assert.equal(isDenseModelSupported('unknown'), false);
  });

  it('no ColBERT/SPLADE/image/Cohere/Jina/OpenAI/OpenRouter entries exist anywhere in the catalog', () => {
    const allIds = [...QDRANT_CLOUD_DENSE_MODELS, ...QDRANT_CLOUD_SPARSE_MODELS].map((m) => m.id.toLowerCase());
    for (const banned of ['colbert', 'splade', 'cohere', 'jina', 'openai', 'openrouter', 'clip']) {
      assert.ok(!allIds.some((id) => id.includes(banned)), `catalog must not contain a "${banned}" entry`);
    }
  });
});

describe('isCatalogCompatibleWithChunking() — coarse, settings-time only', () => {
  it('flags MiniLM (256) against a 512-token MAX_CHUNK_TOKENS', () => {
    assert.equal(isCatalogCompatibleWithChunking(MINILM, { maxChunkTokens: 512 }), false);
  });

  it('accepts E5 (512) against a 512-token MAX_CHUNK_TOKENS', () => {
    assert.equal(isCatalogCompatibleWithChunking(E5, { maxChunkTokens: 512 }), true);
  });

  it('a null-contextWindow model (e.g. BM25) is always compatible', () => {
    assert.equal(isCatalogCompatibleWithChunking(BM25, { maxChunkTokens: 999999 }), true);
  });
});

describe('checkEmbedInputFits() — REAL per-embed check, tokenizer-backed, async', () => {
  it('a model with no contextWindow always fits, without loading any tokenizer', async () => {
    const result = await checkEmbedInputFits(BM25, 'x'.repeat(100000));
    assert.deepEqual(result, { fits: true, tokenCount: null, contextWindow: null });
  });

  it('TOKENIZER_UNAVAILABLE is a hard stop, never a silent fallback to the heuristic', async () => {
    const unknownModel = { id: 'definitely/not-a-real-model-xyz', contextWindow: 512 };
    const result = await checkEmbedInputFits(unknownModel, 'short text that would easily fit under any heuristic');
    assert.equal(result.fits, false);
    assert.equal(result.code, 'TOKENIZER_UNAVAILABLE');
  });

  it('a short text fits E5\'s 512-token window (real tokenizer)', { skip: !e5TokenizerAvailable }, async () => {
    const result = await checkEmbedInputFits(E5, 'A short sentence about semidex.');
    assert.equal(result.fits, true);
    assert.ok(Number.isInteger(result.tokenCount));
    assert.equal(result.contextWindow, 512);
  });

  it('REGRESSION (P1 fix): a dense camelCase-identifier text whose HEURISTIC estimate says "fits" (<=512) is REJECTED by the real tokenizer, which counts MORE tokens than the window allows', { skip: !e5TokenizerAvailable }, async () => {
    // Built to land the heuristic (chars/4) estimate just under 512 while
    // the real E5 tokenizer — which splits dense camelCase/identifier text
    // into many more subword tokens — counts well over 512. This is the
    // exact class of input the review flagged: "Math.ceil(text.length/4)
    // ... can substantially understate token count for ... code and
    // identifiers", reintroducing silent truncation risk if unfixed.
    const chunk = 'resolveEmbeddingProfileFromCollectionInfoConfigMetadataParamsVectorsSparseVectors ';
    let text = '';
    let heuristicEstimate = 0;
    while (heuristicEstimate < 480) {
      text += chunk;
      heuristicEstimate = Math.ceil(text.length / 4);
    }
    assert.ok(heuristicEstimate <= 512, 'test setup: heuristic must say it fits, to prove the real check catches what heuristic would miss');

    const result = await checkEmbedInputFits(E5, text);
    assert.equal(result.fits, false, 'the real tokenizer must reject this input even though the heuristic estimate says it fits');
    assert.equal(result.code, 'EMBEDDING_INPUT_TOO_LONG');
    assert.ok(result.tokenCount > 512, `expected real tokenCount > 512, got ${result.tokenCount}`);
  });

  it('is called against the FULL assembled context+text string, never chunk.text alone (proven by the caller contract, not this function\'s own logic)', { skip: !e5TokenizerAvailable }, async () => {
    // checkEmbedInputFits() itself has no notion of "context" vs "text" —
    // it only ever sees whatever string it's given. This test pins that
    // contract: passing a short chunk.text ALONE fits, but passing that
    // same text prefixed with a long context string does not — proving
    // the function's behavior is sensitive to what's included in embedText,
    // which is exactly why embedForIndexCloud (embeddings.js) must pass
    // the full assembled string, never chunk.text alone.
    const chunkTextAlone = 'A short chunk body.';
    const fitsAlone = await checkEmbedInputFits(E5, chunkTextAlone);
    assert.equal(fitsAlone.fits, true);

    const heavyContext = 'Section > Subsection > '.repeat(200);
    const fitsWithContext = await checkEmbedInputFits(E5, `${heavyContext}\n\n${chunkTextAlone}`);
    assert.equal(fitsWithContext.fits, false, 'a heavy context prefix must be able to push the assembled string over the window even when chunk.text alone would fit');
  });
});

describe('fitContextToBudget() — REGRESSION for P1: a typical chunk (body near MAX_CHUNK_TOKENS + normal context) must not hard-fail indexing', () => {
  it('a model with no contextWindow always fits, context unchanged, without loading any tokenizer', async () => {
    const result = await fitContextToBudget(BM25, 'some context', 'some text');
    assert.deepEqual(result, { context: 'some context', tokenCount: 0 });
  });

  it('when the full context+text already fits, context is returned UNCHANGED (no unnecessary trimming)', { skip: !e5TokenizerAvailable }, async () => {
    const context = 'Doc > Section';
    const text = 'A short chunk body.';
    const result = await fitContextToBudget(E5, context, text);
    assert.equal(result.context, context);
  });

  it('REGRESSION: a chunk whose body is near the window and whose context is a normal heading-path pushes the assembled input over — context is trimmed (kept tail), text is NEVER touched, and the retry fits', { skip: !e5TokenizerAvailable }, async () => {
    // A realistic heading-path/skeleton-summary context, long enough on its
    // own to push a near-window-sized body over 512 real E5 tokens.
    const context = 'Semidex Lite > Architecture > Storage Adapter > Qdrant Adapter > Embedding Profile > Schema Building > '.repeat(4);
    const chunk = 'This function derives the full Qdrant collection-creation vector schema object from the resolved embedding profile alone. ';
    let text = '';
    let fits = true;
    while (fits) {
      text += chunk;
      fits = (await checkEmbedInputFits(E5, `${context}\n\n${text}`)).fits;
    }
    // test setup: confirm the unmodified assembly genuinely doesn't fit
    // (the loop above appends exactly until it stops fitting).
    const unfitted = await checkEmbedInputFits(E5, `${context}\n\n${text}`);
    assert.equal(unfitted.fits, false, 'test setup: expected the untrimmed assembly to exceed the window');

    const result = await fitContextToBudget(E5, context, text);
    assert.ok(result !== null, 'a normal chunk body plus a heading-path context must be rescuable by trimming context alone');
    assert.ok(result.context.length < context.length, 'context must actually be shortened');
    assert.equal(context.endsWith(result.context) || result.context === '', true, 'trimming must keep the TAIL of context (the most specific part), not an arbitrary substring');
    assert.ok(result.tokenCount <= 512);

    const refit = await checkEmbedInputFits(E5, `${result.context}\n\n${text}`);
    assert.equal(refit.fits, true, 'the trimmed context + UNTOUCHED text must now fit');
  });

  it('returns null (never trims text) when the chunk BODY ALONE already exceeds the window, even with context reduced to empty', { skip: !e5TokenizerAvailable }, async () => {
    const chunk = 'resolveEmbeddingProfileFromCollectionInfoConfigMetadataParamsVectorsSparseVectors ';
    let text = '';
    let heuristicEstimate = 0;
    while (heuristicEstimate < 700) {
      text += chunk;
      heuristicEstimate = Math.ceil(text.length / 4);
    }
    const bodyAlone = await checkEmbedInputFits(E5, `\n\n${text}`);
    assert.equal(bodyAlone.fits, false, 'test setup: chunk body alone must already exceed the window');

    const result = await fitContextToBudget(E5, 'irrelevant context', text);
    assert.equal(result, null, 'must never attempt to shorten text — an unfittable body reports null, not a trimmed body');
  });

  it('TOKENIZER_UNAVAILABLE (unknown model) returns null rather than throwing or silently using the heuristic', async () => {
    const unknownModel = { id: 'definitely/not-a-real-model-xyz', contextWindow: 512 };
    const result = await fitContextToBudget(unknownModel, 'context', 'text');
    assert.equal(result, null);
  });

  it('embedForIndexCloud (embeddings.js) integration: a typical over-budget chunk succeeds via the trim-and-retry path instead of throwing EmbeddingInputTooLongError', { skip: !e5TokenizerAvailable }, async () => {
    const { embedForIndex } = await import('../../../../src/core/embeddings.js');
    const context = 'Semidex Lite > Architecture > Storage Adapter > Qdrant Adapter > Embedding Profile > Schema Building > '.repeat(4);
    const chunk = 'This function derives the full Qdrant collection-creation vector schema object from the resolved embedding profile alone. ';
    let text = '';
    let fits = true;
    while (fits) {
      text += chunk;
      fits = (await checkEmbedInputFits(E5, `${context}\n\n${text}`)).fits;
    }
    const cloudProfile = {
      schemaVersion: 1, managedBy: 'semidex',
      embedding: {
        dense: { provider: 'qdrant-cloud', model: 'intfloat/multilingual-e5-small', vectorName: 'dense', dimensions: 384, distance: 'Cosine', execution: 'qdrant-cloud' },
        sparse: { provider: 'qdrant-cloud', model: 'qdrant/bm25', vectorName: 'sparse', execution: 'qdrant-cloud', modifier: 'idf' },
      },
      embeddingSchemaVersion: 2,
    };
    const result = await embedForIndex(cloudProfile, `${context}\n\n${text}`, { context });
    assert.ok(result.dense.text.endsWith(text), 'the returned embed text must still end with the FULL, untouched chunk body');
    assert.ok(result.dense.text.length < `${context}\n\n${text}`.length, 'the returned embed text must be shorter than the untrimmed assembly (context was trimmed)');
  });

  it('embedForIndexCloud still throws EmbeddingInputTooLongError when even an empty context cannot rescue an over-budget body', { skip: !e5TokenizerAvailable }, async () => {
    const { embedForIndex, EmbeddingInputTooLongError } = await import('../../../../src/core/embeddings.js');
    const chunk = 'resolveEmbeddingProfileFromCollectionInfoConfigMetadataParamsVectorsSparseVectors ';
    let text = '';
    let heuristicEstimate = 0;
    while (heuristicEstimate < 700) {
      text += chunk;
      heuristicEstimate = Math.ceil(text.length / 4);
    }
    const cloudProfile = {
      schemaVersion: 1, managedBy: 'semidex',
      embedding: {
        dense: { provider: 'qdrant-cloud', model: 'intfloat/multilingual-e5-small', vectorName: 'dense', dimensions: 384, distance: 'Cosine', execution: 'qdrant-cloud' },
        sparse: null,
      },
      embeddingSchemaVersion: 2,
    };
    await assert.rejects(
      () => embedForIndex(cloudProfile, `short context\n\n${text}`, { context: 'short context' }),
      (err) => {
        assert.ok(err instanceof EmbeddingInputTooLongError);
        assert.equal(err.code, 'EMBEDDING_INPUT_TOO_LONG');
        return true;
      },
    );
  });
});

describe('buildCloudQueryInputs() — pure query-descriptor builder', () => {
  const profile = {
    embedding: {
      dense: { model: 'intfloat/multilingual-e5-small' },
      sparse: { model: 'qdrant/bm25', modifier: 'idf' },
    },
  };

  it('builds {text, model} descriptors for both lanes', () => {
    const { denseQuery, sparseQuery } = buildCloudQueryInputs(profile, 'привіт світ');
    assert.deepEqual(denseQuery, { text: 'привіт світ', model: 'intfloat/multilingual-e5-small' });
    assert.deepEqual(sparseQuery, { text: 'привіт світ', model: 'qdrant/bm25' });
  });

  it('REGRESSION (P1 fix #2): neither descriptor ever carries options/modifier — that is collection-schema metadata, not a per-request inference parameter', () => {
    const { denseQuery, sparseQuery } = buildCloudQueryInputs(profile, 'q');
    assert.ok(!('modifier' in denseQuery));
    assert.ok(!('options' in denseQuery));
    assert.ok(!('modifier' in sparseQuery));
    assert.ok(!('options' in sparseQuery));
  });

  it('sparseQuery is null when the profile has no sparse lane', () => {
    const denseOnly = { embedding: { dense: { model: 'intfloat/multilingual-e5-small' }, sparse: null } };
    const { sparseQuery } = buildCloudQueryInputs(denseOnly, 'q');
    assert.equal(sparseQuery, null);
  });
});
