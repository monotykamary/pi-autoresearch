/**
 * State management for autoresearch sessions
 *
 * Note: updateStateAfterLog, resetForReinit, and resetSessionCounters
 * have moved to the harness server. This module only retains what the
 * extension UI and tests need.
 */

import type { ExperimentState, AutoresearchRuntime } from '../types/index.js';

/** Create a fresh experiment state */
export function createExperimentState(): ExperimentState {
  return {
    results: [],
    bestMetric: null,
    bestDirection: 'lower',
    metricName: 'metric',
    metricUnit: '',
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
    pendingResumeTimer: null,
    pendingResumeMessage: null,
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

// registerSecondaryMetrics moved to harness server
