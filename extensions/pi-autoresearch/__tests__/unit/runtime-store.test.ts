/**
 * Runtime store session isolation tests
 */

import { describe, it, expect } from 'vitest';
import { createRuntimeStore, createSessionRuntime } from '../../src/state/index.js';

describe('Runtime Store Session Isolation', () => {
  it('creates separate runtime instances for different session keys', () => {
    const store = createRuntimeStore();

    const session1 = 'session-alpha-123';
    const session2 = 'session-beta-456';

    const runtime1 = store.ensure(session1);
    const runtime2 = store.ensure(session2);

    // Should be different objects
    expect(runtime1).not.toBe(runtime2);
  });

  it('returns same runtime instance for same session key', () => {
    const store = createRuntimeStore();
    const sessionKey = 'same-session-789';

    const runtime1 = store.ensure(sessionKey);
    const runtime2 = store.ensure(sessionKey);

    // Should be same object
    expect(runtime1).toBe(runtime2);
  });

  it('runtime state is isolated between sessions', () => {
    const store = createRuntimeStore();

    const session1 = 'isolated-1';
    const session2 = 'isolated-2';

    const runtime1 = store.ensure(session1);
    const runtime2 = store.ensure(session2);

    // Modify session 1's state
    runtime1.autoresearchMode = true;
    runtime1.state.name = 'Session 1 Experiment';
    runtime1.state.results.push({
      commit: 'abc123',
      metric: 100,
      metrics: {},
      status: 'keep',
      description: 'Session 1 result',
      timestamp: Date.now(),
      segment: 0,
      confidence: null,
    });

    // Session 2 should not be affected
    expect(runtime2.autoresearchMode).toBe(false);
    expect(runtime2.state.name).toBeNull();
    expect(runtime2.state.results).toHaveLength(0);

    // Session 1 should have its data
    expect(runtime1.autoresearchMode).toBe(true);
    expect(runtime1.state.name).toBe('Session 1 Experiment');
    expect(runtime1.state.results).toHaveLength(1);
  });

  it('worktreeDir is isolated per session', () => {
    const store = createRuntimeStore();

    const session1 = 'worktree-test-1';
    const session2 = 'worktree-test-2';

    const runtime1 = store.ensure(session1);
    const runtime2 = store.ensure(session2);

    // Set different worktrees
    runtime1.worktreeDir = '/project/autoresearch/worktree-test-1';
    runtime2.worktreeDir = '/project/autoresearch/worktree-test-2';

    // Each should have its own worktree
    expect(runtime1.worktreeDir).toBe('/project/autoresearch/worktree-test-1');
    expect(runtime2.worktreeDir).toBe('/project/autoresearch/worktree-test-2');
    expect(runtime1.worktreeDir).not.toBe(runtime2.worktreeDir);
  });

  it('clear removes only the specified session', () => {
    const store = createRuntimeStore();

    const session1 = 'clear-test-1';
    const session2 = 'clear-test-2';

    // Create both sessions
    store.ensure(session1);
    store.ensure(session2);

    expect(store.has(session1)).toBe(true);
    expect(store.has(session2)).toBe(true);

    // Clear only session 1
    store.clear(session1);

    // Session 1 should be gone
    expect(store.has(session1)).toBe(false);

    // Session 2 should still exist
    expect(store.has(session2)).toBe(true);

    // Re-ensuring session1 should create fresh runtime
    const freshRuntime = store.ensure(session1);
    expect(store.has(session1)).toBe(true);
    expect(freshRuntime.autoresearchMode).toBe(false); // Fresh state
  });

  it('experiment counters are per-session', () => {
    const store = createRuntimeStore();

    const session1 = 'counters-1';
    const session2 = 'counters-2';

    const runtime1 = store.ensure(session1);
    const runtime2 = store.ensure(session2);

    // Increment session 1 counters
    runtime1.experimentsThisSession = 5;
    runtime1.autoResumeTurns = 3;

    // Session 2 should be at defaults
    expect(runtime2.experimentsThisSession).toBe(0);
    expect(runtime2.autoResumeTurns).toBe(0);

    // Session 1 should have its values
    expect(runtime1.experimentsThisSession).toBe(5);
    expect(runtime1.autoResumeTurns).toBe(3);
  });

  it('jsonlWatcher is per-session', () => {
    const store = createRuntimeStore();

    const session1 = 'watcher-1';
    const session2 = 'watcher-2';

    const runtime1 = store.ensure(session1);
    const runtime2 = store.ensure(session2);

    // Mock watcher for session 1
    const mockWatcher = { close: () => {} };
    runtime1.jsonlWatcher = mockWatcher as any;

    // Session 2 should not have the watcher
    expect(runtime2.jsonlWatcher).toBeNull();

    // Session 1 should have its watcher
    expect(runtime1.jsonlWatcher).toBe(mockWatcher);
  });
});
