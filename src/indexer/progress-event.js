// Machine-readable progress line format shared between the indexer
// (emits) and the admin job registry (parses). Kept in its own
// zero-dependency module so the registry doesn't have to import all of
// src/indexer/index.js (Qdrant/ONNX/Ollama clients, etc.) just to know the
// prefix string.
export const PROGRESS_EVENT_PREFIX = '[semidex:progress] ';

/**
 * Parse a single stdout line into a progress payload, or null if the line
 * isn't a progress event or its JSON body is malformed. Never throws —
 * callers (the job registry) must be able to run this on arbitrary,
 * untrusted-shape child-process output without risking a crash.
 */
export function parseProgressLine(line) {
  if (!line.startsWith(PROGRESS_EVENT_PREFIX)) return null;
  const jsonPart = line.slice(PROGRESS_EVENT_PREFIX.length);
  try {
    const data = JSON.parse(jsonPart);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
    return data;
  } catch {
    return null;
  }
}
