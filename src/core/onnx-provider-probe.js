// Read-only ONNX provider probe — used by npm run doctor only.
// Does not run inference, does not download models, does not trigger load().

import * as ort from 'onnxruntime-node';

const MAX_ERR_LEN = 120;

// Attempt to create an ONNX InferenceSession with the given provider list.
// Returns { ok: true } or { ok: false, message: string (one line, truncated) }.
// Never falls back to CPU — caller controls the provider list.
export async function probeOnnxProvider(providers, modelPath) {
  try {
    const sess = await ort.InferenceSession.create(modelPath, { executionProviders: providers });
    try { await sess.release(); } catch { /* ignore — probe succeeded */ }
    return { ok: true };
  } catch (err) {
    const raw = String(err?.message ?? err ?? 'unknown error').replace(/\r?\n.*/s, '').trim();
    const message = raw.length > MAX_ERR_LEN ? raw.slice(0, MAX_ERR_LEN) + '…' : raw;
    return { ok: false, message };
  }
}
