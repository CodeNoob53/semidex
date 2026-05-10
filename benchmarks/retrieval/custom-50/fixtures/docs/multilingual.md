# Multilingual Support

semidex is designed to work with Ukrainian, English, and mixed-language content.
The BGE-M3 model (both Ollama and ONNX variants) supports over 100 languages and
produces high-quality embeddings for cross-lingual retrieval.

## Language Support by Provider

### ollama + hashed-tf (default)

Dense embeddings are produced by `bge-m3` via Ollama. BGE-M3 is multilingual
and handles Ukrainian well. Sparse embeddings use `hashed-tf` — a term-frequency
encoder that works on any language but does not carry semantic weight for rare
or morphologically complex words.

For Ukrainian content, `hashed-tf` assigns uniform weight to all tokens based
on frequency. This means that a rare Ukrainian technical term like
`вбудований_провайдер` gets the same sparse weight as a common word, which can
reduce retrieval precision for exact technical lookups.

### bge-m3-onnx + bge-m3-onnx

Both dense and sparse embeddings are produced by the BGE-M3 ONNX model.
The sparse embeddings are neural sparse — the model learns token importance,
not just frequency. For Ukrainian and mixed-language content, this produces
better sparse weights for technical terms and rare vocabulary.

Enable with `ONNX_EMBED=1`.

## Query Language vs Document Language

semidex supports cross-lingual retrieval: a Ukrainian query can match an
English document and vice versa. BGE-M3 maps both to the same semantic space,
so language mismatch does not require separate indexes or translation.

Example cross-lingual retrieval patterns that work:
- Ukrainian query → English document: `"як налаштувати провайдер"` → `providers.md`
- English query → Ukrainian document
- Mixed-language query → any document

## Ukrainian-Specific Chunking Notes

The chunking logic uses Unicode-aware sentence splitting:
`/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g`. This regex handles Cyrillic text correctly
because it does not assume ASCII sentence boundaries.

Markdown headings in Ukrainian are parsed identically to English headings.
Section detection is based on `#`/`##`/`###` prefix, not language-specific patterns.

## Mixed-Language Documents

Documents that mix Ukrainian and English (e.g., technical documentation with English
code blocks and Ukrainian prose) are chunked as a single document. The embedding
covers both languages within each chunk. This is the normal case for semidex
documentation and works well with BGE-M3.

## Benchmark Coverage

The custom-50 benchmark includes:
- Ukrainian-only queries (e.g., `"де налаштовується sparseProvider"`)
- English-only queries (e.g., `"valid provider combinations for embedding"`)
- Mixed-language queries (e.g., queries mentioning `ONNX_EMBED` in a Ukrainian sentence)
- Cross-file queries that require understanding concepts across multiple documents

## LLM Phases and Language

The context and tag LLM phases use the model specified by `CONTEXT_MODEL` and
`TAG_MODEL` (default: `gemma3:4b`). The prompt is in English but the model
processes Ukrainian content correctly. Tags generated for Ukrainian documents
may be in English, Ukrainian, or a mix depending on the model.

## Recommended Provider for Multilingual Use

For best results with Ukrainian or mixed-language content, use `bge-m3-onnx`:

```bash
ONNX_EMBED=1 COLLECTION=my-notes SOURCE_ROOT=./notes npm run index
```

The neural sparse encoder consistently outperforms `hashed-tf` on rare and
technical Ukrainian terms, especially for exact-token queries where the correct
result depends on a low-frequency word being given high sparse weight.
