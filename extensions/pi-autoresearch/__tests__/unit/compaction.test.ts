/**
 * Tests for the deterministic compaction summary builder
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  autoresearchSummaryPathsFor,
  buildAutoresearchCompactionSummary,
} from '../../src/compaction/index.js';
import type { ExperimentState } from '../../src/types/index.js';
import { createExperimentState } from '../../src/state/index.js';

function withTempWorkDir(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-autoresearch-compact-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeJsonlLines(workDir: string, lines: string[]) {
  fs.writeFileSync(path.join(workDir, 'autoresearch.jsonl'), lines.join('\n') + '\n');
}

function makeState(overrides: Partial<ExperimentState> = {}): ExperimentState {
  const state = createExperimentState();
  return { ...state, ...overrides };
}

describe('buildAutoresearchCompactionSummary', () => {
  it('contains all persisted sources when present', () => {
    withTempWorkDir((workDir) => {
      fs.writeFileSync(path.join(workDir, 'autoresearch.md'), '# Rules\nDo not cheat.');
      fs.writeFileSync(
        path.join(workDir, 'autoresearch.ideas.md'),
        '- Try memoization\n- Try parallelism'
      );
      writeJsonlLines(workDir, [
        '{"name":"Speed up parser","metric_name":"total_us","metric_unit":"us","direction":"lower","segment":0}',
        '{"run":1,"commit":"aaa1111","metric":100,"status":"keep","description":"baseline","timestamp":1,"metrics":{},"asi":{"hypothesis":"start point"}}',
        '{"run":2,"commit":"bbb2222","metric":80,"status":"keep","description":"cache foo","timestamp":2,"metrics":{},"asi":{"hypothesis":"memoize repeated keys","next_action_hint":"try LRU"}}',
        '{"run":3,"commit":"ccc3333","metric":120,"status":"discard","description":"tried lru-cache","timestamp":3,"metrics":{},"asi":{"rollback_reason":"import overhead"}}',
      ]);

      const state = makeState({
        name: 'Speed up parser',
        metricName: 'total_us',
        metricUnit: 'us',
        bestDirection: 'lower',
        currentSegment: 0,
        results: [
          {
            run: 1,
            commit: 'aaa1111',
            metric: 100,
            metrics: {},
            status: 'keep',
            description: 'baseline',
            timestamp: 1,
            segment: 0,
            confidence: null,
            asi: { hypothesis: 'start point' },
          },
          {
            run: 2,
            commit: 'bbb2222',
            metric: 80,
            metrics: {},
            status: 'keep',
            description: 'cache foo',
            timestamp: 2,
            segment: 0,
            confidence: null,
            asi: { hypothesis: 'memoize repeated keys', next_action_hint: 'try LRU' },
          },
          {
            run: 3,
            commit: 'ccc3333',
            metric: 120,
            metrics: {},
            status: 'discard',
            description: 'tried lru-cache',
            timestamp: 3,
            segment: 0,
            confidence: null,
            asi: { rollback_reason: 'import overhead' },
          },
        ],
      });

      const summary = buildAutoresearchCompactionSummary(
        autoresearchSummaryPathsFor(workDir),
        state
      );

      expect(summary).toMatch(/# Autoresearch Compaction Summary/);
      expect(summary).toMatch(/## Session/);
      expect(summary).toMatch(/Goal: Speed up parser/);
      expect(summary).toMatch(/Metric: total_us — lower is better/);
      expect(summary).toMatch(/Runs so far: 3 \(2 keep · 1 discard\)/);
      expect(summary).toMatch(/Baseline \(#1\): 100us/);
      expect(summary).toMatch(/Best\s+\(#2\): 80us \(-20\.0%\)/);
      expect(summary).toMatch(/## Experiment Rules \(autoresearch\.md\)/);
      expect(summary).toMatch(/Do not cheat\./);
      expect(summary).toMatch(/## Ideas Backlog \(autoresearch\.ideas\.md\)/);
      expect(summary).toMatch(/Try memoization/);
      expect(summary).toMatch(/## Recent Runs \(last 3\)/);
      expect(summary).toMatch(/#1 keep/);
      expect(summary).toMatch(/#2 keep\s+80 \(-20\.0%\)/);
      expect(summary).toMatch(/#3 discard\s+120 \(\+20\.0%\)/);
      expect(summary).toMatch(/hyp: memoize repeated keys/);
      expect(summary).toMatch(/next: try LRU/);
      expect(summary).toMatch(/rollback: import overhead/);
      expect(summary).toMatch(/## Next Step/);
      expect(summary).toMatch(
        /If you need more details, read additional lines from autoresearch\.jsonl\./
      );
    });
  });

  it('session block omits baseline/best when no runs exist yet', () => {
    withTempWorkDir((workDir) => {
      writeJsonlLines(workDir, [
        '{"name":"Cold start","metric_name":"ms","metric_unit":"ms","direction":"lower","segment":0}',
      ]);

      const state = makeState({
        name: 'Cold start',
        metricName: 'ms',
        metricUnit: 'ms',
        bestDirection: 'lower',
      });

      const summary = buildAutoresearchCompactionSummary(
        autoresearchSummaryPathsFor(workDir),
        state
      );

      expect(summary).toMatch(/Goal: Cold start/);
      expect(summary).toMatch(/Runs so far: 0/);
      expect(summary).not.toMatch(/Baseline/);
      expect(summary).not.toMatch(/Best\s+\(#/);
    });
  });

  it('session block reflects current segment after re-init', () => {
    withTempWorkDir((workDir) => {
      writeJsonlLines(workDir, [
        '{"name":"Old goal","metric_name":"ms","metric_unit":"ms","direction":"lower","segment":0}',
        '{"run":1,"commit":"a","metric":500,"status":"keep","description":"old baseline","timestamp":1,"segment":0,"metrics":{}}',
        '{"name":"New goal","metric_name":"score","metric_unit":"pts","direction":"higher","segment":1}',
        '{"run":2,"commit":"b","metric":10,"status":"keep","description":"new baseline","timestamp":2,"segment":1,"metrics":{}}',
      ]);

      const state = makeState({
        name: 'New goal',
        metricName: 'score',
        metricUnit: 'pts',
        bestDirection: 'higher',
        currentSegment: 1,
        results: [
          {
            run: 1,
            commit: 'a',
            metric: 500,
            metrics: {},
            status: 'keep',
            description: 'old baseline',
            timestamp: 1,
            segment: 0,
            confidence: null,
          },
          {
            run: 2,
            commit: 'b',
            metric: 10,
            metrics: {},
            status: 'keep',
            description: 'new baseline',
            timestamp: 2,
            segment: 1,
            confidence: null,
          },
        ],
      });

      const summary = buildAutoresearchCompactionSummary(
        autoresearchSummaryPathsFor(workDir),
        state
      );

      expect(summary).toMatch(/Goal: New goal/);
      expect(summary).toMatch(/Metric: score — higher is better/);
      expect(summary).toMatch(/Runs so far: 1 \(1 keep\)/);
    });
  });

  it('caps recent runs at 50', () => {
    withTempWorkDir((workDir) => {
      fs.writeFileSync(path.join(workDir, 'autoresearch.md'), '# Rules');
      const lines: string[] = [
        '{"name":"Long run","metric_name":"ms","metric_unit":"ms","direction":"lower","segment":0}',
      ];
      for (let i = 1; i <= 60; i++) {
        lines.push(
          `{"run":${i},"commit":"c${i}","metric":${100 - i},"status":"keep","description":"run ${i}","timestamp":${i},"segment":0,"metrics":{}}`
        );
      }
      writeJsonlLines(workDir, lines);

      const results = Array.from({ length: 60 }, (_, i) => ({
        run: i + 1,
        commit: `c${i + 1}`,
        metric: 100 - (i + 1),
        metrics: {},
        status: 'keep' as const,
        description: `run ${i + 1}`,
        timestamp: i + 1,
        segment: 0,
        confidence: null,
      }));

      const state = makeState({
        name: 'Long run',
        metricName: 'ms',
        metricUnit: 'ms',
        bestDirection: 'lower',
        currentSegment: 0,
        results,
      });

      const summary = buildAutoresearchCompactionSummary(
        autoresearchSummaryPathsFor(workDir),
        state
      );

      expect(summary).toMatch(/Recent Runs \(last 50\)/);
      expect(summary).toMatch(/#11 keep/); // First in the 50-run window
      expect(summary).not.toMatch(/#10 keep/); // Before the window
      expect(summary).toMatch(/#60 keep/); // Last run
    });
  });

  it('omits rules and ideas sections when files are missing', () => {
    withTempWorkDir((workDir) => {
      writeJsonlLines(workDir, [
        '{"name":"No docs","metric_name":"ms","metric_unit":"ms","direction":"lower","segment":0}',
      ]);

      const state = makeState({
        name: 'No docs',
        metricName: 'ms',
        metricUnit: 'ms',
        bestDirection: 'lower',
      });

      const summary = buildAutoresearchCompactionSummary(
        autoresearchSummaryPathsFor(workDir),
        state
      );

      expect(summary).not.toMatch(/## Experiment Rules/);
      expect(summary).not.toMatch(/## Ideas Backlog/);
    });
  });

  it('uses segment baseline for delta computation, not first visible run', () => {
    withTempWorkDir((workDir) => {
      fs.writeFileSync(path.join(workDir, 'autoresearch.md'), '# Rules');
      const lines: string[] = [
        '{"name":"Delta test","metric_name":"ms","metric_unit":"ms","direction":"lower","segment":0}',
      ];
      for (let i = 1; i <= 55; i++) {
        lines.push(
          `{"run":${i},"commit":"c${i}","metric":${1000 - i * 10},"status":"keep","description":"run ${i}","timestamp":${i},"segment":0,"metrics":{}}`
        );
      }
      writeJsonlLines(workDir, lines);

      const results = Array.from({ length: 55 }, (_, i) => ({
        run: i + 1,
        commit: `c${i + 1}`,
        metric: 1000 - (i + 1) * 10,
        metrics: {},
        status: 'keep' as const,
        description: `run ${i + 1}`,
        timestamp: i + 1,
        segment: 0,
        confidence: null,
      }));

      const state = makeState({
        name: 'Delta test',
        metricName: 'ms',
        metricUnit: 'ms',
        bestDirection: 'lower',
        currentSegment: 0,
        results,
      });

      const summary = buildAutoresearchCompactionSummary(
        autoresearchSummaryPathsFor(workDir),
        state
      );

      // Run #1 (metric 990) is the segment baseline, even though it's not in
      // the last-50 window. Deltas should still reference it.
      expect(summary).toMatch(/#6 keep\s+940 \(-5\.1%\)/);
    });
  });
});
