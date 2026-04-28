/**
 * Session lifecycle event handlers (simplified for harness-based architecture)
 *
 * The harness server manages experiment state. This module only handles:
 * - Session cleanup (stop watchers, clear UI)
 * - Widget updates on state changes
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { AutoresearchRuntime } from '../types/index.js';
import { createExperimentState } from '../state/index.js';

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

/**
 * Register session lifecycle event handlers
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

  const reconstructState = createReconstructor(ctx);

  pi.on('session_before_switch', async (event, extCtx) => {
    stopJsonlWatcher(getRuntime(extCtx));
    if (event.reason === 'new') {
      clearSessionUi(extCtx);
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

  return {
    reconstructState,
    startWatcher: (extCtx: ExtensionContext) =>
      startJsonlWatcher(extCtx, getRuntime, reconstructState, updateWidget),
  };
}

/**
 * Reconstruct experiment state from autoresearch.jsonl
 */
function createReconstructor(ctx: LifecycleContext) {
  const { getRuntime, updateWidget } = ctx;

  return async function reconstructState(extCtx: ExtensionContext): Promise<void> {
    const runtime = getRuntime(extCtx);
    const preservedWorktreeDir = runtime.worktreeDir;

    runtime.state = createExperimentState();
    runtime.lastRunChecks = null;
    runtime.lastRunDuration = null;
    runtime.runningExperiment = null;
    runtime.experimentCompletedWaitingForLog = false;
    runtime.lastRunSucceeded = null;

    const workDir = preservedWorktreeDir ?? extCtx.cwd;
    const jsonlPath = path.join(workDir, 'autoresearch.jsonl');

    if (fs.existsSync(jsonlPath)) {
      try {
        const content = fs.readFileSync(jsonlPath, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.name && !entry.run) {
              runtime.state.name = entry.name;
              runtime.state.metricName = entry.metric_name ?? 'metric';
              runtime.state.metricUnit = entry.metric_unit ?? '';
              runtime.state.bestDirection = entry.direction ?? 'lower';
              runtime.state.targetValue = entry.target_value ?? null;
              runtime.state.maxExperiments = entry.max_experiments ?? null;
              runtime.state.currentSegment = entry.segment ?? 0;
            }
            if (entry.run && typeof entry.run === 'number') {
              runtime.state.results.push({
                commit: entry.commit ?? 'unknown',
                metric: entry.metric ?? 0,
                metrics: entry.metrics ?? {},
                status: entry.status ?? 'discard',
                description: entry.description ?? '',
                timestamp: entry.timestamp ?? Date.now(),
                segment: entry.segment ?? 0,
                confidence: entry.confidence ?? null,
                asi: entry.asi,
              });
            }
          } catch {}
        }

        if (runtime.state.results.length > 0) {
          runtime.state.bestMetric = runtime.state.results[0]?.metric ?? null;
        }
      } catch {}
    }

    if (preservedWorktreeDir) {
      runtime.worktreeDir = preservedWorktreeDir;
    }

    updateWidget(extCtx);
  };
}

/** Start watching autoresearch.jsonl for real-time UI updates */
function startJsonlWatcher(
  extCtx: ExtensionContext,
  getRuntime: (ctx: ExtensionContext) => AutoresearchRuntime,
  reconstructState: (ctx: ExtensionContext) => Promise<void>,
  updateWidget: (ctx: ExtensionContext) => void
): void {
  const runtime = getRuntime(extCtx);
  stopJsonlWatcher(runtime);

  const workDir = runtime.worktreeDir ?? extCtx.cwd;
  const jsonlPath = path.join(workDir, 'autoresearch.jsonl');

  if (!fs.existsSync(jsonlPath)) return;

  try {
    fs.watchFile(jsonlPath, { interval: 500 }, async (curr, prev) => {
      if (curr.mtime !== prev.mtime) {
        await reconstructState(extCtx);
        updateWidget(extCtx);
      }
    });

    runtime.jsonlWatcher = {
      close() {
        fs.unwatchFile(jsonlPath);
      },
    };
  } catch {}
}

/** Re-exported for external use */
export function createStateReconstructor(ctx: LifecycleContext) {
  return createReconstructor(ctx);
}
