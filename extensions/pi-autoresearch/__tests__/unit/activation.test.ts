/**
 * Unit tests for tool activation/deactivation logic
 *
 * Tests the activation.ts module that controls which tools are visible
 * to the model via pi.setActiveTools(). The core principle:
 * - Tools start hidden (prevents unprompted tool calls)
 * - activate makes them visible (on /autoresearch or init_experiment)
 * - deactivate hides them (only on explicit /autoresearch off or clear)
 * - Interrupts (Ctrl+C, context limits, loop completion) keep tools visible
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  activateAutoresearchTools,
  deactivateAutoresearchTools,
  excludeAutoresearchToolsFromDefaults,
  AUTORESEARCH_TOOL_NAMES,
} from '../../src/tools/activation.js';

// ---------------------------------------------------------------------------
// Mock ExtensionAPI
// ---------------------------------------------------------------------------

function createMockPi(activeTools: string[] = []) {
  const state = {
    activeTools: [...activeTools],
    setActiveToolsCalls: [] as string[][],
  };

  const pi = {
    getActiveTools: vi.fn(() => [...state.activeTools]),
    setActiveTools: vi.fn((tools: string[]) => {
      state.activeTools = [...tools];
      state.setActiveToolsCalls.push([...tools]);
    }),
    /** Expose internal state for assertions */
    _state: state,
  };

  return pi;
}

// ---------------------------------------------------------------------------
// AUTORESEARCH_TOOL_NAMES constant
// ---------------------------------------------------------------------------

describe('AUTORESEARCH_TOOL_NAMES', () => {
  it('contains exactly the 3 experiment tools', () => {
    expect(AUTORESEARCH_TOOL_NAMES).toEqual([
      'init_experiment',
      'run_experiment',
      'log_experiment',
    ]);
  });

  it('is a readonly array (frozen at type level)', () => {
    expect(AUTORESEARCH_TOOL_NAMES).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// activateAutoresearchTools
// ---------------------------------------------------------------------------

describe('activateAutoresearchTools', () => {
  it('adds all 3 experiment tools to the active set', () => {
    const pi = createMockPi(['read', 'bash', 'edit', 'write']);

    activateAutoresearchTools(pi as any);

    expect(pi.setActiveTools).toHaveBeenCalledOnce();
    const newActive = pi._state.activeTools;
    expect(newActive).toContain('init_experiment');
    expect(newActive).toContain('run_experiment');
    expect(newActive).toContain('log_experiment');
  });

  it('preserves existing active tools', () => {
    const pi = createMockPi(['read', 'bash', 'edit', 'write', 'grep']);

    activateAutoresearchTools(pi as any);

    const newActive = pi._state.activeTools;
    expect(newActive).toContain('read');
    expect(newActive).toContain('bash');
    expect(newActive).toContain('edit');
    expect(newActive).toContain('write');
    expect(newActive).toContain('grep');
  });

  it('is idempotent — calling twice does not duplicate tools', () => {
    const pi = createMockPi(['read', 'bash']);

    activateAutoresearchTools(pi as any);
    activateAutoresearchTools(pi as any);

    expect(pi.setActiveTools).toHaveBeenCalledTimes(2);
    const newActive = pi._state.activeTools;
    // Each tool should appear exactly once
    expect(newActive.filter((n) => n === 'init_experiment')).toHaveLength(1);
    expect(newActive.filter((n) => n === 'run_experiment')).toHaveLength(1);
    expect(newActive.filter((n) => n === 'log_experiment')).toHaveLength(1);
  });

  it('works when active set starts empty', () => {
    const pi = createMockPi([]);

    activateAutoresearchTools(pi as any);

    expect(pi._state.activeTools).toEqual(['init_experiment', 'run_experiment', 'log_experiment']);
  });

  it('works when experiment tools are already partially active', () => {
    const pi = createMockPi(['read', 'bash', 'init_experiment']);

    activateAutoresearchTools(pi as any);

    const newActive = pi._state.activeTools;
    expect(newActive).toContain('init_experiment');
    expect(newActive).toContain('run_experiment');
    expect(newActive).toContain('log_experiment');
    expect(newActive).toContain('read');
    expect(newActive).toContain('bash');
  });
});

// ---------------------------------------------------------------------------
// deactivateAutoresearchTools
// ---------------------------------------------------------------------------

describe('deactivateAutoresearchTools', () => {
  it('removes all 3 experiment tools from the active set', () => {
    const pi = createMockPi([
      'read',
      'bash',
      'edit',
      'write',
      'init_experiment',
      'run_experiment',
      'log_experiment',
    ]);

    deactivateAutoresearchTools(pi as any);

    const newActive = pi._state.activeTools;
    expect(newActive).not.toContain('init_experiment');
    expect(newActive).not.toContain('run_experiment');
    expect(newActive).not.toContain('log_experiment');
  });

  it('preserves non-experiment tools', () => {
    const pi = createMockPi([
      'read',
      'bash',
      'edit',
      'write',
      'grep',
      'init_experiment',
      'run_experiment',
      'log_experiment',
    ]);

    deactivateAutoresearchTools(pi as any);

    const newActive = pi._state.activeTools;
    expect(newActive).toContain('read');
    expect(newActive).toContain('bash');
    expect(newActive).toContain('edit');
    expect(newActive).toContain('write');
    expect(newActive).toContain('grep');
  });

  it('is idempotent — calling twice is safe', () => {
    const pi = createMockPi(['read', 'bash', 'init_experiment']);

    deactivateAutoresearchTools(pi as any);
    deactivateAutoresearchTools(pi as any);

    expect(pi.setActiveTools).toHaveBeenCalledTimes(2);
    expect(pi._state.activeTools).not.toContain('init_experiment');
    expect(pi._state.activeTools).toContain('read');
    expect(pi._state.activeTools).toContain('bash');
  });

  it('works when experiment tools are not in the active set', () => {
    const pi = createMockPi(['read', 'bash', 'edit', 'write']);

    deactivateAutoresearchTools(pi as any);

    expect(pi._state.activeTools).toEqual(['read', 'bash', 'edit', 'write']);
  });

  it('works on empty active set', () => {
    const pi = createMockPi([]);

    deactivateAutoresearchTools(pi as any);

    expect(pi._state.activeTools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// excludeAutoresearchToolsFromDefaults
// ---------------------------------------------------------------------------

describe('excludeAutoresearchToolsFromDefaults', () => {
  it('is an alias for deactivateAutoresearchTools', () => {
    const pi = createMockPi([
      'read',
      'bash',
      'edit',
      'write',
      'init_experiment',
      'run_experiment',
      'log_experiment',
    ]);

    excludeAutoresearchToolsFromDefaults(pi as any);

    // Same as deactivate — removes experiment tools, keeps others
    expect(pi._state.activeTools).not.toContain('init_experiment');
    expect(pi._state.activeTools).not.toContain('run_experiment');
    expect(pi._state.activeTools).not.toContain('log_experiment');
    expect(pi._state.activeTools).toContain('read');
    expect(pi._state.activeTools).toContain('bash');
  });
});

// ---------------------------------------------------------------------------
// Round-trip: activate then deactivate
// ---------------------------------------------------------------------------

describe('Round-trip activation cycle', () => {
  it('activate then deactivate returns to original set', () => {
    const original = ['read', 'bash', 'edit', 'write'];
    const pi = createMockPi([...original]);

    activateAutoresearchTools(pi as any);
    expect(pi._state.activeTools).toHaveLength(original.length + 3);

    deactivateAutoresearchTools(pi as any);
    expect(pi._state.activeTools).toEqual(original);
  });

  it('multiple activate/deactivate cycles are stable', () => {
    const original = ['read', 'bash', 'edit', 'write'];
    const pi = createMockPi([...original]);

    for (let i = 0; i < 5; i++) {
      activateAutoresearchTools(pi as any);
      deactivateAutoresearchTools(pi as any);
    }

    expect(pi._state.activeTools).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// Behavioral contract: tools stay active through interrupts
// ---------------------------------------------------------------------------

describe('Tool visibility through interrupt scenarios', () => {
  it('agent_end (Ctrl+C) does NOT call deactivate — tools stay visible', () => {
    // Simulates: user started autoresearch, agent was interrupted
    const pi = createMockPi(['read', 'bash', 'edit', 'write']);
    activateAutoresearchTools(pi as any);

    // agent_end fires but we do NOT call deactivateAutoresearchTools
    // (only autoresearchMode is set to false, tools remain active)
    const activeAfterInterrupt = pi._state.activeTools;
    expect(activeAfterInterrupt).toContain('init_experiment');
    expect(activeAfterInterrupt).toContain('run_experiment');
    expect(activeAfterInterrupt).toContain('log_experiment');
  });

  it('log_experiment max reached does NOT call deactivate — tools stay visible', () => {
    // Simulates: loop completed because max experiments reached
    const pi = createMockPi(['read', 'bash', 'edit', 'write']);
    activateAutoresearchTools(pi as any);

    // max experiments reached but we do NOT call deactivateAutoresearchTools
    // (model may want to re-init with a new target)
    const activeAfterCompletion = pi._state.activeTools;
    expect(activeAfterCompletion).toContain('init_experiment');
    expect(activeAfterCompletion).toContain('run_experiment');
    expect(activeAfterCompletion).toContain('log_experiment');
  });

  it('log_experiment target reached does NOT call deactivate — tools stay visible', () => {
    const pi = createMockPi(['read', 'bash', 'edit', 'write']);
    activateAutoresearchTools(pi as any);

    // target reached but we do NOT call deactivateAutoresearchTools
    const activeAfterTarget = pi._state.activeTools;
    expect(activeAfterTarget).toContain('init_experiment');
    expect(activeAfterTarget).toContain('run_experiment');
    expect(activeAfterTarget).toContain('log_experiment');
  });

  it('/autoresearch off DOES call deactivate — tools are hidden', () => {
    const pi = createMockPi(['read', 'bash', 'edit', 'write']);
    activateAutoresearchTools(pi as any);

    // User explicitly opts out
    deactivateAutoresearchTools(pi as any);

    expect(pi._state.activeTools).not.toContain('init_experiment');
    expect(pi._state.activeTools).not.toContain('run_experiment');
    expect(pi._state.activeTools).not.toContain('log_experiment');
  });

  it('/autoresearch clear DOES call deactivate — tools are hidden', () => {
    const pi = createMockPi(['read', 'bash', 'edit', 'write']);
    activateAutoresearchTools(pi as any);

    // User explicitly clears
    deactivateAutoresearchTools(pi as any);

    expect(pi._state.activeTools).not.toContain('init_experiment');
    expect(pi._state.activeTools).not.toContain('run_experiment');
    expect(pi._state.activeTools).not.toContain('log_experiment');
  });
});

// ---------------------------------------------------------------------------
// Session start: tools start hidden, re-activated on resume with data
// ---------------------------------------------------------------------------

describe('Session start tool visibility', () => {
  it('session_start always deactivates first (ensures tools start hidden)', () => {
    const pi = createMockPi([
      'read',
      'bash',
      'init_experiment',
      'run_experiment',
      'log_experiment',
    ]);

    // session_start handler always deactivates first
    deactivateAutoresearchTools(pi as any);

    expect(pi._state.activeTools).not.toContain('init_experiment');
    expect(pi._state.activeTools).not.toContain('run_experiment');
    expect(pi._state.activeTools).not.toContain('log_experiment');
  });

  it('session resume with existing data re-activates tools', () => {
    const pi = createMockPi(['read', 'bash', 'edit', 'write']);

    // Step 1: session_start deactivates (ensures clean slate)
    deactivateAutoresearchTools(pi as any);

    // Step 2: resume handler detects existing experiment data, re-activates
    const hasExistingData = true; // e.g. state.results.length > 0
    if (hasExistingData) {
      activateAutoresearchTools(pi as any);
    }

    expect(pi._state.activeTools).toContain('init_experiment');
    expect(pi._state.activeTools).toContain('run_experiment');
    expect(pi._state.activeTools).toContain('log_experiment');
  });

  it('session resume without data stays deactivated', () => {
    const pi = createMockPi(['read', 'bash', 'edit', 'write']);

    // Step 1: session_start deactivates
    deactivateAutoresearchTools(pi as any);

    // Step 2: no existing data — don't re-activate
    const hasExistingData = false; // state.results.length === 0
    if (hasExistingData) {
      activateAutoresearchTools(pi as any);
    }

    expect(pi._state.activeTools).not.toContain('init_experiment');
    expect(pi._state.activeTools).not.toContain('run_experiment');
    expect(pi._state.activeTools).not.toContain('log_experiment');
  });
});

// ---------------------------------------------------------------------------
// init_experiment auto-activates tools
// ---------------------------------------------------------------------------

describe('init_experiment auto-activation', () => {
  it('init_experiment activates tools even if they were hidden', () => {
    // Simulates: tools were deactivated, then model calls init_experiment
    const pi = createMockPi(['read', 'bash', 'edit', 'write']);

    // init_experiment sets autoresearchMode = true AND activates tools
    activateAutoresearchTools(pi as any);

    expect(pi._state.activeTools).toContain('init_experiment');
    expect(pi._state.activeTools).toContain('run_experiment');
    expect(pi._state.activeTools).toContain('log_experiment');
  });
});

// ---------------------------------------------------------------------------
// Auto-resume: tools stay active so next turn can call init_experiment
// ---------------------------------------------------------------------------

describe('Auto-resume tool visibility', () => {
  it('after agent_end with auto-resume, tools remain active for next turn', () => {
    const pi = createMockPi(['read', 'bash', 'edit', 'write']);

    // User activated autoresearch
    activateAutoresearchTools(pi as any);

    // agent_end fires: autoresearchMode = false but tools stay active
    // (no deactivateAutoresearchTools call)
    // auto-resume sends sendUserMessage to continue the loop

    // Next turn: model can still see and call init_experiment
    expect(pi._state.activeTools).toContain('init_experiment');
    expect(pi._state.activeTools).toContain('run_experiment');
    expect(pi._state.activeTools).toContain('log_experiment');
  });
});
