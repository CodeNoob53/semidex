// Structural carryover smoke: entityContext() includes cleaned nearby prose in
// the same section; placeholder lines are stripped; heading boundaries are not
// crossed; carryover is capped; raw content is always preserved.

export default async function ({ ok }) {
  console.log('\n[57] skeleton structural carryover — prose context, boundaries, caps');

  const { parseSkeleton }    = await import('../../shared/indexer/phases/skeleton.js');
  const { chunkFromSkeleton } = await import('../../shared/indexer/phases/skeleton-chunk.js');

  // ── fixture helpers ──────────────────────────────────────────────────────────
  async function chunks(md) {
    const { chunks: result } = await chunkFromSkeleton(parseSkeleton(md, { sourceFile: 'test.md' }), { sourceFile: 'test.md' });
    return result;
  }
  function byType(cs, t) { return cs.filter(c => c.node_type === t); }

  // ── case 1: table after explanatory paragraph ─────────────────────────────
  const doc1 = `# Config

Use these directives to configure the service.

| Directive | Meaning |
|-----------|---------|
| Restart   | auto    |
`;
  const c1 = await chunks(doc1);
  const tbl1 = byType(c1, 'table')[0];
  ok('[1] table chunk context includes cleaned prose phrase',
     /directives/.test(tbl1?.context ?? ''));
  ok('[1] table chunk text is raw markdown',
     tbl1?.text?.includes('Restart'));
  ok('[1] table raw_content is raw markdown',
     tbl1?.raw_content?.includes('Restart'));

  // ── case 2: code_block after explanatory paragraph ───────────────────────
  // Must be large enough to pass the entity threshold (not merged as tiny code).
  const doc2 = `# Setup

Install dependencies and configure the environment before running the service.

\`\`\`bash
#!/usr/bin/env bash
set -euo pipefail
npm ci
npm run build
npm run lint
node server.js --port 3000
\`\`\`
`;
  const c2 = await chunks(doc2);
  const code2 = byType(c2, 'code_block')[0];
  ok('[2] code_block context includes prose carryover',
     /Install|dependencies|environment/.test(code2?.context ?? ''));
  ok('[2] code_block text is raw source', code2?.text?.includes('npm ci'));
  ok('[2] code_block raw_content is raw source', code2?.raw_content?.includes('npm ci'));

  // ── case 3: placeholder lines are stripped from carryover ────────────────
  // The prose accumulator has the placeholder appended before flush;
  // entityContext must not include it in the context string.
  const doc3 = `# Ops

Run the migration before deploy.

| Step | Command |
|------|---------|
| 1    | migrate |

\`\`\`sh
npm run migrate
\`\`\`
`;
  const c3 = await chunks(doc3);
  const tbl3  = byType(c3, 'table')[0];
  const code3 = byType(c3, 'code_block')[0];
  ok('[3] table context has no placeholder lines',
     !/\[table node:/.test(tbl3?.context ?? '') && !/\[code block node:/.test(tbl3?.context ?? ''));
  ok('[3] code context has no placeholder lines',
     !/\[code block node:/.test(code3?.context ?? '') && !/\[table node:/.test(code3?.context ?? ''));

  // ── case 4: no heading-boundary crossing ─────────────────────────────────
  // Structural node at start of new section must NOT inherit prose from the
  // previous section.
  const doc4 = `# Section A

Background prose from section A.

# Section B

| Col | Val |
|-----|-----|
| x   | 1   |
`;
  const c4 = await chunks(doc4);
  const tbl4 = byType(c4, 'table')[0];
  ok('[4] table context does not carry prose from previous section',
     !/Background|Section A/.test(tbl4?.context ?? ''));

  // ── case 5: placeholder-only prose does not become carryover ─────────────
  // If the only content preceding an entity is a placeholder from an earlier
  // entity, that placeholder should be stripped and the context should not
  // contain it.
  const doc5 = `# Items

Here is the first table.

| A | B |
|---|---|
| 1 | 2 |

| C | D |
|---|---|
| 3 | 4 |
`;
  const c5 = await chunks(doc5);
  const tables5 = byType(c5, 'table');
  ok('[5] second table context has no placeholder from first table',
     tables5.length >= 2 && !/\[table node:/.test(tables5[1]?.context ?? ''));

  // ── case 6: carryover is capped ──────────────────────────────────────────
  // Generate a very long paragraph; entity context must be capped.
  const longProse = 'Word '.repeat(400).trim(); // ~2000 chars
  const doc6 = `# Long

${longProse}

| Col | Val |
|-----|-----|
| a   | 1   |
`;
  const c6 = await chunks(doc6);
  const tbl6 = byType(c6, 'table')[0];
  // context = "Long — table — <prose>"; prose portion must be capped
  const prose6 = (tbl6?.context ?? '').split(' — ').slice(2).join(' — ');
  const defaultCap = parseInt(process.env.SKELETON_CARRYOVER_CHARS ?? '500', 10) || 500;
  ok('[6] carryover prose is capped at configured limit',
     prose6.length <= defaultCap);

  // ── case 7a: SKELETON_CARRYOVER_CHARS env var respected ──────────────────
  const prevVal = process.env.SKELETON_CARRYOVER_CHARS;
  process.env.SKELETON_CARRYOVER_CHARS = '50';
  try {
    const c7a = await chunks(doc6);
    const tbl7a = byType(c7a, 'table')[0];
    const prose7a = (tbl7a?.context ?? '').split(' — ').slice(2).join(' — ');
    ok('[7a] SKELETON_CARRYOVER_CHARS=50 caps prose at 50 chars',
       prose7a.length <= 50);
  } finally {
    if (prevVal === undefined) delete process.env.SKELETON_CARRYOVER_CHARS;
    else process.env.SKELETON_CARRYOVER_CHARS = prevVal;
  }

  // ── case 7b: invalid SKELETON_CARRYOVER_CHARS falls back safely ──────────
  process.env.SKELETON_CARRYOVER_CHARS = 'notanumber';
  try {
    const c7b = await chunks(doc6);
    const tbl7b = byType(c7b, 'table')[0];
    ok('[7b] invalid SKELETON_CARRYOVER_CHARS falls back to default',
       tbl7b !== undefined && typeof tbl7b.context === 'string');
  } finally {
    if (prevVal === undefined) delete process.env.SKELETON_CARRYOVER_CHARS;
    else process.env.SKELETON_CARRYOVER_CHARS = prevVal;
  }

  // ── case 7c: fallback when entity follows entity with no prose ───────────
  // Two structural nodes in sequence, no prose between them.
  // Second entity falls back to last emitted prose chunk in same section.
  const doc7c = `# Data

Introductory sentence for this section.

| A | B |
|---|---|
| 1 | 2 |

| C | D |
|---|---|
| 3 | 4 |
`;
  const c7c = await chunks(doc7c);
  const tables7c = byType(c7c, 'table');
  // Both tables are in the same section; second should have context from the
  // intro prose (carried via lastProseIdx), not empty.
  ok('[7c] second entity in sequence gets prose from same section',
     tables7c.length >= 2 &&
     /Introductory|Data/.test(tables7c[1]?.context ?? ''));
}
