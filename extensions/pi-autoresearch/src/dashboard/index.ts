/**
 * Dashboard table rendering for autoresearch
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { ExperimentState, ExperimentResult } from "../types/index.js";
import {
  formatNum,
  isBetter,
  currentResults,
  findBaselineMetric,
  findBaselineSecondary,
  findBaselineRunNumber,
} from "../utils/index.js";

/**
 * Render scatter plot of experiment results
 * Shows keep/discard/crash as points on a 2D grid
 */
function renderScatterPlot(
  results: ExperimentResult[],
  segment: number,
  metricUnit: string,
  width: number,
  th: Theme,
  currentRunIndex?: number
): string[] {
  const lines: string[] = [];
  
  // Filter to current segment
  const segmentResults = results.filter(r => r.segment === segment);
  
  // Stratified sampling: 1 (first) + 19 (bucketed middle) + 10 (recent detail)
  const maxPoints = 30;
  const reservedForRecent = 10;
  
  let displayResults: ExperimentResult[];
  let runNumbers: number[];
  
  if (segmentResults.length <= maxPoints) {
    // Show all if they fit
    displayResults = segmentResults;
    runNumbers = displayResults.map((_, i) => i + 1);
  } else {
    const bucketableCount = maxPoints - reservedForRecent - 1; // 19
    const first = segmentResults[0];
    const recent = segmentResults.slice(-reservedForRecent);
    const middle = segmentResults.slice(1, -reservedForRecent);
    
    // Bucket the middle section
    const bucketSize = Math.max(1, Math.ceil(middle.length / bucketableCount));
    const bucketed: ExperimentResult[] = [];
    
    for (let i = 0; i < middle.length; i += bucketSize) {
      const bucket = middle.slice(i, i + bucketSize);
      // Use median metric for representative point (more stable than min/max)
      const sortedByMetric = [...bucket].sort((a, b) => a.metric - b.metric);
      const medianResult = sortedByMetric[Math.floor(sortedByMetric.length / 2)];
      bucketed.push(medianResult);
    }
    
    displayResults = [first, ...bucketed, ...recent];
    
    // Build run numbers: 1, then bucket centers, then last 10
    runNumbers = [1];
    for (let i = 0; i < bucketed.length; i++) {
      // Calculate approximate original run number for this bucket
      const bucketStartIdx = 1 + i * bucketSize;
      const bucketCenterIdx = bucketStartIdx + Math.floor(bucketSize / 2);
      runNumbers.push(Math.min(bucketCenterIdx, segmentResults.length - reservedForRecent));
    }
    for (let i = 0; i < recent.length; i++) {
      runNumbers.push(segmentResults.length - reservedForRecent + i + 1);
    }
  }
  
  if (displayResults.length === 0) return lines;
  
  // Find metric range from displayed results
  const metrics = displayResults.map(r => r.metric);
  const minMetric = Math.min(...metrics);
  const maxMetric = Math.max(...metrics);
  const metricRange = maxMetric - minMetric || 1;
  
  // Chart dimensions - centered
  const chartHeight = 10;
  const maxChartWidth = 60;
  const leftPad = 8; // Space for y-axis labels
  const rightPad = 2; // Right margin
  const chartWidth = Math.min(maxChartWidth, width - leftPad - rightPad - 2);
  const centerOffset = Math.max(0, Math.floor((width - chartWidth - leftPad - rightPad) / 2));
  
  const yTicks = 5;
  
  // Y-axis labels (evenly distributed)
  const yTickValues: number[] = [];
  for (let i = 0; i < yTicks; i++) {
    const ratio = i / (yTicks - 1);
    const val = maxMetric - (metricRange * ratio);
    yTickValues.push(val);
  }
  
  // Build grid rows (top to bottom)
  for (let row = 0; row < chartHeight; row++) {
    const yMin = minMetric + (metricRange * (chartHeight - row - 1) / chartHeight);
    const yMax = minMetric + (metricRange * (chartHeight - row) / chartHeight);
    
    // Y-axis label - pick appropriate tick for this row
    const tickIndex = Math.round(row * (yTicks - 1) / (chartHeight - 1));
    const yLabel = formatNum(yTickValues[Math.min(tickIndex, yTicks - 1)], metricUnit);
    const yLabelPadded = yLabel.padStart(leftPad - 1).slice(0, leftPad - 1);
    
    let rowStr = " ".repeat(centerOffset) + th.fg("muted", yLabelPadded) + " " + th.fg("borderMuted", "│") + " ";
    
    // Fill with points or spaces
    const gridRow: (string | null)[] = new Array(chartWidth).fill(null);
    
    for (let i = 0; i < displayResults.length; i++) {
      const r = displayResults[i];
      const x = Math.floor((i / Math.max(displayResults.length - 1, 1)) * (chartWidth - 1));
      const y = (r.metric - minMetric) / metricRange;
      const yRow = Math.min(Math.floor((1 - y) * chartHeight), chartHeight - 1);
      
      if (yRow === row) {
        // Determine symbol and color
        let symbol: string;
        let color: Parameters<typeof th.fg>[0];
        
        if (currentRunIndex !== undefined && i === displayResults.length - 1 && r.status !== "keep") {
          // Currently running
          symbol = "◐";
          color = "warning";
        } else {
          switch (r.status) {
            case "keep":
              symbol = "●";
              color = "success";
              break;
            case "discard":
              symbol = "○";
              color = "warning";
              break;
            case "crash":
              symbol = "💥";
              color = "error";
              break;
            case "checks_failed":
              symbol = "⚠";
              color = "error";
              break;
            default:
              symbol = "·";
              color = "dim";
          }
        }
        
        // If multiple points fall in same cell, prioritize
        const existing = gridRow[x];
        if (!existing || (symbol !== "·" && existing === "·")) {
          gridRow[x] = th.fg(color, symbol);
        }
      }
    }
    
    // Build row string with right padding
    for (const cell of gridRow) {
      rowStr += cell || " ";
    }
    rowStr += " "; // Right padding after graph
    
    lines.push(rowStr);
  }
  
  // X-axis line - centered
  // Align ┴ with the dots: yLabelPadded(7) + space + space = 9 chars, then ┴
  const xAxisLeftPad = " ".repeat(centerOffset) + th.fg("borderMuted", "─".repeat(leftPad) + "┴");
  // Right side: chartWidth + 1 (for right padding space) + 1 (compensate for left shift)
  const xAxisRight = th.fg("borderMuted", "─".repeat(chartWidth + 2));
  lines.push(xAxisLeftPad + xAxisRight);
  
  // X-axis labels - centered under chart
  // Position: first at col 0, last at end, middle centered
  // Account for the space after "│" in the chart rows (+1 offset)
  // +1 more to align with the dots (which have space after │ + space before them)
  const firstCol = centerOffset + leftPad + 1 + 1;
  const lastCol = centerOffset + leftPad + 1 + chartWidth - 1;
  const midCol = Math.floor((firstCol + lastCol) / 2);
  
  let xLabelsLine = " ".repeat(width);
  const setChar = (pos: number, char: string) => {
    if (pos >= 0 && pos < width) {
      xLabelsLine = xLabelsLine.slice(0, pos) + char + xLabelsLine.slice(pos + char.length);
    }
  };
  
  // Set labels - center them on their positions
  // For multi-char labels, position the left edge so the label is centered
  const setLabel = (pos: number, text: string) => {
    // Center the label on the position
    const start = pos - Math.floor((text.length - 1) / 2);
    for (let i = 0; i < text.length; i++) {
      const p = start + i;
      if (p >= 0 && p < width) {
        xLabelsLine = xLabelsLine.slice(0, p) + text[i] + xLabelsLine.slice(p + 1);
      }
    }
  };
  
  setLabel(firstCol, String(runNumbers[0]));
  if (displayResults.length > 2) {
    setLabel(midCol, String(runNumbers[Math.floor(displayResults.length / 2)]));
  }
  setLabel(lastCol, String(runNumbers[displayResults.length - 1]));
  
  lines.push(th.fg("muted", xLabelsLine.slice(0, width)));
  
  // Centered legend
  const legendText = `${th.fg("success", "●")} keep  ${th.fg("warning", "○")} discard  ${th.fg("error", "💥")} crash  ${th.fg("error", "⚠")} checks  ${th.fg("warning", "◐")} current`;
  const legendPadding = Math.max(0, Math.floor((width - visibleWidth(legendText)) / 2));
  lines.push(" ".repeat(legendPadding) + legendText);
  
  return lines;
}

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
    lines.push(`  ${th.fg("dim", "No experiments yet.")}`);
    return lines;
  }

  const cur = currentResults(st.results, st.currentSegment);
  const kept = cur.filter((r) => r.status === "keep").length;
  const discarded = cur.filter((r) => r.status === "discard").length;
  const crashed = cur.filter((r) => r.status === "crash").length;
  const checksFailed = cur.filter((r) => r.status === "checks_failed").length;

  const baseline = st.bestMetric;
  const baselineRunNumber = findBaselineRunNumber(st.results, st.currentSegment);
  const baselineSec = findBaselineSecondary(
    st.results,
    st.currentSegment,
    st.secondaryMetrics
  );

  // Find best kept primary metric and its run number (current segment only)
  let bestPrimary: number | null = null;
  let bestSecondary: Record<string, number> = {};
  let bestRunNum = 0;
  for (let i = st.results.length - 1; i >= 0; i--) {
    const r = st.results[i];
    if (r.segment !== st.currentSegment) continue;
    if (r.status === "keep" && r.metric > 0) {
      if (
        bestPrimary === null ||
        isBetter(r.metric, bestPrimary, st.bestDirection)
      ) {
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
            st.confidence! >= 2.0
              ? "success"
              : st.confidence! >= 1.0
                ? "warning"
                : "error";
          return `  ${th.fg(confColor, `(conf: ${confStr}×)`)}`;
        })()
      : "";
  lines.push(
    truncateToWidth(
      `  ${th.fg("muted", "Runs:")} ${th.fg("text", String(st.results.length))}` +
        `  ${th.fg("success", `${kept} kept`)}` +
        confSuffix +
        (discarded > 0 ? `  ${th.fg("warning", `${discarded} discarded`)}` : "") +
        (crashed > 0 ? `  ${th.fg("error", `${crashed} crashed`)}` : "") +
        (checksFailed > 0
          ? `  ${th.fg("error", `${checksFailed} checks failed`)}`
          : ""),
      width
    )
  );

  // Worktree path (if in isolated worktree)
  if (worktreePath) {
    lines.push(
      truncateToWidth(
        `  ${th.fg("muted", "Worktree:")} ${th.fg("dim", `📁 ${worktreePath}`)}`,
        width
      )
    );
  }

  // Baseline: first run's primary metric
  const baselineSuffix =
    baselineRunNumber === null ? "" : ` #${baselineRunNumber}`;
  lines.push(
    truncateToWidth(
      `  ${th.fg("muted", "Baseline:")} ${th.fg("muted", `★ ${st.metricName}: ${formatNum(baseline, st.metricUnit)}${baselineSuffix}`)}`,
      width
    )
  );

  // Progress: best primary metric with delta + run number
  if (bestPrimary !== null) {
    let progressLine =
      `  ${th.fg("muted", "Progress:")} ${th.fg("warning", th.bold(`★ ${st.metricName}: ${formatNum(bestPrimary, st.metricUnit)}`))}${th.fg("dim", ` #${bestRunNum}`)}`;

    if (baseline !== null && baseline !== 0 && bestPrimary !== baseline) {
      const pct = ((bestPrimary - baseline) / baseline) * 100;
      const sign = pct > 0 ? "+" : "";
      const color = isBetter(bestPrimary, baseline, st.bestDirection)
        ? "success"
        : "error";
      progressLine += th.fg(color, ` (${sign}${pct.toFixed(1)}%)`);
    }

    lines.push(truncateToWidth(progressLine, width));

    // Show target if set
    if (st.targetValue !== null) {
      const reached = st.bestDirection === "lower"
        ? bestPrimary <= st.targetValue
        : bestPrimary >= st.targetValue;
      const targetColor: Parameters<typeof th.fg>[0] = reached ? "success" : "muted";
      const targetIcon = reached ? "🎯" : "→";
      lines.push(truncateToWidth(
        `  ${th.fg("muted", "Target:")}   ${th.fg(targetColor, `${targetIcon} ${formatNum(st.targetValue, st.metricUnit)}${reached ? " ✓ REACHED" : ""}`)}`,
        width
      ));
    }

    // Progress secondary metrics — with "Metrics:" label for consistency
    if (st.secondaryMetrics.length > 0) {
      // Build individually-colored parts
      const secParts: string[] = [];
      for (const sm of st.secondaryMetrics) {
        const val = bestSecondary[sm.name];
        const bv = baselineSec[sm.name];
        if (val !== undefined) {
          let part = th.fg("muted", `${sm.name}: ${formatNum(val, sm.unit)}`);
          if (bv !== undefined && bv !== 0 && val !== bv) {
            const p = ((val - bv) / bv) * 100;
            const s = p > 0 ? "+" : "";
            const c = val <= bv ? "success" : "error";
            part += th.fg(c, ` ${s}${p.toFixed(1)}%`);
          }
          secParts.push(part);
        }
      }

      // Flow-wrap parts into lines with "Metrics:" label on first line
      if (secParts.length > 0) {
        const metricsLabel = th.fg("muted", "Metrics:");
        const tilde = th.fg("muted", "~");
        const prefix = `  ${metricsLabel}  ${tilde} `;
        const prefixWidth = visibleWidth(prefix);
        const maxLineW = width - prefixWidth;
        
        let curLine = "";
        let curVisW = 0;
        let isFirstLine = true;
        
        for (const part of secParts) {
          const partVisW = visibleWidth(part);
          const sep = curLine ? "  " : "";
          
          if (curLine && curVisW + sep.length + partVisW > maxLineW) {
            const linePrefix = isFirstLine ? prefix : " ".repeat(prefixWidth);
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
          const linePrefix = isFirstLine ? prefix : " ".repeat(prefixWidth);
          lines.push(truncateToWidth(`${linePrefix}${curLine}`, width));
        }
      }
    }
  }

  // Chart visualization - only in fullscreen mode (maxRows === 0)
  if (maxRows === 0 && st.results.length > 0) {
    lines.push("");
    lines.push(th.fg("muted", "  Chart:"));
    const chartLines = renderScatterPlot(
      st.results,
      st.currentSegment,
      st.metricUnit,
      width,
      th
    );
    lines.push(...chartLines);
  }

  lines.push("");

  // Determine visible rows for column pruning
  const effectiveMax = maxRows <= 0 ? st.results.length : maxRows;
  const startIdx = Math.max(0, st.results.length - effectiveMax);
  const visibleRows = st.results.slice(startIdx);

  // Only show secondary metric columns that have at least one value in visible rows
  const secMetrics = st.secondaryMetrics.filter((sm) =>
    visibleRows.some((r) => (r.metrics ?? {})[sm.name] !== undefined)
  );

  // Column definitions — guarantee 25% of width for description
  const col = { idx: 3, commit: 8, primary: 11, status: 15 };
  const secColWidth = 11;
  const minDescW = Math.max(10, Math.floor(width * 0.25));
  const fixedW = col.idx + col.commit + col.primary + col.status + 6;
  const availableForSec = width - fixedW - minDescW;

  // Drop secondary columns from the right until they fit
  let visibleSecMetrics = secMetrics;
  while (
    visibleSecMetrics.length > 0 &&
    visibleSecMetrics.length * secColWidth > availableForSec
  ) {
    visibleSecMetrics = visibleSecMetrics.slice(0, -1);
  }

  const totalSecWidth = visibleSecMetrics.length * secColWidth;
  const descW = Math.max(minDescW, width - fixedW - totalSecWidth);

  // Table header — primary metric name bolded with ★
  let headerLine =
    `  ${th.fg("muted", "#".padEnd(col.idx))}` +
    `${th.fg("muted", "commit".padEnd(col.commit))}` +
    `${th.fg("warning", th.bold(("★ " + st.metricName).slice(0, col.primary - 1).padEnd(col.primary)))}`;

  for (const sm of visibleSecMetrics) {
    headerLine += th.fg(
      "muted",
      sm.name.slice(0, secColWidth - 1).padEnd(secColWidth)
    );
  }

  headerLine +=
    `${th.fg("muted", "status".padEnd(col.status))}` +
    `${th.fg("muted", "description")}`;

  lines.push(truncateToWidth(headerLine, width));
  lines.push(
    truncateToWidth(`  ${th.fg("borderMuted", "─".repeat(width - 4))}`, width)
  );

  // Baseline values for delta display (current segment only)
  const baselinePrimary = findBaselineMetric(st.results, st.currentSegment);
  const baselineSecondary = findBaselineSecondary(
    st.results,
    st.currentSegment,
    st.secondaryMetrics
  );

  // Show max 6 recent runs, with a note about hidden earlier ones
  if (startIdx > 0) {
    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", `… ${startIdx} earlier run${startIdx === 1 ? "" : "s"}`)}`,
        width
      )
    );
  }

  for (let i = startIdx; i < st.results.length; i++) {
    const r = st.results[i];
    const isOld = r.segment !== st.currentSegment;
    const isBaseline =
      !isOld && i === st.results.findIndex((x) => x.segment === st.currentSegment);

    const color = isOld
      ? "dim"
      : r.status === "keep"
        ? "success"
        : r.status === "crash" || r.status === "checks_failed"
          ? "error"
          : "warning";

    // Primary metric with color coding
    const primaryStr = formatNum(r.metric, st.metricUnit);
    let primaryColor: Parameters<typeof th.fg>[0] = isOld ? "dim" : "text";
    if (!isOld) {
      if (isBaseline) {
        primaryColor = "text"; // baseline row — normal text
      } else if (
        baselinePrimary !== null &&
        r.status === "keep" &&
        r.metric > 0
      ) {
        if (isBetter(r.metric, baselinePrimary, st.bestDirection)) {
          primaryColor = "success";
        } else if (r.metric !== baselinePrimary) {
          primaryColor = "error";
        }
      }
    }

    const idxStr = th.fg("dim", String(i + 1).padEnd(col.idx));
    const commitStr = isOld
      ? "(old)".padEnd(col.commit)
      : r.status !== "keep"
        ? "—".padStart(Math.ceil(col.commit / 2)).padEnd(col.commit)
        : r.commit.padEnd(col.commit);

    let rowLine =
      `  ${idxStr}` +
      `${th.fg(isOld ? "dim" : "accent", commitStr)}` +
      `${th.fg(primaryColor, isOld ? primaryStr.padEnd(col.primary) : th.bold(primaryStr.padEnd(col.primary)))}`;

    // Secondary metrics (only visible columns)
    const rowMetrics = r.metrics ?? {};
    for (const sm of visibleSecMetrics) {
      const val = rowMetrics[sm.name];
      if (val !== undefined) {
        const secStr = formatNum(val, sm.unit);
        let secColor: Parameters<typeof th.fg>[0] = "dim";
        if (!isOld) {
          const bv = baselineSecondary[sm.name];
          if (isBaseline) {
            secColor = "text"; // baseline row — normal text
          } else if (bv !== undefined && bv !== 0) {
            secColor = val <= bv ? "success" : "error";
          }
        }
        rowLine += th.fg(secColor, secStr.padEnd(secColWidth));
      } else {
        rowLine += th.fg("dim", "—".padEnd(secColWidth));
      }
    }

    rowLine +=
      `${th.fg(color, r.status.padEnd(col.status))}` +
      `${th.fg("muted", r.description.slice(0, descW))}`;

    lines.push(truncateToWidth(rowLine, width));
  }

  return lines;
}
