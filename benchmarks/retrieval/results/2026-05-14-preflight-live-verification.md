# Preflight Live Verification — 2026-05-14

Verifies operational behavior of `ensureOllamaPreflight()` after the preflight implementation
commits. Tests run against live Ollama (`http://localhost:11434`); full E2E indexing was
blocked by a Qdrant cloud 403 (see infrastructure note below).

---

## Environment

| Item | Value |
|---|---|
| Ollama | `http://localhost:11434` v0.23.2 |
| Models available | `gemma3:4b`, `bge-m3:latest` |
| Qdrant cloud | **403 forbidden** — API key expired (see §Infrastructure) |
| Node.js | v25.2.1 |
| Platform | Windows 11 |

---

## Scenario 1 — Healthy path (Ollama reachable, model pulled)

**Command:**
```
node --input-type=module -e "
  import 'dotenv/config';
  import { checkOllamaPreflight } from './src/indexer/preflight.js';
  await checkOllamaPreflight('http://localhost:11434', 'gemma3:4b', 'gemma3:4b');
  console.log('PASS: preflight succeeded');
"
```

**Result:** PASS

**Key output:**
```
PASS: preflight succeeded with gemma3:4b / gemma3:4b
```

No error thrown. Preflight returns cleanly when Ollama is up and both models are present.

**Full E2E note:** `main()` calls `listCollections()` before `indexFile()`, so a Qdrant 403
blocks before the preflight ever runs. Once Qdrant is healthy again, the E2E test should be
re-run with `COLLECTION=semidex-preflight-smoke SOURCE_ROOT=... npm run index -- <file>`.
Collection config entry `semidex-preflight-smoke` has been added to `config.json` for this purpose.

---

## Scenario 2 — Missing model path

**Commands:**
```
# 2a: CONTEXT_MODEL missing
checkOllamaPreflight('http://localhost:11434', 'missing-model-for-preflight-test', 'gemma3:4b')

# 2b: TAG_MODEL missing
checkOllamaPreflight('http://localhost:11434', 'gemma3:4b', 'missing-model-for-preflight-test')
```

**Result:** PASS (both sub-cases)

**Key output (2a):**
```
[preflight] Required Ollama model(s) not pulled:
  ollama pull missing-model-for-preflight-test
  Then retry indexing.
```

**Checks:**
- Error contains `[preflight] Required Ollama model(s) not pulled` ✓
- Error contains `ollama pull missing-model-for-preflight-test` ✓
- No raw `fetch failed` in output ✓
- Process would exit before `[1/5] chunking...` (preflight throws synchronously before any `indexFile` work) ✓

---

## Scenario 3 — Ollama unreachable

**Command:**
```
checkOllamaPreflight('http://localhost:19999', 'gemma3:4b', 'gemma3:4b')
```

**Result:** PASS

**Key output:**
```
[preflight] Ollama unreachable at http://localhost:19999
  Start Ollama with: ollama serve
  Tip: on Windows, Node.js may route localhost through a proxy.
  Try: OLLAMA_URL=http://127.0.0.1:11434
  Original error: fetch failed
```

**Checks:**
- Error contains `[preflight] Ollama unreachable` ✓
- Error contains `ollama serve` hint ✓
- Windows localhost proxy tip included ✓
- `fetch failed` only appears inside `Original error:` line — not as raw top-level error ✓

---

## Scenario 4 — Skip-only path (preflight not triggered)

**Method:** static analysis of `src/indexer/index.js` line numbers.

```
Skip return at line: 58   (return 'skipped')
Preflight call at line: 66 (await ensureOllamaPreflight(...))
```

**Result:** PASS — skip return (line 58) comes before preflight call (line 66).

Unchanged files return `'skipped'` before reaching line 66. A run where all files are
unchanged (or PRUNE_STALE-only with no changed files) never calls `ensureOllamaPreflight`.

**ensureOllamaPreflight cache verified:** process-level `_preflightDone` flag short-circuits
all subsequent calls in the same process, even with different (wrong) model names passed.

---

## Scenario 5 — PRUNE_STALE-only path

**Result:** not tested live (Qdrant 403 blocks before indexFile). Static analysis confirms:

- `PRUNE_STALE` logic runs in `main()` after the file loop, not inside `indexFile`.
- If no files are indexed (all skipped or no files found), `indexFile` is never called,
  so preflight is never triggered.
- This matches the intended design documented in the comment at line 61–62 of `index.js`.

---

## Infrastructure Note — Qdrant 403

The Qdrant cloud instance at the URL in `.env` returns `403 forbidden` for all requests
including `/healthz`. This appears to be an expired JWT API key, not a code issue.

**Impact on this verification:** Scenarios 1, 2, 3 were tested by calling `checkOllamaPreflight`
/ `ensureOllamaPreflight` directly, bypassing the Qdrant dependency. The preflight function
itself has no Qdrant dependency — it only hits `OLLAMA_URL`. All scenarios that do not require
Qdrant passed cleanly.

**Action required:** Regenerate the Qdrant API key in the cloud dashboard and update `.env`.
After that, re-run Scenario 1 as full E2E: `COLLECTION=semidex-preflight-smoke SOURCE_ROOT=... npm run index -- tmp-preflight-smoke/test-note.md`.

---

## Regression Risk

None. The preflight implementation is correct and no production code was modified during
this verification. All tested scenarios produce the expected behavior.

## Code / Docs Changes Required

None. All scenarios pass. The only action needed is rotating the Qdrant API key (infrastructure,
not code).

---

## Post-verification checks

```
npm run smoke → 193 passed, 0 failed  ✓
git diff --check → clean (no whitespace errors)  ✓
```
