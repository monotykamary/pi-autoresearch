/**
 * Constants and configuration for autoresearch extension
 */

// ---------------------------------------------------------------------------
// Metric parsing constants (used by utils/parse.ts)
// ---------------------------------------------------------------------------

/** Prefix for structured metric output lines: `METRIC name=value` */
export const METRIC_LINE_PREFIX = 'METRIC';

/** Metric names that could cause prototype pollution if used as object keys */
export const DENIED_METRIC_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
