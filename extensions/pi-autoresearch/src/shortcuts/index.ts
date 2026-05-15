/**
 * Configurable keyboard shortcuts for the autoresearch dashboard.
 *
 * Allows users to override or disable dashboard shortcuts with a
 * profile-aware config file so the extension can coexist with other
 * extensions that bind the same keys.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_TOGGLE_DASHBOARD_SHORTCUT = 'ctrl+shift+a';
export const DEFAULT_FULLSCREEN_DASHBOARD_SHORTCUT = 'ctrl+shift+x';

const CONFIG_FILE_NAME = 'pi-autoresearch.json';

export interface AutoresearchShortcuts {
  toggleDashboard: string | null;
  fullscreenDashboard: string | null;
}

interface AutoresearchShortcutConfig {
  toggleDashboard?: unknown;
  fullscreenDashboard?: unknown;
}

export function autoresearchShortcutsConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, 'extensions', CONFIG_FILE_NAME);
}

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
}

export function resolveAutoresearchShortcuts(
  configPath: string = autoresearchShortcutsConfigPath()
): AutoresearchShortcuts {
  if (!existsSync(configPath)) {
    return defaultAutoresearchShortcuts();
  }

  const config = readShortcutConfig(configPath);
  if (!config) {
    return defaultAutoresearchShortcuts();
  }

  return {
    toggleDashboard: shortcutFromConfig(config.toggleDashboard, DEFAULT_TOGGLE_DASHBOARD_SHORTCUT),
    fullscreenDashboard: shortcutFromConfig(
      config.fullscreenDashboard,
      DEFAULT_FULLSCREEN_DASHBOARD_SHORTCUT
    ),
  };
}

function readShortcutConfig(configPath: string): AutoresearchShortcutConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    warnUsingDefaults('Could not read', configPath);
    return null;
  }

  const shortcuts = isRecord(parsed) ? parsed.shortcuts : undefined;
  if (shortcuts === undefined) {
    return {};
  }

  if (!isRecord(shortcuts) || !hasValidShortcutValues(shortcuts)) {
    warnUsingDefaults('Invalid', configPath);
    return null;
  }

  return shortcuts;
}

function hasValidShortcutValues(shortcuts: Record<string, unknown>): boolean {
  return (
    isValidShortcutConfigValue(shortcuts.toggleDashboard) &&
    isValidShortcutConfigValue(shortcuts.fullscreenDashboard)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidShortcutConfigValue(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || (typeof value === 'string' && value !== '');
}

function shortcutFromConfig(configured: unknown, fallback: string): string | null {
  if (configured === null) return null;
  return typeof configured === 'string' ? configured : fallback;
}

function defaultAutoresearchShortcuts(): AutoresearchShortcuts {
  return {
    toggleDashboard: DEFAULT_TOGGLE_DASHBOARD_SHORTCUT,
    fullscreenDashboard: DEFAULT_FULLSCREEN_DASHBOARD_SHORTCUT,
  };
}

function warnUsingDefaults(reason: 'Could not read' | 'Invalid', configPath: string): void {
  console.warn(`${reason} pi-autoresearch config at ${configPath}; using default shortcuts.`);
}

/**
 * Build adaptive hint variants for the dashboard header.
 * Returns an array of hint strings from most descriptive to least.
 */
export function dashboardHintVariants(
  shortcuts: AutoresearchShortcuts,
  toggleAction: 'expand' | 'collapse'
): string[] {
  const toggle = shortcuts.toggleDashboard ? `${shortcuts.toggleDashboard} ${toggleAction}` : null;
  const fullscreen = shortcuts.fullscreenDashboard
    ? `${shortcuts.fullscreenDashboard} fullscreen`
    : null;

  if (toggle && fullscreen) {
    return [
      `${toggle} • ${fullscreen}`,
      `${toggle} • full: ${shortcuts.fullscreenDashboard}`,
      `${shortcuts.toggleDashboard} • ${shortcuts.fullscreenDashboard}`,
    ];
  }

  return [toggle, fullscreen].filter((hint): hint is string => hint !== null);
}
