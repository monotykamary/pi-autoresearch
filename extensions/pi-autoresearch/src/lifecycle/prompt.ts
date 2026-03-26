/**
 * System prompt injection for autoresearch mode
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AutoresearchRuntime } from "../types/index.js";
import { resolveWorkDir, getDisplayWorktreePath } from "../git/index.js";
import { BENCHMARK_GUARDRAIL, SCOPE_GUARDRAIL } from "../constants.js";

/** Dependencies needed by prompt functions */
export interface PromptContext {
  getRuntime: (ctx: ExtensionContext) => AutoresearchRuntime;
}

/**
 * Create system prompt extension for autoresearch mode
 */
export function createPromptExtender(ctx: PromptContext) {
  const { getRuntime } = ctx;

  return function extendSystemPrompt(
    event: { systemPrompt: string },
    extCtx: ExtensionContext
  ): { systemPrompt: string } | undefined {
    const runtime = getRuntime(extCtx);
    if (!runtime.autoresearchMode) return;

    const workDir = resolveWorkDir(extCtx.cwd, runtime);
    const mdPath = path.join(workDir, "autoresearch.md");
    const ideasPath = path.join(workDir, "autoresearch.ideas.md");
    const hasIdeas = fs.existsSync(ideasPath);

    const checksPath = path.join(workDir, "autoresearch.checks.sh");
    const hasChecks = fs.existsSync(checksPath);

    const worktreeDisplay = getDisplayWorktreePath(extCtx.cwd, runtime.worktreeDir);

    let extra =
      "\n\n## Autoresearch Mode (ACTIVE)" +
      "\nYou are in autoresearch mode for LONG-HORIZON OPTIMIZATION with verifiable metrics." +
      "\nPurpose: Optimize a primary metric through an autonomous experiment loop. " +
      "Use init_experiment, run_experiment, and log_experiment tools. NEVER STOP until interrupted." +
      `\nExperiment rules: ${mdPath} — read this file at the start of every session and after compaction.`;

    if (runtime.worktreeDir) {
      extra += `\n📁 Isolated worktree: ${worktreeDisplay} — all experiments AND file operations (read, edit, write) run here. Your main working directory stays clean.`;
    }

    extra +=
      "\nWrite promising but deferred optimizations as bullet points to autoresearch.ideas.md — don't let good ideas get lost." +
      `\n${SCOPE_GUARDRAIL}` +
      `\n${BENCHMARK_GUARDRAIL}` +
      "\nIf the user sends a follow-on message while an experiment is running, finish the current run_experiment + log_experiment cycle first, then address their message in the next iteration.";

    if (hasChecks) {
      extra +=
        "\n\n## Backpressure Checks (ACTIVE)" +
        `\n${checksPath} exists and runs automatically after every passing benchmark in run_experiment.` +
        "\nIf the benchmark passes but checks fail, run_experiment will report it clearly." +
        "\nUse status 'checks_failed' in log_experiment when this happens — it behaves like a crash (no commit, changes auto-reverted)." +
        "\nYou cannot use status 'keep' when checks have failed." +
        "\nThe checks execution time does NOT affect the primary metric.";
    }

    if (hasIdeas) {
      extra += `\n\n💡 Ideas backlog exists at ${ideasPath} — check it for promising experiment paths. Prune stale entries.`;
    }

    return {
      systemPrompt: event.systemPrompt + extra,
    };
  };
}
