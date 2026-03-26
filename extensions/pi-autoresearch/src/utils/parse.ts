/**
 * Metric parsing utilities
 */

import { METRIC_LINE_PREFIX, DENIED_METRIC_NAMES } from "../constants.js";

/**
 * Parse structured METRIC lines from command output.
 * Format: METRIC name=value (one per line)
 * Returns a Map preserving insertion order of first occurrence per key.
 */
export function parseMetricLines(output: string): Map<string, number> {
  const metrics = new Map<string, number>();
  const regex = new RegExp(
    `^${METRIC_LINE_PREFIX}\\s+([\\w.µ]+)=(\\S+)\\s*$`,
    "gm"
  );
  let match;
  while ((match = regex.exec(output)) !== null) {
    const name = match[1];
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) {
      metrics.set(name, value);
    }
  }
  return metrics;
}

/** Infer unit from metric name suffix */
export function inferUnit(name: string): string {
  if (name.endsWith("µs")) return "µs";
  if (name.endsWith("_ms")) return "ms";
  if (name.endsWith("_s") || name.endsWith("_sec")) return "s";
  if (name.endsWith("_kb")) return "kb";
  if (name.endsWith("_mb")) return "mb";
  return "";
}
