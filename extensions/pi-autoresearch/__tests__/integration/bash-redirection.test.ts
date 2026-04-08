/**
 * Integration tests for bash tool redirection in autoresearch mode
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import type { AutoresearchRuntime } from '../../src/types/index.js';

describe('Bash Tool Redirection Integration', { timeout: 30000 }, () => {
  let testDir: string;
  let repoDir: string;
  let worktreePath: string;
  let mainCwd: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-bash-'));
    repoDir = path.join(testDir, `repo-${Date.now()}`);
    mainCwd = repoDir;
    fs.mkdirSync(repoDir, { recursive: true });

    execSync('git init', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: repoDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Repo');
    execSync('git add README.md', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "Initial commit"', { cwd: repoDir, stdio: 'ignore' });

    const sessionId = 'test-session-bash';
    worktreePath = path.join(repoDir, 'autoresearch', sessionId);
    const branchName = `autoresearch/${sessionId}`;

    fs.mkdirSync(path.join(repoDir, 'autoresearch'), { recursive: true });
    execSync(`git branch ${branchName}`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git worktree add ${worktreePath} ${branchName}`, { cwd: repoDir, stdio: 'ignore' });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  describe('createBashRedirectHandler', () => {
    it('should execute commands in worktree when autoresearch is ON', async () => {
      const { createBashRedirectHandler } = await import('../../src/tools/bash-redirect.js');

      const runtime: AutoresearchRuntime = {
        autoresearchMode: true,
        dashboardExpanded: false,
        lastAutoResumeTime: 0,
        experimentsThisSession: 0,
        autoResumeTurns: 0,
        lastRunChecks: null,
        lastRunDuration: null,
        lastRunSucceeded: null,
        runningExperiment: null,
        experimentCompletedWaitingForLog: false,
        state: {
          results: [],
          bestMetric: null,
          bestDirection: 'lower',
          metricName: '',
          metricUnit: '',
          secondaryMetrics: [],
          name: null,
          currentSegment: 0,
          maxExperiments: null,
          confidence: null,
          targetValue: null,
        },
        worktreeDir: worktreePath,
        startingCommit: null,
        jsonlWatcher: null,
      };

      const getRuntime = () => runtime;
      const handler = createBashRedirectHandler(getRuntime);

      // Mock ExtensionContext
      const mockCtx = {
        cwd: mainCwd,
        sessionManager: { getSessionId: () => 'test-session' },
        ui: { notify: () => {}, clear: () => {} },
      } as any;

      // Execute pwd command to check working directory
      const result = await handler.execute(
        'test-call-id',
        { command: 'pwd' },
        new AbortController().signal,
        undefined,
        mockCtx
      );

      // The command should execute in the worktree
      // (macOS may return /private/var/... instead of /var/...)
      const output = result.content[0]?.type === 'text' ? result.content[0].text : '';
      const normalizedOutput = output.trim().replace(/^\/private/, '');
      const normalizedWorktreePath = worktreePath.replace(/^\/private/, '');
      expect(normalizedOutput).toBe(normalizedWorktreePath);
    });

    it('should execute commands in main repo when autoresearch is OFF', async () => {
      const { createBashRedirectHandler } = await import('../../src/tools/bash-redirect.js');

      const runtime: AutoresearchRuntime = {
        autoresearchMode: false,
        dashboardExpanded: false,
        lastAutoResumeTime: 0,
        experimentsThisSession: 0,
        autoResumeTurns: 0,
        lastRunChecks: null,
        lastRunDuration: null,
        lastRunSucceeded: null,
        runningExperiment: null,
        experimentCompletedWaitingForLog: false,
        state: {
          results: [],
          bestMetric: null,
          bestDirection: 'lower',
          metricName: '',
          metricUnit: '',
          secondaryMetrics: [],
          name: null,
          currentSegment: 0,
          maxExperiments: null,
          confidence: null,
          targetValue: null,
        },
        worktreeDir: null,
        startingCommit: null,
        jsonlWatcher: null,
      };

      const getRuntime = () => runtime;
      const handler = createBashRedirectHandler(getRuntime);

      const mockCtx = {
        cwd: mainCwd,
        sessionManager: { getSessionId: () => 'test-session' },
        ui: { notify: () => {}, clear: () => {} },
      } as any;

      const result = await handler.execute(
        'test-call-id',
        { command: 'pwd' },
        new AbortController().signal,
        undefined,
        mockCtx
      );

      // (macOS may return /private/var/... instead of /var/...)
      const output = result.content[0]?.type === 'text' ? result.content[0].text : '';
      const normalizedOutput = output.trim().replace(/^\/private/, '');
      const normalizedMainCwd = mainCwd.replace(/^\/private/, '');
      expect(normalizedOutput).toBe(normalizedMainCwd);
    });

    it('should execute commands in main repo when no worktree exists', async () => {
      const { createBashRedirectHandler } = await import('../../src/tools/bash-redirect.js');

      const runtime: AutoresearchRuntime = {
        autoresearchMode: true,
        dashboardExpanded: false,
        lastAutoResumeTime: 0,
        experimentsThisSession: 0,
        autoResumeTurns: 0,
        lastRunChecks: null,
        lastRunDuration: null,
        lastRunSucceeded: null,
        runningExperiment: null,
        experimentCompletedWaitingForLog: false,
        state: {
          results: [],
          bestMetric: null,
          bestDirection: 'lower',
          metricName: '',
          metricUnit: '',
          secondaryMetrics: [],
          name: null,
          currentSegment: 0,
          maxExperiments: null,
          confidence: null,
          targetValue: null,
        },
        worktreeDir: null, // No worktree even though autoresearchMode is true
        startingCommit: null,
        jsonlWatcher: null,
      };

      const getRuntime = () => runtime;
      const handler = createBashRedirectHandler(getRuntime);

      const mockCtx = {
        cwd: mainCwd,
        sessionManager: { getSessionId: () => 'test-session' },
        ui: { notify: () => {}, clear: () => {} },
      } as any;

      const result = await handler.execute(
        'test-call-id',
        { command: 'pwd' },
        new AbortController().signal,
        undefined,
        mockCtx
      );

      // (macOS may return /private/var/... instead of /var/...)
      const output = result.content[0]?.type === 'text' ? result.content[0].text : '';
      const normalizedOutput = output.trim().replace(/^\/private/, '');
      const normalizedMainCwd = mainCwd.replace(/^\/private/, '');
      expect(normalizedOutput).toBe(normalizedMainCwd);
    });

    it('should set isolation environment variables in worktree', async () => {
      const { createBashRedirectHandler } = await import('../../src/tools/bash-redirect.js');

      const runtime: AutoresearchRuntime = {
        autoresearchMode: true,
        dashboardExpanded: false,
        lastAutoResumeTime: 0,
        experimentsThisSession: 0,
        autoResumeTurns: 0,
        lastRunChecks: null,
        lastRunDuration: null,
        lastRunSucceeded: null,
        runningExperiment: null,
        experimentCompletedWaitingForLog: false,
        state: {
          results: [],
          bestMetric: null,
          bestDirection: 'lower',
          metricName: '',
          metricUnit: '',
          secondaryMetrics: [],
          name: null,
          currentSegment: 0,
          maxExperiments: null,
          confidence: null,
          targetValue: null,
        },
        worktreeDir: worktreePath,
        startingCommit: null,
        jsonlWatcher: null,
      };

      const getRuntime = () => runtime;
      const handler = createBashRedirectHandler(getRuntime);

      const mockCtx = {
        cwd: mainCwd,
        sessionManager: { getSessionId: () => 'test-session' },
        ui: { notify: () => {}, clear: () => {} },
      } as any;

      // Check that environment variables are set
      const result = await handler.execute(
        'test-call-id',
        { command: 'echo $PI_AUTORESEARCH $PI_WORKTREE_DIR $PI_SOURCE_DIR' },
        new AbortController().signal,
        undefined,
        mockCtx
      );

      const output = result.content[0]?.type === 'text' ? result.content[0].text : '';
      expect(output.trim()).toBe(`1 ${worktreePath} ${mainCwd}`);
    });

    it('should not set isolation env vars when autoresearch is OFF', async () => {
      const { createBashRedirectHandler } = await import('../../src/tools/bash-redirect.js');

      const runtime: AutoresearchRuntime = {
        autoresearchMode: false,
        dashboardExpanded: false,
        lastAutoResumeTime: 0,
        experimentsThisSession: 0,
        autoResumeTurns: 0,
        lastRunChecks: null,
        lastRunDuration: null,
        lastRunSucceeded: null,
        runningExperiment: null,
        experimentCompletedWaitingForLog: false,
        state: {
          results: [],
          bestMetric: null,
          bestDirection: 'lower',
          metricName: '',
          metricUnit: '',
          secondaryMetrics: [],
          name: null,
          currentSegment: 0,
          maxExperiments: null,
          confidence: null,
          targetValue: null,
        },
        worktreeDir: null,
        startingCommit: null,
        jsonlWatcher: null,
      };

      const getRuntime = () => runtime;
      const handler = createBashRedirectHandler(getRuntime);

      const mockCtx = {
        cwd: mainCwd,
        sessionManager: { getSessionId: () => 'test-session' },
        ui: { notify: () => {}, clear: () => {} },
      } as any;

      const result = await handler.execute(
        'test-call-id',
        { command: 'echo $PI_AUTORESEARCH $PI_WORKTREE_DIR $PI_SOURCE_DIR' },
        new AbortController().signal,
        undefined,
        mockCtx
      );

      const output = result.content[0]?.type === 'text' ? result.content[0].text : '';
      // Variables should be empty/undefined (output may be empty or whitespace)
      expect(output.trim()).toBe('');
    });

    it('should create files in worktree, not main repo', async () => {
      const { createBashRedirectHandler } = await import('../../src/tools/bash-redirect.js');

      const runtime: AutoresearchRuntime = {
        autoresearchMode: true,
        dashboardExpanded: false,
        lastAutoResumeTime: 0,
        experimentsThisSession: 0,
        autoResumeTurns: 0,
        lastRunChecks: null,
        lastRunDuration: null,
        lastRunSucceeded: null,
        runningExperiment: null,
        experimentCompletedWaitingForLog: false,
        state: {
          results: [],
          bestMetric: null,
          bestDirection: 'lower',
          metricName: '',
          metricUnit: '',
          secondaryMetrics: [],
          name: null,
          currentSegment: 0,
          maxExperiments: null,
          confidence: null,
          targetValue: null,
        },
        worktreeDir: worktreePath,
        startingCommit: null,
        jsonlWatcher: null,
      };

      const getRuntime = () => runtime;
      const handler = createBashRedirectHandler(getRuntime);

      const mockCtx = {
        cwd: mainCwd,
        sessionManager: { getSessionId: () => 'test-session' },
        ui: { notify: () => {}, clear: () => {} },
      } as any;

      // Create a file via bash
      await handler.execute(
        'test-call-id',
        { command: "mkdir -p src && echo 'worktree content' > src/test.txt" },
        new AbortController().signal,
        undefined,
        mockCtx
      );

      // File should exist in worktree
      const worktreeFile = path.join(worktreePath, 'src', 'test.txt');
      expect(fs.existsSync(worktreeFile)).toBe(true);
      expect(fs.readFileSync(worktreeFile, 'utf-8').trim()).toBe('worktree content');

      // File should NOT exist in main repo
      const mainRepoFile = path.join(mainCwd, 'src', 'test.txt');
      expect(fs.existsSync(mainRepoFile)).toBe(false);
    });
  });
});
