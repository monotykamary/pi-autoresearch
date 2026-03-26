/**
 * State management for autoresearch sessions
 */

import type {
  ExperimentState,
  AutoresearchRuntime,
  ExperimentResult,
  MetricDef,
} from "../types/index.js";
import { inferUnit, computeConfidence, currentResults } from "../utils/index.js";

/** Create a fresh experiment state */
export function createExperimentState(): ExperimentState {
  return {
    results: [],
    bestMetric: null,
    bestDirection: "lower",
    metricName: "metric",
    metricUnit: "",
    secondaryMetrics: [],
    name: null,
    currentSegment: 0,
    maxExperiments: null,
    confidence: null,
    targetValue: null,
  };
}

/** Create a fresh session runtime */
export function createSessionRuntime(): AutoresearchRuntime {
  return {
    autoresearchMode: false,
    dashboardExpanded: false,
    lastAutoResumeTime: 0,
    experimentsThisSession: 0,
    autoResumeTurns: 0,
    lastRunChecks: null,
    lastRunDuration: null,
    lastRunSucceeded: null,
    runningExperiment: null,
    experimentCompletedWaitingForLog: false,
    state: createExperimentState(),
    worktreeDir: null,
    startingCommit: null,
    jsonlWatcher: null,
  };
}

/** Runtime store for managing multiple sessions */
export function createRuntimeStore() {
  const runtimes = new Map<string, AutoresearchRuntime>();

  return {
    ensure(sessionKey: string): AutoresearchRuntime {
      let runtime = runtimes.get(sessionKey);
      if (!runtime) {
        runtime = createSessionRuntime();
        runtimes.set(sessionKey, runtime);
      }
      return runtime;
    },

    clear(sessionKey: string): void {
      runtimes.delete(sessionKey);
    },

    has(sessionKey: string): boolean {
      return runtimes.has(sessionKey);
    },
  };
}

/** Register secondary metrics from an experiment result */
export function registerSecondaryMetrics(
  state: ExperimentState,
  metrics: Record<string, number>
): void {
  for (const name of Object.keys(metrics)) {
    if (!state.secondaryMetrics.find((m) => m.name === name)) {
      state.secondaryMetrics.push({ name, unit: inferUnit(name) });
    }
  }
}

/** Update state after logging a new experiment */
export function updateStateAfterLog(
  state: ExperimentState,
  experiment: ExperimentResult
): void {
  // Register any new secondary metric names
  registerSecondaryMetrics(state, experiment.metrics);

  // Recalculate baseline
  state.bestMetric = currentResults(state.results, state.currentSegment)[0]?.metric ?? null;

  // Recalculate confidence
  state.confidence = computeConfidence(
    state.results,
    state.currentSegment,
    state.bestDirection
  );
  experiment.confidence = state.confidence;
}

/** Reset runtime state for a new segment/reinit */
export function resetForReinit(
  state: ExperimentState,
  incrementSegment: boolean = true
): void {
  if (incrementSegment) {
    state.currentSegment++;
  }
  state.bestMetric = null;
  state.secondaryMetrics = [];
  state.confidence = null;
}

/** Reset session-specific counters */
export function resetSessionCounters(runtime: AutoresearchRuntime): void {
  runtime.experimentsThisSession = 0;
  runtime.autoResumeTurns = 0;
  runtime.lastAutoResumeTime = 0;
}
