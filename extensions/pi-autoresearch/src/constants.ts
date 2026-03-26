/**
 * Constants and configuration for autoresearch extension
 */

// ---------------------------------------------------------------------------
// Experiment output limits (sent to LLM — keep small to save context)
// ---------------------------------------------------------------------------
export const EXPERIMENT_MAX_LINES = 10;
export const EXPERIMENT_MAX_BYTES = 4 * 1024; // 4KB

// ---------------------------------------------------------------------------
// Metric parsing constants
// ---------------------------------------------------------------------------

/** Prefix for structured metric output lines: `METRIC name=value` */
export const METRIC_LINE_PREFIX = "METRIC";

/** Metric names that could cause prototype pollution if used as object keys */
export const DENIED_METRIC_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

// ---------------------------------------------------------------------------
// Autoresearch behavior constants
// ---------------------------------------------------------------------------
export const MAX_AUTORESUME_TURNS = 20;

// ---------------------------------------------------------------------------
// Guardrail messages
// ---------------------------------------------------------------------------
export const BENCHMARK_GUARDRAIL =
  "Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.";

export const SCOPE_GUARDRAIL =
  "Autoresearch is ONLY for long-horizon optimization tasks with verifiable metrics (e.g., performance, accuracy, bundle size). " +
  "Do NOT use autoresearch for: general development, one-off commits, exploratory coding without a metric, or tasks without a measurable optimization target. " +
  "If there's no clear metric to optimize, use regular tools instead.";
