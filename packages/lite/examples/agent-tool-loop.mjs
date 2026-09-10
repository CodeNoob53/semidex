#!/usr/bin/env node
// Agent mode (POST /api/v3/ask) — a runnable, BACKEND-ONLY example of the
// full loop: start -> requires_action -> validate -> execute -> continue.
//
// WHAT THIS DEMONSTRATES, AND WHAT IT DELIBERATELY DOES NOT
// --------------------------------------------------------
// Semidex NEVER executes a tool. It returns a *request* to call one; the
// decision to run it — and the authority to cause any side effect — belongs
// entirely to this file, your backend. That is why the executor below:
//
//   1. checks the requested name against ITS OWN allowlist (never trusting
//      that the model stayed inside the tools it was offered),
//   2. runs only a synthetic, READ-ONLY lookup,
//   3. returns a discriminated { ok } result, so a failure reaches the model
//      as a real error instead of a fabricated success.
//
// A write-capable tool (placing an order, sending a message, charging a
// card) would need YOUR confirmation step here — not the model's, and not
// Semidex's. Nothing in this example performs a write of any kind.
//
// Credentials come only from the environment. Nothing is logged that could
// contain a key.
//
// Usage:
//   SEMIDEX_URL=http://127.0.0.1:8642 SEMIDEX_KEY=sdx_v1_... \
//     node packages/lite/examples/agent-tool-loop.mjs
//
// The key must be scoped to the `agent` operation:
//   semidex-lite key add --name demo --collection "*" --operation agent
import { createSemidexClient } from '../lite-src/client/index.js';

const baseUrl = process.env.SEMIDEX_URL;
const apiKey = process.env.SEMIDEX_KEY;

if (!baseUrl || !apiKey) {
  console.error('Set SEMIDEX_URL and SEMIDEX_KEY. The key must be scoped to --operation agent.');
  process.exit(2);
}

// ── The tool surface this application chooses to expose ──────────────────
// The schema uses only the supported subset: object/properties/required/
// additionalProperties plus scalar types. Anything else (pattern, const,
// $ref, ...) is REJECTED by the server rather than silently ignored, so a
// constraint declared here is always one that is actually enforced.
const TOOLS = [{
  name: 'lookup_items',
  description: 'Look up available items by a free-text query. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for' },
      limit: { type: 'integer', description: 'Maximum number of items to return' },
    },
    required: ['query'],
    additionalProperties: false,
  },
}];

// ── The executor: THIS backend's own allowlist and implementation ────────
// Deliberately a separate allowlist from TOOLS above. Semidex already
// verifies the model stayed inside the offered tools, but an executor that
// trusts an upstream check it does not own is one refactor away from being
// wrong. Defence in depth is cheap here.
const EXECUTORS = {
  lookup_items({ query, limit = 3 }) {
    // Synthetic, read-only, no I/O. A real implementation would call your
    // own service or MCP server here — with your credentials, under your
    // policy, never Semidex's.
    const catalogue = ['oat milk', 'whole milk', 'almond milk', 'rye bread', 'butter'];
    const items = catalogue.filter((name) => name.includes(String(query).toLowerCase())).slice(0, limit);
    return { items, count: items.length };
  },
};

/**
 * Runs ONE requested tool call. Returns the discriminated result shape the
 * continuation expects. An executor failure is reported as { ok: false } so
 * the model is told the truth rather than handed a fake success.
 */
function executeToolCall(call) {
  const executor = EXECUTORS[call.name];
  if (!executor) {
    // The model asked for something this backend does not implement. Refuse
    // locally rather than improvising.
    return { callId: call.id, ok: false, error: { code: 'unknown_tool', message: `This backend does not implement "${call.name}".` } };
  }
  try {
    return { callId: call.id, ok: true, output: executor(call.arguments) };
  } catch (err) {
    return { callId: call.id, ok: false, error: { code: 'executor_failed', message: err.message } };
  }
}

async function main() {
  const client = createSemidexClient({ baseUrl, apiKey, timeoutMs: 60_000 });

  // A hard local ceiling on loop iterations, INDEPENDENT of the server's own
  // run limits. Two parties bound the loop, so neither one's bug can spin it.
  const MAX_ITERATIONS = 5;

  let step = await client.agentStep({
    input: 'Find an appropriate milk option and tell me how many there are.',
    systemInstructions: 'You are a concise shopping assistant. Use the available tools to look things up before answering.',
    tools: TOOLS,
  });

  for (let i = 0; i < MAX_ITERATIONS; i += 1) {
    if (step.status === 'completed') {
      console.log('\n--- final answer ---');
      console.log(step.answer);
      console.log(`\n(model steps: ${step.steps}, tokens in/out: ${step.usage.tokensIn}/${step.usage.tokensOut})`);
      return;
    }

    // status === 'requires_action'
    if (step.text) console.log(`[model] ${step.text}`);
    console.log(`[semidex] requested ${step.toolCalls.length} tool call(s) — THIS backend decides whether to run them`);

    const toolResults = step.toolCalls.map((call) => {
      console.log(`  -> ${call.name}(${JSON.stringify(call.arguments)})`);
      return executeToolCall(call);
    });

    // The continuation carries ONLY the id and the COMPLETE set of results.
    // Instructions, tools and model are frozen for the life of the run.
    step = await client.agentStep({ continuationId: step.continuationId, toolResults });
  }

  console.error(`Stopped after ${MAX_ITERATIONS} iterations without a final answer.`);
  process.exitCode = 1;
}

main().catch((err) => {
  // SemidexApiError carries a typed code; never print headers or the key.
  console.error(`Agent run failed: ${err.code ?? 'error'} — ${err.message}`);
  process.exitCode = 1;
});
