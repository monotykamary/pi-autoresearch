/**
 * Scatter plot chart visualization for experiment results
 */

import type { Theme } from '@mariozechner/pi-coding-agent';
import { visibleWidth } from '@mariozechner/pi-tui';
import type { ExperimentResult } from '../types/index.js';
import { formatNum } from '../utils/format.js';

/**
 * Render scatter plot of experiment results
 * Shows keep/discard/crash as points on a 2D grid
 */
export function renderScatterPlot(
  results: ExperimentResult[],
  metricUnit: string,
  width: number,
  th: Theme,
  currentRunIndex?: number
): string[] {
  const lines: string[] = [];

  // Stratified sampling: 1 (first) + 19 (bucketed middle) + 10 (recent detail)
  const maxPoints = 30;
  const reservedForRecent = 10;

  let displayResults: ExperimentResult[];
  let runNumbers: number[];

  if (results.length <= maxPoints) {
    // Show all if they fit
    displayResults = results;
    runNumbers = displayResults.map((_, i) => i + 1);
  } else {
    const bucketableCount = maxPoints - reservedForRecent - 1; // 19
    const first = results[0];
    const recent = results.slice(-reservedForRecent);
    const middle = results.slice(1, -reservedForRecent);

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
      runNumbers.push(Math.min(bucketCenterIdx, results.length - reservedForRecent));
    }
    for (let i = 0; i < recent.length; i++) {
      runNumbers.push(results.length - reservedForRecent + i + 1);
    }
  }

  if (displayResults.length === 0) return lines;

  // Find metric range from displayed results
  const metrics = displayResults.map((r) => r.metric);
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
    const val = maxMetric - metricRange * ratio;
    yTickValues.push(val);
  }

  // Build grid rows (top to bottom)
  for (let row = 0; row < chartHeight; row++) {
    const yMin = minMetric + (metricRange * (chartHeight - row - 1)) / chartHeight;
    const yMax = minMetric + (metricRange * (chartHeight - row)) / chartHeight;

    // Y-axis label - pick appropriate tick for this row
    const tickIndex = Math.round((row * (yTicks - 1)) / (chartHeight - 1));
    const yLabel = formatNum(yTickValues[Math.min(tickIndex, yTicks - 1)], metricUnit);
    const yLabelPadded = yLabel.padStart(leftPad - 1).slice(0, leftPad - 1);

    let rowStr =
      ' '.repeat(centerOffset) +
      th.fg('muted', yLabelPadded) +
      ' ' +
      th.fg('borderMuted', '│') +
      ' ';

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

        if (
          currentRunIndex !== undefined &&
          i === displayResults.length - 1 &&
          r.status !== 'keep'
        ) {
          // Currently running
          symbol = '◐';
          color = 'warning';
        } else {
          switch (r.status) {
            case 'keep':
              symbol = '●';
              color = 'success';
              break;
            case 'discard':
              symbol = '○';
              color = 'warning';
              break;
            case 'crash':
              symbol = '💥';
              color = 'error';
              break;
            case 'checks_failed':
              symbol = '⚠';
              color = 'error';
              break;
            default:
              symbol = '·';
              color = 'dim';
          }
        }

        // If multiple points fall in same cell, prioritize
        const existing = gridRow[x];
        if (!existing || (symbol !== '·' && existing === '·')) {
          gridRow[x] = th.fg(color, symbol);
        }
      }
    }

    // Build row string with right padding
    for (const cell of gridRow) {
      rowStr += cell || ' ';
    }
    rowStr += ' '; // Right padding after graph

    lines.push(rowStr);
  }

  // X-axis line - centered
  // Align ┴ with the dots: yLabelPadded(7) + space + space = 9 chars, then ┴
  const xAxisLeftPad = ' '.repeat(centerOffset) + th.fg('borderMuted', '─'.repeat(leftPad) + '┴');
  // Right side: chartWidth + 1 (for right padding space) + 1 (compensate for left shift)
  const xAxisRight = th.fg('borderMuted', '─'.repeat(chartWidth + 2));
  lines.push(xAxisLeftPad + xAxisRight);

  // X-axis labels - centered under chart
  // Position: first at col 0, last at end, middle centered
  // Account for the space after "│" in the chart rows (+1 offset)
  // +1 more to align with the dots (which have space after │ + space before them)
  const firstCol = centerOffset + leftPad + 1 + 1;
  const lastCol = centerOffset + leftPad + 1 + chartWidth - 1;
  const midCol = Math.floor((firstCol + lastCol) / 2);

  let xLabelsLine = ' '.repeat(width);

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

  lines.push(th.fg('muted', xLabelsLine.slice(0, width)));

  // Centered legend
  const legendText = `${th.fg('success', '●')} keep  ${th.fg('warning', '○')} discard  ${th.fg('error', '💥')} crash  ${th.fg('error', '⚠')} checks  ${th.fg('warning', '◐')} current`;
  const legendPadding = Math.max(0, Math.floor((width - visibleWidth(legendText)) / 2));
  lines.push(' '.repeat(legendPadding) + legendText);

  return lines;
}
