# Gemini Ask Live Acceptance - 2026-07-20

## Scope

Live verification of the Gemini `GenerationProvider` through the production
Admin API. The API key was loaded from `.env` and was never printed, persisted
to `settings.json`, or written to this report.

## Environment

- generation backend: `gemini`
- collection: `nodejs-basics`
- retrieval: local BGE-M3 ONNX dense+sparse, Qdrant hybrid search
- transport: `POST /api/ask` SSE

## Results

1. `GET /api/generation/status` returned `ready: true` and reported the key as
   configured from `dotenv` without exposing its value.
2. `GET /api/generation/models?backend=gemini` returned 54 models.
3. The former default `gemini-2.5-flash` failed during real generation with
   HTTP 404: Gemini reported that this dated model was no longer available to
   new users.
4. `gemini-flash-latest` completed a positive grounded-answer case in about
   14 seconds. It produced Ukrainian output, citation `[1]`, no invalid
   citations, and `refused: false`.
5. A broader Event Loop question completed the retrieval and generation path
   but returned `refused: true` because the retrieved evidence did not directly
   establish the requested Node.js-specific claim. This confirms the refusal
   path rather than a provider failure.

## Decision

Change the Gemini first-run default to `gemini-flash-latest`. This alias is
appropriate for interactive first-run availability, but it is a moving target.
External benchmarks and reproducible reports must set an exact Gemini model ID
explicitly.

## Verdict

`GEMINI_ASK_LIVE_ACCEPT`

The generation provider, model discovery, retrieval-to-generation path, SSE
streaming, Ukrainian answer output, citations, and refusal behavior worked
against the live service. A dedicated Ask UI is still not implemented; this
acceptance used the application-facing HTTP API directly.
