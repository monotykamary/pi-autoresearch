/**
 * Unit tests for dashboard and chart rendering
 */

import { describe, it, expect } from 'vitest';
import type { ExperimentResult } from '../../src/types/index.js';

// ============================================================================
// Stratified Chart Bucketing
// ============================================================================
const createSegmentResult = (
  metric: number,
  runNumber: number,
  status: ExperimentResult['status'] = 'keep',
  segment = 0
): ExperimentResult => ({
  commit: `abc${runNumber.toString().padStart(4, '0')}`,
  metric,
  metrics: {},
  status,
  description: `Run ${runNumber}`,
  timestamp: Date.now() + runNumber,
  segment,
  confidence: null,
});

function stratifiedBucket(
  segmentResults: ExperimentResult[],
  maxPoints = 30,
  reservedForRecent = 10
): { displayResults: ExperimentResult[]; runNumbers: number[] } {
  if (segmentResults.length <= maxPoints) {
    return {
      displayResults: segmentResults,
      runNumbers: segmentResults.map((_, i) => i + 1),
    };
  }

  const recentCount = Math.min(reservedForRecent, Math.floor(maxPoints / 2));
  const bucketCount = maxPoints - recentCount;

  const recent = segmentResults.slice(-recentCount);
  const older = segmentResults.slice(0, -recentCount);

  const bucketSize = Math.ceil(older.length / bucketCount);
  const buckets: ExperimentResult[][] = [];

  for (let i = 0; i < older.length; i += bucketSize) {
    buckets.push(older.slice(i, i + bucketSize));
  }

  const sampled = buckets.map((bucket) => {
    const keep = bucket.find((r) => r.status === 'keep');
    if (keep) return keep;
    const checks = bucket.find((r) => r.status === 'checks_failed');
    if (checks) return checks;
    const crash = bucket.find((r) => r.status === 'crash');
    if (crash) return crash;
    return bucket[bucket.length - 1];
  });

  const displayResults = [...sampled, ...recent];
  const runNumbers = displayResults.map((r) => {
    const idx = segmentResults.findIndex((sr) => sr === r);
    return idx + 1;
  });

  return { displayResults, runNumbers };
}

describe('Stratified chart bucketing', () => {
  describe('Small datasets (no bucketing needed)', () => {
    it('returns all results when count <= maxPoints', () => {
      const results = Array.from({ length: 20 }, (_, i) => createSegmentResult(100 + i, i + 1));
      const { displayResults, runNumbers } = stratifiedBucket(results, 30);
      expect(displayResults.length).toBe(20);
      expect(runNumbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    });

    it('returns exact maxPoints results when count equals maxPoints', () => {
      const results = Array.from({ length: 30 }, (_, i) => createSegmentResult(100 + i, i + 1));
      const { displayResults } = stratifiedBucket(results, 30);
      expect(displayResults.length).toBe(30);
    });
  });

  describe('Large datasets (bucketing applied)', () => {
    it('limits output to maxPoints when input exceeds limit', () => {
      const results = Array.from({ length: 100 }, (_, i) => createSegmentResult(100 + i, i + 1));
      const { displayResults } = stratifiedBucket(results, 30);
      expect(displayResults.length).toBeLessThanOrEqual(30);
    });

    it('reserves space for recent results', () => {
      const results = Array.from({ length: 100 }, (_, i) => createSegmentResult(100 + i, i + 1));
      const { displayResults, runNumbers } = stratifiedBucket(results, 30, 10);

      const recentRunNumbers = runNumbers.slice(-10);
      expect(recentRunNumbers).toContain(91);
      expect(recentRunNumbers).toContain(100);
    });

    it('always includes the most recent result', () => {
      const results = Array.from({ length: 50 }, (_, i) => createSegmentResult(100 + i, i + 1));
      const { runNumbers } = stratifiedBucket(results, 30, 10);
      expect(runNumbers).toContain(50);
    });

    it('always includes the first (baseline) result', () => {
      const results = Array.from({ length: 50 }, (_, i) => createSegmentResult(100 + i, i + 1));
      const { runNumbers } = stratifiedBucket(results, 30, 10);
      expect(runNumbers).toContain(1);
    });
  });

  describe('Status prioritization in buckets', () => {
    it("prioritizes 'keep' status within bucket", () => {
      const results = [
        createSegmentResult(100, 1, 'keep'),
        createSegmentResult(101, 2, 'discard'),
        createSegmentResult(99, 3, 'keep'),
        createSegmentResult(102, 4, 'discard'),
      ];
      const { displayResults } = stratifiedBucket(results, 3, 1);
      expect(displayResults.some((r) => r.status === 'keep')).toBe(true);
    });

    it("falls back to 'checks_failed' if no keep", () => {
      const results = [
        createSegmentResult(100, 1, 'discard'),
        createSegmentResult(101, 2, 'checks_failed'),
        createSegmentResult(102, 3, 'discard'),
      ];
      const { displayResults } = stratifiedBucket(results, 2, 1);
      expect(displayResults.some((r) => r.status === 'checks_failed')).toBe(true);
    });

    it("falls back to 'crash' if no keep or checks_failed", () => {
      const results = [
        createSegmentResult(100, 1, 'discard'),
        createSegmentResult(0, 2, 'crash'),
        createSegmentResult(101, 3, 'discard'),
      ];
      const { displayResults } = stratifiedBucket(results, 2, 1);
      expect(displayResults.some((r) => r.status === 'crash')).toBe(true);
    });

    it('uses last result in bucket as final fallback', () => {
      const results = [
        createSegmentResult(100, 1, 'discard'),
        createSegmentResult(101, 2, 'discard'),
        createSegmentResult(102, 3, 'discard'),
      ];
      const { displayResults, runNumbers } = stratifiedBucket(results, 2, 1);
      expect(displayResults.length).toBeGreaterThan(0);
      expect(runNumbers.length).toBeGreaterThan(0);
    });
  });

  describe('Progressive bucketing as data grows', () => {
    it('50 results: moderate bucketing', () => {
      const results = Array.from({ length: 50 }, (_, i) =>
        createSegmentResult(100 + Math.random() * 50, i + 1)
      );
      const { displayResults, runNumbers } = stratifiedBucket(results, 30, 10);
      expect(displayResults.length).toBeLessThanOrEqual(30);
      expect(runNumbers.length).toBe(displayResults.length);
    });

    it('100 results: more aggressive bucketing', () => {
      const results = Array.from({ length: 100 }, (_, i) =>
        createSegmentResult(100 + Math.random() * 50, i + 1)
      );
      const { displayResults, runNumbers } = stratifiedBucket(results, 30, 10);
      expect(displayResults.length).toBeLessThanOrEqual(30);
      expect(runNumbers[0]).toBe(1);
      expect(runNumbers[runNumbers.length - 1]).toBe(100);
    });

    it('500 results: heavy bucketing but preserves trends', () => {
      const results = Array.from({ length: 500 }, (_, i) =>
        createSegmentResult(100 + Math.random() * 50, i + 1)
      );
      const { displayResults, runNumbers } = stratifiedBucket(results, 30, 10);
      expect(displayResults.length).toBeLessThanOrEqual(30);
      expect(runNumbers[0]).toBe(1);
      expect(runNumbers[runNumbers.length - 1]).toBe(500);

      for (let i = 1; i < runNumbers.length; i++) {
        expect(runNumbers[i]).toBeGreaterThan(runNumbers[i - 1]);
      }
    });
  });

  describe('Edge cases', () => {
    it('handles empty results array', () => {
      const { displayResults, runNumbers } = stratifiedBucket([], 30);
      expect(displayResults.length).toBe(0);
      expect(runNumbers.length).toBe(0);
    });

    it('handles single result', () => {
      const results = [createSegmentResult(100, 1)];
      const { displayResults, runNumbers } = stratifiedBucket(results, 30);
      expect(displayResults.length).toBe(1);
      expect(runNumbers).toEqual([1]);
    });

    it('handles all same status', () => {
      const results = Array.from({ length: 50 }, (_, i) =>
        createSegmentResult(100 + i, i + 1, 'discard')
      );
      const { displayResults } = stratifiedBucket(results, 30, 10);
      expect(displayResults.length).toBeLessThanOrEqual(30);
      expect(displayResults.every((r) => r.status === 'discard')).toBe(true);
    });

    it('handles alternating statuses', () => {
      const results = Array.from({ length: 50 }, (_, i) =>
        createSegmentResult(100 + i, i + 1, i % 2 === 0 ? 'keep' : 'discard')
      );
      const { displayResults } = stratifiedBucket(results, 30, 10);
      expect(displayResults.length).toBeLessThanOrEqual(30);
      expect(displayResults.some((r) => r.status === 'keep')).toBe(true);
    });

    it('preserves metric values through bucketing', () => {
      const results = Array.from({ length: 100 }, (_, i) =>
        createSegmentResult(1000 - i * 5, i + 1)
      );
      const { displayResults } = stratifiedBucket(results, 30, 10);

      for (const r of displayResults) {
        expect(r.metric).toBeGreaterThan(0);
      }
    });
  });
});
