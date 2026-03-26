/**
 * Session lifecycle event handlers
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AutoresearchRuntime, LogDetails } from "../types/index.js";
import {
  createExperimentState,
  resetSessionCounters,
  cloneExperimentState,
} from "../state/index.js";
import { computeConfidence } from "../utils/stats.js";
import { resolveWorkDir } from "../git/index.js";
import { BENCHMARK_GUARDRAIL, MAX_AUTORESUME_TURNS } from "../constants.js";

/** Dependencies needed by lifecycle handlers */
export interface LifecycleContext {
  pi: ExtensionAPI;
  getRuntime: (ctx: ExtensionContext) => AutoresearchRuntime;
  getSessionKey: (ctx: ExtensionContext) => string;
  runtimeStore: {
    clear: (key: string) => void;
  };
  updateWidget: (ctx: ExtensionContext) => void;
  clearSessionUi: (ctx: ExtensionContext) => void;
  clearOverlay: () => void;
}

/**
 * Reconstruct experiment state from session history
 */
export function createStateReconstructor(ctx: LifecycleContext) {
  const { getRuntime, updateWidget } = ctx;

  return function reconstructState(extCtx: ExtensionContext): void {
    const runtime = getRuntime(extCtx);

    // Preserve worktreeDir - it may have been set by /autoresearch command
    // and we don't want to lose it before init_experiment runs
    const preservedWorktreeDir = runtime.worktreeDir;

    runtime.lastRunChecks = null;
    runtime.lastRunDuration = null;
    runtime.runningExperiment = null;
    runtime.experimentCompletedWaitingForLog = false;
    runtime.lastRunSucceeded = null;
    runtime.lastAutoResumeTime = 0;
    runtime.experimentsThisSession = 0;
    runtime.autoResumeTurns = 0;
    runtime.state = createExperimentState();

    let state = runtime.state;

    // Only reconstruct from session history (THIS session only)
    // Session isolation: we never load from files on startup
    for (const entry of extCtx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "toolResult" || msg.toolName !== "log_experiment")
        continue;
      const details = msg.details as LogDetails | undefined;
      if (details?.state) {
        runtime.state = cloneExperimentState(details.state);
        state = runtime.state;
        if (!state.secondaryMetrics) state.secondaryMetrics = [];
        if (state.metricUnit === "s" && state.metricName === "metric") {
          state.metricUnit = "";
        }
        for (const r of state.results) {
          if (!r.metrics) r.metrics = {};
          if (r.confidence === undefined) r.confidence = null;
        }
        if (state.confidence === undefined) {
          state.confidence = computeConfidence(
            state.results,
            state.currentSegment,
            state.bestDirection
          );
        }
      }
    }

    updateWidget(extCtx);
  };
}

/**
 * Register all session lifecycle event handlers
 */
export function registerLifecycleHandlers(ctx: LifecycleContext): void {
  const {
    pi,
    getRuntime,
    getSessionKey,
    runtimeStore,
    updateWidget,
    clearSessionUi,
    clearOverlay,
  } = ctx;

  const reconstructState = createStateReconstructor(ctx);

  // Session events
  pi.on("session_start", async (_e, extCtx) => reconstructState(extCtx));
  pi.on("session_switch", async (_e, extCtx) => reconstructState(extCtx));
  pi.on("session_fork", async (_e, extCtx) => reconstructState(extCtx));
  pi.on("session_tree", async (_e, extCtx) => reconstructState(extCtx));

  // Clear UI when starting a new session via /new - before the switch happens
  pi.on("session_before_switch", async (event, extCtx) => {
    if (event.reason === "new") {
      clearSessionUi(extCtx);
      // Clear the runtime store for this session to ensure clean state
      runtimeStore.clear(getSessionKey(extCtx));
    }
  });

  pi.on("session_before_switch", async () => {
    clearOverlay();
  });

  pi.on("session_shutdown", async (_e, extCtx) => {
    clearSessionUi(extCtx);
    runtimeStore.clear(getSessionKey(extCtx));
  });

  // Reset per-session experiment counter when agent starts
  pi.on("agent_start", async (_event, extCtx) => {
    resetSessionCounters(getRuntime(extCtx));
  });

  // Clear running experiment state when agent stops; check ideas file for continuation
  pi.on("agent_end", async (_event, extCtx) => {
    const runtime = getRuntime(extCtx);
    runtime.runningExperiment = null;
    runtime.experimentCompletedWaitingForLog = false;
    runtime.lastRunSucceeded = null;

    if (!runtime.autoresearchMode) return;

    // Don't auto-resume if no experiments ran this session
    if (runtime.experimentsThisSession === 0) return;

    // Rate-limit auto-resume to once every 5 minutes
    const now = Date.now();
    if (now - runtime.lastAutoResumeTime < 5 * 60 * 1000) return;
    runtime.lastAutoResumeTime = now;

    if (runtime.autoResumeTurns >= MAX_AUTORESUME_TURNS) {
      extCtx.ui.notify(
        `Autoresearch auto-resume limit reached (${MAX_AUTORESUME_TURNS} turns)`,
        "info"
      );
      return;
    }

    const workDir = resolveWorkDir(extCtx.cwd, runtime);
    const ideasPath = path.join(workDir, "autoresearch.ideas.md");
    const hasIdeas = fs.existsSync(ideasPath);

    let resumeMsg =
      "Autoresearch loop ended (likely context limit). Resume the experiment loop — read autoresearch.md and git log for context.";
    if (hasIdeas) {
      resumeMsg +=
        " Check autoresearch.ideas.md for promising paths to explore. Prune stale/tried ideas.";
    }
    resumeMsg += ` ${BENCHMARK_GUARDRAIL}`;

    runtime.autoResumeTurns++;
    pi.sendUserMessage(resumeMsg);
  });
}
