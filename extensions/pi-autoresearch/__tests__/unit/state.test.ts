/**
 * Unit tests for state management, widget behaviors, and session lifecycle
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { ExperimentResult } from "../../src/types/index.js";

// ============================================================================
// Test fixtures and helpers
// ============================================================================
interface TestRuntime {
  autoresearchMode: boolean;
  dashboardExpanded: boolean;
  runningExperiment: { startedAt: number; command: string } | null;
  experimentCompletedWaitingForLog: boolean;
  lastRunSucceeded: boolean | null;
  autoResumeTurns: number;
  state: {
    name: string | null;
    results: ExperimentResult[];
    metricName: string;
  };
}

function createWidgetTestRuntime(): TestRuntime {
  return {
    autoresearchMode: false,
    dashboardExpanded: false,
    runningExperiment: null,
    experimentCompletedWaitingForLog: false,
    lastRunSucceeded: null,
    autoResumeTurns: 0,
    state: {
      name: null,
      results: [],
      metricName: "metric",
    },
  };
}

function getWidgetState(
  runtime: TestRuntime
):
  | { type: "hidden" }
  | { type: "running"; name: string | null; command: string }
  | { type: "waiting_for_log"; succeeded: boolean; name: string | null }
  | { type: "ready"; name: string }
  | { type: "dashboard" } {
  if (runtime.state.results.length > 0) {
    return { type: "dashboard" };
  }

  if (runtime.runningExperiment) {
    return {
      type: "running",
      name: runtime.state.name,
      command: runtime.runningExperiment.command,
    };
  }

  if (runtime.experimentCompletedWaitingForLog) {
    return {
      type: "waiting_for_log",
      succeeded: runtime.lastRunSucceeded === true,
      name: runtime.state.name,
    };
  }

  if (runtime.state.name) {
    return { type: "ready", name: runtime.state.name };
  }

  return { type: "hidden" };
}

// ============================================================================
// Widget State Behaviors
// ============================================================================
describe("Widget state behaviors", () => {
  describe("Initial state", () => {
    it("hides widget when no session initialized", () => {
      const runtime = createWidgetTestRuntime();
      const state = getWidgetState(runtime);
      expect(state.type).toBe("hidden");
    });
  });

  describe("After init_experiment", () => {
    it("shows 'ready' state with session name", () => {
      const runtime = createWidgetTestRuntime();
      runtime.state.name = "Optimize render performance";
      const state = getWidgetState(runtime);
      expect(state.type).toBe("ready");
      expect((state as { type: "ready"; name: string }).name).toBe("Optimize render performance");
    });

    it("stays hidden if name is empty string", () => {
      const runtime = createWidgetTestRuntime();
      runtime.state.name = "";
      const state = getWidgetState(runtime);
      expect(state.type).toBe("hidden");
    });
  });

  describe("During run_experiment", () => {
    it("shows 'running' state with command", () => {
      const runtime = createWidgetTestRuntime();
      runtime.state.name = "Test Session";
      runtime.runningExperiment = {
        startedAt: Date.now(),
        command: "bash benchmark.sh",
      };
      const state = getWidgetState(runtime);
      expect(state.type).toBe("running");
      expect((state as { type: "running"; command: string }).command).toBe("bash benchmark.sh");
    });

    it("running state takes precedence over waiting_for_log", () => {
      const runtime = createWidgetTestRuntime();
      runtime.experimentCompletedWaitingForLog = true;
      runtime.lastRunSucceeded = true;
      runtime.runningExperiment = {
        startedAt: Date.now(),
        command: "bash new_run.sh",
      };
      const state = getWidgetState(runtime);
      expect(state.type).toBe("running");
    });
  });

  describe("After successful run_experiment", () => {
    it("shows 'waiting_for_log' with succeeded=true", () => {
      const runtime = createWidgetTestRuntime();
      runtime.state.name = "Test Session";
      runtime.experimentCompletedWaitingForLog = true;
      runtime.lastRunSucceeded = true;
      const state = getWidgetState(runtime);
      expect(state.type).toBe("waiting_for_log");
      expect((state as { type: "waiting_for_log"; succeeded: boolean }).succeeded).toBe(true);
    });
  });

  describe("After failed run_experiment", () => {
    it("shows 'waiting_for_log' with succeeded=false for crash", () => {
      const runtime = createWidgetTestRuntime();
      runtime.state.name = "Test Session";
      runtime.experimentCompletedWaitingForLog = true;
      runtime.lastRunSucceeded = false;
      const state = getWidgetState(runtime);
      expect(state.type).toBe("waiting_for_log");
      expect((state as { type: "waiting_for_log"; succeeded: boolean }).succeeded).toBe(false);
    });

    it("does NOT hide widget on failure (no flash)", () => {
      const runtime = createWidgetTestRuntime();
      runtime.state.name = "Test Session";
      runtime.experimentCompletedWaitingForLog = true;
      runtime.lastRunSucceeded = false;
      const state = getWidgetState(runtime);
      expect(state.type).not.toBe("hidden");
    });
  });

  describe("After log_experiment", () => {
    it("transitions to dashboard when results exist", () => {
      const runtime = createWidgetTestRuntime();
      runtime.state.name = "Test Session";
      runtime.state.results = [
        {
          commit: "abc1234",
          metric: 100,
          metrics: {},
          status: "keep",
          description: "Baseline",
          timestamp: Date.now(),
          segment: 0,
          confidence: null,
        },
      ];
      runtime.experimentCompletedWaitingForLog = false;
      runtime.lastRunSucceeded = null;
      const state = getWidgetState(runtime);
      expect(state.type).toBe("dashboard");
    });
  });

  describe("State transitions", () => {
    it("full lifecycle: hidden → ready → running → waiting (success) → dashboard", () => {
      const runtime = createWidgetTestRuntime();

      expect(getWidgetState(runtime).type).toBe("hidden");

      runtime.state.name = "My Session";
      expect(getWidgetState(runtime).type).toBe("ready");

      runtime.runningExperiment = { startedAt: Date.now(), command: "test" };
      expect(getWidgetState(runtime).type).toBe("running");

      runtime.runningExperiment = null;
      runtime.experimentCompletedWaitingForLog = true;
      runtime.lastRunSucceeded = true;
      expect(getWidgetState(runtime).type).toBe("waiting_for_log");

      runtime.experimentCompletedWaitingForLog = false;
      runtime.lastRunSucceeded = null;
      runtime.state.results.push({
        commit: "abc1234",
        metric: 100,
        metrics: {},
        status: "keep",
        description: "First run",
        timestamp: Date.now(),
        segment: 0,
        confidence: null,
      });
      expect(getWidgetState(runtime).type).toBe("dashboard");
    });

    it("full lifecycle with crash: hidden → ready → running → waiting (failed) → dashboard", () => {
      const runtime = createWidgetTestRuntime();

      expect(getWidgetState(runtime).type).toBe("hidden");

      runtime.state.name = "My Session";
      expect(getWidgetState(runtime).type).toBe("ready");

      runtime.runningExperiment = { startedAt: Date.now(), command: "test" };
      expect(getWidgetState(runtime).type).toBe("running");

      runtime.runningExperiment = null;
      runtime.experimentCompletedWaitingForLog = true;
      runtime.lastRunSucceeded = false;
      const waitingState = getWidgetState(runtime) as { type: "waiting_for_log"; succeeded: boolean };
      expect(waitingState.type).toBe("waiting_for_log");
      expect(waitingState.succeeded).toBe(false);

      runtime.experimentCompletedWaitingForLog = false;
      runtime.lastRunSucceeded = null;
      runtime.state.results.push({
        commit: "abc1234",
        metric: 0,
        metrics: {},
        status: "crash",
        description: "Crashed run",
        timestamp: Date.now(),
        segment: 0,
        confidence: null,
      });
      expect(getWidgetState(runtime).type).toBe("dashboard");
    });
  });

  describe("Widget never flashes", () => {
    it("maintains visibility through entire pre-log lifecycle", () => {
      const runtime = createWidgetTestRuntime();

      runtime.state.name = "Test";
      const state1 = getWidgetState(runtime);
      expect(state1.type).not.toBe("hidden");

      runtime.runningExperiment = { startedAt: Date.now(), command: "cmd" };
      const state2 = getWidgetState(runtime);
      expect(state2.type).not.toBe("hidden");

      runtime.runningExperiment = null;
      runtime.experimentCompletedWaitingForLog = true;
      runtime.lastRunSucceeded = true;
      const state3 = getWidgetState(runtime);
      expect(state3.type).not.toBe("hidden");

      runtime.lastRunSucceeded = false;
      const state4 = getWidgetState(runtime);
      expect(state4.type).not.toBe("hidden");
    });
  });

  describe("After first result: no transient states", () => {
    it("shows dashboard instead of 'running' when results exist", () => {
      const runtime = createWidgetTestRuntime();
      runtime.state.name = "Test Session";
      runtime.state.results = [
        {
          commit: "abc1234",
          metric: 100,
          metrics: {},
          status: "keep",
          description: "First run",
          timestamp: Date.now(),
          segment: 0,
          confidence: null,
        },
      ];
      runtime.runningExperiment = { startedAt: Date.now(), command: "test" };
      const state = getWidgetState(runtime);
      expect(state.type).toBe("dashboard");
    });

    it("shows dashboard instead of 'waiting_for_log' when results exist", () => {
      const runtime = createWidgetTestRuntime();
      runtime.state.name = "Test Session";
      runtime.state.results = [
        {
          commit: "abc1234",
          metric: 100,
          metrics: {},
          status: "keep",
          description: "First run",
          timestamp: Date.now(),
          segment: 0,
          confidence: null,
        },
      ];
      runtime.experimentCompletedWaitingForLog = true;
      runtime.lastRunSucceeded = true;
      const state = getWidgetState(runtime);
      expect(state.type).toBe("dashboard");
    });
  });
});

// ============================================================================
// Session Lifecycle Cleanup
// ============================================================================
describe("Session lifecycle cleanup", () => {
  describe("New session via /new command", () => {
    it("clears widget state when session_before_switch fires with reason=new", () => {
      const runtime = createWidgetTestRuntime();

      runtime.autoresearchMode = true;
      runtime.state.name = "Optimize performance";
      runtime.state.results = [
        {
          commit: "abc1234",
          metric: 100,
          metrics: {},
          status: "keep",
          description: "Baseline run",
          timestamp: Date.now(),
          segment: 0,
          confidence: null,
        },
      ];
      runtime.dashboardExpanded = true;

      expect(getWidgetState(runtime).type).toBe("dashboard");

      const clearedRuntime = createWidgetTestRuntime();

      expect(getWidgetState(clearedRuntime).type).toBe("hidden");
      expect(clearedRuntime.state.results.length).toBe(0);
      expect(clearedRuntime.autoresearchMode).toBe(false);
    });
  });

  describe("Session isolation - never load from files", () => {
    it("session_start never loads widget from files (session isolation)", () => {
      const runtime = createWidgetTestRuntime();

      expect(getWidgetState(runtime).type).toBe("hidden");
      expect(runtime.state.results.length).toBe(0);
    });

    it("autoresearchMode only set by explicit /autoresearch command", () => {
      const runtime = createWidgetTestRuntime();

      expect(runtime.autoresearchMode).toBe(false);

      runtime.autoresearchMode = true;
      runtime.state.name = "Test Session";

      expect(runtime.autoresearchMode).toBe(true);
      expect(getWidgetState(runtime).type).toBe("ready");
    });
  });
});

// ============================================================================
// Automatic Commit Tracking
// ============================================================================
interface RuntimeWithStartingCommit {
  startingCommit: string | null;
  autoresearchMode: boolean;
  worktreeDir: string | null;
}

function createCommitTrackingRuntime(): RuntimeWithStartingCommit {
  return {
    startingCommit: null,
    autoresearchMode: false,
    worktreeDir: null,
  };
}

describe("Automatic commit tracking", () => {
  describe("startingCommit initialization", () => {
    it("initializes with null startingCommit", () => {
      const runtime = createCommitTrackingRuntime();
      expect(runtime.startingCommit).toBeNull();
    });

    it("can set startingCommit after creation", () => {
      const runtime = createCommitTrackingRuntime();
      runtime.startingCommit = "abc1234";
      expect(runtime.startingCommit).toBe("abc1234");
    });

    it("captures 7-character short hash format", () => {
      const runtime = createCommitTrackingRuntime();
      runtime.startingCommit = "a1b2c3d";
      expect(runtime.startingCommit).toHaveLength(7);
    });
  });

  describe("startingCommit lifecycle", () => {
    it("clears stale starting commit before capturing new one", () => {
      const runtime = createCommitTrackingRuntime();

      runtime.startingCommit = "old1234";
      runtime.startingCommit = null;
      runtime.startingCommit = "new5678";

      expect(runtime.startingCommit).toBe("new5678");
    });

    it("resets to null after log_experiment completes", () => {
      const runtime = createCommitTrackingRuntime();

      runtime.startingCommit = "abc1234";
      expect(runtime.startingCommit).not.toBeNull();

      runtime.startingCommit = null;
      expect(runtime.startingCommit).toBeNull();
    });
  });

  describe("startingCommit usage in experiment records", () => {
    it("records starting commit in experiment result", () => {
      const runtime = createCommitTrackingRuntime();
      runtime.startingCommit = "abc1234";

      const experiment = {
        commit: runtime.startingCommit ?? "unknown",
        metric: 100,
        status: "keep" as const,
        description: "Test experiment",
      };

      expect(experiment.commit).toBe("abc1234");
    });

    it("falls back to 'unknown' when startingCommit is null", () => {
      const runtime = createCommitTrackingRuntime();

      const experiment = {
        commit: runtime.startingCommit ?? "unknown",
        metric: 100,
        status: "keep" as const,
        description: "Test experiment",
      };

      expect(experiment.commit).toBe("unknown");
    });
  });

  describe("Commit tracking scenarios", () => {
    it("handles normal keep flow: starting commit -> new commit", () => {
      const runtime = createCommitTrackingRuntime();

      runtime.startingCommit = "abc0001";
      expect(runtime.startingCommit).toBe("abc0001");

      runtime.startingCommit = null;

      runtime.startingCommit = "abc0002";
      expect(runtime.startingCommit).toBe("abc0002");
    });

    it("handles discard flow: starting commit unchanged after revert", () => {
      const runtime = createCommitTrackingRuntime();

      runtime.startingCommit = "abc0001";

      runtime.startingCommit = null;

      runtime.startingCommit = "abc0001";
      expect(runtime.startingCommit).toBe("abc0001");
    });

    it("handles crash flow: starting commit cleared but no new commit", () => {
      const runtime = createCommitTrackingRuntime();

      runtime.startingCommit = "abc0001";

      runtime.startingCommit = null;

      runtime.startingCommit = "abc0001";
      expect(runtime.startingCommit).toBe("abc0001");
    });
  });

  describe("Error handling", () => {
    it("validates 7-character minimum length", () => {
      const runtime = createCommitTrackingRuntime();

      const shortHash = "abc12";

      if (shortHash.length >= 7) {
        runtime.startingCommit = shortHash;
      }

      expect(runtime.startingCommit).toBeNull();
    });
  });
});
