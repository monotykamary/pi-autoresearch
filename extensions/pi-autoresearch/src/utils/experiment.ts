/**
 * Experiment state helper functions
 */

import type { ExperimentResult, MetricDef } from "../types/index.js";

/** Get results in the current segment only */
export function currentResults(
  results: ExperimentResult[],
  segment: number
): ExperimentResult[] {
  return results.filter((r) => r.segment === segment);
}

/** Baseline = first experiment in current segment */
export function findBaselineMetric(
  results: ExperimentResult[],
  segment: number
): number | null {
  const cur = currentResults(results, segment);
  return cur.length > 0 ? cur[0].metric : null;
}

/** Find the run number of the baseline experiment */
export function findBaselineRunNumber(
  results: ExperimentResult[],
  segment: number
): number | null {
  const index = results.findIndex((result) => result.segment === segment);
  return index >= 0 ? index + 1 : null;
}

/**
 * Find secondary metric baselines from the first experiment in current segment.
 * For metrics that didn't exist at baseline time, falls back to the first
 * occurrence of that metric in the current segment.
 */
export function findBaselineSecondary(
  results: ExperimentResult[],
  segment: number,
  knownMetrics?: MetricDef[]
): Record<string, number> {
  const cur = currentResults(results, segment);
  const base: Record<string, number> =
    cur.length > 0 ? { ...(cur[0].metrics ?? {}) } : {};

  // Fill in any known metrics missing from baseline with their first occurrence
  if (knownMetrics) {
    for (const sm of knownMetrics) {
      if (base[sm.name] === undefined) {
        for (const r of cur) {
          const val = (r.metrics ?? {})[sm.name];
          if (val !== undefined) {
            base[sm.name] = val;
            break;
          }
        }
      }
    }
  }

  return base;
}
