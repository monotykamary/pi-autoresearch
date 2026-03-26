/**
 * Statistical helpers for experiment analysis
 */

import type { ExperimentResult, ExperimentState, MetricDef } from "../types/index.js";

/** Compute the median of a numeric array (returns 0 for empty arrays) */
export function sortedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Check if current value is better than best based on direction */
export function isBetter(
  current: number,
  best: number,
  direction: "lower" | "higher"
): boolean {
  return direction === "lower" ? current < best : current > best;
}

/**
 * Compute confidence score for the best improvement vs. session noise floor.
 *
 * Uses Median Absolute Deviation (MAD) of all metric values in the current
 * segment as a robust noise estimator. Returns `|best_delta| / MAD`.
 *
 * Returns null when there are fewer than 3 data points or when MAD is 0.
 */
export function computeConfidence(
  results: ExperimentResult[],
  segment: number,
  direction: "lower" | "higher"
): number | null {
  const cur = currentResults(results, segment).filter((r) => r.metric > 0);
  if (cur.length < 3) return null;

  const values = cur.map((r) => r.metric);
  const median = sortedMedian(values);
  const deviations = values.map((v) => Math.abs(v - median));
  const mad = sortedMedian(deviations);

  if (mad === 0) return null;

  const baseline = findBaselineMetric(results, segment);
  if (baseline === null) return null;

  // Find best kept metric in current segment
  let bestKept: number | null = null;
  for (const r of cur) {
    if (r.status === "keep" && r.metric > 0) {
      if (
        bestKept === null ||
        isBetter(r.metric, bestKept, direction)
      ) {
        bestKept = r.metric;
      }
    }
  }
  if (bestKept === null || bestKept === baseline) return null;

  const delta = Math.abs(bestKept - baseline);
  return delta / mad;
}

// Re-export from experiment.ts to avoid circular deps
// These are used by computeConfidence and other stats functions
import { currentResults, findBaselineMetric } from "./experiment.js";
export { currentResults, findBaselineMetric };
