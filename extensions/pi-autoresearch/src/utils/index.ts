/**
 * Utility functions barrel export
 */

// Formatting utilities
export { commas, fmtNum, formatNum, formatSize, formatElapsed } from './format.js';

// Parsing utilities
export { parseMetricLines, inferUnit } from './parse.js';

// Validation utilities
export { isAutoresearchShCommand } from './validate.js';

// Process and file utilities
export { killTree, createTempFileAllocator } from './process.js';

// Statistical helpers
export { sortedMedian, isBetter, computeConfidence } from './stats.js';

// Experiment state helpers (segment-based filtering - kept for internal use)
export {
  currentResults,
  findBaselineMetric,
  findBaselineRunNumber,
  findBaselineSecondary,
} from './experiment.js';
