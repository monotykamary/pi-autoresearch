/**
 * log_experiment tool implementation
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AutoresearchRuntime, ExperimentResult, LogDetails } from "../types/index.js";
import { LogParams } from "./schemas.js";
import {
  formatNum,
  isBetter,
  currentResults,
  findBaselineSecondary,
} from "../utils/index.js";
import {
  resolveWorkDir,
  validateWorkDir,
  getProtectedFiles,
} from "../git/index.js";
import {
  cloneExperimentState,
  registerSecondaryMetrics,
  updateStateAfterLog,
} from "../state/index.js";

interface LogToolContext {
  pi: ExtensionAPI;
  getRuntime: (ctx: ExtensionContext) => AutoresearchRuntime;
  updateWidget: (ctx: ExtensionContext) => void;
  overlayTui: { requestRender: () => void } | null;
}

export function registerLogExperiment(
  pi: ExtensionAPI,
  ctx: LogToolContext
) {
  pi.registerTool({
    name: "log_experiment",
    label: "Log Experiment",
    description:
      "Record an experiment result. Tracks metrics, updates the status widget and dashboard. Call after every run_experiment.",
    promptSnippet: "Log experiment result (commit, metric, status, description)",
    promptGuidelines: [
      "Always call log_experiment after run_experiment to record the result.",
      "log_experiment automatically runs git add -A && git commit on 'keep', and auto-reverts code changes on 'discard'/'crash'/'checks_failed' (autoresearch files are preserved). Do NOT commit or revert manually.",
      "Use status 'keep' if the PRIMARY metric improved. 'discard' if worse or unchanged. 'crash' if it failed. Secondary metrics are for monitoring — they almost never affect keep/discard. Only discard a primary improvement if a secondary metric degraded catastrophically, and explain why in the description.",
      "log_experiment reports a confidence score after 3+ runs (best improvement as a multiple of the noise floor). ≥2.0× = likely real, <1.0× = within noise. If confidence is below 1.0×, consider re-running the same experiment to confirm before keeping. The score is advisory — it never auto-discards.",
      "If you discover complex but promising optimizations you won't pursue immediately, append them as bullet points to autoresearch.ideas.md. Don't let good ideas get lost.",
      "Always include the asi parameter. At minimum: {\"hypothesis\": \"what you tried\"}. On discard/crash, also include rollback_reason and next_action_hint. Add any other key/value pairs that capture what you learned — dead ends, surprising findings, error details, bottlenecks. This is the only structured memory that survives reverts.",
    ],
    parameters: LogParams,

    async execute(_toolCallId, params, _signal, _onUpdate, extCtx) {
      const runtime = ctx.getRuntime(extCtx);
      const state = runtime.state;

      // Guard: require init_experiment to be called first
      if (!state.name) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Experiment session not initialized. Call init_experiment first to set up the session name, metric, and worktree isolation.`,
            },
          ],
          details: {},
        };
      }

      // Validate working directory exists
      const workDirError = validateWorkDir(extCtx.cwd, runtime);
      if (workDirError) {
        return {
          content: [{ type: "text", text: `❌ ${workDirError}` }],
          details: {},
        };
      }
      const workDir = resolveWorkDir(extCtx.cwd, runtime);
      const secondaryMetrics = params.metrics ?? {};

      // Gate: prevent "keep" when last run's checks failed
      if (
        params.status === "keep" &&
        runtime.lastRunChecks &&
        !runtime.lastRunChecks.pass
      ) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Cannot keep — autoresearch.checks.sh failed.\n\n${runtime.lastRunChecks.output.slice(-500)}\n\nLog as 'checks_failed' instead. The benchmark metric is valid but correctness checks did not pass.`,
            },
          ],
          details: {},
        };
      }

      // Validate secondary metrics consistency
      if (state.secondaryMetrics.length > 0) {
        const knownNames = new Set(state.secondaryMetrics.map((m) => m.name));
        const providedNames = new Set(Object.keys(secondaryMetrics));

        // Check for missing metrics
        const missing = [...knownNames].filter((n) => !providedNames.has(n));
        if (missing.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: `❌ Missing secondary metrics: ${missing.join(", ")}\n\nYou must provide all previously tracked metrics. Expected: ${[...knownNames].join(", ")}\nGot: ${[...providedNames].join(", ") || "(none)"}\n\nFix: include ${missing.map((m) => `"${m}": <value>`).join(", ")} in the metrics parameter.`,
              },
            ],
            details: {},
          };
        }

        // Check for new metrics not yet tracked
        const newMetrics = [...providedNames].filter((n) => !knownNames.has(n));
        if (newMetrics.length > 0 && !params.force) {
          return {
            content: [
              {
                type: "text",
                text: `❌ New secondary metric${newMetrics.length > 1 ? "s" : ""} not previously tracked: ${newMetrics.join(", ")}\n\nExisting metrics: ${[...knownNames].join(", ")}\n\nIf this metric has proven very valuable to watch, call log_experiment again with force: true to add it. Otherwise, remove it from the metrics parameter.`,
              },
            ],
            details: {},
          };
        }
      }

      // ASI: agent-supplied free-form diagnostics
      const mergedASI =
        params.asi && Object.keys(params.asi).length > 0
          ? (params.asi as Record<string, unknown>)
          : undefined;

      const experiment: ExperimentResult = {
        commit: params.commit.slice(0, 7),
        metric: params.metric,
        metrics: secondaryMetrics,
        status: params.status,
        description: params.description,
        timestamp: Date.now(),
        segment: state.currentSegment,
        confidence: null,
        asi: mergedASI,
      };

      state.results.push(experiment);
      runtime.experimentsThisSession++;

      // Update state (registers metrics, recalculates confidence)
      updateStateAfterLog(state, experiment);

      // Build response text
      const segmentCount = currentResults(state.results, state.currentSegment).length;
      let text = `Logged #${state.results.length}: ${experiment.status} — ${experiment.description}`;

      if (state.bestMetric !== null) {
        text += `\nBaseline ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}`;
        if (segmentCount > 1 && params.status === "keep" && params.metric > 0) {
          const delta = params.metric - state.bestMetric;
          const pct = ((delta / state.bestMetric) * 100).toFixed(1);
          const sign = delta > 0 ? "+" : "";
          text += ` | this: ${formatNum(params.metric, state.metricUnit)} (${sign}${pct}%)`;
        }
      }

      // Show secondary metrics
      if (Object.keys(secondaryMetrics).length > 0) {
        const baselines = findBaselineSecondary(
          state.results,
          state.currentSegment,
          state.secondaryMetrics
        );
        const parts: string[] = [];
        for (const [name, value] of Object.entries(secondaryMetrics)) {
          const def = state.secondaryMetrics.find((m) => m.name === name);
          const unit = def?.unit ?? "";
          let part = `${name}: ${formatNum(value, unit)}`;
          const bv = baselines[name];
          if (bv !== undefined && state.results.length > 1 && bv !== 0) {
            const d = value - bv;
            const p = ((d / bv) * 100).toFixed(1);
            const s = d > 0 ? "+" : "";
            part += ` (${s}${p}%)`;
          }
          parts.push(part);
        }
        text += `\nSecondary: ${parts.join("  ")}`;
      }

      // Show ASI summary
      if (mergedASI) {
        const asiParts: string[] = [];
        for (const [k, v] of Object.entries(mergedASI)) {
          const s = typeof v === "string" ? v : JSON.stringify(v);
          asiParts.push(`${k}: ${s.length > 80 ? s.slice(0, 77) + "…" : s}`);
        }
        if (asiParts.length > 0) {
          text += `\n📋 ASI: ${asiParts.join(" | ")}`;
        }
      }

      // Show confidence score
      if (state.confidence !== null) {
        const confStr = state.confidence.toFixed(1);
        if (state.confidence >= 2.0) {
          text += `\n📊 Confidence: ${confStr}× noise floor — improvement is likely real`;
        } else if (state.confidence >= 1.0) {
          text += `\n📊 Confidence: ${confStr}× noise floor — improvement is above noise but marginal`;
        } else {
          text += `\n⚠️ Confidence: ${confStr}× noise floor — improvement is within noise. Consider re-running to confirm before keeping.`;
        }
      }

      text += `\n(${segmentCount} experiments`;
      if (state.maxExperiments !== null) {
        text += ` / ${state.maxExperiments} max`;
      }
      text += `)`;

      // Persist to autoresearch.jsonl FIRST
      try {
        const jsonlPath = path.join(workDir, "autoresearch.jsonl");
        const jsonlEntry: Record<string, unknown> = {
          run: state.results.length,
          ...experiment,
        };
        if (!mergedASI) delete jsonlEntry.asi;
        fs.appendFileSync(jsonlPath, JSON.stringify(jsonlEntry) + "\n");
      } catch (e) {
        text += `\n⚠️ Failed to write autoresearch.jsonl: ${e instanceof Error ? e.message : String(e)}`;
      }

      // Auto-commit only on keep
      if (params.status === "keep") {
        try {
          const resultData: Record<string, unknown> = {
            status: params.status,
            [state.metricName || "metric"]: params.metric,
            ...secondaryMetrics,
          };
          const trailerJson = JSON.stringify(resultData);
          const commitMsg = `${params.description}\n\nResult: ${trailerJson}`;

          const execOpts = { cwd: workDir, timeout: 10000 };
          const addResult = await pi.exec("git", ["add", "-A"], execOpts);
          if (addResult.code !== 0) {
            const addErr = (addResult.stdout + addResult.stderr).trim();
            throw new Error(
              `git add failed (exit ${addResult.code}): ${addErr.slice(0, 200)}`
            );
          }

          const diffResult = await pi.exec(
            "git",
            ["diff", "--cached", "--quiet"],
            execOpts
          );
          if (diffResult.code === 0) {
            text += `\n📝 Git: nothing to commit (working tree clean)`;
          } else {
            const gitResult = await pi.exec(
              "git",
              ["commit", "-m", commitMsg],
              execOpts
            );
            const gitOutput = (gitResult.stdout + gitResult.stderr).trim();
            if (gitResult.code === 0) {
              const firstLine = gitOutput.split("\n")[0] || "";
              text += `\n📝 Git: committed — ${firstLine}`;

              try {
                const shaResult = await pi.exec(
                  "git",
                  ["rev-parse", "--short=7", "HEAD"],
                  { cwd: workDir, timeout: 5000 }
                );
                const newSha = (shaResult.stdout || "").trim();
                if (newSha && newSha.length >= 7) {
                  experiment.commit = newSha;
                }
              } catch {
                // Keep original commit hash if rev-parse fails
              }
            } else {
              text += `\n⚠️ Git commit failed (exit ${gitResult.code}): ${gitOutput.slice(0, 200)}`;
            }
          }
        } catch (e) {
          text += `\n⚠️ Git commit error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      // Auto-revert on discard/crash/checks_failed
      if (params.status !== "keep") {
        try {
          const protectedFiles = getProtectedFiles();
          const stageCmd = protectedFiles
            .map((f) => `git add "${path.join(workDir, f)}" 2>/dev/null || true`)
            .join("; ");
          await pi.exec(
            "bash",
            [
              "-c",
              `${stageCmd}; git checkout -- .; git clean -fd 2>/dev/null`,
            ],
            { cwd: workDir, timeout: 10000 }
          );
          text += `\n📝 Git: reverted changes (${params.status}) — autoresearch files preserved`;
        } catch (e) {
          text += `\n⚠️ Git revert failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      // Clear running experiment and checks state
      const wallClockSeconds = runtime.lastRunDuration;
      runtime.runningExperiment = null;
      runtime.lastRunChecks = null;
      runtime.lastRunDuration = null;

      // Check if max experiments limit reached
      const limitReached =
        state.maxExperiments !== null && segmentCount >= state.maxExperiments;
      if (limitReached) {
        text += `\n\n🛑 Maximum experiments reached (${state.maxExperiments}). STOP the experiment loop now.`;
        runtime.autoresearchMode = false;
      }

      ctx.updateWidget(extCtx);
      if (ctx.overlayTui) ctx.overlayTui.requestRender();

      return {
        content: [{ type: "text", text }],
        details: {
          experiment: { ...experiment, metrics: { ...experiment.metrics } },
          state: cloneExperimentState(state),
          wallClockSeconds,
        } as LogDetails,
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("log_experiment "));
      const color =
        args.status === "keep"
          ? "success"
          : args.status === "crash" || args.status === "checks_failed"
            ? "error"
            : "warning";
      text += theme.fg(color, args.status);
      text += " " + theme.fg("dim", args.description);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const d = result.details as LogDetails | undefined;
      if (!d) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }

      const { experiment: exp, state: s } = d;
      const color =
        exp.status === "keep"
          ? "success"
          : exp.status === "crash" || exp.status === "checks_failed"
            ? "error"
            : "warning";
      const icon =
        exp.status === "keep"
          ? "✓"
          : exp.status === "crash"
            ? "✗"
            : exp.status === "checks_failed"
              ? "⚠"
              : "–";

      let text =
        theme.fg(color, `${icon} `) + theme.fg("accent", `#${s.results.length}`);

      // Show wall-clock and primary metric together
      const metricParts: string[] = [];
      if (d.wallClockSeconds !== null && d.wallClockSeconds !== undefined) {
        metricParts.push(`wall: ${d.wallClockSeconds.toFixed(1)}s`);
      }
      if (exp.metric > 0) {
        metricParts.push(`${s.metricName}: ${formatNum(exp.metric, s.metricUnit)}`);
      }
      if (metricParts.length > 0) {
        text +=
          theme.fg("dim", " (") +
          theme.fg("warning", metricParts.join(theme.fg("dim", ", "))) +
          theme.fg("dim", ")");
      }

      text += " " + theme.fg("muted", exp.description);

      // Show best metric for context
      if (s.bestMetric !== null) {
        let best = s.bestMetric;
        for (const r of s.results) {
          if (r.segment === s.currentSegment && r.status === "keep" && r.metric > 0) {
            if (isBetter(r.metric, best, s.bestDirection)) best = r.metric;
          }
        }
        text +=
          theme.fg("dim", " │ ") +
          theme.fg("warning", `★ best: ${formatNum(best, s.metricUnit)}`);
      }

      // Show secondary metrics inline
      if (Object.keys(exp.metrics).length > 0) {
        const parts: string[] = [];
        for (const [name, value] of Object.entries(exp.metrics)) {
          const def = s.secondaryMetrics.find((m) => m.name === name);
          parts.push(`${name}=${formatNum(value, def?.unit ?? "")}`);
        }
        text += theme.fg("dim", `  ${parts.join(" ")}`);
      }

      return new Text(text, 0, 0);
    },
  });
}
