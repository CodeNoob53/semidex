const EMPTY_SECTION_RE = /^\(empty section: .+\)$/;

export function isEmptySectionChunk(chunk) {
  return EMPTY_SECTION_RE.test((chunk.text ?? '').trim());
}

export function finalizeEmptySectionChunk(chunk) {
  return {
    ...chunk,
    context: `Empty section placeholder for "${chunk.section || 'unknown'}".`,
    tags: [],
  };
}

// Split a chunk list into { normal, empty } preserving original indexes.
// Each item in both arrays carries __origIndex so reassembly is O(n).
export function partitionChunks(chunks) {
  const normal = [];
  const empty  = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = { ...chunks[i], __origIndex: i };
    if (isEmptySectionChunk(chunks[i])) empty.push(c);
    else normal.push(c);
  }
  return { normal, empty };
}

// Merge processed normal chunks and finalized empty chunks back into
// original order. Strips __origIndex from the output.
export function reassembleChunks(processedNormal, finalizedEmpty) {
  const total = processedNormal.length + finalizedEmpty.length;
  const result = new Array(total);
  for (const c of processedNormal) {
    const { __origIndex, ...rest } = c;
    result[__origIndex] = rest;
  }
  for (const c of finalizedEmpty) {
    const { __origIndex, ...rest } = c;
    result[__origIndex] = rest;
  }
  return result;
}
