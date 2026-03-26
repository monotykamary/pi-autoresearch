/**
 * Core type definitions for autoresearch extension
 */

/**
 * Actionable Side Information (ASI) — free-form diagnostics per experiment run.
 * The agent decides what to record. Any key/value pair is valid.
 */
export interface ASI {
  [key: string]: unknown;
}

export interface ExperimentResult {
  commit: string;
  metric: number;
  /** Additional tracked metrics: { name: value } */
  metrics: Record<string, number>;
  status: "keep" | "discard" | "crash" | "checks_failed";
  description: string;
  timestamp: number;
  /** Segment index — increments on each config header. Current segment = highest. */
  segment: number;
  /** Session-level confidence score at the time this result was logged. null if insufficient data. */
  confidence: number | null;
  /** Actionable Side Information — structured diagnostics for this run */
  asi?: ASI;
}

export interface MetricDef {
  name: string;
  unit: string;
}

export interface ExperimentState {
  results: ExperimentResult[];
  /** Baseline primary metric (from first experiment in current segment) */
  bestMetric: number | null;
  bestDirection: "lower" | "higher";
  metricName: string;
  metricUnit: string;
  /** Definitions for secondary metrics (order preserved) */
  secondaryMetrics: MetricDef[];
  name: string | null;
  /** Current segment index (incremented on each init_experiment) */
  currentSegment: number;
  /** Maximum number of experiments before auto-stopping. null = unlimited. */
  maxExperiments: number | null;
  /** Current session confidence score (best improvement / noise floor). null if insufficient data. */
  confidence: number | null;
  /** Target value to auto-stop when reached. null = no target. */
  targetValue: number | null;
}

export interface RunDetails {
  command: string;
  exitCode: number | null;
  durationSeconds: number;
  passed: boolean;
  crashed: boolean;
  timedOut: boolean;
  tailOutput: string;
  /** null = checks not run (no file or benchmark failed), true/false = ran */
  checksPass: boolean | null;
  checksTimedOut: boolean;
  checksOutput: string;
  checksDuration: number;
  /** Metrics parsed from METRIC lines in output. null if none found. */
  parsedMetrics: Record<string, number> | null;
  /** Primary metric value extracted from parsedMetrics (matching metricName). null if not found. */
  parsedPrimary: number | null;
  /** Name of the primary metric (for display) */
  metricName: string;
  metricUnit: string;
}

export interface LogDetails {
  experiment: ExperimentResult;
  state: ExperimentState;
  wallClockSeconds: number | null;
}

export interface AutoresearchRuntime {
  autoresearchMode: boolean;
  dashboardExpanded: boolean;
  lastAutoResumeTime: number;
  experimentsThisSession: number;
  autoResumeTurns: number;
  lastRunChecks: { pass: boolean; output: string; duration: number } | null;
  lastRunDuration: number | null;
  runningExperiment: { startedAt: number; command: string } | null;
  /** True when run_experiment finished but log_experiment hasn't been called yet */
  experimentCompletedWaitingForLog: boolean;
  state: ExperimentState;
  /** Path to the session-specific git worktree for isolation, or null if not using worktree */
  worktreeDir: string | null;
  /** Git commit hash captured at run_experiment entry (before AI modifications). Used by log_experiment for the experiment record. */
  startingCommit: string | null;
}

export interface AutoresearchConfig {
  maxIterations?: number;
  workingDir?: string;
}
