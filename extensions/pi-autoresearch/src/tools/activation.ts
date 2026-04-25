/**
 * Autoresearch tool activation/deactivation via setActiveTools().
 *
 * The 3 experiment tools (init_experiment, run_experiment, log_experiment)
 * are registered at extension load but excluded from the default active set.
 * They only appear when autoresearch mode is activated (via /autoresearch
 * or init_experiment) and are removed when autoresearch mode ends.
 *
 * This prevents models from calling autoresearch tools unprompted.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

/** Tool names that are hidden until autoresearch mode is activated */
export const AUTORESEARCH_TOOL_NAMES = [
  'init_experiment',
  'run_experiment',
  'log_experiment',
] as const;

/**
 * Add the autoresearch tools to the active tool set.
 * Preserves all currently active tools and appends the experiment tools.
 */
export function activateAutoresearchTools(pi: ExtensionAPI): void {
  const active = new Set(pi.getActiveTools());
  for (const name of AUTORESEARCH_TOOL_NAMES) {
    active.add(name);
  }
  pi.setActiveTools([...active]);
}

/**
 * Remove the autoresearch tools from the active tool set.
 * Preserves all other active tools.
 */
export function deactivateAutoresearchTools(pi: ExtensionAPI): void {
  const active = pi
    .getActiveTools()
    .filter((name) => !(AUTORESEARCH_TOOL_NAMES as readonly string[]).includes(name));
  pi.setActiveTools(active);
}

/**
 * Exclude autoresearch tools from the initial active set.
 * Called once during extension load.
 */
export function excludeAutoresearchToolsFromDefaults(pi: ExtensionAPI): void {
  deactivateAutoresearchTools(pi);
}
