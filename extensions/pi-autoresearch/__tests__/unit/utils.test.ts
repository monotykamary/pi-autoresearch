/**
 * Unit tests for utility functions
 */

import { describe, it, expect } from 'vitest';
import { parseMetricLines } from '../../src/utils/parse.js';
import { formatNum, formatElapsed } from '../../src/utils/format.js';
import { isBetter, sortedMedian, computeConfidence } from '../../src/utils/stats.js';
import { findBaselineMetric, currentResults } from '../../src/utils/experiment.js';
import { isAutoresearchShCommand } from '../../src/utils/validate.js';
import type { ExperimentResult } from '../../src/types/index.js';

// ============================================================================
// parseMetricLines
// ============================================================================
describe('parseMetricLines', () => {
  it('parses basic METRIC lines', () => {
    const output = `
Some log output
METRIC total_µs=15200
METRIC compile_µs=4200
More output
`;
    const metrics = parseMetricLines(output);
    expect(metrics.get('total_µs')).toBe(15200);
    expect(metrics.get('compile_µs')).toBe(4200);
  });

  it('handles empty output', () => {
    const metrics = parseMetricLines('');
    expect(metrics.size).toBe(0);
  });

  it('ignores malformed lines', () => {
    const output = `
METRIC valid=123
METRIC invalid=abc
METRIC also_invalid
METRIC =456
METRIC no_value=
`;
    const metrics = parseMetricLines(output);
    expect(metrics.get('valid')).toBe(123);
    expect(metrics.get('invalid')).toBeUndefined();
    expect(metrics.get('also_invalid')).toBeUndefined();
    expect(metrics.get('')).toBeUndefined();
    expect(metrics.get('no_value')).toBeUndefined();
  });

  it('handles duplicate names (last wins)', () => {
    const output = `
METRIC value=100
METRIC value=200
METRIC value=150
`;
    const metrics = parseMetricLines(output);
    expect(metrics.get('value')).toBe(150);
  });

  it('rejects prototype pollution names', () => {
    const output = `
METRIC __proto__=1
METRIC constructor=2
METRIC prototype=3
METRIC safe=4
`;
    const metrics = parseMetricLines(output);
    expect(metrics.get('__proto__')).toBeUndefined();
    expect(metrics.get('constructor')).toBeUndefined();
    expect(metrics.get('prototype')).toBeUndefined();
    expect(metrics.get('safe')).toBe(4);
  });

  it('handles special characters in names (µ, ., _)', () => {
    const output = `
METRIC time_µs=1000
METRIC memory_kb=2048
METRIC v1.2.3=42
`;
    const metrics = parseMetricLines(output);
    expect(metrics.get('time_µs')).toBe(1000);
    expect(metrics.get('memory_kb')).toBe(2048);
    expect(metrics.get('v1.2.3')).toBe(42);
  });

  it('rejects Infinity and NaN values', () => {
    const output = `
METRIC inf=Infinity
METRIC neg_inf=-Infinity
METRIC nan=NaN
METRIC valid=100
`;
    const metrics = parseMetricLines(output);
    expect(metrics.get('inf')).toBeUndefined();
    expect(metrics.get('neg_inf')).toBeUndefined();
    expect(metrics.get('nan')).toBeUndefined();
    expect(metrics.get('valid')).toBe(100);
  });

  it('handles negative numbers', () => {
    const output = `
METRIC delta=-50
METRIC loss=-0.5
`;
    const metrics = parseMetricLines(output);
    expect(metrics.get('delta')).toBe(-50);
    expect(metrics.get('loss')).toBe(-0.5);
  });

  it('handles decimal numbers', () => {
    const output = `
METRIC accuracy=0.95
METRIC latency=1.234
`;
    const metrics = parseMetricLines(output);
    expect(metrics.get('accuracy')).toBe(0.95);
    expect(metrics.get('latency')).toBe(1.234);
  });
});

// ============================================================================
// formatNum
// ============================================================================
describe('formatNum', () => {
  it('formats integers with commas', () => {
    expect(formatNum(1000, '')).toBe('1,000');
    expect(formatNum(1000000, '')).toBe('1,000,000');
    expect(formatNum(123456789, '')).toBe('123,456,789');
  });

  it('formats small integers without commas', () => {
    expect(formatNum(0, '')).toBe('0');
    expect(formatNum(999, '')).toBe('999');
  });

  it('formats decimals with 2 places', () => {
    expect(formatNum(1.5, '')).toBe('1.50');
    expect(formatNum(1.234, '')).toBe('1.23');
    expect(formatNum(1234.5678, '')).toBe('1,234.57');
  });

  it('appends unit', () => {
    expect(formatNum(1000, 'µs')).toBe('1,000µs');
    expect(formatNum(1.5, 's')).toBe('1.50s');
  });

  it('returns em-dash for null', () => {
    expect(formatNum(null, '')).toBe('—');
    expect(formatNum(null, 'µs')).toBe('—');
  });

  it('handles negative numbers', () => {
    expect(formatNum(-1000, '')).toBe('-1,000');
    expect(formatNum(-1.5, '')).toBe('-1.50');
  });
});

// ============================================================================
// formatElapsed
// ============================================================================
describe('formatElapsed', () => {
  it('formats seconds', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(500)).toBe('0s');
    expect(formatElapsed(1000)).toBe('1s');
    expect(formatElapsed(59000)).toBe('59s');
  });

  it('formats minutes:seconds', () => {
    expect(formatElapsed(60000)).toBe('1m 00s');
    expect(formatElapsed(90000)).toBe('1m 30s');
    expect(formatElapsed(123456)).toBe('2m 03s');
  });

  it('formats hours as minutes', () => {
    expect(formatElapsed(3600000)).toBe('60m 00s');
    expect(formatElapsed(3661000)).toBe('61m 01s');
  });
});

// ============================================================================
// isBetter
// ============================================================================
describe('isBetter', () => {
  it('handles lower-is-better correctly', () => {
    expect(isBetter(90, 100, 'lower')).toBe(true);
    expect(isBetter(100, 100, 'lower')).toBe(false);
    expect(isBetter(110, 100, 'lower')).toBe(false);
    expect(isBetter(-10, 0, 'lower')).toBe(true);
  });

  it('handles higher-is-better correctly', () => {
    expect(isBetter(110, 100, 'higher')).toBe(true);
    expect(isBetter(100, 100, 'higher')).toBe(false);
    expect(isBetter(90, 100, 'higher')).toBe(false);
    expect(isBetter(0, -10, 'higher')).toBe(true);
  });
});

// ============================================================================
// sortedMedian
// ============================================================================
describe('sortedMedian', () => {
  it('returns 0 for empty array', () => {
    expect(sortedMedian([])).toBe(0);
  });

  it('returns single value', () => {
    expect(sortedMedian([42])).toBe(42);
  });

  it('finds median of odd-length array', () => {
    expect(sortedMedian([3, 1, 2])).toBe(2);
    expect(sortedMedian([1, 2, 3, 4, 5])).toBe(3);
    expect(sortedMedian([5, 4, 3, 2, 1])).toBe(3);
  });

  it('finds median of even-length array', () => {
    expect(sortedMedian([1, 2, 3, 4])).toBe(2.5);
    expect(sortedMedian([4, 3, 2, 1])).toBe(2.5);
    expect(sortedMedian([1, 3, 2, 4])).toBe(2.5);
  });

  it('handles negative numbers', () => {
    expect(sortedMedian([-5, -3, -1])).toBe(-3);
    expect(sortedMedian([-10, -20, -30, -40])).toBe(-25);
  });

  it('handles duplicates', () => {
    expect(sortedMedian([1, 1, 1])).toBe(1);
    expect(sortedMedian([1, 1, 2, 2])).toBe(1.5);
  });

  it('handles decimal numbers', () => {
    expect(sortedMedian([1.5, 2.5, 3.5])).toBe(2.5);
    expect(sortedMedian([1.1, 1.2, 1.3, 1.4])).toBe(1.25);
  });
});

// ============================================================================
// computeConfidence
// ============================================================================
describe('computeConfidence', () => {
  const createResult = (
    metric: number,
    status: ExperimentResult['status'] = 'keep',
    segment = 0
  ): ExperimentResult => ({
    commit: 'abc1234',
    metric,
    metrics: {},
    status,
    description: 'test',
    timestamp: Date.now(),
    segment,
    confidence: null,
  });

  it('returns null with fewer than 3 results', () => {
    const results = [createResult(100, 'keep'), createResult(90, 'keep')];
    expect(computeConfidence(results, 0, 'lower')).toBeNull();
  });

  it('returns null when no kept results', () => {
    const results = [
      createResult(100, 'discard'),
      createResult(90, 'discard'),
      createResult(80, 'discard'),
    ];
    expect(computeConfidence(results, 0, 'lower')).toBeNull();
  });

  it('returns null when best equals baseline', () => {
    const results = [
      createResult(100, 'keep'),
      createResult(100, 'keep'),
      createResult(100, 'keep'),
    ];
    expect(computeConfidence(results, 0, 'lower')).toBeNull();
  });

  it('calculates confidence for lower-is-better', () => {
    const results = [
      createResult(100, 'keep'),
      createResult(95, 'discard'),
      createResult(80, 'keep'),
    ];
    const confidence = computeConfidence(results, 'lower');
    expect(confidence).toBeGreaterThan(0);
    expect(confidence).toBeCloseTo(4.0, 0);
  });

  it('calculates confidence for higher-is-better', () => {
    const results = [
      createResult(100, 'keep'),
      createResult(110, 'discard'),
      createResult(120, 'keep'),
    ];
    const confidence = computeConfidence(results, 'higher');
    expect(confidence).toBeGreaterThan(0);
    expect(confidence).toBeCloseTo(2.0, 0);
  });

  it('returns null when MAD is 0 (all values identical)', () => {
    const results = [
      createResult(100, 'keep'),
      createResult(100, 'keep'),
      createResult(100, 'keep'),
    ];
    expect(computeConfidence(results, 'lower')).toBeNull();
  });

  it('considers all results (no segment filtering)', () => {
    const results = [
      createResult(100, 'keep', 0),
      createResult(90, 'keep', 0),
      createResult(50, 'keep', 1),
      createResult(40, 'keep', 1),
      createResult(30, 'keep', 1),
    ];
    // All results are considered (no segment filtering)
    const confidence = computeConfidence(results, 'lower');
    expect(confidence).toBeGreaterThan(0);
  });

  it('ignores crashed results (metric=0)', () => {
    const results = [
      createResult(100, 'keep'),
      createResult(0, 'crash'),
      createResult(0, 'crash'),
      createResult(90, 'keep'),
      createResult(80, 'keep'),
    ];
    const confidence = computeConfidence(results, 'lower');
    expect(confidence).toBeGreaterThan(0);
  });
});

// ============================================================================
// findBaselineMetric
// ============================================================================
describe('findBaselineMetric', () => {
  const createResult = (metric: number, segment = 0): ExperimentResult => ({
    commit: 'abc1234',
    metric,
    metrics: {},
    status: 'keep',
    description: 'test',
    timestamp: Date.now(),
    segment,
    confidence: null,
  });

  it('returns null for empty results', () => {
    expect(findBaselineMetric([], 0)).toBeNull();
  });

  it("returns first result's metric as baseline", () => {
    const results = [createResult(100), createResult(90), createResult(80)];
    expect(findBaselineMetric(results, 0)).toBe(100);
  });

  it('only considers specified segment', () => {
    const results = [
      createResult(100, 0),
      createResult(90, 0),
      createResult(200, 1),
      createResult(180, 1),
    ];
    expect(findBaselineMetric(results, 0)).toBe(100);
    expect(findBaselineMetric(results, 1)).toBe(200);
  });

  it('returns null when segment has no results', () => {
    const results = [createResult(100, 0)];
    expect(findBaselineMetric(results, 1)).toBeNull();
  });
});

// ============================================================================
// currentResults
// ============================================================================
describe('currentResults', () => {
  const createResult = (metric: number, segment = 0): ExperimentResult => ({
    commit: 'abc1234',
    metric,
    metrics: {},
    status: 'keep',
    description: 'test',
    timestamp: Date.now(),
    segment,
    confidence: null,
  });

  it('filters results by segment', () => {
    const results = [
      createResult(100, 0),
      createResult(90, 0),
      createResult(200, 1),
      createResult(180, 1),
    ];
    expect(currentResults(results, 0)).toHaveLength(2);
    expect(currentResults(results, 1)).toHaveLength(2);
    expect(currentResults(results, 0)[0].metric).toBe(100);
    expect(currentResults(results, 1)[0].metric).toBe(200);
  });

  it('returns empty array when segment has no results', () => {
    const results = [createResult(100, 0)];
    expect(currentResults(results, 1)).toHaveLength(0);
  });
});

// ============================================================================
// isAutoresearchShCommand
// ============================================================================
describe('isAutoresearchShCommand', () => {
  it('accepts direct autoresearch.sh invocation', () => {
    expect(isAutoresearchShCommand('./autoresearch.sh')).toBe(true);
    expect(isAutoresearchShCommand('autoresearch.sh')).toBe(true);
    expect(isAutoresearchShCommand('/path/to/autoresearch.sh')).toBe(true);
  });

  it('accepts bash/sh invocation', () => {
    expect(isAutoresearchShCommand('bash autoresearch.sh')).toBe(true);
    expect(isAutoresearchShCommand('bash ./autoresearch.sh')).toBe(true);
    expect(isAutoresearchShCommand('sh autoresearch.sh')).toBe(true);
    expect(isAutoresearchShCommand('source autoresearch.sh')).toBe(true);
  });

  it('accepts with bash flags', () => {
    expect(isAutoresearchShCommand('bash -x autoresearch.sh')).toBe(true);
    expect(isAutoresearchShCommand('bash -e -u ./autoresearch.sh')).toBe(true);
  });

  it('accepts with env vars prefix', () => {
    expect(isAutoresearchShCommand('DEBUG=1 ./autoresearch.sh')).toBe(true);
    expect(isAutoresearchShCommand('FOO=bar BAZ=qux bash autoresearch.sh')).toBe(true);
    expect(isAutoresearchShCommand('ENV_VAR=value ./autoresearch.sh')).toBe(true);
  });

  it('accepts with time/nice/nohup wrappers', () => {
    expect(isAutoresearchShCommand('time ./autoresearch.sh')).toBe(true);
    expect(isAutoresearchShCommand('nice -n 10 ./autoresearch.sh')).toBe(true);
    expect(isAutoresearchShCommand('nohup ./autoresearch.sh')).toBe(true);
    expect(isAutoresearchShCommand('time nice nohup ./autoresearch.sh')).toBe(true);
  });

  it('accepts complex prefix combinations', () => {
    expect(isAutoresearchShCommand('DEBUG=1 time nice -n 10 bash -x ./autoresearch.sh')).toBe(true);
  });

  it('rejects chained commands', () => {
    expect(isAutoresearchShCommand('evil.sh; ./autoresearch.sh')).toBe(false);
    expect(isAutoresearchShCommand('./autoresearch.sh; cat /etc/passwd')).toBe(false);
  });

  it('rejects commands with autoresearch.sh not as primary', () => {
    expect(isAutoresearchShCommand('./other.sh autoresearch.sh')).toBe(false);
    expect(isAutoresearchShCommand('cat autoresearch.sh')).toBe(false);
    expect(isAutoresearchShCommand('echo autoresearch.sh')).toBe(false);
  });

  it('rejects similar but wrong filenames', () => {
    expect(isAutoresearchShCommand('./autoresearch.sh.bak')).toBe(false);
    expect(isAutoresearchShCommand('./my-autoresearch.sh')).toBe(false);
    expect(isAutoresearchShCommand('./autoresearch.sh.extra')).toBe(false);
  });

  it('rejects empty and whitespace', () => {
    expect(isAutoresearchShCommand('')).toBe(false);
    expect(isAutoresearchShCommand('   ')).toBe(false);
  });

  it('rejects completely different commands', () => {
    expect(isAutoresearchShCommand('pnpm test')).toBe(false);
    expect(isAutoresearchShCommand('python train.py')).toBe(false);
    expect(isAutoresearchShCommand('make')).toBe(false);
  });
});
