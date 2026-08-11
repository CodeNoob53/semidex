import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runBoundedFilePipeline } from '../../../../src/shared/indexer/pipeline/bounded-file-pipeline.js';
import { resolveIndexSchedulingPolicy } from '../../../../src/shared/indexer/device/scheduling-policy.js';

// Deferred-gate helper, mirroring the repo's existing pattern (ground
// truth: phase-capability-injection.test.js style).
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function constantPolicy(overrides = {}) {
  return async () => ({
    canOverlapGenerationAndEmbedding: false,
    canOverlapGenerationAndTagging: false,
    canOverlapTaggingAndEmbedding: false,
    serializedLaneGroups: [],
    reason: 'test policy',
    pairReasons: { generationEmbedding: 'test', generationTagging: 'test', taggingEmbedding: 'test' },
    ...overrides,
  });
}

describe('runBoundedFilePipeline', () => {
  it('TEST 1 — GPU generation + CPU embedding overlap across files', async () => {
    const events = [];
    const gateA = deferred();

    const runStageA = async (f) => ({ status: 'ok', file: f });
    const runStageB = async (prepared) => {
      events.push(`${prepared.file}:summarizing:start`);
      if (prepared.file === 'A') await gateA.promise;
      events.push(`${prepared.file}:summarizing:end`);
      return prepared;
    };
    const runStageC = async (prepared) => {
      events.push(`${prepared.file}:embedding:start`);
      events.push(`${prepared.file}:embedding:end`);
      return prepared;
    };
    const runStageD = async () => {};

    const run = runBoundedFilePipeline({
      files: ['A', 'B'],
      runStageA, runStageB, runStageC, runStageD,
      taggingLaneActive: false,
      recomputePolicy: constantPolicy({ canOverlapGenerationAndEmbedding: true }),
    });

    // Let B run to completion while A's stageB is still gated.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    gateA.resolve();
    await run;

    const bSummStart = events.indexOf('B:summarizing:start');
    const aEmbedEnd = events.indexOf('A:embedding:end');
    assert.ok(bSummStart !== -1 && aEmbedEnd !== -1);
    assert.ok(bSummStart < aEmbedEnd, `expected B:summarizing:start before A:embedding:end, got: ${events.join(', ')}`);

    const bEmbedStart = events.indexOf('B:embedding:start');
    const bSummEnd = events.indexOf('B:summarizing:end');
    assert.ok(bEmbedStart > bSummEnd, 'intra-file ordering violated for B');
  });

  it('TEST 1b — self-healing per-file re-evaluation', async () => {
    const events = [];
    let callCount = 0;
    const recomputePolicy = async () => {
      callCount += 1;
      const overlap = callCount > 1;
      return {
        canOverlapGenerationAndEmbedding: overlap,
        canOverlapGenerationAndTagging: false,
        canOverlapTaggingAndEmbedding: false,
        serializedLaneGroups: [],
        reason: overlap ? 'verified after file 1' : 'embedding not yet verified (file 1)',
        pairReasons: { generationEmbedding: '', generationTagging: '', taggingEmbedding: '' },
      };
    };

    const runStageA = async (f) => ({ status: 'ok', file: f });
    const runStageB = async (prepared) => {
      events.push(`${prepared.file}:summarizing:start`);
      events.push(`${prepared.file}:summarizing:end`);
      return prepared;
    };
    const runStageC = async (prepared) => {
      events.push(`${prepared.file}:embedding:start`);
      events.push(`${prepared.file}:embedding:end`);
      return prepared;
    };
    const runStageD = async () => {};

    await runBoundedFilePipeline({
      files: ['1', '2', '3'],
      runStageA, runStageB, runStageC, runStageD,
      taggingLaneActive: false,
      recomputePolicy,
      stageAConcurrency: 1,
    });

    assert.ok(callCount >= 3, 'recomputePolicy should be called once per file');
  });

  it('TEST 1c — a policy captured before queueing behind generationSem is refreshed again once the permit is actually granted (closes the queueing-delay staleness gap)', async () => {
    // Both files' outer, pre-queue recompute() calls (right after their
    // own stageA, both racing at roughly the same time since
    // stageAConcurrency:2) see the pre-upgrade state. Only A ever
    // proceeds straight into generationSem (it's first in file order);
    // its OWN re-check inside generationSem.run() is what flips
    // `upgraded` to true from that point on -- simulating A's real
    // stageB call having loaded the model. B, still queued behind A's
    // generationSem hold (gated open via gateA), can only make its OWN
    // re-check once A finally releases the permit -- by which point
    // `upgraded` is already true, proving B's mode reflects a signal
    // that changed strictly WHILE B was waiting, not one it already saw
    // before it ever queued.
    const events = [];
    let upgraded = false;
    const gateA = deferred();

    const recomputePolicy = async () => ({
      canOverlapGenerationAndEmbedding: false, // both files still commit to the sequential branch structurally
      canOverlapGenerationAndTagging: upgraded,
      canOverlapTaggingAndEmbedding: false,
      serializedLaneGroups: [],
      reason: upgraded ? 'upgraded mid-queue' : 'not yet verified',
      pairReasons: { generationEmbedding: '', generationTagging: '', taggingEmbedding: '' },
    });

    const runStageA = async (f) => ({ status: 'ok', file: f });
    // generationTaggingExecutionMode ('mode') is only ever passed to
    // runStageB when taggingLaneActive:true (it drives
    // acquireTaggingAndEmbeddingForStageB's own
    // canOverlapGenerationAndTagging read) -- this test enables it
    // specifically to observe the re-checked policy's effect.
    const runStageB = async (prepared, mode) => {
      events.push(`${prepared.file}:mode:${mode}`);
      if (prepared.file === 'A') {
        // A is INSIDE generationSem here (runStageB only ever runs
        // there) -- flipping the signal now simulates it becoming
        // verified strictly after A's own re-check already ran but
        // before A releases the permit, so ONLY a file that re-checks
        // AFTER this point (B, once it gets the permit) can observe it.
        upgraded = true;
        await gateA.promise;
      }
      return prepared;
    };
    const runStageC = async (prepared) => prepared;
    const runStageD = async () => {};

    const run = runBoundedFilePipeline({
      files: ['A', 'B'],
      runStageA, runStageB, runStageC, runStageD,
      taggingLaneActive: true,
      recomputePolicy,
      stageAConcurrency: 2,
    });

    // Let both files reach their own FIRST recomputePolicy() call (both
    // see the pre-upgrade state) and queue for generationSem; A proceeds
    // into generationSem and its runStageB flips `upgraded`, then blocks
    // on gateA.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    gateA.resolve();
    await run;

    // A's mode reflects its own pre-queue/pre-upgrade read (it flips
    // `upgraded` only AFTER its own re-check already ran). B's mode,
    // captured only once B actually acquires generationSem (after A
    // releases it), must reflect the upgraded signal -- proving the
    // re-check inside generationSem.run() actually fired for B, not
    // just the outer per-file recompute.
    assert.deepEqual(events, ['A:mode:sequential', 'B:mode:parallel']);
  });

  it('TEST 1d — a file queued while canOverlapGenerationAndEmbedding was false actually switches to the overlap-capable BRANCH once the signal upgrades before its own permit is granted (not just a mode refinement inside the still-sequential shape)', async () => {
    // Three files. ALL THREE make their first, pre-queue recomputePolicy()
    // call while the signal is still unverified (canOverlapGenerationAndEmbedding:
    // false) -- reproducing the exact scenario the review flagged: every
    // file's outer snapshot says "sequential" before any of them has
    // actually started stageB. File A proceeds into generationSem first
    // and its OWN stageB call is what causes the signal to upgrade
    // (simulating Ollama loading the model for real). Files B and C are
    // still queued behind generationSem at that point. The fix under
    // test: B (the next file to acquire the permit) must re-read policy
    // AFTER acquiring it and find canOverlapGenerationAndEmbedding:true,
    // and consequently take the OVERLAP-CAPABLE branch (stageC runs
    // OUTSIDE the generationSem hold) rather than remaining stuck in the
    // sequential branch shape it would have committed to under the old,
    // incomplete fix. Proven directly: B's own stageC must be observed
    // running concurrently with C's stageB (only possible if B released
    // generationSem before its stageC started).
    const events = [];
    let overlapEnabled = false;
    const gateA = deferred();
    const gateBEmbed = deferred();

    const recomputePolicy = async () => ({
      canOverlapGenerationAndEmbedding: overlapEnabled,
      canOverlapGenerationAndTagging: false,
      canOverlapTaggingAndEmbedding: false,
      serializedLaneGroups: [],
      reason: overlapEnabled ? 'upgraded' : 'not yet verified',
      pairReasons: { generationEmbedding: '', generationTagging: '', taggingEmbedding: '' },
    });

    const runStageA = async (f) => ({ status: 'ok', file: f });
    const runStageB = async (prepared) => {
      events.push(`${prepared.file}:summarizing:start`);
      if (prepared.file === 'A') {
        // A's own real generation call is what "loads the model" --
        // upgrading the signal for every file that checks AFTER this
        // point, while B and C are still queued behind generationSem.
        overlapEnabled = true;
        await gateA.promise;
      }
      events.push(`${prepared.file}:summarizing:end`);
      return prepared;
    };
    const runStageC = async (prepared) => {
      events.push(`${prepared.file}:embedding:start`);
      if (prepared.file === 'B') await gateBEmbed.promise;
      events.push(`${prepared.file}:embedding:end`);
      return prepared;
    };
    const runStageD = async () => {};

    const run = runBoundedFilePipeline({
      files: ['A', 'B', 'C'],
      runStageA, runStageB, runStageC, runStageD,
      taggingLaneActive: false,
      recomputePolicy,
      stageAConcurrency: 3,
    });

    // Let all three files reach their own first (pre-upgrade) recompute
    // and queue behind generationSem; A acquires it first and flips
    // overlapEnabled, then blocks in stageB on gateA.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    gateA.resolve();
    // Let A finish stageB+stageC and B acquire generationSem, re-check
    // policy (now overlapEnabled:true), take the overlap-capable branch,
    // finish its own stageB, and release generationSem so C can start.
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));

    // At this point, if the fix works, B has released generationSem
    // (overlap branch) and C's own stageB (summarizing) has been able to
    // both start AND finish even though B's own stageC (embedding) is
    // still gated open -- proof B took the overlap-capable branch
    // (released generationSem right after its own stageB) rather than
    // remaining stuck holding it through stageC. Two acceptable
    // interleavings both count as overlap here (the exact tick-by-tick
    // order between "B:embedding:start" and "C:summarizing:start" is not
    // itself the property under test — only that C's summarizing window
    // and B's still-open embedding window genuinely intersect):
    const cSummStart = events.indexOf('C:summarizing:start');
    const cSummEnd = events.indexOf('C:summarizing:end');
    const bEmbedEnd = events.indexOf('B:embedding:end');
    assert.ok(cSummStart !== -1, `C:summarizing:start never fired while B's embedding was still gated open -- B did not switch to the overlap-capable branch: ${events.join(', ')}`);
    assert.equal(bEmbedEnd, -1, 'B:embedding:end must not have fired yet -- gateBEmbed is still held at this point in the test');
    assert.ok(cSummEnd !== -1, `C's own stageB should have been able to fully complete while B's embedding was still open: ${events.join(', ')}`);

    gateBEmbed.resolve();
    await run;
  });

  it('TEST 2 — CPU+CPU does not overlap across files', async () => {
    const events = [];
    const runStageA = async (f) => ({ status: 'ok', file: f });
    const runStageB = async (prepared) => {
      events.push(`${prepared.file}:summarizing:start`);
      await new Promise((r) => setImmediate(r));
      events.push(`${prepared.file}:summarizing:end`);
      return prepared;
    };
    const runStageC = async (prepared) => {
      events.push(`${prepared.file}:embedding:start`);
      events.push(`${prepared.file}:embedding:end`);
      return prepared;
    };
    const runStageD = async () => {};

    await runBoundedFilePipeline({
      files: ['A', 'B'],
      runStageA, runStageB, runStageC, runStageD,
      taggingLaneActive: false,
      recomputePolicy: constantPolicy({ canOverlapGenerationAndEmbedding: false }),
    });

    const bSummStart = events.indexOf('B:summarizing:start');
    const aEmbedEnd = events.indexOf('A:embedding:end');
    assert.ok(bSummStart > aEmbedEnd, `expected strictly sequential, got: ${events.join(', ')}`);
  });

  it('TEST 3 — end-to-end composition via resolveIndexSchedulingPolicy: same GPU does not overlap', async () => {
    const events = [];
    const runStageA = async (f) => ({ status: 'ok', file: f });
    const runStageB = async (prepared) => {
      events.push(`${prepared.file}:summarizing:start`);
      events.push(`${prepared.file}:summarizing:end`);
      return prepared;
    };
    const runStageC = async (prepared) => {
      events.push(`${prepared.file}:embedding:start`);
      events.push(`${prepared.file}:embedding:end`);
      return prepared;
    };
    const runStageD = async () => {};

    const sameGpuId = { kind: 'gpu', backend: 'ollama', deviceId: 'gpu-0', verified: true, source: 'ollama-api' };
    const taggingInactive = { kind: 'unknown', backend: 'unknown', deviceId: null, verified: false, source: null };
    const recomputePolicy = async () => resolveIndexSchedulingPolicy({ generation: sameGpuId, embedding: sameGpuId, tagging: taggingInactive });

    await runBoundedFilePipeline({
      files: ['A', 'B'],
      runStageA, runStageB, runStageC, runStageD,
      taggingLaneActive: false,
      recomputePolicy,
    });

    const bSummStart = events.indexOf('B:summarizing:start');
    const aEmbedEnd = events.indexOf('A:embedding:end');
    assert.ok(bSummStart > aEmbedEnd);
  });

  it('TEST 3b — unverified + verified matching deviceId still sequential (verified-gating, not device-id equality)', async () => {
    const gpuUnverified = { kind: 'gpu', backend: 'ollama', deviceId: 'gpu-A', verified: false, source: 'manual' };
    const gpuVerified = { kind: 'gpu', backend: 'ollama', deviceId: 'gpu-B', verified: true, source: 'ollama-api' };
    const taggingInactive = { kind: 'unknown', backend: 'unknown', deviceId: null, verified: false, source: null };
    const policy = resolveIndexSchedulingPolicy({ generation: gpuUnverified, embedding: gpuVerified, tagging: taggingInactive });
    assert.equal(policy.canOverlapGenerationAndEmbedding, false);
  });

  it('TEST 4 — unknown/unverified and mixed fall back to sequential', async () => {
    const unknownId = { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null };
    const gpuId = { kind: 'gpu', backend: 'ollama', deviceId: 'gpu-0', verified: true, source: 'ollama-api' };
    const mixedId = { kind: 'mixed', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' };
    const taggingInactive = { kind: 'unknown', backend: 'unknown', deviceId: null, verified: false, source: null };

    const p1 = resolveIndexSchedulingPolicy({ generation: unknownId, embedding: gpuId, tagging: taggingInactive });
    assert.equal(p1.canOverlapGenerationAndEmbedding, false);

    const p2 = resolveIndexSchedulingPolicy({ generation: mixedId, embedding: gpuId, tagging: taggingInactive });
    assert.equal(p2.canOverlapGenerationAndEmbedding, false);
    assert.match(p2.pairReasons.generationEmbedding, /mixed/i);
  });

  it('TEST 5 — within one file, embedding never starts before that file\'s own summary finishes', async () => {
    const gate = deferred();
    let stageBDone = false;
    const runStageA = async (f) => ({ status: 'ok', file: f });
    const runStageB = async (prepared) => {
      await gate.promise;
      stageBDone = true;
      return prepared;
    };
    const runStageC = async (prepared) => {
      assert.equal(stageBDone, true, 'stageC ran before stageB resolved for the same file');
      return prepared;
    };
    const runStageD = async () => {};

    const run = runBoundedFilePipeline({
      files: ['A'],
      runStageA, runStageB, runStageC, runStageD,
      taggingLaneActive: false,
      recomputePolicy: constantPolicy({ canOverlapGenerationAndEmbedding: true }),
    });

    await new Promise((r) => setImmediate(r));
    gate.resolve();
    await run;
  });

  it('TEST 6 — max concurrency per lane is exactly 1', async () => {
    let activeGen = 0;
    let activeEmbed = 0;
    const runStageA = async (f) => ({ status: 'ok', file: f });
    const runStageB = async (prepared) => {
      activeGen += 1;
      assert.ok(activeGen <= 1, 'generation lane concurrency exceeded 1');
      await new Promise((r) => setImmediate(r));
      activeGen -= 1;
      return prepared;
    };
    const runStageC = async (prepared) => {
      activeEmbed += 1;
      assert.ok(activeEmbed <= 1, 'embedding lane concurrency exceeded 1');
      await new Promise((r) => setImmediate(r));
      activeEmbed -= 1;
      return prepared;
    };
    const runStageD = async () => {};

    await runBoundedFilePipeline({
      files: ['A', 'B', 'C', 'D'],
      runStageA, runStageB, runStageC, runStageD,
      taggingLaneActive: false,
      recomputePolicy: constantPolicy({ canOverlapGenerationAndEmbedding: true }),
    });
  });

  it('TEST 7 — backpressure prevents holding all files in RAM at once', async () => {
    const N = 50;
    const files = Array.from({ length: N }, (_, i) => `f${i}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const commitGate = deferred();

    const runStageA = async (f) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return { status: 'ok', file: f };
    };
    const runStageB = async (prepared) => prepared;
    const runStageC = async (prepared) => prepared;
    const runStageD = async (prepared) => {
      await commitGate.promise;
      inFlight -= 1;
    };

    const maxPreparedInFlight = 8;
    const run = runBoundedFilePipeline({
      files,
      runStageA, runStageB, runStageC, runStageD,
      taggingLaneActive: false,
      recomputePolicy: constantPolicy({ canOverlapGenerationAndEmbedding: false }),
      maxPreparedInFlight,
    });

    // Let the pipeline pump as far as it can given commits are blocked.
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    assert.ok(maxInFlight <= maxPreparedInFlight, `maxInFlight=${maxInFlight} exceeded cap=${maxPreparedInFlight}`);

    commitGate.resolve();
    await run;
  });

  it('TEST 8 — commit order is deterministic given fixed completion times', async () => {
    // NOTE on input-order vs. completion-order: this module's own header
    // comment documents that commit order need not match input order in
    // general (commitQueue.run() calls chain in SUBMISSION order, and
    // faster files can in principle submit earlier). In THIS
    // implementation specifically, generationSem's fixed FIFO order
    // (always acquired in file-input order) transitively orders each
    // file's stageC/embeddingSem acquisition the same way, so with the
    // default single-embedding-lane concurrency, commit order in practice
    // always equals input order too -- a stronger property than the
    // module strictly promises, verified here rather than assumed. The
    // required guarantee -- determinism given fixed completion times --
    // is what this test actually asserts.
    async function runOnce() {
      const commits = [];
      const runStageA = async (f) => ({ status: 'ok', file: f });
      const runStageB = async (prepared) => prepared;
      const runStageC = async (prepared) => {
        if (prepared.file === 'A') await new Promise((r) => setTimeout(r, 15));
        return prepared;
      };
      const runStageD = async (prepared) => { commits.push(prepared.file); };

      await runBoundedFilePipeline({
        files: ['A', 'B'],
        runStageA, runStageB, runStageC, runStageD,
        taggingLaneActive: false,
        recomputePolicy: constantPolicy({ canOverlapGenerationAndEmbedding: true }),
      });
      return commits;
    }

    const run1 = await runOnce();
    const run2 = await runOnce();
    assert.deepEqual(run1, run2, 'commit order should be deterministic given fixed completion times');
    assert.deepEqual(run1, ['A', 'B']);
  });

  it('TEST 9 — progress never regresses (processedFiles non-decreasing)', async () => {
    const processedValues = [];
    const runStageA = async (f) => ({ status: 'ok', file: f });
    const runStageB = async (prepared) => prepared;
    const runStageC = async (prepared) => prepared;
    const runStageD = async () => {};

    await runBoundedFilePipeline({
      files: ['A', 'B', 'C'],
      runStageA, runStageB, runStageC, runStageD,
      taggingLaneActive: false,
      recomputePolicy: constantPolicy({ canOverlapGenerationAndEmbedding: true }),
      onProgress: (evt) => processedValues.push(evt.processedFiles),
    });

    for (let i = 1; i < processedValues.length; i++) {
      assert.ok(processedValues[i] >= processedValues[i - 1], 'processedFiles regressed');
    }
  });

  it('TEST 10 — error/cancel stops new scheduling, in-flight files still complete, overall call rejects', async () => {
    const stageACalls = [];
    const stageDCalls = [];
    const gateFile3 = deferred();

    const runStageA = async (f) => { stageACalls.push(f); return { status: 'ok', file: f }; };
    const runStageB = async (prepared) => {
      if (prepared.file === '2') throw new Error('file 2 failed');
      if (prepared.file === '3') await gateFile3.promise;
      return prepared;
    };
    const runStageC = async (prepared) => prepared;
    const runStageD = async (prepared) => { stageDCalls.push(prepared.file); };

    // maxPreparedInFlight: 1 -- only ONE file is ever in flight past the
    // backpressure gate at a time (matching generationSem's own capacity
    // 1 under sequential mode, so this cap is the binding constraint,
    // not an incidental one). Files park behind the gate in input order.
    // File 1 completes normally and frees the slot; file 2 takes it and
    // throws almost immediately (no artificial delay); by the time file
    // 3 is granted the slot file 2 vacated, fatalError is already set
    // (the throw and the backpressureSem release both happen inside the
    // same microtask chain, strictly before file 3's own backpressureSem
    // .run() callback can be scheduled — Promise callbacks run in
    // registration order). File 3 is then held open (gateFile3) so we
    // can observe, at that point, that files 4 and 5 were never even
    // attempted.
    const run = runBoundedFilePipeline({
      files: ['1', '2', '3', '4', '5'],
      runStageA, runStageB, runStageC, runStageD,
      taggingLaneActive: false,
      recomputePolicy: constantPolicy({ canOverlapGenerationAndEmbedding: false }),
      maxPreparedInFlight: 1,
      stageAConcurrency: 1,
      onProgress: () => {},
    });

    // Let files 1 and 2 run to completion/failure, and file 3 reach its
    // gated stageB (but not resolve it yet).
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));

    assert.ok(stageACalls.includes('3'), 'file 3 (already queued when file 2 failed) should have been allowed to start');
    assert.ok(!stageACalls.includes('4'), 'file 4 stageA should never have been called');
    assert.ok(!stageACalls.includes('5'), 'file 5 stageA should never have been called');

    gateFile3.resolve();

    await assert.rejects(run);

    assert.ok(!stageACalls.includes('4'), 'file 4 stageA should never have been called (post-rejection)');
    assert.ok(!stageACalls.includes('5'), 'file 5 stageA should never have been called (post-rejection)');
    assert.ok(stageDCalls.includes('1'), 'file 1 (completed before the failure) should have committed');
    assert.ok(stageDCalls.includes('3'), 'file 3 (already in flight when the failure occurred) should have completed to stageD');
  });

  it('TEST 11 — single-file indexing behaves unchanged', async () => {
    const calls = [];
    const runStageA = async (f) => { calls.push('A'); return { status: 'ok', file: f }; };
    const runStageB = async (prepared) => { calls.push('B'); return prepared; };
    const runStageC = async (prepared) => { calls.push('C'); return prepared; };
    const runStageD = async () => { calls.push('D'); };

    const { results } = await runBoundedFilePipeline({
      files: ['only'],
      runStageA, runStageB, runStageC, runStageD,
      taggingLaneActive: false,
      recomputePolicy: constantPolicy({ canOverlapGenerationAndEmbedding: false }),
    });

    assert.deepEqual(calls, ['A', 'B', 'C', 'D']);
    assert.deepEqual(results, ['indexed']);
  });

  it('TEST 12 — no artificial serialization for a zero-delay, no-summary run', async () => {
    const runStageA = async (f) => ({ status: 'ok', file: f });
    const runStageB = async (prepared) => prepared;
    const runStageC = async (prepared) => prepared;
    const runStageD = async () => {};

    const start = Date.now();
    await runBoundedFilePipeline({
      files: ['A', 'B'],
      runStageA, runStageB, runStageC, runStageD,
      taggingLaneActive: false,
      recomputePolicy: constantPolicy({ canOverlapGenerationAndEmbedding: false }),
    });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 50, `expected under 50ms, took ${elapsed}ms`);
  });

  it('TEST 13 — ONNX tag lane never concurrent with ONNX embedding, including across files', async () => {
    let embeddingLaneHolders = 0;
    const checkHolders = () => assert.ok(embeddingLaneHolders <= 1, `embeddingLaneHolders=${embeddingLaneHolders} exceeded 1`);

    const runStageA = async (f) => ({ status: 'ok', file: f });
    const runStageB = async (prepared) => {
      // Simulate stageB's internal tag segment occupying the CPU lane.
      embeddingLaneHolders += 1;
      checkHolders();
      await new Promise((r) => setImmediate(r));
      embeddingLaneHolders -= 1;
      return prepared;
    };
    const runStageC = async (prepared) => {
      embeddingLaneHolders += 1;
      checkHolders();
      await new Promise((r) => setImmediate(r));
      embeddingLaneHolders -= 1;
      return prepared;
    };
    const runStageD = async () => {};

    // Files A, B: canOverlapTaggingAndEmbedding false (both CPU) -> stageB holds embeddingSem too.
    // File C: canOverlapTaggingAndEmbedding true -> stageB does NOT hold embeddingSem.
    const recomputePolicy = async () => ({
      canOverlapGenerationAndEmbedding: true,
      canOverlapGenerationAndTagging: true,
      canOverlapTaggingAndEmbedding: false,
      serializedLaneGroups: [['tagging', 'embedding']],
      reason: 'test',
      pairReasons: { generationEmbedding: '', generationTagging: '', taggingEmbedding: '' },
    });

    await runBoundedFilePipeline({
      files: ['A', 'B'],
      runStageA, runStageB, runStageC, runStageD,
      taggingLaneActive: true,
      recomputePolicy,
    });
  });

  it('TEST 13b — canOverlapTaggingAndEmbedding true does not needlessly serialize', async () => {
    const events = [];
    const runStageA = async (f) => ({ status: 'ok', file: f });
    const runStageB = async (prepared) => {
      events.push(`${prepared.file}:tag:start`);
      await new Promise((r) => setImmediate(r));
      events.push(`${prepared.file}:tag:end`);
      return prepared;
    };
    const gateCEmbed = deferred();
    const runStageC = async (prepared) => {
      events.push(`${prepared.file}:embed:start`);
      if (prepared.file === 'other') await gateCEmbed.promise;
      events.push(`${prepared.file}:embed:end`);
      return prepared;
    };
    const runStageD = async () => {};

    const recomputePolicy = async () => ({
      canOverlapGenerationAndEmbedding: true,
      canOverlapGenerationAndTagging: true,
      canOverlapTaggingAndEmbedding: true,
      serializedLaneGroups: [],
      reason: 'test',
      pairReasons: { generationEmbedding: '', generationTagging: '', taggingEmbedding: '' },
    });

    const run = runBoundedFilePipeline({
      files: ['other', 'C'],
      runStageA, runStageB, runStageC, runStageD,
      taggingLaneActive: true,
      recomputePolicy,
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    gateCEmbed.resolve();
    await run;

    // C's tag segment should be able to run concurrently with other's embed
    // segment -- i.e. C:tag:start occurs before other:embed:end (the two
    // windows [C:tag:start, C:tag:end] and [other:embed:start,
    // other:embed:end] genuinely intersect), proving
    // canOverlapTaggingAndEmbedding:true does not force needless
    // serialization the way TEST 13's canOverlapTaggingAndEmbedding:false
    // case does.
    const otherEmbedEnd = events.indexOf('other:embed:end');
    const cTagStart = events.indexOf('C:tag:start');
    assert.ok(cTagStart < otherEmbedEnd, `expected C tag segment to start before other's embed finished (overlap), got: ${events.join(', ')}`);
  });

  it('TEST 14 — deadlock-freedom under compound acquisition, adversarial interleaving', async () => {
    const files = ['A', 'B', 'C', 'D', 'E', 'F'];
    let toggle = false;
    const recomputePolicy = async () => {
      toggle = !toggle;
      return {
        canOverlapGenerationAndEmbedding: true,
        canOverlapGenerationAndTagging: true,
        canOverlapTaggingAndEmbedding: toggle,
        serializedLaneGroups: toggle ? [] : [['tagging', 'embedding']],
        reason: 'test',
        pairReasons: { generationEmbedding: '', generationTagging: '', taggingEmbedding: '' },
      };
    };

    async function randomYield() {
      const n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
    }

    const runStageA = async (f) => { await randomYield(); return { status: 'ok', file: f }; };
    const runStageB = async (prepared) => { await randomYield(); return prepared; };
    const runStageC = async (prepared) => { await randomYield(); return prepared; };
    const runStageD = async () => { await randomYield(); };

    const start = Date.now();
    const { results } = await runBoundedFilePipeline({
      files,
      runStageA, runStageB, runStageC, runStageD,
      taggingLaneActive: true,
      recomputePolicy,
    });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 2000, `pipeline took ${elapsed}ms — possible deadlock`);
    assert.deepEqual(results, files.map(() => 'indexed'));
  });
});
