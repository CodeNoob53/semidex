#!/usr/bin/env node
// OPT-IN live characterization for agent mode against the REAL Gemini API.
//
// WHY THIS EXISTS
// ---------------
// Every automated test for agent mode uses a fake @google/genai transport.
// That proves the wiring and the contract; it proves NOTHING about whether
// Gemini itself returns native function calls in the shape this adapter
// maps. Only a real round trip can establish that, and a real round trip
// costs money and needs a key — so it is opt-in, bounded, and never part of
// `npm test`.
//
// If this has not been run for a build, the release notes must say the live
// native call/result round trip is UNVERIFIED for that build, and the mode
// stays marked experimental. "It is correct by construction" is not
// evidence.
//
// SAFETY BOUNDS
// -------------
//  - ONE read-only local tool (no network, no filesystem, no writes).
//  - At most 3 model steps and a small output ceiling.
//  - Only reads GEMINI_API_KEY from the environment; never prints it.
//  - Creates nothing, deletes nothing, and touches no Qdrant collection.
//
// Usage:
//   GEMINI_API_KEY=... node scripts/agent-live-characterization.mjs
//   GEMINI_API_KEY=... ASK_MODEL=gemini-3.6-flash node scripts/agent-live-characterization.mjs
import 'dotenv/config';
import { createGeminiProvider } from '../src/cloud/generation/gemini-provider.js';
import { createAgentRuntime } from '../src/core/agent/runtime.js';

const apiKey = process.env.GEMINI_API_KEY;
// Default confirmed reachable on 2026-09-10. NOTE: models.list() and real
// generateContent availability can DISAGREE — this key lists
// gemini-2.5-flash, but calling it returns 404 "no longer available to new
// users". Override with ASK_MODEL when this default ages out; the 404 body
// names the replacement.
const model = process.env.ASK_MODEL || 'gemini-3.6-flash';

if (!apiKey) {
  console.error('LIVE_BLOCKED: GEMINI_API_KEY is not set. This script is opt-in and makes a real, billed API call.');
  process.exit(2);
}

// A deliberately synthetic, read-only tool. Its answer cannot be guessed
// from the model's own knowledge, so a correct final answer is real evidence
// that the tool result actually reached the model.
const TOOLS = [{
  name: 'get_warehouse_count',
  description: 'Returns how many units of a given item are in the warehouse.',
  inputSchema: {
    type: 'object',
    properties: { item: { type: 'string', description: 'The item name' } },
    required: ['item'],
    additionalProperties: false,
  },
}];

const SECRET_COUNT = 4173; // not derivable from training data
function executeToolCall(call) {
  if (call.name !== 'get_warehouse_count') {
    return { callId: call.id, ok: false, error: { message: `unknown tool ${call.name}` } };
  }
  return { callId: call.id, ok: true, output: { item: call.arguments.item, units: SECRET_COUNT } };
}

async function main() {
  const provider = createGeminiProvider({ apiKey, model });
  const readiness = await provider.ready();
  if (!readiness.ok) {
    console.error(`LIVE_BLOCKED: ${readiness.reason}`);
    process.exit(2);
  }

  const runtime = createAgentRuntime({
    generationProvider: provider,
    limits: { maxModelSteps: 3, maxToolCallsPerRun: 4, maxOutputTokensPerStep: 512 },
  });

  const evidence = { model, steps: [], verdict: null };

  let step = await runtime.start({
    identity: 'live-characterization',
    input: 'How many units of widget-A are in the warehouse? Use the available tool.',
    systemInstructions: 'You are a terse inventory assistant. Always use the tool before answering.',
    tools: TOOLS,
  });
  evidence.steps.push({ n: 1, status: step.status, toolCalls: step.toolCalls?.map((c) => ({ name: c.name, arguments: c.arguments })) ?? [] });

  if (step.status !== 'requires_action') {
    evidence.verdict = 'NO_TOOL_CALL';
    console.log(JSON.stringify(evidence, null, 2));
    console.error('\nThe model answered without requesting the tool. Native tool calling was NOT exercised.');
    process.exit(1);
  }

  let guard = 0;
  while (step.status === 'requires_action' && guard++ < 3) {
    const toolResults = step.toolCalls.map(executeToolCall);
    step = await runtime.continue({
      identity: 'live-characterization',
      continuationId: step.continuationId,
      toolResults,
    });
    evidence.steps.push({ n: evidence.steps.length + 1, status: step.status, text: step.status === 'completed' ? step.text : undefined });
  }

  // Compare against DIGITS ONLY. A model legitimately formats a number with
  // a thousands separator ("4,173" / "4 173" / "4.173" depending on locale),
  // so a raw `includes("4173")` would report a genuine round trip as
  // INCONCLUSIVE — which is exactly what happened on the first live run.
  // Stripping every non-digit from both sides tests what actually matters:
  // did the tool-supplied value reach the answer at all.
  const answerDigits = String(step.text ?? '').replace(/\D+/g, '');
  const answered = step.status === 'completed' && answerDigits.includes(String(SECRET_COUNT));
  evidence.verdict = answered ? 'LIVE_NATIVE_ROUND_TRIP_CONFIRMED' : 'INCONCLUSIVE';
  evidence.finalAnswerContainsToolValue = answered;

  console.log(JSON.stringify(evidence, null, 2));
  if (!answered) {
    console.error('\nThe final answer did not contain the tool-supplied value. Treat the round trip as UNVERIFIED.');
    process.exit(1);
  }
  console.error('\nLive native function call/result round trip confirmed.');
}

main().catch((err) => {
  // Never print the key; the provider already redacts it from its own messages.
  console.error(`Live characterization failed: ${err.code ?? 'error'} — ${err.message}`);
  process.exit(1);
});
