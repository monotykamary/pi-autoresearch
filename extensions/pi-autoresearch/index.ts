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

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth, matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderDashboardLines } from "./src/dashboard/index.js";
import {
  createRuntimeStore,
  createExperimentState,
  resetSessionCounters,
  cloneExperimentState,
} from "./src/state/index.js";
import {
  resolveWorkDir,
  getDisplayWorktreePath,
  createAutoresearchWorktree,
  removeAutoresearchWorktree,
} from "./src/git/index.js";
import {
  currentResults,
  findBaselineMetric,
  findBaselineSecondary,
  isBetter,
  computeConfidence,
  formatNum,
  formatElapsed,
} from "./src/utils/index.js";
import {
  registerInitExperiment,
  registerRunExperiment,
  registerLogExperiment,
  registerRedirectedFileTools,
} from "./src/tools/index.js";
import {
  BENCHMARK_GUARDRAIL,
  SCOPE_GUARDRAIL,
  MAX_AUTORESUME_TURNS,
} from "./src/constants.js";
import type { AutoresearchRuntime, ExperimentResult, LogDetails } from "./src/types/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTORESEARCH_OVERLAY_MAX_HEIGHT_RATIO = 0.9;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function autoresearchExtension(pi: ExtensionAPI) {
  const runtimeStore = createRuntimeStore();
  const getSessionKey = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const getRuntime = (ctx: ExtensionContext): AutoresearchRuntime =>
    runtimeStore.ensure(getSessionKey(ctx));

  // UI state
  let overlayTui: { requestRender: () => void } | null = null;
  let spinnerInterval: ReturnType<typeof setInterval> | null = null;
  let spinnerFrame = 0;

  const clearOverlay = () => {
    overlayTui = null;
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = null;
    }
  };

  const clearSessionUi = (ctx: ExtensionContext) => {
    clearOverlay();
    if (ctx.hasUI) {
      ctx.ui.setWidget("autoresearch", undefined);
    }
  };

  // -----------------------------------------------------------------------
  // Dashboard Widget
  // -----------------------------------------------------------------------

  const updateWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    const runtime = getRuntime(ctx);
    const state = runtime.state;
    const width = process.stdout.columns || 120;

    // Once we have results, NEVER show transient states (running/done/failed/ready).
    // The dashboard (compact or expanded) is the only state after first log.
    if (state.results.length > 0) {
      if (runtime.dashboardExpanded) {
        // Expanded: full dashboard table rendered as widget
        ctx.ui.setWidget("autoresearch", (_tui, theme) => {
          const lines: string[] = [];

          const hintText = " ctrl+x collapse • ctrl+shift+x fullscreen ";
          const labelPrefix = "🔬 autoresearch";
          let nameStr = state.name ? `: ${state.name}` : "";
          const maxLabelLen = width - 3 - 2 - hintText.length - 1;
          let label = labelPrefix + nameStr;
          if (label.length > maxLabelLen) {
            label = label.slice(0, maxLabelLen - 1) + "…";
          }
          const fillLen = Math.max(0, width - 3 - 1 - label.length - 1 - hintText.length);
          const leftBorder = "───";
          const rightBorder = "─".repeat(fillLen);
          lines.push(
            truncateToWidth(
              theme.fg("borderMuted", leftBorder) +
                theme.fg("accent", " " + label + " ") +
                theme.fg("borderMuted", rightBorder) +
                theme.fg("dim", hintText),
              width
            )
          );

          const worktreeDisplay = runtime.worktreeDir
            ? getDisplayWorktreePath(ctx.cwd, runtime.worktreeDir)
            : null;
          lines.push(...renderDashboardLines(state, width, theme, 6, worktreeDisplay));

          return new Text(lines.join("\n"), 0, 0);
        });
      } else {
        // Collapsed: compact one-liner
        ctx.ui.setWidget("autoresearch", (_tui, theme) => {
          const cur = currentResults(state.results, state.currentSegment);
          const kept = cur.filter((r) => r.status === "keep").length;
          const crashed = cur.filter((r) => r.status === "crash").length;
          const checksFailed = cur.filter((r) => r.status === "checks_failed").length;
          const baseline = state.bestMetric;
          const baselineSec = findBaselineSecondary(
            state.results,
            state.currentSegment,
            state.secondaryMetrics
          );

          // Find best kept primary metric, its secondary values, and run number
          let bestPrimary: number | null = null;
          let bestSec: Record<string, number> = {};
          let bestRunNum = 0;
          for (let i = state.results.length - 1; i >= 0; i--) {
            const r = state.results[i];
            if (r.segment !== state.currentSegment) continue;
            if (r.status === "keep" && r.metric > 0) {
              if (
                bestPrimary === null ||
                isBetter(r.metric, bestPrimary, state.bestDirection)
              ) {
                bestPrimary = r.metric;
                bestSec = r.metrics ?? {};
                bestRunNum = i + 1;
              }
            }
          }

          const displayVal = bestPrimary ?? baseline;
          const parts = [
            theme.fg("accent", "🔬"),
            theme.fg("muted", ` ${state.results.length} runs`),
            theme.fg("success", ` ${kept} kept`),
            crashed > 0 ? theme.fg("error", ` ${crashed}💥`) : "",
            checksFailed > 0 ? theme.fg("error", ` ${checksFailed}⚠`) : "",
            theme.fg("dim", " │ "),
            theme.fg(
              "warning",
              theme.bold(`★ ${state.metricName}: ${formatNum(displayVal, state.metricUnit)}`)
            ),
            bestRunNum > 0 ? theme.fg("dim", ` #${bestRunNum}`) : "",
          ];

          // Show delta % vs baseline for primary
          if (baseline !== null && bestPrimary !== null && baseline !== 0 && bestPrimary !== baseline) {
            const pct = ((bestPrimary - baseline) / baseline) * 100;
            const sign = pct > 0 ? "+" : "";
            const deltaColor = isBetter(bestPrimary, baseline, state.bestDirection)
              ? "success"
              : "error";
            parts.push(theme.fg(deltaColor, ` (${sign}${pct.toFixed(1)}%)`));
          }

          // Show confidence score
          if (state.confidence !== null) {
            const confStr = state.confidence.toFixed(1);
            const confColor: Parameters<typeof theme.fg>[0] =
              state.confidence >= 2.0
                ? "success"
                : state.confidence >= 1.0
                  ? "warning"
                  : "error";
            parts.push(theme.fg("dim", " │ "));
            parts.push(theme.fg(confColor, `conf: ${confStr}×`));
          }

          // Show target value progress
          if (state.targetValue !== null && displayVal !== null) {
            const reached = state.bestDirection === "lower"
              ? displayVal <= state.targetValue
              : displayVal >= state.targetValue;
            parts.push(theme.fg("dim", " │ "));
            if (reached) {
              parts.push(theme.fg("success", `🎯 ${formatNum(state.targetValue, state.metricUnit)} ✓`));
            } else {
              parts.push(theme.fg("muted", `→ ${formatNum(state.targetValue, state.metricUnit)}`));
            }
          }

          // Show secondary metrics with delta %
          if (state.secondaryMetrics.length > 0) {
            for (const sm of state.secondaryMetrics) {
              const val = bestSec[sm.name];
              const bv = baselineSec[sm.name];
              if (val !== undefined) {
                parts.push(theme.fg("dim", "  "));
                parts.push(theme.fg("muted", `${sm.name}: ${formatNum(val, sm.unit)}`));
                if (bv !== undefined && bv !== 0 && val !== bv) {
                  const p = ((val - bv) / bv) * 100;
                  const s = p > 0 ? "+" : "";
                  const c = val <= bv ? "success" : "error";
                  parts.push(theme.fg(c, ` ${s}${p.toFixed(1)}%`));
                }
              }
            }
          }

          if (state.name) {
            parts.push(theme.fg("dim", ` │ ${state.name}`));
          }

          parts.push(theme.fg("dim", "  (ctrl+x expand • ctrl+shift+x fullscreen)"));

          return new Text(truncateToWidth(parts.join(""), width), 0, 0);
        });
      }
      return;
    }

    // === TRANSIENT STATES (only before first result) ===

    // State 1: During run_experiment — actively running
    if (runtime.runningExperiment) {
      ctx.ui.setWidget("autoresearch", (_tui, theme) => {
        const parts = [
          theme.fg("accent", "🔬"),
          theme.fg("warning", " running…"),
        ];

        if (state.name) {
          parts.push(theme.fg("dim", ` │ ${state.name}`));
        }

        return new Text(truncateToWidth(parts.join(""), width), 0, 0);
      });
      return;
    }

    // State 2: After run_experiment, before log_experiment — finished, needs logging
    if (runtime.experimentCompletedWaitingForLog) {
      const succeeded = runtime.lastRunSucceeded;
      ctx.ui.setWidget("autoresearch", (_tui, theme) => {
        const parts = [
          theme.fg("accent", "🔬"),
          succeeded 
            ? theme.fg("text", " done") 
            : theme.fg("error", " failed"),
          theme.fg("dim", succeeded ? " — call log_experiment" : " — rerunning experiment"),
        ];

        if (state.name) {
          parts.push(theme.fg("dim", ` │ ${state.name}`));
        }

        return new Text(truncateToWidth(parts.join(""), width), 0, 0);
      });
      return;
    }

    // State 3: After init_experiment, before any run_experiment — session ready
    if (state.name) {
      ctx.ui.setWidget("autoresearch", (_tui, theme) => {
        const parts = [
          theme.fg("accent", "🔬"),
          theme.fg("text", ` ${state.name}`),
          theme.fg("dim", " — ready"),
        ];

        return new Text(truncateToWidth(parts.join(""), width), 0, 0);
      });
      return;
    }

    // Hide widget if no session initialized and no activity
    ctx.ui.setWidget("autoresearch", undefined);
  };
        const maxLabelLen = width - 3 - 2 - hintText.length - 1;
        let label = labelPrefix + nameStr;
        if (label.length > maxLabelLen) {
          label = label.slice(0, maxLabelLen - 1) + "…";
        }
        const fillLen = Math.max(0, width - 3 - 1 - label.length - 1 - hintText.length);
        const leftBorder = "───";
        const rightBorder = "─".repeat(fillLen);
        lines.push(
          truncateToWidth(
            theme.fg("borderMuted", leftBorder) +
              theme.fg("accent", " " + label + " ") +
              theme.fg("borderMuted", rightBorder) +
              theme.fg("dim", hintText),
            width
          )
        );

        const worktreeDisplay = runtime.worktreeDir
          ? getDisplayWorktreePath(ctx.cwd, runtime.worktreeDir)
          : null;
        lines.push(...renderDashboardLines(state, width, theme, 6, worktreeDisplay));

        return new Text(lines.join("\n"), 0, 0);
      });
    } else {
      // Collapsed: compact one-liner
      ctx.ui.setWidget("autoresearch", (_tui, theme) => {
        const cur = currentResults(state.results, state.currentSegment);
        const kept = cur.filter((r) => r.status === "keep").length;
        const crashed = cur.filter((r) => r.status === "crash").length;
        const checksFailed = cur.filter((r) => r.status === "checks_failed").length;
        const baseline = state.bestMetric;
        const baselineSec = findBaselineSecondary(
          state.results,
          state.currentSegment,
          state.secondaryMetrics
        );

        // Find best kept primary metric, its secondary values, and run number
        let bestPrimary: number | null = null;
        let bestSec: Record<string, number> = {};
        let bestRunNum = 0;
        for (let i = state.results.length - 1; i >= 0; i--) {
          const r = state.results[i];
          if (r.segment !== state.currentSegment) continue;
          if (r.status === "keep" && r.metric > 0) {
            if (
              bestPrimary === null ||
              isBetter(r.metric, bestPrimary, state.bestDirection)
            ) {
              bestPrimary = r.metric;
              bestSec = r.metrics ?? {};
              bestRunNum = i + 1;
            }
          }
        }

        const displayVal = bestPrimary ?? baseline;
        const parts = [
          theme.fg("accent", "🔬"),
          theme.fg("muted", ` ${state.results.length} runs`),
          theme.fg("success", ` ${kept} kept`),
          crashed > 0 ? theme.fg("error", ` ${crashed}💥`) : "",
          checksFailed > 0 ? theme.fg("error", ` ${checksFailed}⚠`) : "",
          theme.fg("dim", " │ "),
          theme.fg(
            "warning",
            theme.bold(`★ ${state.metricName}: ${formatNum(displayVal, state.metricUnit)}`)
          ),
          bestRunNum > 0 ? theme.fg("dim", ` #${bestRunNum}`) : "",
        ];

        // Show delta % vs baseline for primary
        if (baseline !== null && bestPrimary !== null && baseline !== 0 && bestPrimary !== baseline) {
          const pct = ((bestPrimary - baseline) / baseline) * 100;
          const sign = pct > 0 ? "+" : "";
          const deltaColor = isBetter(bestPrimary, baseline, state.bestDirection)
            ? "success"
            : "error";
          parts.push(theme.fg(deltaColor, ` (${sign}${pct.toFixed(1)}%)`));
        }

        // Show confidence score
        if (state.confidence !== null) {
          const confStr = state.confidence.toFixed(1);
          const confColor: Parameters<typeof theme.fg>[0] =
            state.confidence >= 2.0
              ? "success"
              : state.confidence >= 1.0
                ? "warning"
                : "error";
          parts.push(theme.fg("dim", " │ "));
          parts.push(theme.fg(confColor, `conf: ${confStr}×`));
        }

        // Show target value progress
        if (state.targetValue !== null && displayVal !== null) {
          const reached = state.bestDirection === "lower"
            ? displayVal <= state.targetValue
            : displayVal >= state.targetValue;
          parts.push(theme.fg("dim", " │ "));
          if (reached) {
            parts.push(theme.fg("success", `🎯 ${formatNum(state.targetValue, state.metricUnit)} ✓`));
          } else {
            parts.push(theme.fg("muted", `→ ${formatNum(state.targetValue, state.metricUnit)}`));
          }
        }

        // Show secondary metrics with delta %
        if (state.secondaryMetrics.length > 0) {
          for (const sm of state.secondaryMetrics) {
            const val = bestSec[sm.name];
            const bv = baselineSec[sm.name];
            if (val !== undefined) {
              parts.push(theme.fg("dim", "  "));
              parts.push(theme.fg("muted", `${sm.name}: ${formatNum(val, sm.unit)}`));
              if (bv !== undefined && bv !== 0 && val !== bv) {
                const p = ((val - bv) / bv) * 100;
                const s = p > 0 ? "+" : "";
                const c = val <= bv ? "success" : "error";
                parts.push(theme.fg(c, ` ${s}${p.toFixed(1)}%`));
              }
            }
          }
        }

        if (state.name) {
          parts.push(theme.fg("dim", ` │ ${state.name}`));
        }

        parts.push(theme.fg("dim", "  (ctrl+x expand • ctrl+shift+x fullscreen)"));

        return new Text(parts.join(""), 0, 0);
      });
    }
  };

  // -----------------------------------------------------------------------
  // State reconstruction
  // -----------------------------------------------------------------------

  const reconstructState = (ctx: ExtensionContext) => {
    const runtime = getRuntime(ctx);
    
    // Preserve worktreeDir - it may have been set by /autoresearch command
    // and we don't want to lose it before init_experiment runs
    const preservedWorktreeDir = runtime.worktreeDir;
    
    runtime.lastRunChecks = null;
    runtime.lastRunDuration = null;
    runtime.runningExperiment = null;
    runtime.experimentCompletedWaitingForLog = false;
    runtime.lastRunSucceeded = null;
    runtime.lastAutoResumeTime = 0;
    runtime.experimentsThisSession = 0;
    runtime.autoResumeTurns = 0;
    runtime.state = createExperimentState();

    let state = runtime.state;

    const workDir = resolveWorkDir(ctx.cwd, runtime);

    // Find autoresearch.jsonl: since we use isolated worktrees exclusively,
    // scan for worktree subdirectories first, then fall back to main workDir
    let jsonlPath: string | null = null;
    let loadedFromJsonl = false;

    // Primary: scan for worktree subdirectories (exclusive worktree mode)
    const autoresearchDir = path.join(ctx.cwd, "autoresearch");
    if (fs.existsSync(autoresearchDir)) {
      const entries = fs.readdirSync(autoresearchDir, { withFileTypes: true });
      const candidates = entries
        .filter((e) => e.isDirectory())
        .map((e) => path.join(autoresearchDir, e.name, "autoresearch.jsonl"))
        .filter((p) => fs.existsSync(p));
      
      if (candidates.length > 0) {
        // Use most recently modified
        candidates.sort((a, b) => {
          const statA = fs.statSync(a);
          const statB = fs.statSync(b);
          return statB.mtimeMs - statA.mtimeMs;
        });
        jsonlPath = candidates[0];
      }
    }

    // Fallback: legacy location (main workDir, for backwards compatibility)
    if (!jsonlPath) {
      const legacyPath = path.join(workDir, "autoresearch.jsonl");
      if (fs.existsSync(legacyPath)) {
        jsonlPath = legacyPath;
      }
    }

    try {
      if (jsonlPath && fs.existsSync(jsonlPath)) {
        let segment = 0;
        const lines = fs
          .readFileSync(jsonlPath, "utf-8")
          .trim()
          .split("\n")
          .filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);

            // Config header line
            if (entry.type === "config") {
              if (entry.name) state.name = entry.name;
              if (entry.metricName) state.metricName = entry.metricName;
              if (entry.metricUnit !== undefined) state.metricUnit = entry.metricUnit;
              if (entry.bestDirection) state.bestDirection = entry.bestDirection;
              if (entry.targetValue !== undefined) state.targetValue = entry.targetValue ?? null;
              if (state.results.length > 0) {
                segment++;
                state.secondaryMetrics = [];
              }
              state.currentSegment = segment;
              continue;
            }

            // Experiment result line
            const experiment: ExperimentResult = {
              commit: entry.commit ?? "",
              metric: entry.metric ?? 0,
              metrics: entry.metrics ?? {},
              status: entry.status ?? "keep",
              description: entry.description ?? "",
              timestamp: entry.timestamp ?? 0,
              segment,
              confidence: entry.confidence ?? null,
              asi: entry.asi ?? undefined,
            };
            state.results.push(experiment);

            // Register secondary metrics
            for (const name of Object.keys(entry.metrics ?? {})) {
              if (!state.secondaryMetrics.find((m) => m.name === name)) {
                let unit = "";
                if (name.endsWith("µs")) unit = "µs";
                else if (name.endsWith("_ms")) unit = "ms";
                else if (name.endsWith("_s") || name.endsWith("_sec")) unit = "s";
                else if (name.endsWith("_kb")) unit = "kb";
                else if (name.endsWith("_mb")) unit = "mb";
                state.secondaryMetrics.push({ name, unit });
              }
            }
          } catch {
            // Skip malformed lines
          }
        }
        if (state.results.length > 0) {
          loadedFromJsonl = true;
          state.bestMetric = findBaselineMetric(state.results, state.currentSegment);
          state.confidence = computeConfidence(
            state.results,
            state.currentSegment,
            state.bestDirection
          );
        }
      }
    } catch {
      // Fall through to session history
    }

    // Restore worktreeDir: prioritize the preserved one (from /autoresearch command)
    // over the one detected from JSONL (which might be stale from a previous session)
    if (preservedWorktreeDir && fs.existsSync(preservedWorktreeDir)) {
      // Use the preserved worktree (newly created by /autoresearch command)
      runtime.worktreeDir = preservedWorktreeDir;
    } else if (loadedFromJsonl && jsonlPath.includes("/autoresearch/")) {
      // Fallback: detect worktree from JSONL path (for session restore)
      const detectedWorktreeDir = path.dirname(jsonlPath);
      if (fs.existsSync(detectedWorktreeDir)) {
        runtime.worktreeDir = detectedWorktreeDir;
      }
    }

    // Fallback: reconstruct from session history
    if (!loadedFromJsonl) {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (msg.role !== "toolResult" || msg.toolName !== "log_experiment")
          continue;
        const details = msg.details as LogDetails | undefined;
        if (details?.state) {
          runtime.state = cloneExperimentState(details.state);
          state = runtime.state;
          if (!state.secondaryMetrics) state.secondaryMetrics = [];
          if (state.metricUnit === "s" && state.metricName === "metric") {
            state.metricUnit = "";
          }
          for (const r of state.results) {
            if (!r.metrics) r.metrics = {};
            if (r.confidence === undefined) r.confidence = null;
          }
          if (state.confidence === undefined) {
            state.confidence = computeConfidence(
              state.results,
              state.currentSegment,
              state.bestDirection
            );
          }
        }
      }
    }

    // Auto-enter autoresearch mode only when a persisted experiment log exists
    runtime.autoresearchMode = fs.existsSync(path.join(workDir, "autoresearch.jsonl"));

    updateWidget(ctx);
  };

  // -----------------------------------------------------------------------
  // Event handlers
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_switch", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_fork", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_before_switch", async () => {
    clearOverlay();
  });
  pi.on("session_shutdown", async (_e, ctx) => {
    clearSessionUi(ctx);
    runtimeStore.clear(getSessionKey(ctx));
  });

  // Reset per-session experiment counter when agent starts
  pi.on("agent_start", async (_event, ctx) => {
    resetSessionCounters(getRuntime(ctx));
  });

  // Clear running experiment state when agent stops; check ideas file for continuation
  pi.on("agent_end", async (_event, ctx) => {
    const runtime = getRuntime(ctx);
    runtime.runningExperiment = null;
    runtime.experimentCompletedWaitingForLog = false;
    runtime.lastRunSucceeded = null;
    if (overlayTui) overlayTui.requestRender();

    if (!runtime.autoresearchMode) return;

    // Don't auto-resume if no experiments ran this session
    if (runtime.experimentsThisSession === 0) return;

    // Rate-limit auto-resume to once every 5 minutes
    const now = Date.now();
    if (now - runtime.lastAutoResumeTime < 5 * 60 * 1000) return;
    runtime.lastAutoResumeTime = now;

    if (runtime.autoResumeTurns >= MAX_AUTORESUME_TURNS) {
      ctx.ui.notify(
        `Autoresearch auto-resume limit reached (${MAX_AUTORESUME_TURNS} turns)`,
        "info"
      );
      return;
    }

    const workDir = resolveWorkDir(ctx.cwd, runtime);
    const ideasPath = path.join(workDir, "autoresearch.ideas.md");
    const hasIdeas = fs.existsSync(ideasPath);

    let resumeMsg =
      "Autoresearch loop ended (likely context limit). Resume the experiment loop — read autoresearch.md and git log for context.";
    if (hasIdeas) {
      resumeMsg +=
        " Check autoresearch.ideas.md for promising paths to explore. Prune stale/tried ideas.";
    }
    resumeMsg += ` ${BENCHMARK_GUARDRAIL}`;

    runtime.autoResumeTurns++;
    pi.sendUserMessage(resumeMsg);
  });

  // Add autoresearch guidance to system prompt when in autoresearch mode
  pi.on("before_agent_start", async (event, ctx) => {
    const runtime = getRuntime(ctx);
    if (!runtime.autoresearchMode) return;

    const workDir = resolveWorkDir(ctx.cwd, runtime);
    const mdPath = path.join(workDir, "autoresearch.md");
    const ideasPath = path.join(workDir, "autoresearch.ideas.md");
    const hasIdeas = fs.existsSync(ideasPath);

    const checksPath = path.join(workDir, "autoresearch.checks.sh");
    const hasChecks = fs.existsSync(checksPath);

    const worktreeDisplay = getDisplayWorktreePath(ctx.cwd, runtime.worktreeDir);

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
  });

  // -----------------------------------------------------------------------
  // Register tools
  // -----------------------------------------------------------------------

  registerRedirectedFileTools(pi, getRuntime);
  registerInitExperiment(pi, { pi, getRuntime, updateWidget, getSessionKey });
  registerRunExperiment(pi, { pi, getRuntime, updateWidget, overlayTui });
  registerLogExperiment(pi, { pi, getRuntime, updateWidget, overlayTui });

  // -----------------------------------------------------------------------
  // Keyboard shortcuts
  // -----------------------------------------------------------------------

  pi.registerShortcut("ctrl+x", {
    description: "Toggle autoresearch dashboard",
    handler: async (ctx) => {
      const runtime = getRuntime(ctx);
      const state = runtime.state;
      if (state.results.length === 0) {
        if (
          !runtime.autoresearchMode &&
          !fs.existsSync(path.join(resolveWorkDir(ctx.cwd, runtime), "autoresearch.md"))
        ) {
          ctx.ui.notify("No experiments yet — run /autoresearch to get started", "info");
        } else {
          ctx.ui.notify("No experiments yet", "info");
        }
        return;
      }
      runtime.dashboardExpanded = !runtime.dashboardExpanded;
      updateWidget(ctx);
    },
  });

  pi.registerShortcut("ctrl+shift+x", {
    description: "Fullscreen autoresearch dashboard",
    handler: async (ctx) => {
      const runtime = getRuntime(ctx);
      const state = runtime.state;
      if (state.results.length === 0) {
        ctx.ui.notify("No experiments yet", "info");
        return;
      }

      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          let scrollOffset = 0;
          overlayTui = tui;

          // Start spinner interval for elapsed time animation
          spinnerInterval = setInterval(() => {
            spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
            if (runtime.runningExperiment) tui.requestRender();
          }, 80);

          let lastSectionWidth = Math.max(10, (process.stdout.columns || 100) - 4);

          return {
            render(width: number): string[] {
              const termRows = process.stdout.rows || 40;
              const overlayRows = Math.max(
                10,
                Math.floor(termRows * AUTORESEARCH_OVERLAY_MAX_HEIGHT_RATIO)
              );
              const innerW = width - 2;
              const sectionW = innerW - 2;
              lastSectionWidth = sectionW;

              const border = (s: string) => theme.fg("dim", s);
              const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
              const row = (content: string) => {
                const safe = truncateToWidth(content, sectionW);
                return border("│") + pad(" " + safe, innerW) + border("│");
              };
              const emptyRow = () => border("│") + " ".repeat(innerW) + border("│");

              const worktreeDisplay = runtime.worktreeDir
                ? getDisplayWorktreePath(ctx.cwd, runtime.worktreeDir)
                : null;
              const content = renderDashboardLines(state, sectionW, theme, 0, worktreeDisplay);

              // Add running experiment as next row in the list
              if (runtime.runningExperiment) {
                const elapsed = formatElapsed(
                  Date.now() - runtime.runningExperiment.startedAt
                );
                const frame = SPINNER[spinnerFrame % SPINNER.length];
                const nextIdx = state.results.length + 1;
                content.push(
                  `  ${theme.fg("dim", String(nextIdx).padEnd(3))}` +
                    theme.fg("warning", `${frame} running… ${elapsed}`)
                );
              }

              const totalRows = content.length;
              const chromeRows = 5;
              const viewportRows = Math.max(4, overlayRows - chromeRows);

              const maxScroll = Math.max(0, totalRows - viewportRows);
              if (scrollOffset > maxScroll) scrollOffset = maxScroll;
              if (scrollOffset < 0) scrollOffset = 0;

              const out: string[] = [];

              // Title bar with border
              const titlePrefix = "🔬 autoresearch";
              const nameStr = state.name ? `: ${state.name}` : "";
              const titleContent = titlePrefix + nameStr;
              const titleText = ` ${titleContent} `;
              const titleLen = visibleWidth(titleContent) + 2;
              const borderLen = Math.max(0, innerW - titleLen);
              const leftBorder = Math.floor(borderLen / 2);
              const rightBorder = borderLen - leftBorder;

              out.push(
                border("╭" + "─".repeat(leftBorder)) +
                  theme.fg("accent", titleText) +
                  border("─".repeat(rightBorder) + "╮")
              );

              out.push(emptyRow());

              // Content rows with side borders
              const visible = content.slice(scrollOffset, scrollOffset + viewportRows);
              for (const line of visible) {
                out.push(row(line));
              }
              for (let i = visible.length; i < viewportRows; i++) {
                out.push(emptyRow());
              }

              // Footer row with scroll info and help
              const visibleStart = totalRows === 0 ? 0 : scrollOffset + 1;
              const visibleEnd = Math.min(scrollOffset + viewportRows, totalRows);
              const scrollState =
                totalRows <= viewportRows
                  ? "all"
                  : scrollOffset === 0
                    ? "top"
                    : visibleEnd >= totalRows
                      ? "bottom"
                      : `${Math.round((visibleEnd / totalRows) * 100)}%`;
              const scrollInfo = ` ${visibleStart}-${visibleEnd}/${totalRows} • ${scrollState}`;
              const helpText = `↑↓/j/k scroll • u/d page • g/G top/bottom • esc close${scrollInfo}`;
              out.push(border("├" + "─".repeat(innerW) + "┤"));
              out.push(row(theme.fg("dim", " " + helpText)));
              out.push(border("╰" + "─".repeat(innerW) + "╯"));

              return out;
            },

            handleInput(data: string): void {
              const termRows = process.stdout.rows || 40;
              const overlayRows = Math.max(
                10,
                Math.floor(termRows * AUTORESEARCH_OVERLAY_MAX_HEIGHT_RATIO)
              );
              const chromeRows = 5;
              const viewportRows = Math.max(4, overlayRows - chromeRows);
              const worktreeDisplayRows = runtime.worktreeDir
                ? getDisplayWorktreePath(ctx.cwd, runtime.worktreeDir)
                : null;
              const totalRows = renderDashboardLines(state, lastSectionWidth, theme, 0, worktreeDisplayRows).length + (runtime.runningExperiment ? 1 : 0);
              const maxScroll = Math.max(0, totalRows - viewportRows);

              if (matchesKey(data, "tui.escape") || data === "q") {
                done(undefined);
                return;
              }
              if (matchesKey(data, "tui.up") || data === "k") {
                scrollOffset = Math.max(0, scrollOffset - 1);
              } else if (matchesKey(data, "tui.down") || data === "j") {
                scrollOffset = Math.min(maxScroll, scrollOffset + 1);
              } else if (matchesKey(data, "tui.pageUp") || data === "u") {
                scrollOffset = Math.max(0, scrollOffset - viewportRows);
              } else if (matchesKey(data, "tui.pageDown") || data === "d") {
                scrollOffset = Math.min(maxScroll, scrollOffset + viewportRows);
              } else if (data === "g") {
                scrollOffset = 0;
              } else if (data === "G") {
                scrollOffset = maxScroll;
              }
              tui.requestRender();
            },

            invalidate(): void {},

            dispose(): void {
              clearOverlay();
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            width: "95%",
            maxHeight: "90%",
            anchor: "center" as const,
          },
        }
      );
    },
  });

  // -----------------------------------------------------------------------
  // /autoresearch command
  // -----------------------------------------------------------------------

  const autoresearchHelp = () =>
    [
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

  pi.registerCommand("autoresearch", {
    description: "Start, stop, clear, or resume autoresearch mode",
    handler: async (args, ctx) => {
      const runtime = getRuntime(ctx);
      const trimmedArgs = (args ?? "").trim();
      const command = trimmedArgs.toLowerCase();

      if (!trimmedArgs) {
        ctx.ui.notify(autoresearchHelp(), "info");
        return;
      }

      if (command === "off") {
        // Remove worktree if one exists
        if (runtime.worktreeDir) {
          await removeAutoresearchWorktree(pi, ctx.cwd, runtime.worktreeDir);
          runtime.worktreeDir = null;
        }

        runtime.autoresearchMode = false;
        runtime.lastAutoResumeTime = 0;
        runtime.autoResumeTurns = 0;
        runtime.experimentsThisSession = 0;
        runtime.lastRunChecks = null;
        runtime.runningExperiment = null;
        ctx.ui.notify("Autoresearch mode OFF — worktree removed", "info");
        return;
      }

      if (command === "clear") {
        const workDir = resolveWorkDir(ctx.cwd, runtime);
        const jsonlPath = path.join(workDir, "autoresearch.jsonl");

        // Remove worktree if one exists
        if (runtime.worktreeDir) {
          await removeAutoresearchWorktree(pi, ctx.cwd, runtime.worktreeDir);
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
        updateWidget(ctx);

        if (fs.existsSync(jsonlPath)) {
          try {
            fs.unlinkSync(jsonlPath);
            ctx.ui.notify("Deleted autoresearch.jsonl and turned autoresearch mode OFF", "info");
          } catch (error) {
            ctx.ui.notify(
              `Failed to delete autoresearch.jsonl: ${error instanceof Error ? error.message : String(error)}`,
              "error"
            );
          }
        } else {
          ctx.ui.notify("No autoresearch.jsonl found. Autoresearch mode OFF", "info");
        }
        return;
      }

      runtime.autoresearchMode = true;
      runtime.autoResumeTurns = 0;

      // Create worktree for isolation if not already exists
      if (!runtime.worktreeDir) {
        const worktreePath = await createAutoresearchWorktree(
          pi,
          ctx.cwd,
          getSessionKey(ctx)
        );
        if (worktreePath) {
          runtime.worktreeDir = worktreePath;
          const displayPath = getDisplayWorktreePath(ctx.cwd, worktreePath);
          ctx.ui.notify(`Created autoresearch worktree: ${displayPath}`, "info");
        } else {
          ctx.ui.notify(
            "Failed to create autoresearch worktree — isolation required",
            "error"
          );
          return;
        }
      }

      const workDir = resolveWorkDir(ctx.cwd, runtime);
      const mdPath = path.join(workDir, "autoresearch.md");
      const hasRules = fs.existsSync(mdPath);

      if (hasRules) {
        ctx.ui.notify("Autoresearch mode ON — rules loaded from autoresearch.md", "info");
        pi.sendUserMessage(
          `Autoresearch mode active. ${trimmedArgs} ${BENCHMARK_GUARDRAIL}`
        );
      } else {
        ctx.ui.notify("Autoresearch mode ON — no autoresearch.md found, setting up", "info");
        pi.sendUserMessage(
          `Start autoresearch: ${trimmedArgs} ${BENCHMARK_GUARDRAIL}`
        );
      }
    },
  });
}
