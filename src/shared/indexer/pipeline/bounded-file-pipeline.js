// Device-aware bounded indexing pipeline (plan: recursive-roaming-anchor.md
// §4). Replaces the old unbounded `Promise.allSettled(files.map(...))`
// cross-file loop with a windowed pump: every file's runOneFile() call is
// kicked off immediately, but gated by a backpressure semaphore, so a
// queued-but-not-yet-run file holds no chunk data in memory — only a
// pending Promise closure over a filePath string.
//
// Pure orchestration — takes stage functions and concurrency knobs as
// parameters, never imports stageA/B/C/D directly (run.js owns those).
// This keeps the module independently unit-testable with fully fake stage
// functions and decoupled from scheduling-policy.js (it takes an already-
// resolved-per-call `recomputePolicy()` function, never computes a policy
// itself).
//
// LOAD-BEARING SAFETY INVARIANT — fixed lane-permit acquisition order:
// whenever a code path needs more than one of the three lane semaphores
// at once, permits are ALWAYS acquired in the fixed order
// generationSem -> taggingSem -> embeddingSem, never the reverse, never
// interleaved with another file's acquisition of the same two in a
// different order. This is the ONLY multi-permit acquisition path in the
// whole module, so a classic circular-wait deadlock (file A holds
// generationSem waiting for taggingSem while file B holds taggingSem
// waiting for generationSem) is structurally impossible — there is only
// one code path that ever holds two lane permits simultaneously, and it
// always requests them in the same order.
//
// POLICY FRESHNESS: recomputePolicy() is called exactly once per file
// INSIDE generationSem.run() (runOneFile()'s own callback), never before
// queueing for that permit. This is deliberate, not an optimization: a
// snapshot taken before a file queues behind a busy generation lane can
// go stale while it waits (e.g. Ollama's model finishes loading, or
// ONNX's first real embed call completes, mid-queue). Reading the policy
// only after the permit is actually held, and choosing the sequential-
// vs-overlap-capable BRANCH itself from that fresh read (not from an
// earlier snapshot), means every file's behavior reflects the signal as
// of the moment it truly starts stageB, not as of whenever its own
// stageA happened to finish. An earlier version of this function
// computed policy once outside generationSem.run() to pick the branch
// shape, then only re-checked inside to refine the tagging/embedding
// mode — which meant a cohort of files that all queued while the signal
// was still unverified could never escape the sequential branch shape
// even after the signal upgraded while they waited. See
// bounded-file-pipeline.test.js's TEST 1d for the direct regression test.
//
// COMMIT ORDERING: stageD still runs through one SerialQueue
// (commitQueue), unchanged. Because commitQueue.run() calls chain onto
// _tail in CALL order, commit order follows whatever order each file's
// own stageC resolved. In this implementation, generationSem's fixed
// FIFO acquisition order (always granted in file-input order) transitively
// orders each file's stageC/embeddingSem acquisition the same way (a
// file can only reach embeddingSem after its own stageB has released
// generationSem, which — because generationSem is capacity 1 and FIFO —
// always happens in input order), so with the default single-embedding-
// lane concurrency, commit order in practice matches input order even
// under overlap. This is NOT a hard guarantee of the module's contract
// (a future increase to embedding-lane concurrency, or a different lane
// topology, could break the transitivity) — only that commit order is
// deterministic given a fixed set of stage completion times, which IS
// guaranteed. Verified directly in bounded-file-pipeline.test.js's own
// TEST 8 rather than assumed.

import { Semaphore } from '../semaphore.js';
import { SerialQueue } from '../serial-queue.js';

/**
 * The one place that decides how many of {taggingSem, embeddingSem}
 * stageB must acquire, and for how long, for ONE file — assumes
 * generationSem is ALREADY held by the caller (never acquires it itself;
 * Semaphore is not reentrant, so this must never be called except from
 * inside an already-open generationSem.run() callback).
 *
 * Two cases (the "!taggingLaneActive" case is handled by the caller
 * before this function is ever invoked):
 *   A. canOverlapTaggingAndEmbedding === true — acquire taggingSem for
 *      stageB's own duration only; embeddingSem is left untouched here,
 *      so stageC (called separately by the caller) can acquire it fresh.
 *   B. canOverlapTaggingAndEmbedding === false — acquire taggingSem THEN
 *      embeddingSem (fixed order), and hold BOTH for stageB's entire
 *      duration. embeddingSem is released only when stageB itself
 *      resolves. No OTHER file's stageC can start while this file's
 *      stageB (tagging included) is running, and this file's own stageC,
 *      requesting embeddingSem fresh right after, is trivially safe.
 *
 * @param {Object} params
 * @param {import('../semaphore.js').Semaphore} params.taggingSem
 * @param {import('../semaphore.js').Semaphore} params.embeddingSem
 * @param {Function} params.runStageB
 * @param {Object} params.preparedA
 * @param {import('../device/scheduling-policy.js').SchedulingPolicy} params.policy
 * @returns {Promise<{ result: Object }>}
 */
async function acquireTaggingAndEmbeddingForStageB({ taggingSem, embeddingSem, runStageB, preparedA, policy }) {
  const mode = policy.canOverlapGenerationAndTagging ? 'parallel' : 'sequential';
  if (policy.canOverlapTaggingAndEmbedding) {
    return { result: await taggingSem.run(() => runStageB(preparedA, mode)) };
  }
  return { result: await taggingSem.run(() => embeddingSem.run(() => runStageB(preparedA, mode))) };
}

/**
 * @param {{
 *   files: Array,
 *   runStageA: (file, index) => Promise<{status:'skipped'}|Object>,
 *   runStageB: (prepared, generationTaggingExecutionMode: 'parallel'|'sequential') => Promise<Object>,
 *   runStageC: (prepared) => Promise<Object>,
 *   runStageD: (prepared) => Promise<void>,
 *   taggingLaneActive: boolean,
 *   stageAConcurrency?: number,
 *   recomputePolicy: () => Promise<import('../device/scheduling-policy.js').SchedulingPolicy>,
 *   maxPreparedInFlight?: number,
 *   onProgress?: (event: Object) => void,
 * }} params
 * @returns {Promise<{ results: Array<'indexed'|'skipped'|'error'>, errors: Error[] }>}
 */
export async function runBoundedFilePipeline({
  files,
  runStageA,
  runStageB,
  runStageC,
  runStageD,
  taggingLaneActive,
  stageAConcurrency = 4,
  recomputePolicy,
  maxPreparedInFlight,
  onProgress = () => {},
}) {
  const effectiveMaxPreparedInFlight = maxPreparedInFlight ?? (stageAConcurrency + 1 + 1 + 2);

  const stageASem = new Semaphore(stageAConcurrency);
  const generationSem = new Semaphore(1);
  const taggingSem = new Semaphore(1);
  const embeddingSem = new Semaphore(1);
  const backpressureSem = new Semaphore(effectiveMaxPreparedInFlight);
  const commitQueue = new SerialQueue();

  let fatalError = null;
  const results = new Array(files.length);
  let processedFiles = 0;
  const activeStagesMap = new Map(); // filePath -> Set<stage>

  function emitProgress(currentFile) {
    onProgress({
      processedFiles,
      totalFiles: files.length,
      currentFile,
      activeStages: [...activeStagesMap.entries()].flatMap(([file, stages]) => [...stages].map((stage) => ({ stage, file }))),
    });
  }

  function markActive(filePath, stage) {
    if (!activeStagesMap.has(filePath)) activeStagesMap.set(filePath, new Set());
    activeStagesMap.get(filePath).add(stage);
    emitProgress(filePath);
  }

  function unmarkActive(filePath, stage) {
    const set = activeStagesMap.get(filePath);
    if (set) {
      set.delete(stage);
      if (set.size === 0) activeStagesMap.delete(filePath);
    }
    emitProgress(filePath);
  }

  async function runStageBWithLanes(filePath, preparedA, policy) {
    markActive(filePath, 'summarizing');
    let out;
    if (taggingLaneActive) {
      out = await acquireTaggingAndEmbeddingForStageB({ taggingSem, embeddingSem, runStageB, preparedA, policy });
    } else {
      out = { result: await runStageB(preparedA) };
    }
    unmarkActive(filePath, 'summarizing');
    return out;
  }

  async function runOneFile(filePath, index) {
    return backpressureSem.run(async () => {
      if (fatalError) return 'skipped-due-to-cancellation';

      const preparedA = await stageASem.run(() => {
        markActive(filePath, 'preparing');
        return runStageA(filePath, index);
      });
      if (preparedA.status === 'skipped') {
        unmarkActive(filePath, 'preparing');
        return 'skipped';
      }
      unmarkActive(filePath, 'preparing');

      // A SINGLE generationSem.run() call, always — the branch actually
      // taken (sequential-through-stageC vs. overlap-capable) is decided
      // ONLY from the policy read fresh INSIDE this callback, once the
      // permit is actually held, never from a snapshot captured before
      // queueing. This closes a real gap an earlier version of this
      // function had: computing policy once outside generationSem.run()
      // and using it to pick which branch's *shape* to commit to (whether
      // stageC would run inside or outside the generationSem hold) meant
      // several files that all queued while the signal was still
      // unverified would ALL commit to the sequential shape structurally,
      // and a later re-check inside that shape could only refine the
      // tagging/embedding mode — it could never actually switch a file
      // over to the overlap-capable shape, even once the signal became
      // verified while those files were still queued. Reading policy
      // fresh INSIDE, before the branch is chosen, means every file's
      // branch choice reflects the signal as of the moment it truly
      // starts, not as of whenever stageA happened to finish.
      let preparedB, preparedC;
      let stageCRanInsideGenerationSem = false;
      await generationSem.run(async () => {
        const policy = await recomputePolicy();

        if (!policy.canOverlapGenerationAndEmbedding) {
          // Sequential shape: stageC runs INSIDE this generationSem hold
          // (chosen fresh, right now) — no other file's stageB can start
          // until this file's stageC has also finished.
          markActive(filePath, 'summarizing');
          const { result } = taggingLaneActive
            ? await acquireTaggingAndEmbeddingForStageB({ taggingSem, embeddingSem, runStageB, preparedA, policy })
            : { result: await runStageB(preparedA) };
          preparedB = result;
          unmarkActive(filePath, 'summarizing');
          preparedC = await embeddingSem.run(() => {
            markActive(filePath, 'embedding');
            return runStageC(preparedB);
          });
          unmarkActive(filePath, 'embedding');
          stageCRanInsideGenerationSem = true;
        } else {
          // Overlap-capable shape: generationSem is released as soon as
          // stageB itself resolves (this callback returns) — stageC runs
          // OUTSIDE it, below, so another file's stageB can start while
          // THIS file's stageC is still running.
          const { result } = await runStageBWithLanes(filePath, preparedA, policy);
          preparedB = result;
        }
      });

      if (!stageCRanInsideGenerationSem) {
        preparedC = await embeddingSem.run(() => {
          markActive(filePath, 'embedding');
          return runStageC(preparedB);
        });
        unmarkActive(filePath, 'embedding');
      }

      await commitQueue.run(() => runStageD(preparedC));
      return 'indexed';
    });
  }

  function onFileSettled(index) {
    processedFiles += 1;
    emitProgress(files[index]);
  }

  const active = files.map((filePath, index) =>
    runOneFile(filePath, index)
      .then((status) => { results[index] = status; onFileSettled(index); })
      .catch((err) => { fatalError = fatalError ?? err; results[index] = 'error'; onFileSettled(index); })
  );

  await Promise.allSettled(active);

  if (fatalError) throw fatalError;
  return { results, errors: [] };
}
