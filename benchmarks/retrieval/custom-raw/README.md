# Custom-Raw Benchmark

This suite evaluates semidex's robustness against unstructured, messy, and noisy text. Unlike `custom-large` which relies on well-formatted markdown documents, `custom-raw` uses input that lacks clean paragraphs or headings.

**Characteristics of the fixtures:**
- Mixed languages (Ukrainian and English)
- Stack traces and incident logs
- Unformatted config dumps
- Unstructured agent notes
- Boundary neighbor issues (split sentences)
- Repeated distractors

**Evaluation Goal:**
Verify that semidex retrieval gracefully handles real-world noisy text while avoiding matches with distractors and accurately capturing exact-token queries, paraphrased concepts, and negative exclusions.
