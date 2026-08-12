#!/usr/bin/env node
// Ask API v2 — runnable CLI demo of a multi-turn conversation against a
// REAL, already-running Semidex Lite server.
//
// This script does NOT start a server and does NOT index anything — it
// assumes you already have `npx semidex-lite serve` running (or the Full
// admin server) with a collection you can question. It exists purely to
// demonstrate the ask-v2-sse-client.mjs + conversation-manager.mjs pair in
// a runnable, copy-pasteable form — see packages/lite/README.md's own
// "Backend integration: multi-turn Ask" section for the narrative
// explanation this script makes concrete.
//
// Usage:
//   node packages/lite/examples/run-conversation-demo.mjs <collection> "question 1" "question 2" ...
//   SEMIDEX_BASE_URL=http://127.0.0.1:8642 node run-conversation-demo.mjs my-docs "What is X?" "And how does that relate to Y?"
//
// *** DEMO ONLY *** — conversation-manager.mjs stores state in an in-memory
// Map that is lost the moment this process exits. See that file's own
// header comment for the production-persistence boundary this is
// deliberately NOT implementing.
import { createConversationManager } from './conversation-manager.mjs';

async function main() {
  const [collection, ...questions] = process.argv.slice(2);
  if (!collection || questions.length === 0) {
    console.error('Usage: node run-conversation-demo.mjs <collection> "question 1" ["question 2" ...]');
    process.exitCode = 1;
    return;
  }

  const baseUrl = process.env.SEMIDEX_BASE_URL ?? 'http://127.0.0.1:8642';
  const manager = createConversationManager();
  let conversationId;

  for (const [index, question] of questions.entries()) {
    console.log(`\n--- Turn ${index + 1} ---`);
    console.log(`Q: ${question}`);
    const turn = await manager.ask({ baseUrl, collection, conversationId, question });
    conversationId = turn.conversationId;

    if (!turn.ok) {
      console.error(`Error [${turn.error?.code}]: ${turn.error?.message}`);
      continue;
    }
    if (turn.refused) {
      console.log('A: (refused — insufficient evidence in the collection)');
      continue;
    }
    console.log(`A: ${turn.answer}`);
    console.log(`   sources: ${turn.sources.length}, citations: ${turn.citations.join(', ') || 'none'}`);
    if (turn.summaryChanged) {
      console.log('   (conversation summary was refreshed this turn)');
    }
  }

  console.log(`\nconversationId used throughout: ${conversationId}`);
}

main().catch((err) => {
  console.error('Demo failed:', err.message);
  process.exitCode = 1;
});
