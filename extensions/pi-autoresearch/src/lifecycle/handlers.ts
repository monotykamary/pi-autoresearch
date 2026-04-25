/**
 * Session lifecycle event handlers
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { AutoresearchRuntime, ExperimentResult } from '../types/index.js';
import {
  createExperimentState,
  resetSessionCounters,
  registerSecondaryMetrics,
} from '../state/index.js';
import { computeConfidence } from '../utils/stats.js';
import { resolveWorkDir } from '../git/index.js';
import { BENCHMARK_GUARDRAIL, MAX_AUTORESUME_TURNS } from '../constants.js';
import { deactivateAutoresearchTools, activateAutoresearchTools } from '../tools/activation.js';

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

/** Stop watching autoresearch.jsonl for changes */
function stopJsonlWatcher(runtime: AutoresearchRuntime): void {
  if (runtime.jsonlWatcher) {
    runtime.jsonlWatcher.close();
    runtime.jsonlWatcher = null;
  }
}

/** Start watching autoresearch.jsonl for real-time UI updates */
function startJsonlWatcher(
  extCtx: ExtensionContext,
  getRuntime: (ctx: ExtensionContext) => AutoresearchRuntime,
  reconstructState: (ctx: ExtensionContext) => Promise<void>,
  updateWidget: (ctx: ExtensionContext) => void
): void {
  const runtime = getRuntime(extCtx);

  // Stop any existing watcher
  stopJsonlWatcher(runtime);

  const workDir = resolveWorkDir(extCtx.cwd, runtime);
  const jsonlPath = path.join(workDir, 'autoresearch.jsonl');

  if (!fs.existsSync(jsonlPath)) {
    return;
  }

  try {
    // Use fs.watchFile for reliable cross-platform file watching
    fs.watchFile(jsonlPath, { interval: 500 }, async (curr, prev) => {
      if (curr.mtime !== prev.mtime) {
        // File changed - reload state
        await reconstructState(extCtx);
        updateWidget(extCtx);
      }
    });

    runtime.jsonlWatcher = {
      close() {
        fs.unwatchFile(jsonlPath);
      },
    };
  } catch {
    // Watch failed - ignore and rely on manual refresh
  }
}

/**
 * Reconstruct experiment state from autoresearch.jsonl (sole source of truth)
 */
export function createStateReconstructor(ctx: LifecycleContext) {
  const { getRuntime, updateWidget } = ctx;

  return async function reconstructState(extCtx: ExtensionContext): Promise<void> {
    const runtime = getRuntime(extCtx);

    // Preserve worktreeDir - it may have been set by /autoresearch command
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
    const workDir = resolveWorkDir(extCtx.cwd, runtime);
    const jsonlPath = path.join(workDir, 'autoresearch.jsonl');

    // Load from JSONL file (sole source of truth)
    if (fs.existsSync(jsonlPath)) {
      try {
        const content = fs.readFileSync(jsonlPath, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);

            // Config header (from init_experiment)
            if (entry.name && !entry.run) {
              state.name = entry.name;
              state.metricName = entry.metric_name ?? 'metric';
              state.metricUnit = entry.metric_unit ?? '';
              state.bestDirection = entry.direction ?? 'lower';
              state.targetValue = entry.target_value ?? null;
              state.maxExperiments = entry.max_experiments ?? null;
              state.currentSegment = entry.segment ?? 0;
            }

            // Experiment result (from log_experiment)
            if (entry.run && typeof entry.run === 'number') {
              const experiment: ExperimentResult = {
                commit: entry.commit ?? 'unknown',
                metric: entry.metric ?? 0,
                metrics: entry.metrics ?? {},
                status: entry.status ?? 'discard',
                description: entry.description ?? '',
                timestamp: entry.timestamp ?? Date.now(),
                segment: entry.segment ?? 0,
                confidence: entry.confidence ?? null,
                asi: entry.asi,
              };
              state.results.push(experiment);

              // Register secondary metrics
              if (experiment.metrics) {
                registerSecondaryMetrics(state, experiment.metrics);
              }
            }
          } catch {
            // Skip malformed lines
          }
        }

        // Recalculate derived state from loaded results
        if (state.results.length > 0) {
          // Recalculate baseline (first result overall)
          state.bestMetric = state.results[0]?.metric ?? null;

          // Recalculate confidence across all results
          state.confidence = computeConfidence(state.results, state.bestDirection);
        }

        runtime.state = state;
      } catch {
        // If JSONL is corrupted/unreadable, leave state empty
      }
    }

    // Restore preserved worktreeDir
    if (preservedWorktreeDir) {
      runtime.worktreeDir = preservedWorktreeDir;
    }

    updateWidget(extCtx);
  };
}

/**
 * Register all session lifecycle event handlers
 */
export function registerLifecycleHandlers(ctx: LifecycleContext): {
  reconstructState: (ctx: ExtensionContext) => Promise<void>;
  startWatcher: (ctx: ExtensionContext) => void;
} {
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

  // Session events - use session_start with reason instead of deprecated session_switch/session_fork
  // First: always ensure experiment tools start hidden (runs for ALL session start reasons)
  pi.on('session_start', async (_event, _extCtx) => {
    deactivateAutoresearchTools(pi);
  });

  // Then: for resumed/forked sessions with existing experiment data, re-activate tools
  pi.on('session_start', async (event, extCtx) => {
    // Only handle new, resume, and fork reasons (existing sessions)
    if (event.reason === 'startup' || event.reason === 'reload') return;

    // Auto-detect worktree for existing sessions
    const runtime = getRuntime(extCtx);
    if (!runtime.worktreeDir) {
      const { detectAutoresearchWorktree } = await import('../git/index.js');
      const detected = detectAutoresearchWorktree(extCtx.cwd, getSessionKey(extCtx));
      if (detected) {
        runtime.worktreeDir = detected;
      }
    }
    await reconstructState(extCtx);
    startJsonlWatcher(extCtx, getRuntime, reconstructState, updateWidget);

    // If session has existing experiment data, activate tools so the agent
    // can resume the loop (call init_experiment to re-enter autoresearch mode)
    if (runtime.state.results.length > 0) {
      activateAutoresearchTools(pi);
    }
  });

  // Clear UI when starting a new session via /new - before the switch happens
  pi.on('session_before_switch', async (event, extCtx) => {
    // Stop watcher on current session before switching
    stopJsonlWatcher(getRuntime(extCtx));
    if (event.reason === 'new') {
      clearSessionUi(extCtx);
      // Clear the runtime store for this session to ensure clean state
      runtimeStore.clear(getSessionKey(extCtx));
    }
  });

  pi.on('session_before_switch', async () => {
    clearOverlay();
  });

  pi.on('session_shutdown', async (_e, extCtx) => {
    stopJsonlWatcher(getRuntime(extCtx));
    clearSessionUi(extCtx);
    runtimeStore.clear(getSessionKey(extCtx));
  });

  // Reset per-session experiment counter when agent starts
  pi.on('agent_start', async (_event, extCtx) => {
    resetSessionCounters(getRuntime(extCtx));
  });

  // Clear running experiment state when agent stops; check ideas file for continuation
  pi.on('agent_end', async (_event, extCtx) => {
    const runtime = getRuntime(extCtx);
    runtime.runningExperiment = null;
    runtime.experimentCompletedWaitingForLog = false;
    runtime.lastRunSucceeded = null;

    if (!runtime.autoresearchMode) return;

    // Turn off autoresearchMode when agent legitimately stops (not mid-experiment)
    // This disables file redirection until init_experiment is called again
    // Note: we keep the experiment tools active so the model can call init_experiment
    // to resume (Ctrl+C, context limit, etc. are interrupts, not opt-outs)
    runtime.autoresearchMode = false;
    extCtx.ui.notify(
      'Autoresearch mode paused — file redirection disabled. Call init_experiment to resume.',
      'info'
    );

    // Don't auto-resume if no experiments ran this session
    if (runtime.experimentsThisSession === 0) return;

    // Rate-limit auto-resume to once every 5 minutes
    const now = Date.now();
    if (now - runtime.lastAutoResumeTime < 5 * 60 * 1000) return;
    runtime.lastAutoResumeTime = now;

    if (runtime.autoResumeTurns >= MAX_AUTORESUME_TURNS) {
      extCtx.ui.notify(
        `Autoresearch auto-resume limit reached (${MAX_AUTORESUME_TURNS} turns)`,
        'info'
      );
      return;
    }

    const workDir = resolveWorkDir(extCtx.cwd, runtime);
    const ideasPath = path.join(workDir, 'autoresearch.ideas.md');
    const hasIdeas = fs.existsSync(ideasPath);

    let resumeMsg =
      'Autoresearch loop ended (likely context limit). Resume the experiment loop — read autoresearch.md and git log for context.';
    if (hasIdeas) {
      resumeMsg +=
        ' Check autoresearch.ideas.md for promising paths to explore. Prune stale/tried ideas.';
    }
    resumeMsg += ` ${BENCHMARK_GUARDRAIL}`;

    runtime.autoResumeTurns++;
    pi.sendUserMessage(resumeMsg);
  });

  return {
    reconstructState,
    startWatcher: (extCtx: ExtensionContext) =>
      startJsonlWatcher(extCtx, getRuntime, reconstructState, updateWidget),
  };
}
