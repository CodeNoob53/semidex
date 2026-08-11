# Ask Application Runtime

> Status: product and architecture design, 2026-07-18. Updated 2026-07-28:
> the versioned public contract described in §4 is now implemented —
> `POST /api/v1/ask`, `src/core/ask-api/v1/` — see
> [docs/ask-api-v1-contract-2026-07-28.md](../ask-api-v1-contract-2026-07-28.md)
> for the exact request/event shapes, test results, and migration notes
> from the pre-v1 seed.
>
> This document defines Ask as an application-facing semidex runtime. The
> dashboard chat specified in [ask-chat.md](ask-chat.md) is one reference
> client of this runtime, not the product boundary. The repository now
> contains a versioned, application-facing Ask contract
> (`POST /api/v1/ask`, grounded evidence assembly, Ollama and Gemini
> generation, SSE, citations, and refusal handling) that is stateless, one
> collection per request, and provider-neutral. It is **not yet**
> authenticated or safe for direct public Internet exposure — see §6 Stage
> B for what remains before a public demo.

## 1. Product definition

Ask is the shortest supported path from an indexed collection to a grounded
assistant embedded in another product:

```text
website / internal portal / Telegram bot / custom application
  -> semidex Ask runtime
  -> retrieval + bounded evidence assembly
  -> selected generation provider
  -> streamed answer + citations + source metadata
```

The application developer should not have to reimplement hybrid search,
chunk selection, structural context assembly, prompt construction, citation
validation, or provider streaming. Those are semidex responsibilities.

Ask complements MCP; it does not replace it:

| Surface | Consumer | Who controls retrieval |
|---------|----------|------------------------|
| MCP tools | Claude, Codex, and other tool-using agents | The external agent |
| Ask runtime | Websites, bots, internal tools, and custom applications | semidex's grounded answer pipeline |
| Admin Ask UI | Collection owner during setup and evaluation | The same Ask runtime; UI is a reference client/playground |

## 2. Product promise and limits

Ask answers from an explicitly selected knowledge scope and returns citations
that let the caller verify the source. Raw indexed content remains
authoritative; generated answers, summaries, and citation labels are derived
output.

Ask is not, by default:

- a general-purpose chatbot using unrestricted model world knowledge;
- an autonomous agent with open-ended tool access;
- a replacement for deterministic index/reindex/repair operations;
- a guarantee that an answer is correct merely because it contains citations.

The runtime must refuse or expose insufficient evidence instead of silently
turning a retrieval miss into an ungrounded answer.

## 3. Runtime boundaries

```text
Integration client
  -> public Ask transport (HTTP + streaming)
  -> AskCoordinator
       -> RetrievalService
       -> bounded evidence / structural assembly
       -> grounded prompt policy
       -> GenerationProvider
       -> citation and entity-reference validation
  -> answer events and source metadata
```

Storage, embeddings, and answer generation remain separate capabilities:

- `StorageAdapter` owns indexed data and retrieval operations;
- client-side or storage-side embedding providers prepare index/query inputs;
- `GenerationProvider` produces the grounded answer;
- Ask coordinates these capabilities but does not hard-code Qdrant, Ollama,
  Gemini, or another provider into its public contract.

This separation is required for both deployment profiles:

- **semidex Local:** local Qdrant, BGE-M3 ONNX, and a local generation runtime;
- **semidex Lite:** a small CPU application server, Qdrant Cloud storage and
  server-side inference, and a cloud generation provider such as Gemini.

## 4. Public integration contract (v1, implemented)

`POST /api/v1/ask` is now the one canonical, versioned Ask endpoint. The
pre-v1 seed route (`POST /api/ask`) has been removed entirely — no
compatibility alias was kept, since this project has not released a public
Ask API before now. The request/event shapes below are exactly what is
implemented, not a future plan; see
[docs/ask-api-v1-contract-2026-07-28.md](../ask-api-v1-contract-2026-07-28.md)
for the full field-by-field contract and test evidence.

Request shape:

```json
{
  "collection": "company-docs",
  "question": "How are exceptional refunds approved?",
  "scope": {
    "sourceFile": "returns.md"
  }
}
```

`collection` and `question` are required non-empty strings. `scope` is
optional; `scope.sourceFile` is currently the only supported scope field.
Ask remains **stateless** — there is no `sessionId` or conversation memory
yet (deferred to Stage D, §6). Retrieval internals such as RRF constants,
prefetch sizes, evidence token budgets, retrieval count (`top`), and model
prompts are owner configuration, not end-user controls — a client sending
the obsolete pre-v1 root-level `sourceFile` or `top` fields is rejected
with `400 bad_request`, not silently accepted as a second contract.

Streaming events (SSE):

```text
sources       retrieved evidence and stable source identifiers
answer_delta  a fragment of generated answer text
done          citations, provider/model metadata, timing, and refusal state
error         a redacted, machine-readable failure with a retryable flag
```

The public event payloads are produced by pure contract-projection
functions (`src/core/ask-api/v1/contract.js`), never assembled as ad-hoc
object literals inline in the route — internal validation/debug detail
(`invalidCitations`, `strippedMarkers`) is dropped by that projection, not
merely unread by callers.

SSE is the v1 transport. The domain coordinator (`AskCoordinator`) remains
fully transport- and provider-neutral — it has no knowledge of HTTP, SSE,
or the public wire contract's event names/field shapes; a future Node.js
SDK, server framework adapter, or bot adapter can reuse
`src/core/ask-api/v1/` without importing admin routing code, and a future
non-SSE transport could be added without touching the coordinator.

## 5. Demo scope

The public demo intentionally implements a narrow vertical slice:

- one selected collection per conversation;
- independent, stateless questions;
- hybrid retrieval and bounded structural evidence;
- streamed answer with citations and cite-or-refuse behavior;
- one reference web chat client;
- Qdrant Cloud as storage/retrieval/inference backend;
- Gemini as the cloud generation provider;
- server-side secrets only;
- basic abuse protection, request limits, and redacted errors before the demo
  is exposed publicly.

The demo does **not** claim a complete integration platform. It need not ship
multi-tenant administration, durable conversation memory, every cloud
provider, a polished embeddable widget, or every messaging-channel adapter.

## 6. Integration roadmap

### Stage A - Grounded core (shipped)

- retrieval and bounded evidence assembly;
- generation-provider seam with Ollama implementation;
- native provider system instructions (Gemini `config.systemInstruction`,
  Ollama's `system` request field) — evidence is treated as untrusted data,
  never concatenated into a fake "System:" prefix;
- SSE answer stream;
- citations, entity references, refusal, and cancellation behavior;
- a versioned, application-facing public contract (`POST /api/v1/ask`,
  `src/core/ask-api/v1/`) — the pre-v1 seed route has been removed.

### Stage B - Public demo runtime

- Stage B1 (shipped): Gemini `GenerationProvider` for Ask answer generation —
  `src/core/generation/gemini-provider.js`, selectable via
  `SEMIDEX_GENERATION_BACKEND=gemini`, provider-neutral model discovery
  (`GET /api/generation/models?backend=ollama|gemini`), Global Settings UI
  support. The Ask coordinator (`src/core/ask/`) required zero
  provider-specific changes — the existing `GenerationProvider` seam from
  Stage A absorbed it directly. Indexing-time context/tag generation still
  runs through Ollama only; this stage covers Ask answer generation alone.
  See `docs/admin-api-phase4a5d-gemini-generation-provider-2026-07-18.md`
  for the implementation record.
- Qdrant Cloud server-side embedding path for semidex Lite (not started);
- stable versioned Ask request/event schema (shipped — see Stage A above
  and the v1 contract doc);
- reference web client using only the public contract (not started);
- deployment guide for a small CPU Google Cloud instance (not started);
- authentication boundary, rate limits, CORS policy, and secret handling
  adequate for the public demo (not started — Stage B1's secret handling
  covers GEMINI_API_KEY specifically, not the broader public-demo auth/rate-
  limit/CORS surface this bullet describes).

### Stage C - Developer integration kit

- TypeScript/JavaScript client with streaming support;
- framework-neutral web widget or Web Component;
- reference integrations for a plain website and a Node.js server;
- Telegram adapter demonstrating how channel messages map to Ask requests;
- copyable examples for source links and citation rendering.

### Stage D - Production application features

- durable sessions, provider-neutral context compaction, and retrieval of
  relevant prior conversation episodes without replaying the complete chat;
- scoped long-term memory with provenance, review, correction, and deletion
  controls, following
  [agent-memory-and-conversation-context.md](agent-memory-and-conversation-context.md);
- optional follow-up-question condensation;
- per-user and per-tenant collection authorization;
- quotas, audit events, observability, and provider usage accounting;
- additional generation providers (OpenAI-compatible/OpenRouter, Anthropic,
  Gemini, and others) through the shared provider contract;
- optional multi-collection routing after collection profiles and global
  search are validated.

## 7. Evaluation gates

Ask has two separate quality dependencies and must report both:

1. **Retrieval quality.** External datasets such as BEIR, MIRACL (its own
   supported languages — MIRACL does not include Ukrainian; a Russian run is
   multilingual/Cyrillic evidence only, not a Ukrainian-quality claim), and
   MLDR compare the local BGE-M3 path with Qdrant Cloud inference using the
   same corpus, chunks, qrels, and fusion settings. Ukrainian quality still
   requires a separate, dedicated Ukrainian dataset.
2. **Answer quality.** A grounded-answer suite measures answer correctness,
   citation precision/recall, claim coverage, refusal correctness, latency,
   and provider cost. Retrieval-only metrics cannot establish that the final
   answer is faithful.

Internal regression fixtures remain development gates. They are not evidence
of competitive superiority. Evaluation reports and product claims must
distinguish internal regressions from independently sourced evaluation.

## 8. Product and ecosystem relevance

The product is not merely a dashboard chat. It is an open, provider-neutral
application runtime that lets a developer turn an authoritative document
collection into a website consultant, internal assistant, research helper, or
bot without rebuilding the RAG orchestration layer.

The Local profile preserves an auditable, private path. The Lite profile makes
the same workflow deployable without a GPU by using explicit cloud adapters.
Both profiles share retrieval, evidence, citation, and evaluation contracts;
only provider placement changes.

This creates two complementary deployment values without changing the
architecture:

- **Open, replaceable infrastructure:** developers can integrate a grounded
  assistant without adopting a closed end-to-end chatbot platform. The public
  contract, provider interfaces, citations, and evaluation harness remain
  inspectable and replaceable, while the Local profile preserves a private
  deployment path.
- **Low-operations Qdrant deployment:** the Lite reference deployment makes
  Qdrant Cloud storage, hybrid retrieval, and server-side inference accessible
  to small teams and businesses that do not run GPU infrastructure. semidex
  supplies document processing, application runtime, citations, and client
  integrations around that managed retrieval layer.

Product claims must remain evidence-led. The demo proves that the vertical
slice is usable; BEIR, MIRACL, MLDR, grounded-answer evaluation, latency, and
cost measure whether the provider profiles support broader quality claims.
Neither the existence of a demo nor an internal regression benchmark
establishes competitive superiority.
