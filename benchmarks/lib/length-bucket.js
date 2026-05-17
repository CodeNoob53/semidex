// Re-export from canonical location in src/core.
// benchmarks/ must not be the source of truth for production helpers.
export {
  BUCKET_BOUNDARIES,
  estimateTokens,
  bucketIndex,
  bucketBatches,
  embedBucketed,
} from '../../src/core/length-bucket.js';
