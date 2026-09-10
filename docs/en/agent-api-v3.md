# Agent API v3 — `POST /api/v3/ask`

Agent mode lets a model request **your** tools. Semidex sends the model your
instructions and your tool definitions, and returns the tool calls it wants
made. **Your backend executes them.** Semidex never does, and never connects
to your MCP servers or holds their credentials.

This is a different product surface from Ask v1/v2, not an extension of it.
Ask v1/v2 keep their exact request/SSE/grounding/citation/refusal contracts
and are unchanged by this endpoint.

## Status

**Experimental**, but the live native call/result round trip **is confirmed**
for this build (2026-09-10, `gemini-3.6-flash`): the model issued a real
native function call, the tool result reached it through the native
`functionResponse` channel, and the 684-character `thoughtSignature` Gemini
attached survived the continuation. Re-verify with
`npm run agent:live-characterization` after any provider or model change.

The mode stays labelled experimental because the live run covers the happy
path only. Parallel multi-call responses, safety refusals, `MAX_TOKENS`
truncation, malformed calls and the synthetic-call-id fallback are tested
against a fake transport, not against the real API.

## The loop

One HTTP request is **one model step**. You own the loop.

```
POST /api/v3/ask { input, systemInstructions?, tools }
  -> done { status: "requires_action", continuationId, toolCalls }
       your backend validates + executes the calls
POST /api/v3/ask { continuationId, toolResults }
  -> done { status: "requires_action", ... }   (repeat)
  -> done { status: "completed", answer }
```

## Authorization

The route is on the **integration** surface and needs a key scoped to the
`agent` operation — deliberately **not** `generate`:

```bash
semidex-lite key add --name my-agent --collection "*" --operation agent
```

Agent mode hands the caller control of the model's system instructions and
the tool surface it may request. That is materially wider authority than
asking a grounded question, so sharing the `generate` scope would have
silently granted it to every existing Ask key. **Existing Ask keys do not
work here** until re-created with `--operation agent`.

### Migration for existing keys

An existing key scoped `--operation generate` (or `generate,search`) will
receive `403` from `/api/v3/ask`. There is no in-place widening by design.
Create a new key with the scopes you actually want:

```bash
semidex-lite key add --name my-agent --collection "*" --operation generate --operation agent
```

## Request

### Start

```json
{
  "input": "Find an appropriate option",
  "systemInstructions": "Application-owned instructions",
  "tools": [{
    "name": "lookup_items",
    "description": "Read available items",
    "inputSchema": {
      "type": "object",
      "properties": { "query": { "type": "string" } },
      "required": ["query"],
      "additionalProperties": false
    }
  }]
}
```

Optional: `model`, `maxModelSteps`, `maxToolCalls`, `maxOutputTokens`. A
client may only ever **lower** an operator ceiling, never raise it.

### Continuation

```json
{
  "continuationId": "…",
  "toolResults": [
    { "callId": "c1", "ok": true,  "output": { "count": 2 } },
    { "callId": "c2", "ok": false, "error": { "message": "upstream 500" } }
  ]
}
```

A continuation carries **only** these two fields. Instructions, tools, model
and budget are frozen for the life of a run; sending them again is
**rejected**, not silently ignored. A new task is a new run.

You must supply results for **all** pending calls — partial continuation is
not supported. `ok` is mandatory and discriminates the payload, so an
executor failure reaches the model as a real error instead of a fabricated
success.

## Response (SSE)

- `answer_delta` — `{ text }`, model text for this step.
- `done` — exactly one, either:
  - `{ status: "completed", answer, steps, usage }`
  - `{ status: "requires_action", continuationId, text, toolCalls, steps, usage }`
- `error` — `{ code, message, retryable }`, terminal.

`requires_action` carries `text`, never `answer`: the model text before a
tool call is not a finished answer and must not be rendered as one.

Once streaming has begun, a failure is a terminal `error` event and **never**
becomes a successful `done`.

`toolCalls` are already verified: the name is in the allowlist you supplied,
and the arguments validated against your schema. A call that fails either
check is refused and nothing is executed.

## Supported JSON Schema subset

Tool `inputSchema` supports **only**:

| Construct | Notes |
|---|---|
| `type: "object"` | with `properties`, `required`, `additionalProperties` (boolean) |
| `type: "array"` | with `items` (one sub-schema; tuple form unsupported) |
| `type: "string"` / `"number"` / `"integer"` / `"boolean"` | |
| `enum` | scalars only |
| `description` | any node |

Everything else — `$ref`, `$defs`, `allOf`/`anyOf`/`oneOf`/`not`,
`if`/`then`/`else`, `const`, `format`, `pattern`, `minimum`/`maxLength`/
`minItems`, `patternProperties`, `propertyNames`, `dependent*`, `contains`,
tuple `items`, union `type` arrays, `nullable`, `default` — is **rejected
with an explicit error**, never stripped or ignored. A constraint you declare
is always one that is actually enforced.

When validating model arguments, `additionalProperties` defaults to **false**
even if your schema omits it. JSON Schema's own default is `true`, but for a
tool call an undeclared argument is far more likely to be a model mistake
than an intentional extension. Set `additionalProperties: true` explicitly if
you really want extra keys.

## Limits

| Limit | Default |
|---|---|
| tools per run | 32 |
| schema depth / nodes / properties | 5 / 200 / 50 |
| tools payload | 64 KB |
| model steps per run | 8 |
| tool calls per run | 32 |
| output tokens per step | 2048 |
| reserved tokens per run (aggregate) | 120000 |
| context tokens per step | 200000 |
| one tool result / all results | 128 KB / 512 KB |
| run TTL (inactivity) | 10 min |
| concurrent runs per key / process | 10 / 100 |

A run has its own **aggregate** token budget across every step, separate
from the per-key budget: a long run cannot keep spending step after step
just because each individual step fits. Exhausting it returns
`run_token_ceiling_exceeded` (422 — permanent for that run; start a new
one). Exceeding a context or size ceiling returns `context_budget_exceeded`
or `tool_result_too_large`. Arguments and results are **never silently
truncated** to make room, and an unfinished call/result pair is never
dropped.

## Continuations: what is and is not guaranteed

- **Process-local and non-durable.** A restart invalidates every
  `continuationId` honestly — the id is simply not found (`404`), never
  silently resumed against reconstructed state.
- **Bound to the creating key.** A continuation presented by a different key
  reports `404`, identical to an unknown id, so the response never confirms
  that an id exists to someone who should not know.
- **Single-use per step.** Two concurrent continuations for one run: exactly
  one wins; the other gets `409 run_busy`. A replay of a consumed run gets
  `404` and never re-runs generation.
- **Not exactly-once for your side effects.** A claimed result means *this
  process accepted it once*. Whether your executor's own side effect happened
  exactly once is your concern. If a response is lost after a tool already
  ran, do **not** re-run the tool merely because Semidex was unreachable.

There is no automatic retry after generation has begun, after a lost stream,
or on an ambiguous timeout.

**One generation at a time.** Agent mode contends on the same single-flight
generation gate as Ask v1/v2, so a v3 model step and an Ask request never
run concurrently; the loser gets `429 busy`. The gate is held only for the
model step itself and is **released while a run waits for tool results** — a
run that idles for minutes between requests never holds a process-wide lock.

`429 busy` is a **guaranteed-no-work** outcome: the slot is decided before
the run is claimed and before any tokens are reserved, so a refused request
runs no generation, spends no budget, and leaves the run untouched. Retry the
identical request — including the same `continuationId` and the same already
executed `toolResults` — once the slot frees.

## Guaranteed-no-work failures preserve the continuation

Some failures are raised **before the model is ever invoked**. For those the
run's stored state is untouched and still correct, so the continuation is
**kept**, not closed: you may re-send the identical request — same
`continuationId`, same already-executed `toolResults` — without re-running
your tools.

| Code | HTTP | Retry unchanged? |
|---|---|---|
| `busy` | 429 | yes, once the generation slot frees |
| `key_budget_exceeded` | 429 | yes, once the key's bucket refills (honour `Retry-After`) |
| `run_step_limit_exceeded` | 422 | no — permanent for this run |
| `run_token_ceiling_exceeded` | 422 | no — permanent for this run |
| `context_budget_exceeded` | 422 | no — permanent for this run |

The 422s are permanent for the run, but the run still survives the request:
it never disappears mid-call, so you can inspect it or close it deliberately
rather than discovering it is gone.

This is what makes `retryable: true` an honest flag rather than an empty one.
A budget denial that had destroyed the continuation would have returned
`404 run_not_found` on the retry, stranding tool results your executor had
already produced — and possibly already committed side effects for.

Once generation **has** begun, the opposite rule applies: the provider state
is no longer trustworthy and the run is closed. `safety_refusal`,
`output_limit_reached`, `stream_interrupted`, `unknown_tool` and
`invalid_tool_arguments` all end the run. So does `results_mismatch`, which
means the stored pending calls and your results disagree — an identical
retry could never succeed. Start a new run.

## Errors

Selected codes (full list in `src/core/agent-api/v3/contract.js`):

| Code | HTTP | Meaning |
|---|---|---|
| `capability_unavailable` | 501 | the configured backend cannot do tool calling |
| `unsupported_schema_keyword` | 400 | a rejected JSON Schema construct |
| `invalid_tool_arguments` | 502 | model arguments failed your schema; nothing executed |
| `unknown_tool` | 502 | model asked for a tool outside the allowlist |
| `safety_refusal` | 422 | model stopped on a content filter — not an answer |
| `output_limit_reached` | 422 | hit the output ceiling before finishing — not an answer |
| `run_not_found` | 404 | unknown, expired, or another key's continuation |
| `run_busy` | 409 | a step is already running for this run |
| `results_mismatch` | 400 | missing/extra/duplicate tool results |
| `context_budget_exceeded` | 422 | the run no longer fits the context budget |
| `run_token_ceiling_exceeded` | 422 | the run exhausted its aggregate token budget |
| `busy` | 429 | another generation is running; agent mode shares one generation slot with Ask v1/v2 |
| `key_budget_exceeded` | 429 | the key's token bucket is empty; the run is preserved, retry after `Retry-After` |

## Providers

Gemini only, via native function calling. Any other backend reports
`capability_unavailable` **before** retrieval or generation. Ordinary text
Ask keeps working on every backend.

## Retrieval and grounding

Agent mode performs **no retrieval of its own** and makes no automatic
grounding promise. Retrieval reaches a run only when you declare a retrieval
tool and call it; that call is an ordinary Search/Content API request which
passes through its own collection authorization. A collection name inside
tool arguments grants nothing, because Semidex never acts on it.

Tool-result text is **application data, not a Semidex-verified citation**,
and never becomes a system instruction. Validating that a result is
well-formed JSON says nothing about whether it is true.

## Client

```js
import { createSemidexClient } from 'semidex-lite/client';

const client = createSemidexClient({ baseUrl, apiKey });

let step = await client.agentStep({ input, systemInstructions, tools });
while (step.status === 'requires_action') {
  const toolResults = step.toolCalls.map(runMyToolSafely); // YOUR decision
  step = await client.agentStep({ continuationId: step.continuationId, toolResults });
}
console.log(step.answer);
```

`askAgent()` is the streaming form; `agentStep()` consumes one step to its
terminal event. Neither executes tools and neither loops.

Runnable example: `packages/lite/examples/agent-tool-loop.mjs`.

## Live verification

```bash
GEMINI_API_KEY=... npm run agent:live-characterization
```

Opt-in, bounded (3 steps, one read-only synthetic tool), and never part of
`npm test`. Until it has been run for a build, the release notes must state
that the live native round trip is unverified for that build.

Two cautions learned from running it:

- `models.list()` and real `generateContent` availability can **disagree**.
  This key lists `gemini-2.5-flash`, yet calling it returns
  `404 "no longer available to new users"`. Do not derive availability from
  the model list alone; the 404 body names the replacement model.
- Check tool-supplied values **digits-only**. A model legitimately formats
  numbers with separators (`4,173`), so a naive substring check reports a
  genuine round trip as a failure.
