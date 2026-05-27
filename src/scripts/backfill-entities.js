/**
 * Payload-only entity backfill — Path B migration.
 *
 * Scrolls a Qdrant collection, runs the entity extractor on the stored
 * text/section/source_file payload fields, and issues set_payload calls
 * to add `entities` and `doc_role` to each point.
 *
 * No re-embedding. No production MCP changes.
 *
 * Usage:
 *   COLLECTION=my-collection node src/scripts/backfill-entities.js
 *   APPLY=1 COLLECTION=my-collection node src/scripts/backfill-entities.js
 *
 * Env vars:
 *   COLLECTION  (required) — target Qdrant collection
 *   APPLY=1     — actually write payload; default is dry-run (read-only)
 *   PAGE_SIZE   — scroll batch size (default: 250)
 */

import 'dotenv/config';
import { scrollAllPoints, createPayloadIndex } from '../core/qdrant.js';
import { extractEntities } from '../indexer/phases/entities.js';

const COLLECTION = process.env.COLLECTION;
const APPLY      = process.env.APPLY === '1';
const PAGE_SIZE  = parseInt(process.env.PAGE_SIZE ?? '250');

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_KEY = process.env.QDRANT_KEY;
const headers = () => ({ 'api-key': QDRANT_KEY, 'Content-Type': 'application/json' });

if (!COLLECTION) {
  process.stderr.write('Error: COLLECTION env var is required.\n');
  process.stderr.write('Usage: COLLECTION=my-collection node src/scripts/backfill-entities.js\n');
  process.exit(1);
}

async function setPayload(collection, pointId, payload) {
  const r = await fetch(`${QDRANT_URL}/collections/${collection}/points/payload`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ payload, points: [pointId] }),
  });
  if (!r.ok) throw new Error(`set_payload failed for point ${pointId}: ${await r.text()}`);
}

const ENTITY_INDEX_FIELDS = [
  ['entities.paths',   'keyword'],
  ['entities.symbols', 'keyword'],
  ['entities.env_vars','keyword'],
  ['entities.commands','keyword'],
  ['doc_role',         'keyword'],
];

async function ensureEntityIndexes(collection) {
  for (const [field, type] of ENTITY_INDEX_FIELDS) {
    await createPayloadIndex(collection, field, type);
  }
}

async function main() {
  console.log(`\nEntity backfill — collection: ${COLLECTION}`);
  console.log(APPLY ? '  Mode: APPLY (writing payload)' : '  Mode: DRY-RUN (no writes — set APPLY=1 to apply)');

  if (APPLY) {
    console.log('  Ensuring entity payload indexes...');
    await ensureEntityIndexes(COLLECTION);
    console.log('  Indexes OK.');
  }

  const points = await scrollAllPoints(
    COLLECTION,
    ['text', 'section', 'source_file', 'entities', 'doc_role'],
    PAGE_SIZE,
  );

  console.log(`  Fetched ${points.length} points`);

  let updated = 0;
  let skipped = 0;
  let errors  = 0;

  for (const point of points) {
    const p = point.payload ?? {};
    const chunk = {
      text:        p.text        ?? '',
      section:     p.section     ?? '',
      source_file: p.source_file ?? '',
    };

    const { entities, doc_role } = extractEntities(chunk);

    const alreadyHas = p.entities !== undefined && p.doc_role !== undefined;
    if (alreadyHas) {
      skipped++;
      continue;
    }

    if (APPLY) {
      try {
        await setPayload(COLLECTION, point.id, { entities, doc_role });
        updated++;
      } catch (err) {
        console.error(`  ERROR point ${point.id}: ${err.message}`);
        errors++;
      }
    } else {
      updated++;
    }
  }

  console.log(`\nResult:`);
  console.log(`  Already had entities: ${skipped}`);
  console.log(`  ${APPLY ? 'Updated' : 'Would update'}: ${updated}`);
  if (errors > 0) console.log(`  Errors: ${errors}`);
  if (!APPLY && updated > 0) {
    console.log('\n  Re-run with APPLY=1 to write changes.');
  }
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
