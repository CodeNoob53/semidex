// Shared metric helpers for CE routing benchmarks.

function resultChunkId(r) {
  const sf = r.payload?.source_file;
  const ci = r.payload?.chunk_index;
  return (sf != null && ci != null) ? `${sf}#${ci}` : null;
}

function parseChunkId(id) {
  if (!id) return null;
  const h = id.lastIndexOf('#');
  if (h < 0) return null;
  const sourceFile  = id.slice(0, h);
  const chunkIndex  = parseInt(id.slice(h + 1), 10);
  return (sourceFile && Number.isFinite(chunkIndex)) ? { sourceFile, chunkIndex } : null;
}

export function buildQrels(relevantChunks) {
  const m = new Map();
  for (const rc of (relevantChunks ?? [])) m.set(rc.chunkId, rc.relevance ?? 3);
  return m;
}

export function tokenise(str) { return (str ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []; }

export function chunkRecallHit(results, qrels, k, minRel = 3) {
  if (!qrels.size) return null;
  const rel = new Set([...qrels.entries()].filter(([, r]) => r >= minRel).map(([id]) => id));
  if (!rel.size) return null;
  return results.slice(0, k).some(r => rel.has(resultChunkId(r)));
}

export function windowRecallHit(results, qrels, k, window) {
  if (!qrels.size) return null;
  const exactIds = [...qrels.entries()].filter(([, r]) => r >= 3).map(([id]) => id);
  if (!exactIds.length) return null;
  const topK = results.slice(0, k);
  if (topK.some(r => qrels.get(resultChunkId(r)) >= 3)) return true;
  for (const eid of exactIds) {
    const ep = parseChunkId(eid);
    if (!ep) continue;
    if (topK.some(r => {
      const rp = parseChunkId(resultChunkId(r));
      return rp && rp.sourceFile === ep.sourceFile && Math.abs(rp.chunkIndex - ep.chunkIndex) <= window;
    })) return true;
  }
  return false;
}

export function gradedNDCG(results, qrels, k) {
  if (!qrels.size) return null;
  const topK = results.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    const rel = qrels.get(resultChunkId(topK[i])) ?? 0;
    dcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }
  const gains = [...qrels.values()].map(r => Math.pow(2, r) - 1).sort((a, b) => b - a);
  let idcg = 0;
  for (let i = 0; i < Math.min(gains.length, k); i++) idcg += gains[i] / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

export function mrrAt(results, qrels, k) {
  if (!qrels.size) return null;
  const rel = new Set([...qrels.entries()].filter(([, r]) => r >= 3).map(([id]) => id));
  if (!rel.size) return null;
  for (let i = 0; i < Math.min(results.length, k); i++) {
    if (rel.has(resultChunkId(results[i]))) return 1 / (i + 1);
  }
  return 0;
}

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * p / 100) - 1)];
}

export function bestExactRank(results, qrels) {
  for (let i = 0; i < results.length; i++) {
    if ((qrels.get(resultChunkId(results[i])) ?? 0) >= 3) return i + 1;
  }
  return null;
}

export function supportRecallHit(results, qrels, k) {
  return chunkRecallHit(results, qrels, k, 2);
}

export { resultChunkId };

// ── Shared aggregate helpers ──────────────────────────────────────────────────

export function isModeRegression(r, mode) {
  const h = bestExactRank(r.byMode['hybrid-true'], r.query.qrels);
  const m = bestExactRank(r.byMode[mode],          r.query.qrels);
  return h != null && h <= 3 && (m == null || m > 3);
}

// computeRoutingMetrics — aggregate metrics for all modes.
// options: { topK, window, latencyFn?, includeFileRecall?, fileRecallFn? }
//   latencyFn(queryResult, mode) -> number (ms) — default: hybrid=hybridTrueMs, det=prefetch+det, ce=prefetch+ce
//   fileRecallFn(results, query) -> bool|null — required if includeFileRecall=true
export function computeRoutingMetrics(queryResults, modes, { topK, window: win, latencyFn, includeFileRecall = false, fileRecallFn } = {}) {
  const out = {};
  for (const mode of modes) {
    let cr3=0, cr5=0, cr10=0, wr5=0, wr10=0, supp10=0, ndcgSum=0, mrrSum=0, mrrCount=0;
    let rank1Exact=0, negPass=0, fRecall1=0, fRecall1Count=0;
    const positives   = queryResults.filter(r => !r.query.shouldHaveNoStrongHit);
    const negatives   = queryResults.filter(r =>  r.query.shouldHaveNoStrongHit);
    const hasExact    = positives.filter(r => [...r.query.qrels.values()].some(v => v >= 3)).length;
    const hasAnyQrels = positives.filter(r => r.query.qrels.size > 0).length;

    const defaultLatency = (r, m) => {
      if (m === 'hybrid-true') return r.hybridTrueMs;
      if (m === 'det-rerank')  return r.prefetchMs + r.detRerankMs;
      return r.prefetchMs + r.crossEncoderMs;
    };
    const getLat = latencyFn ?? defaultLatency;
    const lats = queryResults.map(r => getLat(r, mode)).filter(Number.isFinite).sort((a, b) => a - b);

    for (const r of positives) {
      const results = r.byMode[mode];
      const { qrels } = r.query;
      const cr3h  = chunkRecallHit(results, qrels, 3);
      const cr5h  = chunkRecallHit(results, qrels, 5);
      const cr10h = chunkRecallHit(results, qrels, topK);
      const wr5h  = windowRecallHit(results, qrels, 5, win);
      const wr10h = windowRecallHit(results, qrels, topK, win);
      const suppH = chunkRecallHit(results, qrels, topK, 2);
      const ndcgV = gradedNDCG(results, qrels, topK);
      const mrrV  = mrrAt(results, qrels, 10);
      if (cr3h  !== null) cr3    += cr3h  ? 1 : 0;
      if (cr5h  !== null) cr5    += cr5h  ? 1 : 0;
      if (cr10h !== null) cr10   += cr10h ? 1 : 0;
      if (wr5h  !== null) wr5    += wr5h  ? 1 : 0;
      if (wr10h !== null) wr10   += wr10h ? 1 : 0;
      if (suppH !== null) supp10 += suppH ? 1 : 0;
      if (ndcgV !== null) ndcgSum += ndcgV;
      if (mrrV  !== null) { mrrSum += mrrV; mrrCount++; }
      if (qrels.size && [...qrels.values()].some(v => v >= 3)) {
        if ((qrels.get(resultChunkId(results[0])) ?? 0) >= 3) rank1Exact++;
      }
      if (includeFileRecall && fileRecallFn) {
        const fh = fileRecallFn(results, r.query);
        if (fh !== null) { fRecall1Count++; if (fh) fRecall1++; }
      }
    }

    for (const r of negatives) {
      const results   = r.byMode[mode];
      const top1Words = new Set([
        ...tokenise(results[0]?.payload?.text    ?? ''),
        ...tokenise(results[0]?.payload?.section ?? ''),
      ]);
      const strongHit = (r.query.expectedTokens ?? []).some(t => top1Words.has(t));
      if (!strongHit) negPass++;
    }

    const m = {
      rank1Exact,
      chunkRecall3:    hasExact    > 0 ? cr3    / hasExact    : null,
      chunkRecall5:    hasExact    > 0 ? cr5    / hasExact    : null,
      chunkRecall10:   hasExact    > 0 ? cr10   / hasExact    : null,
      windowRecall5:   hasExact    > 0 ? wr5    / hasExact    : null,
      windowRecall10:  hasExact    > 0 ? wr10   / hasExact    : null,
      supportRecall10: hasAnyQrels > 0 ? supp10 / hasAnyQrels : null,
      ndcgK:           hasAnyQrels > 0 ? ndcgSum / hasAnyQrels : null,
      mrr10:           mrrCount    > 0 ? mrrSum  / mrrCount   : null,
      negativePass:    negatives.length > 0 ? negPass / negatives.length : null,
      p50: percentile(lats, 50),
      p95: percentile(lats, 95),
    };
    if (includeFileRecall) m.fileRecall1 = fRecall1Count > 0 ? fRecall1 / fRecall1Count : null;
    out[mode] = m;
  }
  return out;
}

// buildRoutingAnalysis — per-query regression/improvement rows.
// options: {
//   modes,
//   watchedIds?:   Set<string> — query IDs to flag as watched
//   watchedTypes?: Set<string> — query types to flag as watched
//   regrModes?:    string[]    — modes to compute isRegrByMode (default: all non-hybrid modes)
//   improvModes?:  string[]    — modes to compute isImprovByMode
//   sortKey?:      function(row) -> comparable   — default: sort regressions first
// }
export function buildRoutingAnalysis(queryResults, modes, {
  watchedIds   = new Set(),
  watchedTypes = new Set(),
  regrModes,
  improvModes,
} = {}) {
  const evalModes   = regrModes  ?? modes.filter(m => m !== 'hybrid-true');
  const evalImprovs = improvModes ?? modes.filter(m => m !== 'hybrid-true');
  const rows = [];

  for (const r of queryResults) {
    if (r.query.shouldHaveNoStrongHit) continue;
    const { qrels } = r.query;

    const ranks = {};
    for (const mode of modes) ranks[mode] = bestExactRank(r.byMode[mode], qrels);

    const top1ByMode = {};
    for (const mode of modes) {
      const top = r.byMode[mode][0];
      top1ByMode[mode] = top ? resultChunkId(top) : null;
    }

    const hybridRank = ranks['hybrid-true'];

    const isRegrByMode = {};
    for (const mode of evalModes) {
      const rank = ranks[mode];
      isRegrByMode[mode] = hybridRank != null && hybridRank <= 3 && (rank == null || rank > 3);
    }

    const isImprovByMode = {};
    for (const mode of evalImprovs) {
      isImprovByMode[mode] = (hybridRank == null || hybridRank > 1) && ranks[mode] === 1;
    }

    rows.push({
      query: r.query, ranks, top1ByMode,
      isRegrByMode, isImprovByMode,
      isWatched: watchedIds.has(r.query.id) || watchedTypes.has(r.query.type),
      qrels,
      // Pass through all guard/class fields from queryResult for entrypoint use.
      _src: r,
    });
  }

  return rows;
}

// computePerClassRows — structured per-class metric rows (no formatting).
// options: { modes, topK, guardFiredFn? }
//   guardFiredFn(queryResult, mode) -> bool — whether guard fired for this query in this mode
// Returns: Map<mode, Array<{ type, count, posCount, negCount, mrr10, rank1, chunkRecall5, regressions, guards, negativePass }>>
export function computePerClassRows(queryResults, analysis, modes, { topK, guardFiredFn } = {}) {
  const byType = new Map();
  for (const r of queryResults) {
    const t = r.query.type ?? '(missing)';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(r);
  }
  const sorted = [...byType.entries()].sort((a, b) => b[1].length - a[1].length);

  const result = new Map();
  for (const mode of modes) {
    const showRegr = mode !== 'hybrid-true';
    const rows = [];
    for (const [type, typeQRs] of sorted) {
      const neg = typeQRs.filter(r =>  r.query.shouldHaveNoStrongHit);
      const pos = typeQRs.filter(r => !r.query.shouldHaveNoStrongHit);

      let mrrSum = 0, mrrCount = 0, rank1 = 0, cr5 = 0, cr5Count = 0, regrCount = 0;
      for (const r of pos) {
        const results = r.byMode[mode];
        const mrrV = mrrAt(results, r.query.qrels, 10);
        const cr5h = chunkRecallHit(results, r.query.qrels, 5);
        if (mrrV !== null) { mrrSum += mrrV; mrrCount++; }
        if (cr5h !== null) { cr5 += cr5h ? 1 : 0; cr5Count++; }
        if (results.length && (r.query.qrels.get(resultChunkId(results[0])) ?? 0) >= 3) rank1++;
        if (showRegr && isModeRegression(r, mode)) regrCount++;
      }

      const qIds = new Set(typeQRs.map(r => r.query.id));
      const guards = (guardFiredFn && pos.length)
        ? analysis.filter(a => qIds.has(a.query.id) && guardFiredFn(a._src, mode)).length
        : null;

      let negativePass = null;
      if (neg.length > 0) {
        let pass = 0;
        for (const r of neg) {
          const results   = r.byMode[mode];
          const top1Words = new Set([
            ...tokenise(results?.[0]?.payload?.text    ?? ''),
            ...tokenise(results?.[0]?.payload?.section ?? ''),
          ]);
          if (!(r.query.expectedTokens ?? []).some(t => top1Words.has(t))) pass++;
        }
        negativePass = pass / neg.length;
      }

      rows.push({
        type,
        count:        typeQRs.length,
        posCount:     pos.length,
        negCount:     neg.length,
        mrr10:        mrrCount > 0 ? mrrSum / mrrCount : null,
        rank1,
        chunkRecall5: cr5Count > 0 ? cr5 / cr5Count : null,
        regressions:  showRegr && pos.length ? regrCount : null,
        guards,
        negativePass,
      });
    }
    result.set(mode, rows);
  }
  return result;
}
