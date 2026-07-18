# Ask Application Runtime

> Status: product and architecture design, 2026-07-18.
>
> This document defines Ask as an application-facing semidex runtime. The
> dashboard chat specified in [ask-chat.md](ask-chat.md) is one reference
> client of this runtime, not the product boundary. The current repository
> already contains a partial backend (`POST /api/ask`, grounded evidence
> assembly, Ollama generation, SSE, citations, and refusal handling). It is
> not yet a stable public integration API.

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

## 4. Public integration contract

The current `POST /api/ask` route is an implementation seed. Before it is
advertised as a stable integration API, its transport-neutral request and
event shapes must be versioned and moved behind an application-runtime
boundary rather than treated as an admin-only route.

Minimum request shape:

```json
{
  "collection": "company-docs",
  "question": "How are exceptional refunds approved?",
  "scope": {
    "sourceFile": "returns.md"
  },
  "sessionId": "optional-client-session-id"
}
```

Retrieval internals such as RRF constants, prefetch sizes, evidence token
budgets, and model prompts are owner configuration, not end-user controls.

Minimum streaming events:

```text
sources       retrieved evidence and stable source identifiers
answer_delta  a fragment of generated answer text
done          citations, provider/model metadata, timing, and refusal state
error         a redacted, machine-readable failure
```

The final protocol may use SSE first. The domain coordinator must remain
transport-neutral so a Node.js SDK, server framework adapter, or bot adapter
does not import admin routing code.

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

### Stage A - Grounded core (partially shipped)

- retrieval and bounded evidence assembly;
- generation-provider seam with Ollama implementation;
- SSE answer stream;
- citations, entity references, refusal, and cancellation behavior.

### Stage B - Public demo runtime

- Gemini `GenerationProvider`;
- Qdrant Cloud server-side embedding path for semidex Lite;
- stable versioned Ask request/event schema;
- reference web client using only the public contract;
- deployment guide for a small CPU Google Cloud instance;
- authentication boundary, rate limits, CORS policy, and secret handling
  adequate for the public demo.

### Stage C - Developer integration kit

- TypeScript/JavaScript client with streaming support;
- framework-neutral web widget or Web Component;
- reference integrations for a plain website and a Node.js server;
- Telegram adapter demonstrating how channel messages map to Ask requests;
- copyable examples for source links and citation rendering.

### Stage D - Production application features

- durable sessions and optional follow-up-question condensation;
- per-user and per-tenant collection authorization;
- quotas, audit events, observability, and provider usage accounting;
- additional generation providers (OpenAI-compatible/OpenRouter, Anthropic,
  Gemini, and others) through the shared provider contract;
- optional multi-collection routing after collection profiles and global
  search are validated.

## 7. Evaluation gates

Ask has two separate quality dependencies and must report both:

1. **Retrieval quality.** External datasets such as BEIR, MIRACL (including
   Ukrainian), and MLDR compare the local BGE-M3 path with Qdrant Cloud
   inference using the same corpus, chunks, qrels, and fusion settings.
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
