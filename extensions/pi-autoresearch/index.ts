/**
 * autoresearch — Pi Extension
 *
 * Generic autonomous experiment loop infrastructure.
 * Domain-specific behavior comes from skills (what command to run, what to optimize).
 *
 * Provides:
 * - `run_experiment` tool — runs any command, times it, captures output, detects pass/fail
 * - `log_experiment` tool — records results with session-persisted state
 * - `init_experiment` tool — initializes session with name, metric, direction
 * - Status widget showing experiment count + best metric
 * - Ctrl+X toggle to expand/collapse full dashboard inline above the editor
 * - Adds autoresearch guidance to the system prompt and points the agent at autoresearch.md
 * - Injects autoresearch.md into context on every turn via before_agent_start
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AutoresearchRuntime } from "./src/types/index.js";
import { createRuntimeStore } from "./src/state/index.js";
import {
  registerInitExperiment,
  registerRunExperiment,
  registerLogExperiment,
  registerRedirectedFileTools,
} from "./src/tools/index.js";
import {
  createWidgetUpdater,
  clearSessionUi,
  createFullscreenHandler,
  createFullscreenState,
  clearFullscreen,
  type FullscreenState,
} from "./src/ui/index.js";
import {
  registerLifecycleHandlers,
  createPromptExtender,
} from "./src/lifecycle/index.js";
import { registerAutoresearchCommand } from "./src/command.js";

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function autoresearchExtension(pi: ExtensionAPI) {
  // Session management
  const runtimeStore = createRuntimeStore();
  const getSessionKey = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const getRuntime = (ctx: ExtensionContext): AutoresearchRuntime =>
    runtimeStore.ensure(getSessionKey(ctx));

  // UI state
  const uiState: FullscreenState = createFullscreenState();
  const clearOverlay = () => clearFullscreen(uiState);

  // Create widget updater
  const updateWidget = createWidgetUpdater({ getRuntime });

  // Register lifecycle handlers (session events, agent start/end)
  const { reconstructState, startWatcher } = registerLifecycleHandlers({
    pi,
    getRuntime,
    getSessionKey,
    runtimeStore,
    updateWidget,
    clearSessionUi: (ctx) => clearSessionUi(ctx, clearOverlay),
    clearOverlay,
  });

  // Register system prompt extension for autoresearch mode
  const extendPrompt = createPromptExtender({ getRuntime });
  pi.on("before_agent_start", async (event, ctx) => extendPrompt(event, ctx));

  // Register tools
  registerRedirectedFileTools(pi, getRuntime);
  registerInitExperiment(pi, { pi, getRuntime, getSessionKey, startWatcher });
  registerRunExperiment(pi, {
    pi,
    getRuntime,
    updateWidget,
    overlayTui: uiState.overlayTui,
  });
  registerLogExperiment(pi, { pi, getRuntime });

  // Register keyboard shortcuts
  pi.registerShortcut("ctrl+x", {
    description: "Toggle autoresearch dashboard",
    handler: async (ctx) => {
      const runtime = getRuntime(ctx);
      const state = runtime.state;

      if (state.results.length === 0) {
        if (!runtime.autoresearchMode) {
          // Check if autoresearch.md exists to give better message
          const { resolveWorkDir } = await import("./src/git/index.js");
          const workDir = resolveWorkDir(ctx.cwd, runtime);
          const fs = await import("node:fs");
          const path = await import("node:path");
          const hasRules = fs.existsSync(path.join(workDir, "autoresearch.md"));
          ctx.ui.notify(
            hasRules ? "No experiments yet" : "No experiments yet — run /autoresearch to get started",
            "info"
          );
        } else {
          ctx.ui.notify("No experiments yet", "info");
        }
        return;
      }

      runtime.dashboardExpanded = !runtime.dashboardExpanded;
      updateWidget(ctx);
    },
  });

  const showFullscreen = createFullscreenHandler(uiState, { getRuntime });
  pi.registerShortcut("ctrl+shift+x", {
    description: "Fullscreen autoresearch dashboard",
    handler: showFullscreen,
  });

  // Register /autoresearch command
  registerAutoresearchCommand({
    pi,
    getRuntime,
    getSessionKey,
    updateWidget,
    reconstructState,
    startWatcher,
  });
}
