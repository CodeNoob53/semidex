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

// ── Phase-aware intra-file progress (MVP estimate, not a measured ETA) ──────
//
// Design intent (see task discussion): different files/phases cost very
// different amounts of wall time — a "mathematically perfect" percentage
// isn't attainable without profiling every run, and isn't worth chasing.
// Instead each phase is given a fixed, stable weight representing roughly
// "how far through a typical file are we once this phase starts" — honest
// and useful for the user (the bar moves, they see what's happening),
// without pretending to be an exact ETA.
//
// Weights are 0..1, monotonically increasing, ending at 1.0 for "done".
// currentFileProgress in the emitted event is one of these weights, taken
// at the moment each phase *starts* via reporter.step() calls. Skipped
// phases are simply never reported for that file, so progress can visibly
// jump over them (e.g. no "tagging" step at all when TAG_GEN is off)
// rather than showing a step that didn't happen.
//
// The device-aware bounded pipeline (pipeline/bounded-file-pipeline.js,
// the default multi-file codepath since the device-aware scheduler
// replaced the old single-file-at-a-time loop) runs multiple files'
// phases concurrently and does not use createFileProgressReporter at all
// — currentStep/currentFileProgress stay null for its jobs (percent:
// indeterminate), the same trade-off the earlier PIPELINE_MODE=1 opt-in
// already made. It reports the newer activeStages array (see run.js's
// emitProgress) instead, using this same preparing/chunking/summarizing/
// tagging/embedding/writing vocabulary per active file.
export const FILE_PROGRESS_WEIGHTS = {
  preparing:   0.05,
  chunking:    0.15,
  summarizing: 0.45,
  tagging:     0.55,
  embedding:   0.80,
  writing:     0.95,
  done:        1.0,
};

export const FILE_PROGRESS_STEP_LABELS = {
  preparing:   'Preparing file',
  chunking:    'Chunking document',
  summarizing: 'Generating summaries',
  tagging:     'Generating tags',
  embedding:   'Embedding chunks',
  writing:     'Writing to Qdrant',
  done:        'Done',
};

/**
 * Small helper so callers don't scatter raw emitProgress()-shaped calls
 * across every stage function. One reporter per file being indexed.
 *
 * @param {{ emit: (payload: object) => void, fileIndex: number, totalFiles: number, currentFile: string }} opts
 *   `emit` is injected (rather than importing console.log/PROGRESS_EVENT_PREFIX
 *   here) so this module has zero I/O of its own and stays trivially testable.
 * @returns {{ step: (key: keyof FILE_PROGRESS_WEIGHTS, label?: string) => void, done: () => void }}
 */
export function createFileProgressReporter({ emit, fileIndex, totalFiles, currentFile }) {
  return {
    // `label` lets a call site override the default wording for a step key
    // when the generic label doesn't fit (e.g. skeleton's deterministic
    // context phase reports step('summarizing', 'Building navigation
    // context') instead of the default "Generating summaries" — that work
    // is real, it's just not an LLM call).
    step(key, label) {
      emit({
        processedFiles: fileIndex,
        totalFiles,
        currentFile,
        currentStep: label ?? FILE_PROGRESS_STEP_LABELS[key] ?? null,
        currentFileProgress: FILE_PROGRESS_WEIGHTS[key] ?? null,
      });
    },
    done() {
      emit({
        processedFiles: fileIndex + 1,
        totalFiles,
        currentFile: null,
        currentStep: null,
        currentFileProgress: 0,
      });
    },
  };
}
