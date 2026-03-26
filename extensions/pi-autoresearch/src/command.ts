/**
 * /autoresearch command handler
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AutoresearchRuntime } from "./types/index.js";
import {
  resolveWorkDir,
  getDisplayWorktreePath,
  createAutoresearchWorktree,
  removeAutoresearchWorktree,
  detectAutoresearchWorktree,
} from "./git/index.js";
import {
  createExperimentState,
} from "./state/index.js";
import { BENCHMARK_GUARDRAIL } from "./constants.js";

/** Dependencies needed by command handler */
export interface CommandContext {
  pi: ExtensionAPI;
  getRuntime: (ctx: ExtensionContext) => AutoresearchRuntime;
  getSessionKey: (ctx: ExtensionContext) => string;
  updateWidget: (ctx: ExtensionContext) => void;
  reconstructState?: (ctx: ExtensionContext) => Promise<void>;
  startWatcher?: (ctx: ExtensionContext) => void;
}

/**
 * Create the /autoresearch command help text
 */
function createHelpText(): string {
  return [
    "Usage: /autoresearch [off|clear|<text>]",
    "",
    "<text> enters autoresearch mode and starts or resumes the loop.",
    "off leaves autoresearch mode.",
    "clear deletes autoresearch.jsonl and turns autoresearch mode off.",
    "",
    "Examples:",
    '  /autoresearch optimize unit test runtime, monitor correctness',
    '  /autoresearch model training, run 5 minutes of train.py and note the loss ratio as optimization target',
  ].join("\n");
}

/**
 * Create the /autoresearch command handler
 */
export function registerAutoresearchCommand(ctx: CommandContext): void {
  const { pi, getRuntime, getSessionKey, updateWidget } = ctx;

  pi.registerCommand("autoresearch", {
    description: "Start, stop, clear, or resume autoresearch mode",
    handler: async (args, extCtx) => {
      const runtime = getRuntime(extCtx);
      const trimmedArgs = (args ?? "").trim();
      const command = trimmedArgs.toLowerCase();

      if (!trimmedArgs) {
        extCtx.ui.notify(createHelpText(), "info");
        return;
      }

      if (command === "off") {
        // Stop file watcher
        if (runtime.jsonlWatcher) {
          runtime.jsonlWatcher.close();
          runtime.jsonlWatcher = null;
        }
        
        // Remove worktree if one exists
        if (runtime.worktreeDir) {
          await removeAutoresearchWorktree(pi, extCtx.cwd, runtime.worktreeDir);
          runtime.worktreeDir = null;
        }

        runtime.autoresearchMode = false;
        runtime.lastAutoResumeTime = 0;
        runtime.autoResumeTurns = 0;
        runtime.experimentsThisSession = 0;
        runtime.lastRunChecks = null;
        runtime.runningExperiment = null;
        extCtx.ui.notify("Autoresearch mode OFF — worktree removed", "info");
        return;
      }

      if (command === "clear") {
        // Stop file watcher
        if (runtime.jsonlWatcher) {
          runtime.jsonlWatcher.close();
          runtime.jsonlWatcher = null;
        }
        
        const workDir = resolveWorkDir(extCtx.cwd, runtime);
        const jsonlPath = path.join(workDir, "autoresearch.jsonl");

        // Remove worktree if one exists
        if (runtime.worktreeDir) {
          await removeAutoresearchWorktree(pi, extCtx.cwd, runtime.worktreeDir);
          runtime.worktreeDir = null;
        }

        runtime.autoresearchMode = false;
        runtime.dashboardExpanded = false;
        runtime.lastAutoResumeTime = 0;
        runtime.autoResumeTurns = 0;
        runtime.experimentsThisSession = 0;
        runtime.lastRunChecks = null;
        runtime.runningExperiment = null;
        runtime.state = createExperimentState();
        updateWidget(extCtx);

        if (fs.existsSync(jsonlPath)) {
          try {
            fs.unlinkSync(jsonlPath);
            extCtx.ui.notify("Deleted autoresearch.jsonl and turned autoresearch mode OFF", "info");
          } catch (error) {
            extCtx.ui.notify(
              `Failed to delete autoresearch.jsonl: ${error instanceof Error ? error.message : String(error)}`,
              "error"
            );
          }
        } else {
          extCtx.ui.notify("No autoresearch.jsonl found. Autoresearch mode OFF", "info");
        }
        return;
      }

      // Guard against duplicate activation
      if (runtime.autoresearchMode) {
        extCtx.ui.notify("Autoresearch already active — use '/autoresearch off' to stop first", "info");
        return;
      }

      runtime.autoresearchMode = true;
      runtime.autoResumeTurns = 0;

      // Try to detect existing worktree first
      if (!runtime.worktreeDir) {
        const detectedWorktree = detectAutoresearchWorktree(extCtx.cwd);
        if (detectedWorktree) {
          runtime.worktreeDir = detectedWorktree;
          const displayPath = getDisplayWorktreePath(extCtx.cwd, detectedWorktree);
          extCtx.ui.notify(`Found existing autoresearch worktree: ${displayPath}`, "info");

          // Reconstruct state from JSONL now that worktree is known
          if (ctx.reconstructState) {
            await ctx.reconstructState(extCtx);
          }
          if (ctx.startWatcher) {
            ctx.startWatcher(extCtx);
          }
        }
      }

      // Create worktree for isolation if not already exists
      if (!runtime.worktreeDir) {
        const worktreePath = await createAutoresearchWorktree(
          pi,
          extCtx.cwd,
          getSessionKey(extCtx)
        );
        if (worktreePath) {
          runtime.worktreeDir = worktreePath;
          const displayPath = getDisplayWorktreePath(extCtx.cwd, worktreePath);
          extCtx.ui.notify(`Created autoresearch worktree: ${displayPath}`, "info");

          // Reconstruct state from JSONL now that worktree is known
          if (ctx.reconstructState) {
            await ctx.reconstructState(extCtx);
          }
          if (ctx.startWatcher) {
            ctx.startWatcher(extCtx);
          }
        } else {
          extCtx.ui.notify(
            "Failed to create autoresearch worktree — isolation required",
            "error"
          );
          return;
        }
      }

      const workDir = resolveWorkDir(extCtx.cwd, runtime);
      const mdPath = path.join(workDir, "autoresearch.md");
      const hasRules = fs.existsSync(mdPath);

      if (hasRules) {
        extCtx.ui.notify("Autoresearch mode ON — rules loaded from autoresearch.md", "info");
        pi.sendUserMessage(
          `Autoresearch mode active. ${trimmedArgs} ${BENCHMARK_GUARDRAIL}`
        );
      } else {
        extCtx.ui.notify("Autoresearch mode ON — no autoresearch.md found, setting up", "info");
        pi.sendUserMessage(
          `Start autoresearch: ${trimmedArgs} ${BENCHMARK_GUARDRAIL}`
        );
      }
    },
  });
}
