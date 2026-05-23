import { createHash } from 'crypto';

const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // UUID v5 DNS namespace

// Convert a UUID string to a 16-byte Buffer.
function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, '');
  const buf = Buffer.allocUnsafe(16);
  for (let i = 0; i < 16; i++) buf[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return buf;
}

// RFC 4122 §4.3 UUIDv5: SHA-1(namespace bytes + name bytes), then set version/variant.
function uuidv5(name) {
  const nsBytes  = uuidToBytes(NAMESPACE);
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = createHash('sha1').update(nsBytes).update(nameBytes).digest();

  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant RFC 4122

  const h = hash.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

/**
 * Derive a stable Qdrant point ID for a logical chunk.
 *
 * The ID is deterministic across indexing runs: the same inputs always produce
 * the same UUID. This makes every upsert idempotent — Qdrant overwrites the
 * existing point rather than inserting a new one.
 *
 * Inputs that define chunk identity:
 *   collection            — prevents cross-collection ID collisions
 *   sourceFile            — relative path (forward-slash normalised)
 *   chunkIndex            — zero-based position within the file
 *   embeddingSchemaVersion — ensures a schema bump generates fresh IDs
 *
 * Intentionally excluded from the ID:
 *   file_hash    — content changes should overwrite in place, not orphan
 *   tags         — LLM-derived; must not affect physical identity
 *   context      — LLM-derived; must not affect physical identity
 *   model/provider — provider changes are handled by deleteBySourceFile
 */
export function makePointId({ collection, sourceFile, chunkIndex, embeddingSchemaVersion }) {
  const normalizedFile = sourceFile.replace(/\\/g, '/');
  const name = `${collection}\x00${normalizedFile}\x00${chunkIndex}\x00${embeddingSchemaVersion}`;
  return uuidv5(name);
}
