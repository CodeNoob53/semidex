# Semidex Lite 0.1.8

Release candidate. Publication is a separate step from preparing this commit.

## Application-controlled agents

- New `POST /api/v3/ask` with native Gemini function calling, plus typed
  `askAgent()` and `agentStep()` methods in `semidex-lite/client`.
- Applications supply system instructions and tool definitions, execute tools
  themselves, and return results through an opaque continuation ID.
- Continuations retain provider metadata, bind to the integration key, and
  validate pending call IDs. Shared generation gating, bounded state and run
  budgets apply. Temporary key-budget refusals preserve the continuation.
- A new `agent` operation scope is required. Existing Search and Ask keys do
  not automatically gain it. See [the API contract](../en/agent-api-v3.md).
- Grounded Ask v1/v2 remain available with their existing contracts. Agent
  mode performs no implicit retrieval and does not claim indexed citations
  for application-supplied tool results.
- Gemini is the first tool-calling provider. Unsupported providers fail with
  an explicit capability error; their existing text Ask remains supported.

## Administration and development

- Shared reader navigation and rendering for collection content.
- An explicit Gemini model check in Settings, initiated by the operator.
  Listing a model no longer needs to be mistaken for proof it is callable.
- Indexing path policy distinguishes local-only and remote deployments.
- Benchmark harness corrections and versioned evaluation fixtures improve
  reproducibility; these are not claims of improved production retrieval.

## Operational limits

Agent continuations are process-local and expire. Restarting Semidex
invalidates them. Applications own tool permissions, user confirmation and
side-effect reconciliation. A lost response never justifies blindly repeating
an external tool action.

The embedded SDK and app-owned JSON storage remain separate planned work.
Budget Guardian integration is not included in this package release.

## Release verification

Final candidate verification is recorded in `lite-v0.1.8-verification.md`.
The earlier live agent report records a native Gemini round trip; it is not
a new live acceptance run of the final packed 0.1.8 artifact.
