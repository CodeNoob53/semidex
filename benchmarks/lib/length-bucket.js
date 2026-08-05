// Re-export from canonical location in src/local/core.
// benchmarks/ must not be the source of truth for production helpers.
export {
  BUCKET_BOUNDARIES,
  estimateTokens,
  bucketIndex,
  bucketBatches,
  embedBucketed,
} from '../../src/local/core/length-bucket.js';
