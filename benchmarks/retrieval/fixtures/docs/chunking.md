# Chunking

semidex splits documents into chunks before embedding. The chunking logic lives in
`src/indexer/phases/chunk.js` and is controlled by three environment variables.

## Parameters

| Variable           | Default | Range       | Meaning                                    |
|--------------------|---------|-------------|--------------------------------------------|
| `MAX_CHUNK_TOKENS` | 400     | 1–100000    | Maximum tokens per chunk                   |
| `MIN_CHUNK_TOKENS` | 30      | 0–100000    | Minimum tokens for a section to be included|
| `OVERLAP_SENTENCES`| 2       | 0–100       | Sentences carried from chunk N into N+1    |

All three are validated with `envInt()` on startup; invalid values produce a warning and
fall back to the default.

## Sentence splitting

`splitSentences(text)` uses the regex `/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g` to split on
sentence-ending punctuation while also capturing any trailing fragment without a
terminator. This ensures text like `"Hello world"` (no period) is never silently dropped.

## Overlap

`OVERLAP_SENTENCES` controls how many sentences from the end of chunk N are prepended to
chunk N+1. This gives each chunk context from the previous one and helps retrieval when a
query spans a chunk boundary.

### Why overlap must not cross section boundaries

Overlap carries semantic context from one chunk to the next. If overlap crosses a markdown
heading boundary, the first chunk of section B will contain sentences from section A.
This contaminates the embedding for section B — queries about section B content will pull
in section A text, and vice versa. The payload `section` field will say "B" but the
embedding will partially represent "A", causing misleading search results.

semidex resets the overlap accumulator to an empty list at each new heading, so overlap
is always contained within a single section. This means the first chunk of each section
starts clean, and its embedding accurately represents only that section's content.

## Flushing the final chunk

After all sentences have been processed, any remaining sentences are always flushed as a
final chunk — even if the remaining count is less than or equal to `OVERLAP_SENTENCES`.
The previous implementation skipped the final chunk when `current.length <= OVERLAP_SENTENCES`,
which silently dropped content from short documents or short terminal sections.

The flush is conditional on `pending > 0`, where `pending` counts new sentences added
since the last chunk was emitted. This prevents emitting an overlap-only chunk after a
full chunk has just been flushed.

## Markdown sections

`parseMarkdown` splits a document on `#`, `##`, and `###` headings that pass the
`isStructuralHeading` heuristic (length ≤ 120, no sentence-ending punctuation).
Each section becomes an independent chunking unit. Sections shorter than `MIN_CHUNK_TOKENS`
are skipped unless they have a heading (headings alone are kept as context anchors).

## Pandoc formats

`.docx`, `.odt`, `.rtf`, `.epub`, `.html`, and `.htm` files are converted to Markdown
via `pandoc` before chunking. The converted output is processed through `parseMarkdown`
so that heading structure from the original document is preserved. This is achieved by
passing a synthetic `.md` path to `chunkFile` regardless of the original file extension.

## PDF

PDF files are parsed with `pdf-parse` and then chunked as plain text (no heading
detection, since PDF structure is not reliably extracted).
