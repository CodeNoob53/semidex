# semidex Documentation

Documentation is grouped by language so translations can grow independently.

| Language | Entry point | Status |
|----------|-------------|--------|
| English | [en/README.md](en/README.md) | Main detailed documentation |
| Українська | [ua/README.md](ua/README.md) | Ukrainian README, detailed pages to be split later |

Cross-language product and architecture designs live under `design/`. The
application-facing assistant direction is defined in
[Ask application runtime](design/ask-application-runtime.md); the admin chat is
only its reference client.

Suggested structure for future translations:

```text
docs/
  en/
    README.md
    architecture.md
    retrieval.md
    mcp-tools.md
    configuration.md
    benchmarking.md
    operations.md
    project-structure.md
  ua/
    README.md
```
