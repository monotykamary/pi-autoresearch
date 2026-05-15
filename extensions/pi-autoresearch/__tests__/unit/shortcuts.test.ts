/**
 * Tests for configurable dashboard shortcuts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  autoresearchShortcutsConfigPath,
  DEFAULT_FULLSCREEN_DASHBOARD_SHORTCUT,
  DEFAULT_TOGGLE_DASHBOARD_SHORTCUT,
  resolveAutoresearchShortcuts,
  dashboardHintVariants,
} from '../../src/shortcuts/index.js';

describe('resolveAutoresearchShortcuts', () => {
  it('defaults to the documented bindings when config is absent', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-autoresearch-test-'));
    try {
      const configPath = autoresearchShortcutsConfigPath(agentDir);
      const shortcuts = resolveAutoresearchShortcuts(configPath);

      expect(configPath).toBe(join(agentDir, 'extensions', 'pi-autoresearch.json'));
      expect(shortcuts.toggleDashboard).toBe(DEFAULT_TOGGLE_DASHBOARD_SHORTCUT);
      expect(shortcuts.fullscreenDashboard).toBe(DEFAULT_FULLSCREEN_DASHBOARD_SHORTCUT);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it('can be overridden by the config file', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-autoresearch-test-'));
    try {
      const configPath = autoresearchShortcutsConfigPath(agentDir);
      await mkdir(join(agentDir, 'extensions'), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          shortcuts: {
            toggleDashboard: 'ctrl+shift+y',
            fullscreenDashboard: 'ctrl+shift+u',
          },
        })
      );

      const shortcuts = resolveAutoresearchShortcuts(configPath);

      expect(shortcuts.toggleDashboard).toBe('ctrl+shift+y');
      expect(shortcuts.fullscreenDashboard).toBe('ctrl+shift+u');
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it('can be disabled with null in the config file', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-autoresearch-test-'));
    try {
      const configPath = autoresearchShortcutsConfigPath(agentDir);
      await mkdir(join(agentDir, 'extensions'), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          shortcuts: {
            toggleDashboard: null,
            fullscreenDashboard: null,
          },
        })
      );

      const shortcuts = resolveAutoresearchShortcuts(configPath);

      expect(shortcuts.toggleDashboard).toBeNull();
      expect(shortcuts.fullscreenDashboard).toBeNull();
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it('partial shortcut config defaults omitted fields independently', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-autoresearch-test-'));
    try {
      const configPath = autoresearchShortcutsConfigPath(agentDir);
      await mkdir(join(agentDir, 'extensions'), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          shortcuts: {
            toggleDashboard: 'ctrl+shift+y',
          },
        })
      );

      const shortcuts = resolveAutoresearchShortcuts(configPath);

      expect(shortcuts.toggleDashboard).toBe('ctrl+shift+y');
      expect(shortcuts.fullscreenDashboard).toBe(DEFAULT_FULLSCREEN_DASHBOARD_SHORTCUT);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it('falls back to defaults for malformed config', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-autoresearch-test-'));
    try {
      const configPath = autoresearchShortcutsConfigPath(agentDir);
      await mkdir(join(agentDir, 'extensions'), { recursive: true });
      await writeFile(configPath, 'not valid json');

      const shortcuts = resolveAutoresearchShortcuts(configPath);

      expect(shortcuts.toggleDashboard).toBe(DEFAULT_TOGGLE_DASHBOARD_SHORTCUT);
      expect(shortcuts.fullscreenDashboard).toBe(DEFAULT_FULLSCREEN_DASHBOARD_SHORTCUT);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it('falls back to defaults when shortcuts values are invalid', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-autoresearch-test-'));
    try {
      const configPath = autoresearchShortcutsConfigPath(agentDir);
      await mkdir(join(agentDir, 'extensions'), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          shortcuts: {
            toggleDashboard: 42,
            fullscreenDashboard: false,
          },
        })
      );

      const shortcuts = resolveAutoresearchShortcuts(configPath);

      expect(shortcuts.toggleDashboard).toBe(DEFAULT_TOGGLE_DASHBOARD_SHORTCUT);
      expect(shortcuts.fullscreenDashboard).toBe(DEFAULT_FULLSCREEN_DASHBOARD_SHORTCUT);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});

describe('dashboardHintVariants', () => {
  it('returns both toggle and fullscreen hints when both are set', () => {
    const shortcuts = {
      toggleDashboard: 'ctrl+shift+a',
      fullscreenDashboard: 'ctrl+shift+x',
    };
    const hints = dashboardHintVariants(shortcuts, 'collapse');

    expect(hints.length).toBeGreaterThanOrEqual(2);
    expect(hints[0]).toContain('ctrl+shift+a collapse');
    expect(hints[0]).toContain('ctrl+shift+x fullscreen');
  });

  it('returns only fullscreen hint when toggle is null', () => {
    const shortcuts = {
      toggleDashboard: null,
      fullscreenDashboard: 'ctrl+shift+x',
    };
    const hints = dashboardHintVariants(shortcuts, 'expand');

    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('ctrl+shift+x fullscreen');
  });

  it('returns empty array when both are null', () => {
    const shortcuts = {
      toggleDashboard: null,
      fullscreenDashboard: null,
    };
    const hints = dashboardHintVariants(shortcuts, 'expand');

    expect(hints).toHaveLength(0);
  });

  it('uses expand/collapse action in toggle hint', () => {
    const shortcuts = {
      toggleDashboard: 'ctrl+shift+a',
      fullscreenDashboard: 'ctrl+shift+x',
    };

    const expandHints = dashboardHintVariants(shortcuts, 'expand');
    expect(expandHints[0]).toContain('expand');

    const collapseHints = dashboardHintVariants(shortcuts, 'collapse');
    expect(collapseHints[0]).toContain('collapse');
  });
});
