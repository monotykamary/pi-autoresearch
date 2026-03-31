/**
 * Dashboard widget state management and rendering
 */

import { Text, truncateToWidth } from '@mariozechner/pi-tui';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { AutoresearchRuntime } from '../types/index.js';
import { renderDashboardLines } from '../dashboard/index.js';
import { formatNum, isBetter, currentResults, findBaselineSecondary } from '../utils/index.js';
import { getDisplayWorktreePath } from '../git/index.js';

/** Dependencies needed by widget functions */
export interface WidgetContext {
  getRuntime: (ctx: ExtensionContext) => AutoresearchRuntime;
}

/**
 * Create the widget update function
 */
export function createWidgetUpdater(ctx: WidgetContext) {
  const { getRuntime } = ctx;

  return function updateWidget(extCtx: ExtensionContext): void {
    if (!extCtx.hasUI) return;

    const runtime = getRuntime(extCtx);
    const state = runtime.state;
    const width = process.stdout.columns || 120;

    // Once we have results, NEVER show transient states (running/done/failed/ready).
    // The dashboard (compact or expanded) is the only state after first log.
    if (state.results.length > 0) {
      if (runtime.dashboardExpanded) {
        // Expanded: full dashboard table rendered as widget
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
        // Collapsed: compact one-liner
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

          // Find best kept primary metric, its secondary values, and run number
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

          // Show delta % vs baseline for primary
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

          // Show confidence score
          if (state.confidence !== null) {
            const confStr = state.confidence.toFixed(1);
            const confColor: Parameters<typeof theme.fg>[0] =
              state.confidence >= 2.0 ? 'success' : state.confidence >= 1.0 ? 'warning' : 'error';
            parts.push(theme.fg('dim', ' │ '));
            parts.push(theme.fg(confColor, `conf: ${confStr}×`));
          }

          // Show target value progress
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

          // Show secondary metrics with delta %
          if (state.secondaryMetrics.length > 0) {
            let secContent = '';
            for (const sm of state.secondaryMetrics) {
              const val = bestSec[sm.name];
              const bv = baselineSec[sm.name];
              if (val !== undefined) {
                if (secContent) {
                  secContent += '  ';
                }
                secContent += `${sm.name}: ${formatNum(val, sm.unit)}`;
                if (bv !== undefined && bv !== 0 && val !== bv) {
                  const p = ((val - bv) / bv) * 100;
                  const s = p > 0 ? '+' : '';
                  const c = val <= bv ? 'success' : 'error';
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

          return new Text(truncateToWidth(parts.join(''), width), 0, 0);
        });
      }
      return;
    }

    // === TRANSIENT STATES (only before first result) ===

    // State 1: During run_experiment — actively running
    if (runtime.runningExperiment) {
      extCtx.ui.setWidget('autoresearch', (_tui, theme) => {
        const parts = [theme.fg('accent', '🔬'), theme.fg('warning', ' running…')];

        if (state.name) {
          parts.push(theme.fg('dim', ` │ ${state.name}`));
        }

        return new Text(truncateToWidth(parts.join(''), width), 0, 0);
      });
      return;
    }

    // State 2: After run_experiment, before log_experiment — finished, needs logging
    if (runtime.experimentCompletedWaitingForLog) {
      const succeeded = runtime.lastRunSucceeded;
      extCtx.ui.setWidget('autoresearch', (_tui, theme) => {
        const parts = [
          theme.fg('accent', '🔬'),
          succeeded ? theme.fg('text', ' done') : theme.fg('error', ' failed'),
          theme.fg('dim', succeeded ? ' — call log_experiment' : ' — rerunning experiment'),
        ];

        if (state.name) {
          parts.push(theme.fg('dim', ` │ ${state.name}`));
        }

        return new Text(truncateToWidth(parts.join(''), width), 0, 0);
      });
      return;
    }

    // State 3: After init_experiment, before any run_experiment — session ready
    if (state.name) {
      extCtx.ui.setWidget('autoresearch', (_tui, theme) => {
        const parts = [
          theme.fg('accent', '🔬'),
          theme.fg('text', ` ${state.name}`),
          theme.fg('dim', ' — ready'),
        ];

        return new Text(truncateToWidth(parts.join(''), width), 0, 0);
      });
      return;
    }

    // Hide widget if no session initialized and no activity
    extCtx.ui.setWidget('autoresearch', undefined);
  };
}

/**
 * Clear session UI state
 */
export function clearSessionUi(ctx: ExtensionContext, clearOverlay: () => void): void {
  clearOverlay();
  if (ctx.hasUI) {
    ctx.ui.setWidget('autoresearch', undefined);
  }
}
