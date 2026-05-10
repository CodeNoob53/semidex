# Obsidian Review Console

semidex stores live retrieval data in Qdrant, but it also writes a human-readable Markdown review layer to `chunks_out/`.

This output is useful as an Obsidian-compatible quality console. You can open `chunks_out/` as a vault and inspect what the AI agent will later retrieve.

## What Gets Written

For every indexed source file, semidex writes chunk notes:

```text
chunks_out/
  <parent-folder>/
    <source-file>__chunk1.md
    <source-file>__chunk2.md
    ...
```

Each generated note contains YAML frontmatter and the raw chunk body:

```yaml
---
source_file: docs/providers.md
section: bge-m3-onnx + bge-m3-onnx
chunk: 2/6
tags: [embedding, provider, onnx]
links: [docs/qdrant.md, docs/sync.md]
context: "This chunk explains how ONNX embedding mode changes provider selection."
---
```

## Why Obsidian Helps

Obsidian is not required for semidex to work. It is useful because it gives users a familiar interface for inspecting generated knowledge:

- chunk boundaries
- section headings
- LLM-generated context summaries
- tags
- semantic links
- raw chunk text

This makes it easier to answer practical quality questions:

- Is a chunk self-contained?
- Did a converted `.docx` or `.epub` preserve useful headings?
- Did overlap leak text from the previous section?
- Are generated tags useful enough for filtering?
- Are semantic links pointing to relevant neighboring files?

## Source of Truth

`chunks_out/` is a review artifact, not the source of truth.

The MCP server and AI agents search live Qdrant data. If Qdrant and `chunks_out/` disagree, trust Qdrant and re-run indexing to refresh review files.

## Refresh Behavior

Review files are written after the linking phase. If a file is unchanged and skipped by hash checks, its review output is not regenerated.

To force refreshed review files, change the source file or reindex after changing provider/schema settings that force reprocessing.

## Current Limitations

The review layout is compact:

```text
<parent-folder>/<source-file>__chunkN.md
```

Different source files with the same parent-folder name and basename can collide in `chunks_out/`. This does not affect Qdrant `source_file` IDs or MCP retrieval.

Links in frontmatter are semidex file IDs used by the graph and MCP tools. They are not guaranteed Obsidian-native `[[wikilinks]]`.

