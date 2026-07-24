import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function finiteArray(values, label) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`${label} must be a non-empty array of finite numbers`);
  }
  return values;
}

export function compareVectors(left, right) {
  finiteArray(left, 'left vector');
  finiteArray(right, 'right vector');
  if (left.length !== right.length) {
    throw new Error(`vector length mismatch: ${left.length} !== ${right.length}`);
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  let maxAbsDelta = 0;
  let sumAbsDelta = 0;
  for (let index = 0; index < left.length; index++) {
    const leftValue = left[index];
    const rightValue = right[index];
    const delta = Math.abs(leftValue - rightValue);
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
    maxAbsDelta = Math.max(maxAbsDelta, delta);
    sumAbsDelta += delta;
  }

  return {
    cosine: leftNorm > 0 && rightNorm > 0
      ? dot / Math.sqrt(leftNorm * rightNorm)
      : null,
    maxAbsDelta,
    meanAbsDelta: sumAbsDelta / left.length,
  };
}

export function compareProviderOutputs(leftResult, rightResult) {
  const leftOutputs = leftResult?.outputs;
  const rightOutputs = rightResult?.outputs;
  if (!Array.isArray(leftOutputs) || !Array.isArray(rightOutputs)) {
    throw new Error('both results must contain output arrays');
  }
  if (leftOutputs.length !== rightOutputs.length) {
    throw new Error(`text count mismatch: ${leftOutputs.length} !== ${rightOutputs.length}`);
  }

  const perText = leftOutputs.map((left, index) => ({
    index,
    dense: compareVectors(left.dense, rightOutputs[index].dense),
    sparse: compareVectors(left.sparse, rightOutputs[index].sparse),
  }));

  return {
    textCount: perText.length,
    dense: {
      minCosine: Math.min(...perText.map((entry) => entry.dense.cosine)),
      maxAbsDelta: Math.max(...perText.map((entry) => entry.dense.maxAbsDelta)),
      maxMeanAbsDelta: Math.max(...perText.map((entry) => entry.dense.meanAbsDelta)),
    },
    sparse: {
      minCosine: Math.min(...perText.map((entry) => entry.sparse.cosine)),
      maxAbsDelta: Math.max(...perText.map((entry) => entry.sparse.maxAbsDelta)),
      maxMeanAbsDelta: Math.max(...perText.map((entry) => entry.sparse.meanAbsDelta)),
    },
    perText,
  };
}

function loadSingleResult(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed.results) || parsed.results.length !== 1) {
    throw new Error(`${path} must contain exactly one provider result`);
  }
  if (parsed.results[0].error) {
    throw new Error(`${path} contains a failed provider result: ${parsed.results[0].error}`);
  }
  return { metadata: parsed, result: parsed.results[0] };
}

function main() {
  const [leftPath, rightPath] = process.argv.slice(2);
  if (!leftPath || !rightPath) {
    throw new Error('Usage: node benchmarks/compare-onnx-provider-results.mjs <left.json> <right.json>');
  }
  const left = loadSingleResult(leftPath);
  const right = loadSingleResult(rightPath);
  const comparison = compareProviderOutputs(left.result, right.result);
  console.log(JSON.stringify({
    left: {
      runtime: left.metadata.runtime,
      provider: left.result.actualProvider,
      totalMs: left.result.totalMs,
    },
    right: {
      runtime: right.metadata.runtime,
      provider: right.result.actualProvider,
      totalMs: right.result.totalMs,
    },
    speedupRightVsLeft: left.result.totalMs / right.result.totalMs,
    comparison,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
