// Shared CE routing guard implementations for CE routing benchmarks.
//
// Guard versions:
//   v1  — original custom-50 heuristic (no config-env route)
//   v2  — adds config-env route + insertion-order fix (custom-150 only)
//   v3  — provider-activation priority before config-env; exact-token single-protect
//   v4  — v3 + provider-activation top-2 preservation for providers.md activation guides
//   oracle — qrel-aware regression guard (pure CE order; promotes rel>=3 hybrid top-3 chunks)
//
// Note: v4 only fires when a candidate is exactly at ceIdx === 2 in the v3 output.
// If CE pushes a providers.md activation-guide chunk to index 3+, v4 does not rescue it.

// ── Lexical helpers ────────────────────────────────────────────────────────────

export function tokeniseQuery(query) {
  return new Set((query.toLowerCase().match(/[\p{L}\p{N}_@.]+/gu) ?? []).filter(t => t.length >= 2));
}

export function candidateTokens(payload) {
  return new Set([
    ...(payload.source_file ?? '').toLowerCase().match(/[\p{L}\p{N}_@.]+/gu) ?? [],
    ...(payload.section     ?? '').toLowerCase().match(/[\p{L}\p{N}_@.]+/gu) ?? [],
    ...(payload.text        ?? '').toLowerCase().match(/[\p{L}\p{N}_@.]+/gu) ?? [],
  ]);
}

export function tokenOverlapCount(queryTokens, candidateToks) {
  let n = 0;
  for (const t of queryTokens) if (candidateToks.has(t)) n++;
  return n;
}

export function looksLikeEnvTable(payload) {
  const text      = (payload.text ?? '').slice(0, 800);
  const pipeLines = (text.match(/\|/g) ?? []).length;
  const varLines  = (text.match(/\b[A-Z][A-Z_]{3,}[A-Z0-9]\b/g) ?? []).length;
  return pipeLines >= 6 || varLines >= 5;
}

export function hasProviderCandidateInPool(pool) {
  const activationTerms = /providers?\b|ONNX_EMBED|bge.m3.onnx|enable|activat|увімкнути/i;
  return pool.slice(0, 5).some(r =>
    r.payload?.source_file === 'providers.md' && activationTerms.test(r.payload?.text ?? '')
  );
}

export function hasProviderActivationCandidateInPool(pool) {
  const activationTerms = /\bproviders?\b|ONNX_EMBED|bge.m3.onnx|\benable\b|\bactivat|\bswitch\b|увімкнути/i;
  return pool.slice(0, 5).some(r =>
    r.payload?.source_file === 'providers.md' && activationTerms.test(r.payload?.text ?? '')
  );
}

export function chunkId(r) {
  const sf = r.payload?.source_file;
  const ci = r.payload?.chunk_index;
  return (sf != null && ci != null) ? `${sf}#${ci}` : null;
}

// chunkId variant that handles both {result, ceScore} wrappers and plain result objects
function chunkIdWrapped(r) {
  const sf = r.result?.payload?.source_file ?? r.payload?.source_file;
  const ci = r.result?.payload?.chunk_index ?? r.payload?.chunk_index;
  return (sf != null && ci != null) ? `${sf}#${ci}` : null;
}

// ── Query classifiers ──────────────────────────────────────────────────────────

export const ACTIVATION_VERB_PATTERNS = [
  /увімкнути/i, /\benable\b/i, /\bactivate\b/i,
  /without ollama/i, /без ollama/i,
];
export const PROVIDER_TERM_PATTERNS = [
  /bge-m3-onnx/i, /ONNX_EMBED/, /\bprovider\b/i, /провайдер/i,
];

export const SOURCE_NAVIGATION_PATTERNS = [
  /де знаходиться/i, /location in source/i, /\bsource\b/i,
  /експортує/i, /\bexports\b/i, /entry point/i,
  /which file/i, /where is/i,
];

export const EXACT_TOKEN_RE =
  /[A-Z][A-Z_]{2,}[A-Z0-9]|[a-z][A-Za-z]{2,}[A-Z][A-Za-z]*|src\/|\.js\b|\.md\b|@\d+/;

// v1 classifier (original custom-50, no config-env route)
export function classifyQueryV1(queryText) {
  if (ACTIVATION_VERB_PATTERNS.some(p => p.test(queryText)) &&
      PROVIDER_TERM_PATTERNS.some(p => p.test(queryText)))    return 'provider-activation';
  if (SOURCE_NAVIGATION_PATTERNS.some(p => p.test(queryText))) return 'source-navigation';
  if (EXACT_TOKEN_RE.test(queryText))                          return 'exact-token';
  return 'semantic';
}

// config-env detector used by v2/v3 (custom-150)
const CONFIG_ENV_TOKENS = new Set([
  'qdrant_url', 'qdrant_key', 'dense_provider', 'sparse_provider',
  'onnx_embed', 'rerank_enabled', 'rerank_model', 'link_enabled',
  'max_chunk_tokens', 'min_chunk_tokens', 'source_root', 'collection',
  'context_model', 'bench_provider',
  'env', 'environment', 'config.json', 'configuration',
  'змінні', 'середовища',
]);

// config-env detector used by custom-50 v3 (lighter regex-based check)
const CONFIG_ENV_TYPE_TOKENS_RE = /\benv\b|environment variable|config\.json|\bprovider\b|провайдер/i;

export function isConfigEnvQueryC50(queryText, typeLabel) {
  if (typeLabel === 'config-env') return true;
  return CONFIG_ENV_TYPE_TOKENS_RE.test(queryText);
}

export function isConfigEnvQueryC150(queryText, typeLabel) {
  if (typeLabel === 'config-env') return true;
  const lower = queryText.toLowerCase();
  for (const tok of CONFIG_ENV_TOKENS) {
    if (lower.includes(tok)) return true;
  }
  return false;
}

function isProviderActivationQuery(queryText, typeLabel) {
  if (typeLabel === 'provider-activation') return true;
  return ACTIVATION_VERB_PATTERNS.some(p => p.test(queryText)) &&
         PROVIDER_TERM_PATTERNS.some(p => p.test(queryText));
}

// v2 classifier (custom-150 only): config-env before provider-activation
export function classifyQueryV2(queryText, typeLabel) {
  if (isConfigEnvQueryC150(queryText, typeLabel)) return 'config-env';
  if (ACTIVATION_VERB_PATTERNS.some(p => p.test(queryText)) &&
      PROVIDER_TERM_PATTERNS.some(p => p.test(queryText)))  return 'provider-activation';
  if (SOURCE_NAVIGATION_PATTERNS.some(p => p.test(queryText))) return 'source-navigation';
  if (EXACT_TOKEN_RE.test(queryText))                          return 'exact-token';
  return 'semantic';
}

// v3 classifier, custom-50 variant (lighter config-env check)
export function classifyQueryV3C50(queryText, typeLabel) {
  if (isProviderActivationQuery(queryText, typeLabel)) return 'provider-activation';
  if (isConfigEnvQueryC50(queryText, typeLabel))       return 'config-env';
  if (SOURCE_NAVIGATION_PATTERNS.some(p => p.test(queryText))) return 'source-navigation';
  if (EXACT_TOKEN_RE.test(queryText))                          return 'exact-token';
  return 'semantic';
}

// v3 classifier, custom-150 variant (full config-env token set)
export function classifyQueryV3C150(queryText, typeLabel) {
  if (isProviderActivationQuery(queryText, typeLabel)) return 'provider-activation';
  if (isConfigEnvQueryC150(queryText, typeLabel))      return 'config-env';
  if (SOURCE_NAVIGATION_PATTERNS.some(p => p.test(queryText))) return 'source-navigation';
  if (EXACT_TOKEN_RE.test(queryText))                          return 'exact-token';
  return 'semantic';
}

// ── Protection predicates ──────────────────────────────────────────────────────

const STRUCTURAL_SOURCE_WORDS = /\bfunction\b|\bsource\b|\bmodule\b|\bexport\b|\.js\b|[a-z][A-Z]/;

export function exactTokenProtectScore(candidate, hybridRank, qToks) {
  const sf      = candidate.payload?.source_file ?? '';
  const section = (candidate.payload?.section ?? '').toLowerCase();
  const cToks   = candidateTokens(candidate.payload);
  const overlap = tokenOverlapCount(qToks, cToks);
  let structural = 0;
  if (sf === 'project-structure.md') {
    const queryText = [...qToks].join(' ');
    structural = STRUCTURAL_SOURCE_WORDS.test(queryText) ? 5 : 2;
  } else if (section.includes('src/') || section.includes('exports') ||
             section.toLowerCase().includes('source tree')) {
    structural = 3;
  }
  return overlap * 10 + structural - hybridRank;
}

// v1 isProtected (custom-50 guard, uses hasProviderCandidateInPool)
export function isProtectedV1(queryClass, candidate, hybridRank, pool) {
  if (hybridRank >= 3) return false;

  const qToks   = tokeniseQuery(pool.__query__);
  const cToks   = candidateTokens(candidate.payload);
  const overlap = tokenOverlapCount(qToks, cToks);
  const sf      = candidate.payload?.source_file ?? '';

  if (queryClass === 'provider-activation') {
    if (sf === 'config-env.md' && looksLikeEnvTable(candidate.payload)) {
      if (hasProviderCandidateInPool(pool)) return false;
    }
    const text = `${candidate.payload?.section ?? ''}\n${candidate.payload?.text ?? ''}`;
    const hasActivationGuideSignal =
      sf === 'providers.md' ||
      /\benable\b|\bactivate\b|увімкнути/i.test(text);
    if (!hasActivationGuideSignal) return false;
  }

  if (queryClass === 'source-navigation') {
    const section = (candidate.payload?.section ?? '').toLowerCase();
    const isStructural = sf === 'project-structure.md' ||
      section.includes('src/') || section.includes('source tree') || section.includes('exports');
    return overlap >= 1 && isStructural;
  }

  return overlap >= 2;
}

// v2 isProtected (custom-150 guard, uses hasProviderActivationCandidateInPool)
export function isProtectedV2(queryClass, candidate, hybridRank, pool) {
  if (hybridRank >= 3) return false;

  const qToks   = tokeniseQuery(pool.__query__);
  const cToks   = candidateTokens(candidate.payload);
  const overlap = tokenOverlapCount(qToks, cToks);
  const sf      = candidate.payload?.source_file ?? '';

  if (queryClass === 'config-env') {
    if (sf !== 'config-env.md') return false;
    return overlap >= 1;
  }

  if (queryClass === 'provider-activation') {
    if (sf === 'config-env.md' && looksLikeEnvTable(candidate.payload)) {
      if (hasProviderActivationCandidateInPool(pool)) return false;
    }
    const text = `${candidate.payload?.section ?? ''}\n${candidate.payload?.text ?? ''}`;
    const hasActivationGuideSignal =
      sf === 'providers.md' ||
      /\benable\b|\bactivate\b|увімкнути/i.test(text);
    if (!hasActivationGuideSignal) return false;
  }

  if (queryClass === 'source-navigation') {
    const section = (candidate.payload?.section ?? '').toLowerCase();
    const isStructural = sf === 'project-structure.md' ||
      section.includes('src/') || section.includes('source tree') || section.includes('exports');
    return overlap >= 1 && isStructural;
  }

  return overlap >= 2;
}

// v3 isProtected for custom-150 (delegates to isProtectedV2 for non-exact-token)
export function isProtectedV3C150(queryClass, candidate, hybridRank, pool, bestCid) {
  if (queryClass === 'exact-token') {
    if (hybridRank >= 3) return false;
    const sf  = candidate.payload?.source_file;
    const ci  = candidate.payload?.chunk_index;
    const cid = (sf != null && ci != null) ? `${sf}#${ci}` : null;
    return cid != null && cid === bestCid;
  }
  return isProtectedV2(queryClass, candidate, hybridRank, pool);
}

// ── Guard v1 (custom-50 original) ─────────────────────────────────────────────

export function applyHeuristicGuardV1(queryClass, ceRanked, hybridPool) {
  if (queryClass === 'semantic') {
    return { guarded: ceRanked.map(x => x.result), guardFired: false, protectedId: null };
  }

  const protected_ = new Set();
  for (let i = 0; i < Math.min(hybridPool.length, 3); i++) {
    const r = hybridPool[i];
    if (isProtectedV1(queryClass, r, i, hybridPool)) {
      const sf = r.payload?.source_file;
      const ci = r.payload?.chunk_index;
      if (sf != null && ci != null) protected_.add(`${sf}#${ci}`);
    }
  }

  if (!protected_.size) {
    return { guarded: ceRanked.map(x => x.result), guardFired: false, protectedId: null };
  }

  const displaced = [];
  for (let i = 3; i < ceRanked.length; i++) {
    const cid = chunkIdWrapped(ceRanked[i]);
    if (cid && protected_.has(cid)) displaced.push(i);
  }

  if (!displaced.length) {
    return { guarded: ceRanked.map(x => x.result), guardFired: false, protectedId: null };
  }

  const out = [...ceRanked];
  for (const srcIdx of displaced) {
    const entry    = out.splice(srcIdx, 1)[0];
    const insertAt = Math.min(2, out.length);
    out.splice(insertAt, 0, entry);
  }

  return {
    guarded: out.map(x => x.result),
    guardFired: true,
    protectedId: chunkIdWrapped(ceRanked[displaced[0]]) ?? null,
  };
}

// ── Guard v2 (custom-150 only) ────────────────────────────────────────────────

export function applyHeuristicGuardV2(queryClass, ceRanked, hybridPool, typeLabel) {
  const resolvedClass = queryClass === 'semantic' && typeLabel
    ? classifyQueryV2(hybridPool.__query__ ?? '', typeLabel)
    : queryClass;

  if (resolvedClass === 'semantic') {
    return { guarded: ceRanked.map(x => x.result), guardFired: false, protectedId: null, routeClass: resolvedClass };
  }

  const protectedCids = [];
  for (let i = 0; i < Math.min(hybridPool.length, 3); i++) {
    const r = hybridPool[i];
    if (isProtectedV2(resolvedClass, r, i, hybridPool)) {
      const sf = r.payload?.source_file;
      const ci = r.payload?.chunk_index;
      if (sf != null && ci != null) protectedCids.push(`${sf}#${ci}`);
    }
  }

  if (!protectedCids.length) {
    return { guarded: ceRanked.map(x => x.result), guardFired: false, protectedId: null, routeClass: resolvedClass };
  }

  const out = [...ceRanked];
  const displaced = protectedCids.filter(cid => {
    const cePos = out.findIndex(e => chunkIdWrapped(e) === cid);
    return cePos >= 3;
  });

  if (!displaced.length) {
    return { guarded: out.map(x => x.result), guardFired: false, protectedId: null, routeClass: resolvedClass };
  }

  let insertSlot = 0;
  let fired = false;
  let firstProtId = null;

  for (const cid of displaced) {
    const srcIdx = out.findIndex(e => chunkIdWrapped(e) === cid);
    if (srcIdx < 0) continue;
    while (insertSlot < 3 && protectedCids.includes(chunkIdWrapped(out[insertSlot]))) insertSlot++;
    if (insertSlot >= 3) insertSlot = 2;
    const entry = out.splice(srcIdx, 1)[0];
    out.splice(insertSlot, 0, entry);
    insertSlot++;
    fired = true;
    if (!firstProtId) firstProtId = cid;
  }

  return {
    guarded: out.map(x => x.result),
    guardFired: fired,
    protectedId: firstProtId,
    routeClass: resolvedClass,
  };
}

// ── Guard v3, custom-50 variant ────────────────────────────────────────────────
//
// Uses classifyQueryV3C50 (lighter config-env check) and isProtectedV1 for
// non-exact-token classes.

export function applyHeuristicGuardV3C50(queryClass, ceRanked, hybridPool, typeLabel) {
  if (queryClass === 'semantic' || queryClass === 'config-env') {
    return { guarded: ceRanked.map(x => x.result), guardFired: false, protectedId: null, routeClass: queryClass };
  }

  const cidOf = r => {
    const sf = (r.result ?? r).payload?.source_file;
    const ci = (r.result ?? r).payload?.chunk_index;
    return (sf != null && ci != null) ? `${sf}#${ci}` : null;
  };

  let bestCid = null;
  if (queryClass === 'exact-token') {
    const qToks = tokeniseQuery(hybridPool.__query__);
    let bestScore = -Infinity;
    for (let i = 0; i < Math.min(hybridPool.length, 3); i++) {
      const r = hybridPool[i];
      const cToks = candidateTokens(r.payload);
      const overlap = tokenOverlapCount(qToks, cToks);
      if (overlap < 2) continue;
      const score = exactTokenProtectScore(r, i, qToks);
      if (score > bestScore) { bestScore = score; bestCid = cidOf(r); }
    }
  }

  const protected_ = new Set();
  if (queryClass === 'exact-token') {
    if (bestCid) protected_.add(bestCid);
  } else {
    for (let i = 0; i < Math.min(hybridPool.length, 3); i++) {
      const r = hybridPool[i];
      if (isProtectedV1(queryClass, r, i, hybridPool)) {
        const cid = cidOf(r);
        if (cid) protected_.add(cid);
      }
    }
  }

  if (!protected_.size) {
    return { guarded: ceRanked.map(x => x.result), guardFired: false, protectedId: null, routeClass: queryClass };
  }

  const displaced = [];
  for (let i = 3; i < ceRanked.length; i++) {
    const cid = cidOf(ceRanked[i]);
    if (cid && protected_.has(cid)) displaced.push(i);
  }

  if (!displaced.length) {
    return { guarded: ceRanked.map(x => x.result), guardFired: false, protectedId: null, routeClass: queryClass };
  }

  const out = [...ceRanked];
  for (const srcIdx of displaced) {
    const entry    = out.splice(srcIdx, 1)[0];
    const insertAt = Math.min(2, out.length);
    out.splice(insertAt, 0, entry);
  }

  return {
    guarded: out.map(x => x.result),
    guardFired: true,
    protectedId: cidOf(ceRanked[displaced[0]]) ?? null,
    routeClass: queryClass,
  };
}

// ── Guard v3, custom-150 variant ──────────────────────────────────────────────
//
// Uses classifyQueryV3C150 (full CONFIG_ENV_TOKENS set) and isProtectedV2 for
// non-exact-token classes.

export function applyHeuristicGuardV3C150(queryClass, ceRanked, hybridPool, typeLabel) {
  const resolvedClass = classifyQueryV3C150(hybridPool.__query__ ?? '', typeLabel);

  if (resolvedClass === 'semantic') {
    return { guarded: ceRanked.map(x => x.result), guardFired: false, protectedId: null, routeClass: resolvedClass };
  }

  const qToks = tokeniseQuery(hybridPool.__query__ ?? '');

  let bestExactCid = null;
  if (resolvedClass === 'exact-token') {
    let bestScore = -Infinity;
    for (let i = 0; i < Math.min(hybridPool.length, 3); i++) {
      const r      = hybridPool[i];
      const cToks  = candidateTokens(r.payload);
      const overlap = tokenOverlapCount(qToks, cToks);
      if (overlap < 2) continue;
      const score  = exactTokenProtectScore(r, i, qToks);
      if (score > bestScore) {
        bestScore    = score;
        const sf     = r.payload?.source_file;
        const ci     = r.payload?.chunk_index;
        bestExactCid = (sf != null && ci != null) ? `${sf}#${ci}` : null;
      }
    }
  }

  const protectedCids = [];
  for (let i = 0; i < Math.min(hybridPool.length, 3); i++) {
    const r = hybridPool[i];
    if (isProtectedV3C150(resolvedClass, r, i, hybridPool, bestExactCid)) {
      const sf = r.payload?.source_file;
      const ci = r.payload?.chunk_index;
      if (sf != null && ci != null) protectedCids.push(`${sf}#${ci}`);
    }
  }

  if (!protectedCids.length) {
    return { guarded: ceRanked.map(x => x.result), guardFired: false, protectedId: null, routeClass: resolvedClass };
  }

  const out = [...ceRanked];
  const displaced = protectedCids.filter(cid => {
    const cePos = out.findIndex(e => chunkIdWrapped(e) === cid);
    return cePos >= 3;
  });

  if (!displaced.length) {
    return { guarded: out.map(x => x.result), guardFired: false, protectedId: null, routeClass: resolvedClass };
  }

  let insertSlot = 0;
  let fired = false;
  let firstProtId = null;

  for (const cid of displaced) {
    const srcIdx = out.findIndex(e => chunkIdWrapped(e) === cid);
    if (srcIdx < 0) continue;
    while (insertSlot < 3 && protectedCids.includes(chunkIdWrapped(out[insertSlot]))) insertSlot++;
    if (insertSlot >= 3) insertSlot = 2;
    const entry = out.splice(srcIdx, 1)[0];
    out.splice(insertSlot, 0, entry);
    insertSlot++;
    fired = true;
    if (!firstProtId) firstProtId = cid;
  }

  return {
    guarded: out.map(x => x.result),
    guardFired: fired,
    protectedId: firstProtId,
    routeClass: resolvedClass,
  };
}

// ── Guard v4 (shared — works with both v3C50 and v3C150 as base) ──────────────
//
// For provider-activation queries: if a providers.md activation-guide candidate
// was at hybrid rank 0 or 1 (top-2) but landed at exactly CE index 2 (rank #3)
// in the v3 output, lift it to index 1 (rank #2).
//
// Limitation: only fires when ceIdx === 2. If CE pushes the candidate to index 3+,
// v4 does not rescue it.

export function isProviderActivationGuideCandidate(candidate) {
  const sf   = candidate.payload?.source_file ?? '';
  const text = `${candidate.payload?.section ?? ''}\n${candidate.payload?.text ?? ''}`;
  return sf === 'providers.md' && /\benable\b|\bactivate\b|увімкнути/i.test(text);
}

function applyV4Lift(v3Result, hybridPool) {
  // provider-activation top-2 preservation: only applies to provider-activation route.
  if (v3Result.routeClass !== 'provider-activation') return v3Result;

  const top2Cids = new Set();
  for (let i = 0; i < Math.min(hybridPool.length, 2); i++) {
    const r = hybridPool[i];
    if (isProviderActivationGuideCandidate(r)) {
      const cid = chunkId(r);
      if (cid) top2Cids.add(cid);
    }
  }
  if (!top2Cids.size) return v3Result;

  const out = v3Result.guarded.map(r => r);
  let fired = v3Result.guardFired;
  let protId = v3Result.protectedId;

  for (const cid of top2Cids) {
    const ceIdx = out.findIndex(r => chunkId(r) === cid);
    if (ceIdx === 2) {
      const [entry] = out.splice(ceIdx, 1);
      out.splice(1, 0, entry);
      fired = true;
      protId = protId ?? cid;
    }
  }

  return {
    guarded: out,
    guardFired: fired,
    protectedId: protId,
    routeClass: v3Result.routeClass,
  };
}

export function applyHeuristicGuardV4C50(queryClass, ceRanked, hybridPool, typeLabel) {
  const v3Result = applyHeuristicGuardV3C50(queryClass, ceRanked, hybridPool, typeLabel);
  return applyV4Lift(v3Result, hybridPool);
}

export function applyHeuristicGuardV4C150(queryClass, ceRanked, hybridPool, typeLabel) {
  const v3Result = applyHeuristicGuardV3C150(queryClass, ceRanked, hybridPool, typeLabel);
  return applyV4Lift(v3Result, hybridPool);
}

// ── Oracle guard (shared) ─────────────────────────────────────────────────────
//
// Pure CE order as base; promotes any qrel rel>=3 chunk from hybrid top-3 into
// position 3 if CE placed it lower. Not a global upper bound.

export function applyOracleGuard(ceRanked, hybridPool, qrels) {
  const ceBase = ceRanked.map(x => x.result ?? x);

  if (!qrels.size) return { guarded: ceBase, guardFired: false, protectedId: null };

  const protected_ = new Set();
  for (let i = 0; i < Math.min(hybridPool.length, 3); i++) {
    const cid = chunkId(hybridPool[i]);
    if (cid && (qrels.get(cid) ?? 0) >= 3) protected_.add(cid);
  }

  if (!protected_.size) return { guarded: ceBase, guardFired: false, protectedId: null };

  const out = ceBase.map(r => ({ result: r }));
  let fired = false, protId = null;

  for (let i = 3; i < out.length; i++) {
    const cid = chunkId(out[i].result);
    if (cid && protected_.has(cid)) {
      const entry = out.splice(i, 1)[0];
      out.splice(Math.min(2, out.length), 0, entry);
      fired  = true;
      protId = protId ?? cid;
      i--;
    }
  }

  return { guarded: out.map(x => x.result), guardFired: fired, protectedId: protId };
}
