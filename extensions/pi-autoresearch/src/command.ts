/**
 * /autoresearch command handler
 *
 * Delegates to the pi-autoresearch CLI for actual state management.
 */

import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { AutoresearchRuntime } from './types/index.js';
import { createExperimentState } from './state/index.js';

/** Dependencies needed by command handler */
export interface CommandContext {
  pi: ExtensionAPI;
  getRuntime: (ctx: ExtensionContext) => AutoresearchRuntime;
  getSessionKey: (ctx: ExtensionContext) => string;
  updateWidget: (ctx: ExtensionContext) => void;
  clearSessionUi: (ctx: ExtensionContext) => void;
}

/**
 * Create the /autoresearch command handler
 */
export function registerAutoresearchCommand(ctx: CommandContext): void {
  const { pi, getRuntime, updateWidget } = ctx;

  pi.registerCommand('autoresearch', {
    description: 'Start, stop, or clear autoresearch mode',
    handler: async (args, extCtx) => {
      const runtime = getRuntime(extCtx);
      const trimmedArgs = (args ?? '').trim();
      const command = trimmedArgs.toLowerCase();

      if (!trimmedArgs) {
        extCtx.ui.notify(
          'Usage: /autoresearch [off|clear|<text>]\n\nUse pi-autoresearch CLI for experiment operations:\n  pi-autoresearch activate "goal"\n  pi-autoresearch init --name ... --metric-name ...\n  pi-autoresearch run "bash autoresearch.sh"\n  pi-autoresearch log --metric N --status keep --description "..."',
          'info'
        );
        return;
      }

      if (command === 'off') {
        runtime.autoresearchMode = false;
        runtime.dashboardExpanded = false;
        if (runtime.jsonlWatcher) {
          runtime.jsonlWatcher.close();
          runtime.jsonlWatcher = null;
        }
        ctx.clearSessionUi(extCtx);
        extCtx.ui.notify('Autoresearch mode OFF', 'info');
        return;
      }

      if (command === 'clear') {
        if (runtime.jsonlWatcher) {
          runtime.jsonlWatcher.close();
          runtime.jsonlWatcher = null;
        }
        runtime.autoresearchMode = false;
        runtime.dashboardExpanded = false;
        runtime.state = createExperimentState();
        runtime.worktreeDir = null;
        updateWidget(extCtx);
        extCtx.ui.notify('Autoresearch cleared', 'info');
        return;
      }

      // Activate — set mode flag, actual work done via CLI
      runtime.autoresearchMode = true;
      extCtx.ui.notify('Autoresearch mode ON — use pi-autoresearch CLI to run experiments', 'info');
      pi.sendUserMessage(
        `Autoresearch mode active: ${trimmedArgs}. Use pi-autoresearch activate, init, run, and log to run experiments.`
      );
    },
  });
}
