/**
 * Dashboard table rendering for experiment results
 */

import type { Theme } from '@mariozechner/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@mariozechner/pi-tui';
import type { ExperimentState, ExperimentResult } from '../types/index.js';
import { formatNum, isBetter } from '../utils/index.js';
import { renderScatterPlot } from './scatter-plot.js';

/**
 * Render dashboard lines as pure text (no UI deps)
 * Returns array of strings ready for display
 */
export function renderDashboardLines(
  st: ExperimentState,
  width: number,
  th: Theme,
  maxRows: number = 6,
  worktreePath: string | null = null
): string[] {
  const lines: string[] = [];

  if (st.results.length === 0) {
    lines.push(`  ${th.fg('dim', 'No experiments yet.')}`);
    return lines;
  }

  const cur = st.results;
  const kept = cur.filter((r) => r.status === 'keep').length;
  const discarded = cur.filter((r) => r.status === 'discard').length;
  const crashed = cur.filter((r) => r.status === 'crash').length;
  const checksFailed = cur.filter((r) => r.status === 'checks_failed').length;

  const baseline = st.bestMetric;
  const baselineRunNumber = st.results.length > 0 ? 1 : null;
  const baselineSec = st.results.length > 0 ? (st.results[0].metrics ?? {}) : {};

  // Find best kept primary metric and its run number
  let bestPrimary: number | null = null;
  let bestSecondary: Record<string, number> = {};
  let bestRunNum = 0;
  for (let i = st.results.length - 1; i >= 0; i--) {
    const r = st.results[i];
    if (r.status === 'keep' && r.metric > 0) {
      if (bestPrimary === null || isBetter(r.metric, bestPrimary, st.bestDirection)) {
        bestPrimary = r.metric;
        bestSecondary = r.metrics ?? {};
        bestRunNum = i + 1;
      }
    }
  }

  // Runs summary
  const confSuffix =
    st.confidence !== null
      ? (() => {
          const confStr = st.confidence!.toFixed(1);
          const confColor: Parameters<typeof th.fg>[0] =
            st.confidence! >= 2.0 ? 'success' : st.confidence! >= 1.0 ? 'warning' : 'error';
          return `  ${th.fg(confColor, `(conf: ${confStr}×)`)}`;
        })()
      : '';
  lines.push(
    truncateToWidth(
      `  ${th.fg('muted', 'Runs:')} ${th.fg('text', String(st.results.length))}` +
        `  ${th.fg('success', `${kept} kept`)}` +
        confSuffix +
        (discarded > 0 ? `  ${th.fg('warning', `${discarded} discarded`)}` : '') +
        (crashed > 0 ? `  ${th.fg('error', `${crashed} crashed`)}` : '') +
        (checksFailed > 0 ? `  ${th.fg('error', `${checksFailed} checks failed`)}` : ''),
      width
    )
  );

  // Worktree path (if in isolated worktree)
  if (worktreePath) {
    lines.push(
      truncateToWidth(
        `  ${th.fg('muted', 'Worktree:')} ${th.fg('dim', `📁 ${worktreePath}`)}`,
        width
      )
    );
  }

  // Baseline: first run's primary metric
  const baselineSuffix = baselineRunNumber === null ? '' : ` #${baselineRunNumber}`;
  lines.push(
    truncateToWidth(
      `  ${th.fg('muted', 'Baseline:')} ${th.fg('muted', `★ ${st.metricName}: ${formatNum(baseline, st.metricUnit)}${baselineSuffix}`)}`,
      width
    )
  );

  // Progress: best primary metric with delta + run number
  if (bestPrimary !== null) {
    let progressLine = `  ${th.fg('muted', 'Progress:')} ${th.fg('warning', th.bold(`★ ${st.metricName}: ${formatNum(bestPrimary, st.metricUnit)}`))}${th.fg('dim', ` #${bestRunNum}`)}`;

    if (baseline !== null && baseline !== 0 && bestPrimary !== baseline) {
      const pct = ((bestPrimary - baseline) / baseline) * 100;
      const sign = pct > 0 ? '+' : '';
      const color = isBetter(bestPrimary, baseline, st.bestDirection) ? 'success' : 'error';
      progressLine += th.fg(color, ` (${sign}${pct.toFixed(1)}%)`);
    }

    lines.push(truncateToWidth(progressLine, width));

    // Show target if set
    if (st.targetValue !== null) {
      const reached =
        st.bestDirection === 'lower'
          ? bestPrimary <= st.targetValue
          : bestPrimary >= st.targetValue;
      const targetColor: Parameters<typeof th.fg>[0] = reached ? 'success' : 'muted';
      const targetIcon = reached ? '🎯' : '→';
      lines.push(
        truncateToWidth(
          `  ${th.fg('muted', 'Target:')}   ${th.fg(targetColor, `${targetIcon} ${formatNum(st.targetValue, st.metricUnit)}${reached ? ' ✓ REACHED' : ''}`)}`,
          width
        )
      );
    }

    // Progress secondary metrics — with "Metrics:" label for consistency
    if (st.secondaryMetrics.length > 0) {
      // Build individually-colored parts
      const secParts: string[] = [];
      for (const sm of st.secondaryMetrics) {
        const val = bestSecondary[sm.name];
        const bv = baselineSec[sm.name];
        if (val !== undefined) {
          let part = th.fg('muted', `${sm.name}: ${formatNum(val, sm.unit)}`);
          if (bv !== undefined && bv !== 0 && val !== bv) {
            const p = ((val - bv) / bv) * 100;
            const s = p > 0 ? '+' : '';
            const c = val <= bv ? 'success' : 'error';
            part += th.fg(c, ` ${s}${p.toFixed(1)}%`);
          }
          secParts.push(part);
        }
      }

      // Flow-wrap parts into lines with "Metrics:" label on first line
      if (secParts.length > 0) {
        const metricsLabel = th.fg('muted', 'Metrics:');
        const tilde = th.fg('muted', '~');
        const prefix = `  ${metricsLabel}  ${tilde} `;
        const prefixWidth = visibleWidth(prefix);
        const maxLineW = width - prefixWidth;

        let curLine = '';
        let curVisW = 0;
        let isFirstLine = true;

        for (const part of secParts) {
          const partVisW = visibleWidth(part);
          const sep = curLine ? '  ' : '';

          if (curLine && curVisW + sep.length + partVisW > maxLineW) {
            const linePrefix = isFirstLine ? prefix : ' '.repeat(prefixWidth);
            lines.push(truncateToWidth(`${linePrefix}${curLine}`, width));
            curLine = part;
            curVisW = partVisW;
            isFirstLine = false;
          } else {
            curLine += sep + part;
            curVisW += sep.length + partVisW;
          }
        }
        if (curLine) {
          const linePrefix = isFirstLine ? prefix : ' '.repeat(prefixWidth);
          lines.push(truncateToWidth(`${linePrefix}${curLine}`, width));
        }
      }
    }
  }

  // Chart visualization - only in fullscreen mode (maxRows === 0)
  if (maxRows === 0 && st.results.length > 0) {
    lines.push('');
    lines.push(th.fg('muted', '  Chart:'));
    const chartLines = renderScatterPlot(st.results, st.metricUnit, width, th);
    lines.push(...chartLines);
  }

  lines.push('');

  // Determine visible rows for column sizing
  const effectiveMax = maxRows <= 0 ? st.results.length : maxRows;
  const startIdx = Math.max(0, st.results.length - effectiveMax);
  const visibleRows = st.results.slice(startIdx);

  // Filter secondary metrics that have at least one value in visible rows
  const secMetrics = st.secondaryMetrics.filter((sm) =>
    visibleRows.some((r) => (r.metrics ?? {})[sm.name] !== undefined)
  );

  // === SMART COLUMN WIDTH CALCULATION ===
  // Priority: idx, commit, primary, [secondary metrics...], status, description
  // Description uses remaining space when no secondaries, else capped at 25%

  const minGap = 2; // minimum spaces between columns

  // Calculate content widths by scanning visible rows
  function contentWidth(values: (string | undefined)[], header: string): number {
    const maxContent = Math.max(
      header.length,
      ...values.filter(Boolean).map((v) => visibleWidth(v!))
    );
    return maxContent;
  }

  const rowIndices = visibleRows.map((_, i) => String(startIdx + i + 1));
  const commits = visibleRows.map((r) => r.commit);
  const primaryValues = visibleRows.map((r) => formatNum(r.metric, st.metricUnit));
  const statuses = visibleRows.map((r) => r.status);

  const idxW = contentWidth(rowIndices, '#');
  const commitW = contentWidth(commits, 'commit');
  const primaryW = contentWidth(primaryValues, '★ ' + st.metricName);
  const statusW = contentWidth(statuses, 'status');

  // Calculate secondary metric content widths
  const secWidths = secMetrics.map((sm) => {
    const values = visibleRows.map((r) => {
      const val = (r.metrics ?? {})[sm.name];
      return val !== undefined ? formatNum(val, sm.unit) : undefined;
    });
    return { name: sm.name, width: contentWidth(values, sm.name) };
  });

  // Determine how many columns we could potentially show (for capping)
  const totalPotentialCols = 5 + secMetrics.length; // idx, commit, primary, status, desc + secondaries
  const maxColWidth = Math.floor(width / totalPotentialCols);

  // Essential columns (idx, commit, primary, status) always show full content
  const cappedIdxW = idxW + minGap;
  const cappedCommitW = commitW + minGap;
  const cappedPrimaryW = primaryW + minGap;
  const cappedStatusW = statusW + minGap;
  // Secondary metrics use FULL content width (not capped)
  const finalSecWidths = secWidths.map((sw) => ({
    ...sw,
    width: sw.width + minGap,
  }));

  // Fixed columns width (essential columns always shown)
  const fixedColsW = cappedIdxW + cappedCommitW + cappedPrimaryW + cappedStatusW;

  // Calculate how many secondary metrics actually fit
  // Reserve at least 25% of width or 25 chars for description (whichever is larger)
  let visibleSecCount = 0;
  let accumulatedSecW = 0;
  const minDescWidth = Math.max(25, Math.floor(width * 0.25));

  for (let i = 0; i < finalSecWidths.length; i++) {
    const secW = finalSecWidths[i].width;
    // Check if this secondary metric fits
    // Must reserve: accumulated secondaries + this one + ellipsis (5 chars if any would be hidden) + min description
    const wouldHaveHidden = finalSecWidths.length > i + 1;
    const neededWidth =
      fixedColsW + accumulatedSecW + secW + (wouldHaveHidden ? 5 : 0) + minDescWidth;
    if (neededWidth < width) {
      visibleSecCount++;
      accumulatedSecW += secW;
    } else {
      break;
    }
  }

  // Show ellipsis column if there are hidden secondary metrics
  const ellipsisW = visibleSecCount < finalSecWidths.length ? minGap + 3 : 0; // 5 for "...  " (3 dots + 2 space gap)

  // Description uses all remaining width (minimum enforced by secondary fitting logic above)
  const descW = width - fixedColsW - accumulatedSecW - ellipsisW;

  // Final column config
  const col = {
    idx: cappedIdxW,
    commit: cappedCommitW,
    primary: cappedPrimaryW,
    status: cappedStatusW,
    desc: descW,
  };
  const visibleSecMetrics = secMetrics.slice(0, visibleSecCount);
  const visibleSecWidths = finalSecWidths.slice(0, visibleSecCount);

  // Helper to fit text within column width (including the 2-space gap)
  // If text is too long, truncates and adds "..."
  const fit = (s: string, colW: number) => {
    const contentW = colW - minGap; // space for actual content (gap is trailing space)
    const visW = visibleWidth(s);
    if (visW <= contentW) return s.padEnd(colW);
    // Need to truncate - reserve 3 chars for "..."
    return truncateToWidth(s, contentW - 3) + '...';
  };

  // Table header
  let headerLine =
    `  ${th.fg('muted', fit('#', col.idx))}` +
    `${th.fg('muted', fit('commit', col.commit))}` +
    `${th.fg('warning', th.bold(fit('★ ' + st.metricName, col.primary)))}`;

  for (let i = 0; i < visibleSecMetrics.length; i++) {
    const sm = visibleSecMetrics[i];
    const w = visibleSecWidths[i].width;
    // Truncate secondary metric names if needed
    headerLine += th.fg('muted', truncateToWidth(sm.name, w - minGap).padEnd(w));
  }

  if (ellipsisW > 0) {
    headerLine += th.fg('dim', '...'.padEnd(ellipsisW));
  }

  headerLine += `${th.fg('muted', fit('status', col.status))}` + `${th.fg('muted', 'description')}`;

  lines.push(truncateToWidth(headerLine, width));
  lines.push(truncateToWidth(`  ${th.fg('borderMuted', '─'.repeat(width - 4))}`, width));

  // Baseline values for delta display
  const baselinePrimary = st.results.length > 0 ? st.results[0].metric : null;
  const baselineSecondary = st.results.length > 0 ? (st.results[0].metrics ?? {}) : {};

  // Show max 6 recent runs, with a note about hidden earlier ones
  if (startIdx > 0) {
    lines.push(
      truncateToWidth(
        `  ${th.fg('dim', `… ${startIdx} earlier run${startIdx === 1 ? '' : 's'}`)}`,
        width
      )
    );
  }

  for (let i = startIdx; i < st.results.length; i++) {
    const r = st.results[i];
    const isBaseline = i === 0;

    const color =
      r.status === 'keep'
        ? 'success'
        : r.status === 'crash' || r.status === 'checks_failed'
          ? 'error'
          : 'warning';

    // Primary metric with color coding
    const primaryStr = formatNum(r.metric, st.metricUnit);
    let primaryColor: Parameters<typeof th.fg>[0] = 'text';
    if (isBaseline) {
      primaryColor = 'text';
    } else if (baselinePrimary !== null && r.status === 'keep' && r.metric > 0) {
      if (isBetter(r.metric, baselinePrimary, st.bestDirection)) {
        primaryColor = 'success';
      } else if (r.metric !== baselinePrimary) {
        primaryColor = 'error';
      }
    }

    const idxStr = th.fg('dim', String(i + 1).padEnd(col.idx));

    // Commit column: show "—" for non-kept, or the commit hash
    let commitDisplay = '';
    if (r.status !== 'keep') {
      commitDisplay = '—';
    } else {
      commitDisplay = r.commit;
    }
    const commitStr = th.fg('accent', fit(commitDisplay, col.commit));

    let rowLine =
      `  ${idxStr}` +
      `${commitStr}` +
      `${th.fg(primaryColor, th.bold(fit(primaryStr, col.primary)))}`;

    // Secondary metrics (only visible columns - show full values, no truncation)
    const rowMetrics = r.metrics ?? {};
    for (let si = 0; si < visibleSecMetrics.length; si++) {
      const sm = visibleSecMetrics[si];
      const w = visibleSecWidths[si].width;
      const val = rowMetrics[sm.name];
      if (val !== undefined) {
        const secStr = formatNum(val, sm.unit);
        let secColor: Parameters<typeof th.fg>[0] = 'text';
        if (isBaseline) {
          secColor = 'text';
        } else {
          const bv = baselineSecondary[sm.name];
          if (bv !== undefined && bv !== 0) {
            secColor = val <= bv ? 'success' : 'error';
          }
        }
        // Truncate if needed
        rowLine += th.fg(secColor, truncateToWidth(secStr, w - minGap).padEnd(w));
      } else {
        rowLine += th.fg('dim', '—'.padEnd(w));
      }
    }

    // Ellipsis column if metrics were truncated
    if (ellipsisW > 0) {
      const hasHiddenMetrics = secMetrics
        .slice(visibleSecCount)
        .some((sm) => rowMetrics[sm.name] !== undefined);
      rowLine += th.fg('dim', hasHiddenMetrics ? '...'.padEnd(ellipsisW) : ' '.repeat(ellipsisW));
    }

    rowLine +=
      `${th.fg(color, fit(r.status, col.status))}` +
      `${th.fg('muted', r.description.slice(0, col.desc))}`;

    lines.push(truncateToWidth(rowLine, width));
  }

  return lines;
}
