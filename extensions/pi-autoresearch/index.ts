/**
 * autoresearch — Pi Extension (harness-based)
 *
 * Thin lifecycle shell for the autoresearch harness server.
 * All experiment interactions happen through the `pi-autoresearch` CLI,
 * which dispatches to a long-lived harness server holding experiment state.
 *
 * This extension only:
 *   - Installs the CLI shell alias on session start
 *   - Starts/stops the harness server
 *   - Manages the status widget and fullscreen dashboard
 *   - Provides the /autoresearch command
 *   - Writes session ID to disk for the harness server
 */

import { homedir } from 'node:os';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Text, truncateToWidth } from '@mariozechner/pi-tui';
import type {
  AutoresearchRuntime,
  ExperimentState,
  ExperimentResult,
  MetricDef,
} from './src/types/index.js';
import { createRuntimeStore, createExperimentState } from './src/state/index.js';
import {
  createWidgetUpdater,
  clearSessionUi,
  createFullscreenHandler,
  createFullscreenState,
  clearFullscreen,
  type FullscreenState,
} from './src/ui/index.js';
import { renderDashboardLines } from './src/dashboard/index.js';
import { formatNum, isBetter, currentResults, findBaselineSecondary } from './src/utils/index.js';
import { getDisplayWorktreePath } from './src/git/index.js';

// ---------------------------------------------------------------------------
// CLI path resolution
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function getProjectRoot(): string {
  return join(__dirname, '..', '..');
}

function getCliPath(): string {
  return join(getProjectRoot(), 'harness', 'cli.ts');
}

// ---------------------------------------------------------------------------
// Shell alias installation
// ---------------------------------------------------------------------------

function installShellAlias(): void {
  try {
    const agentBinDir = join(homedir(), '.pi', 'agent', 'bin');
    if (!fs.existsSync(agentBinDir)) {
      fs.mkdirSync(agentBinDir, { recursive: true });
    }
    const cliPath = getCliPath();
    const linkPath = join(agentBinDir, 'pi-autoresearch');

    const projectRoot = getProjectRoot();
    const wrapperContent = `#!/bin/sh
cd "${projectRoot}" 2>/dev/null
exec npx tsx "${cliPath}" "$@"
`;

    let currentContent: string | null = null;
    try {
      currentContent = fs.readFileSync(linkPath, 'utf-8');
    } catch {}
    if (currentContent !== wrapperContent) {
      fs.writeFileSync(linkPath, wrapperContent, { mode: 0o755 });
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Harness server lifecycle
// ---------------------------------------------------------------------------

interface HarnessServerController {
  start(): void;
  stop(): void;
}

function createHarnessServer(): HarnessServerController {
  let harnessProcess: ChildProcess | null = null;

  function start(): void {
    if (harnessProcess) return;
    if (process.env.PI_SWARM_SPAWNED === '1') return;

    const cliPath = getCliPath();
    const projectRoot = getProjectRoot();

    try {
      harnessProcess = spawnChild('npx', ['tsx', cliPath, '--start'], {
        cwd: projectRoot,
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
      });
      harnessProcess.unref();
    } catch {}
  }

  function stop(): void {
    if (!harnessProcess) return;
    try {
      harnessProcess.kill('SIGTERM');
    } catch {}
    harnessProcess = null;
  }

  return { start, stop };
}

// ---------------------------------------------------------------------------
// Widget (reads from harness server state via JSONL file watcher)
// ---------------------------------------------------------------------------

function createHarnessWidgetUpdater(getRuntime: (ctx: ExtensionContext) => AutoresearchRuntime) {
  return function updateWidget(extCtx: ExtensionContext): void {
    if (!extCtx.hasUI) return;

    const runtime = getRuntime(extCtx);
    const state = runtime.state;
    const width = process.stdout.columns || 120;

    if (state.results.length > 0) {
      if (runtime.dashboardExpanded) {
        extCtx.ui.setWidget('autoresearch', (_tui, theme) => {
          const lines: string[] = [];
          const hintText = ' ctrl+x collapse • ctrl+shift+x fullscreen ';
          const labelPrefix = '🔬 autoresearch';
          let nameStr = state.name ? `: ${state.name}` : '';
          const maxLabelLen = width - 3 - 2 - hintText.length - 1;
          let label = labelPrefix + nameStr;
          if (label.length > maxLabelLen) {
            label = label.slice(0, maxLabelLen - 1) + '…';
          }
          const fillLen = Math.max(0, width - 3 - 1 - label.length - 1 - hintText.length);
          const leftBorder = '───';
          const rightBorder = '─'.repeat(fillLen);
          lines.push(
            truncateToWidth(
              theme.fg('borderMuted', leftBorder) +
                theme.fg('accent', ' ' + label + ' ') +
                theme.fg('borderMuted', rightBorder) +
                theme.fg('dim', hintText),
              width
            )
          );
          const worktreeDisplay = runtime.worktreeDir
            ? getDisplayWorktreePath(extCtx.cwd, runtime.worktreeDir)
            : null;
          lines.push(...renderDashboardLines(state, width, theme, 6, worktreeDisplay));
          return new Text(lines.join('\n'), 0, 0);
        });
      } else {
        extCtx.ui.setWidget('autoresearch', (_tui, theme) => {
          const cur = currentResults(state.results, state.currentSegment);
          const kept = cur.filter((r) => r.status === 'keep').length;
          const crashed = cur.filter((r) => r.status === 'crash').length;
          const checksFailed = cur.filter((r) => r.status === 'checks_failed').length;
          const baseline = state.bestMetric;
          const baselineSec = findBaselineSecondary(
            state.results,
            state.currentSegment,
            state.secondaryMetrics
          );

          let bestPrimary: number | null = null;
          let bestSec: Record<string, number> = {};
          let bestRunNum = 0;
          for (let i = state.results.length - 1; i >= 0; i--) {
            const r = state.results[i];
            if (r.segment !== state.currentSegment) continue;
            if (r.status === 'keep' && r.metric > 0) {
              if (bestPrimary === null || isBetter(r.metric, bestPrimary, state.bestDirection)) {
                bestPrimary = r.metric;
                bestSec = r.metrics ?? {};
                bestRunNum = i + 1;
              }
            }
          }

          const displayVal = bestPrimary ?? baseline;
          const parts = [
            theme.fg('accent', '🔬'),
            theme.fg('muted', ` ${state.results.length} runs`),
            theme.fg('success', ` ${kept} kept`),
            crashed > 0 ? theme.fg('error', ` ${crashed}💥`) : '',
            checksFailed > 0 ? theme.fg('error', ` ${checksFailed}⚠`) : '',
            theme.fg('dim', ' │ '),
            theme.fg(
              'warning',
              theme.bold(`★ ${state.metricName}: ${formatNum(displayVal, state.metricUnit)}`)
            ),
            bestRunNum > 0 ? theme.fg('dim', ` #${bestRunNum}`) : '',
          ];

          if (
            baseline !== null &&
            bestPrimary !== null &&
            baseline !== 0 &&
            bestPrimary !== baseline
          ) {
            const pct = ((bestPrimary - baseline) / baseline) * 100;
            const sign = pct > 0 ? '+' : '';
            const deltaColor = isBetter(bestPrimary, baseline, state.bestDirection)
              ? 'success'
              : 'error';
            parts.push(theme.fg(deltaColor, ` (${sign}${pct.toFixed(1)}%)`));
          }

          if (state.confidence !== null) {
            const confStr = state.confidence.toFixed(1);
            const confColor: Parameters<typeof theme.fg>[0] =
              state.confidence >= 2.0 ? 'success' : state.confidence >= 1.0 ? 'warning' : 'error';
            parts.push(theme.fg('dim', ' │ '));
            parts.push(theme.fg(confColor, `conf: ${confStr}×`));
          }

          if (state.targetValue !== null && displayVal !== null) {
            const reached =
              state.bestDirection === 'lower'
                ? displayVal <= state.targetValue
                : displayVal >= state.targetValue;
            parts.push(theme.fg('dim', ' │ '));
            if (reached) {
              parts.push(
                theme.fg('success', `🎯 ${formatNum(state.targetValue, state.metricUnit)} ✓`)
              );
            } else {
              parts.push(theme.fg('muted', `→ ${formatNum(state.targetValue, state.metricUnit)}`));
            }
          }

          if (state.secondaryMetrics.length > 0) {
            let secContent = '';
            for (const sm of state.secondaryMetrics) {
              const val = bestSec[sm.name];
              const bv = baselineSec[sm.name];
              if (val !== undefined) {
                if (secContent) secContent += '  ';
                secContent += `${sm.name}: ${formatNum(val, sm.unit)}`;
                if (bv !== undefined && bv !== 0 && val !== bv) {
                  const p = ((val - bv) / bv) * 100;
                  const s = p > 0 ? '+' : '';
                  secContent += ` ${s}${p.toFixed(1)}%`;
                }
              }
            }
            if (secContent) {
              parts.push(theme.fg('dim', ' │ '));
              parts.push(theme.fg('muted', secContent));
            }
          }

          if (state.name) {
            parts.push(theme.fg('dim', ` │ ${state.name}`));
          }

          parts.push(theme.fg('dim', '  (ctrl+x expand • ctrl+shift+x fullscreen)'));

          return new Text(truncateToWidth(parts.join(''), width), width);
        });
      }
      return;
    }

    // No results yet — show session status
    if (state.name) {
      extCtx.ui.setWidget('autoresearch', (_tui, theme) => {
        const parts = [
          theme.fg('accent', '🔬'),
          theme.fg('text', ` ${state.name}`),
          theme.fg('dim', ' — ready'),
        ];
        return new Text(truncateToWidth(parts.join(''), width), width);
      });
      return;
    }

    extCtx.ui.setWidget('autoresearch', undefined);
  };
}

// ---------------------------------------------------------------------------
// JSONL file watcher — reconstructs state when harness server writes to JSONL
// ---------------------------------------------------------------------------

function startJsonlWatcher(
  extCtx: ExtensionContext,
  getRuntime: (ctx: ExtensionContext) => AutoresearchRuntime,
  updateWidget: (ctx: ExtensionContext) => void
): void {
  const runtime = getRuntime(extCtx);
  if (runtime.jsonlWatcher) return;

  const workDir = runtime.worktreeDir ?? extCtx.cwd;
  const jsonlPath = join(workDir, 'autoresearch.jsonl');
  if (!fs.existsSync(jsonlPath)) return;

  try {
    fs.watchFile(jsonlPath, { interval: 500 }, () => {
      reconstructStateFromJsonl(runtime, workDir);
      updateWidget(extCtx);
    });

    runtime.jsonlWatcher = {
      close() {
        fs.unwatchFile(jsonlPath);
      },
    };
  } catch {}
}

function reconstructStateFromJsonl(runtime: AutoresearchRuntime, workDir: string): void {
  const jsonlPath = join(workDir, 'autoresearch.jsonl');
  if (!fs.existsSync(jsonlPath)) return;

  const preservedWorktreeDir = runtime.worktreeDir;
  runtime.state = createExperimentState();

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
          runtime.state.results.push(experiment);
        }
      } catch {}
    }

    if (runtime.state.results.length > 0) {
      runtime.state.bestMetric = runtime.state.results[0]?.metric ?? null;
      runtime.state.confidence = null; // computed on server side
    }
  } catch {}

  if (preservedWorktreeDir) runtime.worktreeDir = preservedWorktreeDir;
}

// ---------------------------------------------------------------------------
// Session ID bridge — writes session ID to disk for harness server / CLI
// ---------------------------------------------------------------------------

function writeSessionId(ctx: ExtensionContext, dirs: { base: string }): void {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    if (sessionId) {
      const sessionFilePath = join(dirs.base, 'session-id');
      const sessionDir = join(dirs.base);
      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(sessionFilePath, sessionId, 'utf-8');
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function autoresearchExtension(pi: ExtensionAPI) {
  const runtimeStore = createRuntimeStore();
  const getSessionKey = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const getRuntime = (ctx: ExtensionContext): AutoresearchRuntime =>
    runtimeStore.ensure(getSessionKey(ctx));

  const uiState: FullscreenState = createFullscreenState();
  const clearOverlay = () => clearFullscreen(uiState);

  const updateWidget = createHarnessWidgetUpdater(getRuntime);

  const harnessServer = createHarnessServer();

  function getDirs() {
    const baseDir = join(process.cwd(), '.pi', 'autoresearch');
    return { base: baseDir };
  }

  // ===========================================================================
  // /autoresearch command
  // ===========================================================================

  pi.registerCommand('autoresearch', {
    description: 'Start, stop, or clear autoresearch mode',
    handler: async (args, extCtx) => {
      const runtime = getRuntime(extCtx);
      const trimmedArgs = (args ?? '').trim();
      const command = trimmedArgs.toLowerCase();

      if (!trimmedArgs) {
        extCtx.ui.notify('Usage: /autoresearch [off|clear|<text>]', 'info');
        return;
      }

      if (command === 'off') {
        runtime.autoresearchMode = false;
        runtime.dashboardExpanded = false;
        if (runtime.jsonlWatcher) {
          runtime.jsonlWatcher.close();
          runtime.jsonlWatcher = null;
        }
        clearSessionUi(extCtx, clearOverlay);
        extCtx.ui.notify('Autoresearch mode OFF', 'info');
        return;
      }

      if (command === 'clear') {
        if (runtime.jsonlWatcher) {
          runtime.jsonlWatcher.close();
          runtime.jsonlWatcher = null;
        }
        runtime.autoresearchMode = false;
        runtime.dashboardExpanded = false;
        runtime.state = createExperimentState();
        runtime.worktreeDir = null;
        updateWidget(extCtx);
        extCtx.ui.notify('Autoresearch cleared', 'info');
        return;
      }

      // Activate — delegate to CLI
      runtime.autoresearchMode = true;
      extCtx.ui.notify('Autoresearch mode ON — use pi-autoresearch CLI to run experiments', 'info');
      pi.sendUserMessage(
        `Autoresearch mode active: ${trimmedArgs}. Use pi-autoresearch activate, init, run, and log to run experiments.`
      );
    },
  });

  // ===========================================================================
  // Keyboard shortcuts
  // ===========================================================================

  pi.registerShortcut('ctrl+shift+a', {
    description: 'Toggle autoresearch dashboard',
    handler: async (ctx) => {
      const runtime = getRuntime(ctx);
      if (runtime.state.results.length === 0) {
        ctx.ui.notify('No experiments yet', 'info');
        return;
      }
      runtime.dashboardExpanded = !runtime.dashboardExpanded;
      updateWidget(ctx);
    },
  });

  const showFullscreen = createFullscreenHandler(uiState, { getRuntime });
  pi.registerShortcut('ctrl+shift+x', {
    description: 'Fullscreen autoresearch dashboard',
    handler: showFullscreen,
  });

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  pi.on('session_start', async (_event, ctx) => {
    installShellAlias();
    writeSessionId(ctx, getDirs());
    harnessServer.start();

    // Reconstruct state from existing JSONL
    const runtime = getRuntime(ctx);
    const sessionId = getSessionKey(ctx);

    // Auto-detect worktree
    if (!runtime.worktreeDir) {
      const { detectAutoresearchWorktree } = await import('./src/git/index.js');
      const detected = detectAutoresearchWorktree(ctx.cwd, sessionId);
      if (detected) {
        runtime.worktreeDir = detected;
      }
    }

    if (runtime.worktreeDir) {
      reconstructStateFromJsonl(runtime, runtime.worktreeDir);
      startJsonlWatcher(ctx, getRuntime, updateWidget);
      updateWidget(ctx);
    }
  });

  pi.on('session_before_switch', async (event, ctx) => {
    const runtime = getRuntime(ctx);
    if (runtime.jsonlWatcher) {
      runtime.jsonlWatcher.close();
      runtime.jsonlWatcher = null;
    }
    if (event.reason === 'new') {
      clearSessionUi(ctx, clearOverlay);
      runtimeStore.clear(getSessionKey(ctx));
    }
  });

  pi.on('session_before_switch', async () => {
    clearOverlay();
  });

  pi.on('session_shutdown', async (_e, ctx) => {
    const runtime = getRuntime(ctx);
    if (runtime.jsonlWatcher) {
      runtime.jsonlWatcher.close();
      runtime.jsonlWatcher = null;
    }
    clearSessionUi(ctx, clearOverlay);
    runtimeStore.clear(getSessionKey(ctx));
    harnessServer.stop();
  });
}
