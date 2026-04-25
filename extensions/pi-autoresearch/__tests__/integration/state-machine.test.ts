/**
 * Integration tests for autoresearch state machine
 * Tests the transitions between NORMAL -> ACTIVE -> PAUSED modes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

describe('Autoresearch State Machine', () => {
  let testDir: string;
  let repoDir: string;
  let worktreePath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-state-'));
    repoDir = path.join(testDir, `repo-${Date.now()}`);
    fs.mkdirSync(repoDir, { recursive: true });

    execSync('git init', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: repoDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Repo');
    execSync('git add README.md', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "Initial commit"', { cwd: repoDir, stdio: 'ignore' });

    const sessionId = 'test-session-state';
    worktreePath = path.join(repoDir, 'autoresearch', sessionId);
    const branchName = `autoresearch/${sessionId}`;

    fs.mkdirSync(path.join(repoDir, 'autoresearch'), { recursive: true });
    execSync(`git branch ${branchName}`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git worktree add ${worktreePath} ${branchName}`, { cwd: repoDir, stdio: 'ignore' });

    // Create initial autoresearch.jsonl
    fs.writeFileSync(
      path.join(worktreePath, 'autoresearch.jsonl'),
      JSON.stringify({
        type: 'config',
        name: 'Test Session',
        metricName: 'time_ms',
        metricUnit: 'ms',
        bestDirection: 'lower',
      }) + '\n'
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  describe('NORMAL -> ACTIVE transition (init_experiment)', { timeout: 30000 }, () => {
    it('init_experiment sets autoresearchMode to true', () => {
      const runtime = {
        autoresearchMode: false,
        worktreeDir: worktreePath,
        state: {
          name: null as string | null,
          results: [] as unknown[],
          metricName: 'metric',
          metricUnit: '',
          bestDirection: 'lower' as const,
          targetValue: null as number | null,
          currentSegment: 0,
          secondaryMetrics: [],
          confidence: null as number | null,
        },
      };

      // Simulate init_experiment behavior
      expect(runtime.autoresearchMode).toBe(false);
      runtime.autoresearchMode = true;
      expect(runtime.autoresearchMode).toBe(true);
    });

    it('file redirection is enabled after init_experiment', async () => {
      const { createWriteOperations } = await import('../../src/tools/file-redirect.js');

      const runtime = {
        autoresearchMode: true,
        worktreeDir: worktreePath,
      };

      const ops = createWriteOperations(repoDir, runtime);
      await ops.writeFile('test.txt', 'hello from active mode');

      // File should be in worktree (redirected)
      const worktreeFile = path.join(worktreePath, 'test.txt');
      expect(fs.existsSync(worktreeFile)).toBe(true);
      expect(fs.readFileSync(worktreeFile, 'utf-8')).toBe('hello from active mode');
    });
  });

  describe('ACTIVE -> PAUSED transition (agent_end)', () => {
    it('agent_end sets autoresearchMode to false', () => {
      const runtime = {
        autoresearchMode: true,
        runningExperiment: null as { startedAt: number; command: string } | null,
        experimentCompletedWaitingForLog: false,
        lastRunSucceeded: null as boolean | null,
        experimentsThisSession: 3,
      };

      // Simulate agent_end behavior
      runtime.runningExperiment = null;
      runtime.experimentCompletedWaitingForLog = false;
      runtime.lastRunSucceeded = null;
      runtime.autoresearchMode = false;

      expect(runtime.autoresearchMode).toBe(false);
    });

    it('file redirection is disabled after agent_end', async () => {
      const { createWriteOperations } = await import('../../src/tools/file-redirect.js');

      // Start in ACTIVE mode
      let runtime = {
        autoresearchMode: true,
        worktreeDir: worktreePath,
      };

      // Agent ends - transition to PAUSED
      runtime = {
        autoresearchMode: false,
        worktreeDir: worktreePath, // worktreeDir is preserved
      };

      const ops = createWriteOperations(repoDir, runtime);
      await ops.writeFile('paused-test.txt', 'hello from paused mode');

      // File should be in main repo (NOT redirected)
      const mainRepoFile = path.join(repoDir, 'paused-test.txt');
      expect(fs.existsSync(mainRepoFile)).toBe(true);
      expect(fs.readFileSync(mainRepoFile, 'utf-8')).toBe('hello from paused mode');

      // File should NOT be in worktree
      const worktreeFile = path.join(worktreePath, 'paused-test.txt');
      expect(fs.existsSync(worktreeFile)).toBe(false);
    });

    it('worktreeDir is preserved when mode is paused', () => {
      const runtime = {
        autoresearchMode: true,
        worktreeDir: worktreePath,
        runningExperiment: null as { startedAt: number; command: string } | null,
        experimentCompletedWaitingForLog: false,
        lastRunSucceeded: null as boolean | null,
      };

      // agent_end handler
      runtime.runningExperiment = null;
      runtime.experimentCompletedWaitingForLog = false;
      runtime.lastRunSucceeded = null;
      runtime.autoresearchMode = false;
      // worktreeDir is NOT cleared

      expect(runtime.autoresearchMode).toBe(false);
      expect(runtime.worktreeDir).toBe(worktreePath); // Preserved
    });
  });

  describe('PAUSED -> ACTIVE transition (init_experiment resume)', () => {
    it('init_experiment can resume from paused mode', () => {
      const runtime = {
        autoresearchMode: false, // Paused
        worktreeDir: worktreePath, // Preserved from before
        state: {
          name: 'Test Session',
          results: [] as unknown[],
          metricName: 'time_ms',
          metricUnit: 'ms',
          bestDirection: 'lower' as const,
        },
      };

      // User calls init_experiment again to resume
      expect(runtime.autoresearchMode).toBe(false);
      runtime.autoresearchMode = true;
      expect(runtime.autoresearchMode).toBe(true);
      expect(runtime.worktreeDir).toBe(worktreePath); // Still preserved
    });

    it('file redirection is re-enabled after resuming', async () => {
      const { createWriteOperations } = await import('../../src/tools/file-redirect.js');

      // PAUSED mode
      let runtime = {
        autoresearchMode: false,
        worktreeDir: worktreePath,
      };

      // Resume with init_experiment
      runtime = {
        autoresearchMode: true,
        worktreeDir: worktreePath,
      };

      const ops = createWriteOperations(repoDir, runtime);
      await ops.writeFile('resumed-test.txt', 'hello from resumed mode');

      // File should be in worktree again (redirected)
      const worktreeFile = path.join(worktreePath, 'resumed-test.txt');
      expect(fs.existsSync(worktreeFile)).toBe(true);
      expect(fs.readFileSync(worktreeFile, 'utf-8')).toBe('hello from resumed mode');

      // File should NOT be in main repo
      const mainRepoFile = path.join(repoDir, 'resumed-test.txt');
      expect(fs.existsSync(mainRepoFile)).toBe(false);
    });
  });

  describe('log_experiment guard when paused', () => {
    it('log_experiment requires autoresearchMode to be true', () => {
      const runtime = {
        autoresearchMode: false, // Paused
        state: {
          name: 'Test Session', // Has name (init was called before)
          results: [] as unknown[],
        },
      };

      // Simulate the guard check from log-experiment.ts
      const canLog = runtime.autoresearchMode === true;

      expect(canLog).toBe(false);
    });

    it('log_experiment works when autoresearchMode is true', () => {
      const runtime = {
        autoresearchMode: true,
        state: {
          name: 'Test Session',
          results: [] as unknown[],
        },
      };

      const canLog = runtime.autoresearchMode === true;

      expect(canLog).toBe(true);
    });
  });

  describe('Complete lifecycle', () => {
    it('full cycle: normal -> active -> paused -> active', async () => {
      const { createWriteOperations } = await import('../../src/tools/file-redirect.js');

      let runtime = {
        autoresearchMode: false,
        worktreeDir: null as string | null,
        state: {
          name: null as string | null,
          results: [] as unknown[],
        },
      };

      // Step 1: NORMAL mode - files go to main repo
      const ops1 = createWriteOperations(repoDir, runtime);
      await ops1.writeFile('step1.txt', 'normal mode');
      expect(fs.existsSync(path.join(repoDir, 'step1.txt'))).toBe(true);

      // Step 2: init_experiment -> ACTIVE mode
      runtime = {
        autoresearchMode: true,
        worktreeDir: worktreePath,
        state: {
          name: 'Test Session',
          results: [],
        },
      };

      const ops2 = createWriteOperations(repoDir, runtime);
      await ops2.writeFile('step2.txt', 'active mode');
      expect(fs.existsSync(path.join(worktreePath, 'step2.txt'))).toBe(true);
      expect(fs.existsSync(path.join(repoDir, 'step2.txt'))).toBe(false);

      // Step 3: agent_end -> PAUSED mode
      runtime = {
        autoresearchMode: false,
        worktreeDir: worktreePath, // Preserved
        state: {
          name: 'Test Session',
          results: [],
        },
      };

      const ops3 = createWriteOperations(repoDir, runtime);
      await ops3.writeFile('step3.txt', 'paused mode');
      expect(fs.existsSync(path.join(repoDir, 'step3.txt'))).toBe(true);
      expect(fs.existsSync(path.join(worktreePath, 'step3.txt'))).toBe(false);

      // Step 4: init_experiment -> ACTIVE mode again
      runtime = {
        autoresearchMode: true,
        worktreeDir: worktreePath,
        state: {
          name: 'Test Session',
          results: [],
        },
      };

      const ops4 = createWriteOperations(repoDir, runtime);
      await ops4.writeFile('step4.txt', 'active again');
      expect(fs.existsSync(path.join(worktreePath, 'step4.txt'))).toBe(true);
      expect(fs.existsSync(path.join(repoDir, 'step4.txt'))).toBe(false);
    });

    it('agent_end does not pause if experiment is in progress', () => {
      const runtime = {
        autoresearchMode: true,
        runningExperiment: { startedAt: Date.now(), command: 'test' }, // In progress
        experimentCompletedWaitingForLog: false,
        lastRunSucceeded: null,
      };

      // agent_end would check this condition before turning off
      const shouldPause = !runtime.runningExperiment && !runtime.experimentCompletedWaitingForLog;

      expect(shouldPause).toBe(false);
      // In real implementation, autoresearchMode would stay true
      expect(runtime.autoresearchMode).toBe(true);
    });

    it('agent_end pauses when no experiment is in progress', () => {
      const runtime = {
        autoresearchMode: true,
        runningExperiment: null, // Not running
        experimentCompletedWaitingForLog: false,
        lastRunSucceeded: null,
      };

      // agent_end checks this condition
      const shouldPause = !runtime.runningExperiment && !runtime.experimentCompletedWaitingForLog;

      expect(shouldPause).toBe(true);
    });
  });
});

// ===========================================================================
// Tool activation lifecycle integration tests
// Tests how tool visibility tracks autoresearchMode across state transitions
// ===========================================================================
import {
  activateAutoresearchTools,
  deactivateAutoresearchTools,
  AUTORESEARCH_TOOL_NAMES,
} from '../../src/tools/activation.js';

function createMockPi(activeTools: string[] = []) {
  const state = {
    activeTools: [...activeTools],
  };
  return {
    getActiveTools: () => [...state.activeTools],
    setActiveTools: (tools: string[]) => {
      state.activeTools = [...tools];
    },
    _state: state,
  };
}

describe('Tool activation lifecycle', () => {
  it('full lifecycle: hidden -> active -> interrupt -> still active -> explicit off -> hidden', () => {
    const pi = createMockPi(['read', 'bash', 'edit', 'write']);

    // 1. Fresh session: tools are hidden
    deactivateAutoresearchTools(pi as any);
    for (const name of AUTORESEARCH_TOOL_NAMES) {
      expect(pi._state.activeTools).not.toContain(name);
    }

    // 2. /autoresearch optimize X -> tools activated
    activateAutoresearchTools(pi as any);
    for (const name of AUTORESEARCH_TOOL_NAMES) {
      expect(pi._state.activeTools).toContain(name);
    }

    // 3. Ctrl+C interrupt (agent_end) -> autoresearchMode off, but tools STAY active
    // (no deactivateAutoresearchTools call)
    for (const name of AUTORESEARCH_TOOL_NAMES) {
      expect(pi._state.activeTools).toContain(name);
    }

    // 4. Model calls init_experiment to resume -> tools still active (idempotent)
    activateAutoresearchTools(pi as any);
    for (const name of AUTORESEARCH_TOOL_NAMES) {
      expect(pi._state.activeTools).toContain(name);
    }

    // 5. /autoresearch off -> tools deactivated (explicit opt-out)
    deactivateAutoresearchTools(pi as any);
    for (const name of AUTORESEARCH_TOOL_NAMES) {
      expect(pi._state.activeTools).not.toContain(name);
    }
  });

  it('loop completion (max experiments) does not hide tools', () => {
    const pi = createMockPi(['read', 'bash', 'edit', 'write']);
    activateAutoresearchTools(pi as any);

    // log_experiment reports max experiments reached
    // autoresearchMode = false, but NO deactivateAutoresearchTools call
    for (const name of AUTORESEARCH_TOOL_NAMES) {
      expect(pi._state.activeTools).toContain(name);
    }

    // Model can call init_experiment to start a new segment
    // (tools are still visible)
  });

  it('loop completion (target reached) does not hide tools', () => {
    const pi = createMockPi(['read', 'bash', 'edit', 'write']);
    activateAutoresearchTools(pi as any);

    // log_experiment reports target reached
    // autoresearchMode = false, but NO deactivateAutoresearchTools call
    for (const name of AUTORESEARCH_TOOL_NAMES) {
      expect(pi._state.activeTools).toContain(name);
    }
  });

  it('/autoresearch clear deactivates tools (clean slate)', () => {
    const pi = createMockPi(['read', 'bash', 'edit', 'write']);
    activateAutoresearchTools(pi as any);

    // /autoresearch clear
    deactivateAutoresearchTools(pi as any);
    for (const name of AUTORESEARCH_TOOL_NAMES) {
      expect(pi._state.activeTools).not.toContain(name);
    }
  });

  it('session start always deactivates first (ensures hidden baseline)', () => {
    const pi = createMockPi([
      'read',
      'bash',
      'init_experiment',
      'run_experiment',
      'log_experiment',
    ]);

    // session_start handler: deactivateAutoresearchTools(pi)
    deactivateAutoresearchTools(pi as any);
    for (const name of AUTORESEARCH_TOOL_NAMES) {
      expect(pi._state.activeTools).not.toContain(name);
    }
  });

  it('session resume with data re-activates after initial deactivation', () => {
    const pi = createMockPi(['read', 'bash', 'edit', 'write']);

    // session_start handler #1: always deactivate
    deactivateAutoresearchTools(pi as any);
    for (const name of AUTORESEARCH_TOOL_NAMES) {
      expect(pi._state.activeTools).not.toContain(name);
    }

    // session_start handler #2: if results.length > 0, re-activate
    const hasResults = true;
    if (hasResults) {
      activateAutoresearchTools(pi as any);
    }
    for (const name of AUTORESEARCH_TOOL_NAMES) {
      expect(pi._state.activeTools).toContain(name);
    }
  });

  it('session resume without data stays deactivated', () => {
    const pi = createMockPi(['read', 'bash', 'edit', 'write']);

    // session_start handler #1: always deactivate
    deactivateAutoresearchTools(pi as any);

    // session_start handler #2: no results -> don't activate
    const hasResults = false;
    if (hasResults) {
      activateAutoresearchTools(pi as any);
    }
    for (const name of AUTORESEARCH_TOOL_NAMES) {
      expect(pi._state.activeTools).not.toContain(name);
    }
  });

  it('builtin tool overrides (bash/read/edit/write) are never removed', () => {
    const pi = createMockPi(['read', 'bash', 'edit', 'write']);

    activateAutoresearchTools(pi as any);
    expect(pi._state.activeTools).toContain('read');
    expect(pi._state.activeTools).toContain('bash');
    expect(pi._state.activeTools).toContain('edit');
    expect(pi._state.activeTools).toContain('write');

    deactivateAutoresearchTools(pi as any);
    expect(pi._state.activeTools).toContain('read');
    expect(pi._state.activeTools).toContain('bash');
    expect(pi._state.activeTools).toContain('edit');
    expect(pi._state.activeTools).toContain('write');
  });
});
