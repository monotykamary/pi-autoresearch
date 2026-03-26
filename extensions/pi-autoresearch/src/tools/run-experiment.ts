/**
 * run_experiment tool implementation
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import {
  truncateTail,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AutoresearchRuntime, RunDetails } from "../types/index.js";
import { RunParams } from "./schemas.js";
import {
  EXPERIMENT_MAX_LINES,
  EXPERIMENT_MAX_BYTES,
} from "../constants.js";
import {
  formatNum,
  formatElapsed,
  parseMetricLines,
  isAutoresearchShCommand,
  killTree,
  createTempFileAllocator,
  currentResults,
} from "../utils/index.js";
import { resolveWorkDir, validateWorkDir } from "../git/index.js";

interface RunToolContext {
  pi: ExtensionAPI;
  getRuntime: (ctx: ExtensionContext) => AutoresearchRuntime;
  updateWidget: (ctx: ExtensionContext) => void;
  overlayTui: { requestRender: () => void } | null;
}

export function registerRunExperiment(
  pi: ExtensionAPI,
  ctx: RunToolContext
) {
  pi.registerTool({
    name: "run_experiment",
    label: "Run Experiment",
    description: `Run a shell command as an experiment. Times wall-clock duration, captures output, detects pass/fail via exit code. Output is truncated to last ${EXPERIMENT_MAX_LINES} lines or ${EXPERIMENT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Use for any autoresearch experiment.`,
    promptSnippet:
      "Run a timed experiment command (captures duration, output, exit code)",
    promptGuidelines: [
      "Use run_experiment instead of bash when running experiment commands — it handles timing and output capture automatically.",
      "After run_experiment, always call log_experiment to record the result.",
      "If the benchmark script outputs structured METRIC lines (e.g. 'METRIC total_µs=15200'), run_experiment will parse them automatically and suggest exact values for log_experiment. Use these parsed values directly instead of extracting them manually from the output.",
    ],
    parameters: RunParams,

    async execute(_toolCallId, params, signal, onUpdate, extCtx) {
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

      // Block if max experiments limit already reached
      if (state.maxExperiments !== null) {
        const segCount = currentResults(state.results, state.currentSegment).length;
        if (segCount >= state.maxExperiments) {
          return {
            content: [
              {
                type: "text",
                text: `🛑 Maximum experiments reached (${state.maxExperiments}). The experiment loop is done. To continue, call init_experiment to start a new segment.`,
              },
            ],
            details: {},
          };
        }
      }

      const timeout = (params.timeout_seconds ?? 600) * 1000;

      // Clear any stale starting commit and capture fresh one BEFORE running
      // This ensures we always record the correct starting point for this experiment
      runtime.startingCommit = null;

      // Capture starting commit BEFORE running the experiment (before any AI modifications)
      // This commit is recorded in the experiment result for reference
      try {
        const shaResult = await pi.exec(
          "git",
          ["rev-parse", "--short=7", "HEAD"],
          { cwd: workDir, timeout: 5000 }
        );
        if (shaResult.code === 0) {
          runtime.startingCommit = (shaResult.stdout || "").trim();
        }
      } catch {
        // If git fails, leave startingCommit as null (log_experiment will handle gracefully)
      }

      // Guard: if autoresearch.sh exists, only allow running it
      const autoresearchShPath = path.join(workDir, "autoresearch.sh");
      if (
        fs.existsSync(autoresearchShPath) &&
        !isAutoresearchShCommand(params.command)
      ) {
        return {
          content: [
            {
              type: "text",
              text: `❌ autoresearch.sh exists — you must run it instead of a custom command.\n\nFound: ${autoresearchShPath}\nYour command: ${params.command}\n\nUse: run_experiment({ command: "bash autoresearch.sh" }) or run_experiment({ command: "./autoresearch.sh" })`,
            },
          ],
          details: {
            command: params.command,
            exitCode: null,
            durationSeconds: 0,
            passed: false,
            crashed: true,
            timedOut: false,
            tailOutput: "",
            checksPass: null,
            checksTimedOut: false,
            checksOutput: "",
            checksDuration: 0,
          } as RunDetails,
        };
      }

      runtime.runningExperiment = {
        startedAt: Date.now(),
        command: params.command,
      };
      ctx.updateWidget(extCtx);
      if (ctx.overlayTui) ctx.overlayTui.requestRender();

      const t0 = Date.now();

      // Spawn the process directly for streaming output
      const getTempFile = createTempFileAllocator();
      const {
        exitCode,
        killed: timedOut,
        output,
        tempFilePath: streamTempFile,
        actualTotalBytes,
      } = await new Promise<{
        exitCode: number | null;
        killed: boolean;
        output: string;
        tempFilePath: string | undefined;
        actualTotalBytes: number;
      }>((resolve, reject) => {
        let processTimedOut = false;

        const child = spawn("bash", ["-c", params.command], {
          cwd: workDir,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        // Rolling buffer for tail truncation
        const chunks: Buffer[] = [];
        let chunksBytes = 0;
        const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

        // Temp file for full output when it overflows
        let tempFilePath: string | undefined;
        let tempFileStream: ReturnType<typeof import("node:fs").createWriteStream> | undefined;
        let totalBytes = 0;

        // Cache for Buffer.concat
        let chunksGeneration = 0;
        let cachedGeneration = -1;
        let cachedText = "";

        function getBufferText(): string {
          if (cachedGeneration === chunksGeneration) return cachedText;
          cachedText = Buffer.concat(chunks).toString("utf-8");
          cachedGeneration = chunksGeneration;
          return cachedText;
        }

        // Timer interval — update every second
        const timerInterval = setInterval(() => {
          if (!onUpdate) return;
          const elapsed = formatElapsed(Date.now() - t0);
          const trunc = truncateTail(getBufferText(), {
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
          });
          onUpdate({
            content: [{ type: "text", text: trunc.content || "" }],
            details: {
              phase: "running",
              elapsed,
              truncation: trunc.truncated ? trunc : undefined,
              fullOutputPath: tempFilePath,
            },
          });
        }, 1000);

        const handleData = (data: Buffer) => {
          totalBytes += data.length;

          if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
            tempFilePath = getTempFile();
            tempFileStream = fs.createWriteStream(tempFilePath);
            for (const chunk of chunks) {
              tempFileStream.write(chunk);
            }
          }

          if (tempFileStream) {
            tempFileStream.write(data);
          }

          // Keep rolling buffer of recent data
          chunks.push(data);
          chunksBytes += data.length;

          // Evict old chunks
          while (chunksBytes > maxChunksBytes && chunks.length > 1) {
            const removed = chunks.shift()!;
            chunksBytes -= removed.length;
          }
          // Trim first surviving chunk to newline boundary
          if (chunks.length > 0 && chunksBytes > maxChunksBytes) {
            const buf = chunks[0];
            const nlIdx = buf.indexOf(0x0a); // '\n'
            if (nlIdx !== -1 && nlIdx < buf.length - 1) {
              chunks[0] = buf.subarray(nlIdx + 1);
              chunksBytes -= nlIdx + 1;
            }
          }

          chunksGeneration++;
        };

        if (child.stdout) child.stdout.on("data", handleData);
        if (child.stderr) child.stderr.on("data", handleData);

        // Timeout
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        if (timeout > 0) {
          timeoutHandle = setTimeout(() => {
            processTimedOut = true;
            if (child.pid) killTree(child.pid);
          }, timeout);
        }

        // Abort signal
        const onAbort = () => {
          if (child.pid) killTree(child.pid);
          else {
            child.kill();
            child.once("spawn", () => {
              if (child.pid) killTree(child.pid);
            });
          }
        };
        if (signal) {
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }

        child.on("error", (err) => {
          clearInterval(timerInterval);
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (signal) signal.removeEventListener("abort", onAbort);
          if (tempFileStream) tempFileStream.end();
          reject(err);
        });

        child.on("close", (code) => {
          clearInterval(timerInterval);
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (signal) signal.removeEventListener("abort", onAbort);
          if (tempFileStream) tempFileStream.end();

          if (signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }

          const fullBuffer = Buffer.concat(chunks);
          resolve({
            exitCode: code,
            killed: processTimedOut,
            output: fullBuffer.toString("utf-8"),
            tempFilePath,
            actualTotalBytes: totalBytes,
          });
        });
      }).finally(() => {
        runtime.runningExperiment = null;
        runtime.experimentCompletedWaitingForLog = true;
        ctx.updateWidget(extCtx);
        if (ctx.overlayTui) ctx.overlayTui.requestRender();
      });

      const durationSeconds = (Date.now() - t0) / 1000;
      runtime.lastRunDuration = durationSeconds;
      const benchmarkPassed = exitCode === 0 && !timedOut;

      // Run backpressure checks if benchmark passed and checks file exists
      let checksPass: boolean | null = null;
      let checksTimedOut = false;
      let checksOutput = "";
      let checksDuration = 0;

      const checksPath = path.join(workDir, "autoresearch.checks.sh");
      if (benchmarkPassed && fs.existsSync(checksPath)) {
        const checksTimeout = (params.checks_timeout_seconds ?? 300) * 1000;
        const ct0 = Date.now();
        try {
          const checksResult = await pi.exec("bash", [checksPath], {
            signal,
            timeout: checksTimeout,
            cwd: workDir,
          });
          checksDuration = (Date.now() - ct0) / 1000;
          checksTimedOut = !!checksResult.killed;
          checksPass = checksResult.code === 0 && !checksResult.killed;
          checksOutput = (checksResult.stdout + "\n" + checksResult.stderr).trim();
        } catch (e) {
          checksDuration = (Date.now() - ct0) / 1000;
          checksPass = false;
          checksOutput = e instanceof Error ? e.message : String(e);
        }
      }

      // Store checks result for log_experiment gate
      runtime.lastRunChecks =
        checksPass !== null
          ? { pass: checksPass, output: checksOutput, duration: checksDuration }
          : null;

      const passed = benchmarkPassed && (checksPass === null || checksPass);

      // Reuse streaming temp file if it exists, otherwise create one for large output
      let fullOutputPath: string | undefined = streamTempFile;
      const totalLines = output.split("\n").length;
      if (
        !fullOutputPath &&
        (actualTotalBytes > EXPERIMENT_MAX_BYTES || totalLines > EXPERIMENT_MAX_LINES)
      ) {
        fullOutputPath = getTempFile();
        fs.writeFileSync(fullOutputPath, output);
      }

      // Wider truncation for TUI display
      const displayTruncation = truncateTail(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      // Tight truncation for LLM context
      const llmTruncation = truncateTail(output, {
        maxLines: EXPERIMENT_MAX_LINES,
        maxBytes: EXPERIMENT_MAX_BYTES,
      });

      // Parse structured METRIC lines from output
      const parsedMetricMap = parseMetricLines(output);
      const parsedMetrics =
        parsedMetricMap.size > 0 ? Object.fromEntries(parsedMetricMap) : null;
      const parsedPrimary = parsedMetricMap.get(state.metricName) ?? null;

      const details: RunDetails = {
        command: params.command,
        exitCode,
        durationSeconds,
        passed,
        crashed: !passed,
        timedOut,
        tailOutput: displayTruncation.content,
        checksPass,
        checksTimedOut,
        checksOutput: checksOutput.split("\n").slice(-80).join("\n"),
        checksDuration,
        parsedMetrics,
        parsedPrimary,
        metricName: state.metricName,
        metricUnit: state.metricUnit,
      };

      // Build LLM response
      let text = "";
      if (details.timedOut) {
        text += `⏰ TIMEOUT after ${durationSeconds.toFixed(1)}s\n`;
      } else if (!benchmarkPassed) {
        text += `💥 FAILED (exit code ${exitCode}) in ${durationSeconds.toFixed(1)}s\n`;
      } else if (checksTimedOut) {
        text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
        text += `⏰ CHECKS TIMEOUT (autoresearch.checks.sh) after ${checksDuration.toFixed(1)}s\n`;
        text += `Log this as 'checks_failed' — the benchmark metric is valid but checks timed out.\n`;
      } else if (checksPass === false) {
        text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
        text += `💥 CHECKS FAILED (autoresearch.checks.sh) in ${checksDuration.toFixed(1)}s\n`;
        text += `Log this as 'checks_failed' — the benchmark metric is valid but correctness checks did not pass.\n`;
      } else {
        text += `✅ PASSED in ${durationSeconds.toFixed(1)}s\n`;
        if (checksPass === true) {
          text += `✅ Checks passed in ${checksDuration.toFixed(1)}s\n`;
        }
      }

      if (state.bestMetric !== null) {
        text += `📊 Current best ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}\n`;
      }

      // Show parsed METRIC lines to the LLM
      if (parsedMetrics) {
        const secondary = Object.entries(parsedMetrics).filter(
          ([k]) => k !== state.metricName
        );

        text += `\n📐 Parsed metrics:`;
        if (parsedPrimary !== null) {
          text += ` ★ ${state.metricName}=${formatNum(parsedPrimary, state.metricUnit)}`;
        }
        for (const [name, value] of secondary) {
          text += ` ${name}=${value}`;
        }

        text += `\nUse these values directly in log_experiment (metric: ${parsedPrimary ?? "?"}, metrics: {${secondary.map(([k, v]) => `"${k}": ${v}`).join(", ")}})\n`;
      }

      text += `\n${llmTruncation.content}`;

      if (llmTruncation.truncated) {
        if (llmTruncation.truncatedBy === "lines") {
          text += `\n\n[Showing last ${llmTruncation.outputLines} of ${llmTruncation.totalLines} lines.`;
        } else {
          text += `\n\n[Showing last ${llmTruncation.outputLines} lines (${formatSize(EXPERIMENT_MAX_BYTES)} limit).`;
        }
        if (fullOutputPath) {
          text += ` Full output: ${fullOutputPath}`;
        }
        text += `]`;
      }

      if (checksPass === false) {
        text += `\n\n── Checks output (last 80 lines) ──\n${details.checksOutput}`;
      }

      return {
        content: [{ type: "text", text }],
        details: {
          ...details,
          truncation: llmTruncation.truncated ? llmTruncation : undefined,
          fullOutputPath,
        },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("run_experiment "));
      text += theme.fg("muted", args.command);
      if (args.timeout_seconds) {
        text += theme.fg("dim", ` (timeout: ${args.timeout_seconds}s)`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const PREVIEW_LINES = 5;

      if (isPartial) {
        const d = result.details as
          | { phase?: string; elapsed?: string; truncation?: any; fullOutputPath?: string }
          | undefined;
        const elapsed = d?.elapsed ?? "";
        const outputText =
          result.content[0]?.type === "text" ? result.content[0].text : "";

        let text = theme.fg(
          "warning",
          `⏳ Running${elapsed ? ` ${elapsed}` : ""}…`
        );

        if (outputText) {
          const lines = outputText.split("\n");
          const maxLines = expanded ? 20 : PREVIEW_LINES;
          const tail = lines.slice(-maxLines).join("\n");
          if (tail.trim()) {
            text += "\n" + theme.fg("dim", tail);
          }
        }

        return new Text(text, 0, 0);
      }

      const d = result.details as
        | (RunDetails & { truncation?: any; fullOutputPath?: string })
        | undefined;
      if (!d) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }

      const appendOutput = (text: string, output: string): string => {
        if (!output) return text;
        const lines = output.split("\n");
        if (expanded) {
          text += "\n" + theme.fg("dim", output.slice(-2000));
        } else {
          const tail = lines.slice(-PREVIEW_LINES).join("\n");
          if (tail.trim()) {
            const hidden = lines.length - PREVIEW_LINES;
            if (hidden > 0) {
              text += "\n" + theme.fg("muted", `… ${hidden} more lines`);
            }
            text += "\n" + theme.fg("dim", tail);
          }
        }
        return text;
      };

      if (d.timedOut) {
        let text = theme.fg("error", `⏰ TIMEOUT ${d.durationSeconds.toFixed(1)}s`);
        text = appendOutput(text, d.tailOutput);
        return new Text(text, 0, 0);
      }

      const parsedSuffix =
        d.parsedPrimary !== null
          ? theme.fg(
              "accent",
              `, ${d.metricName}: ${formatNum(d.parsedPrimary, d.metricUnit)}`
            )
          : "";

      if (d.checksTimedOut) {
        let text =
          theme.fg("success", `✅ wall: ${d.durationSeconds.toFixed(1)}s`) +
          parsedSuffix +
          theme.fg("error", ` ⏰ checks timeout ${d.checksDuration.toFixed(1)}s`);
        text = appendOutput(text, d.checksOutput);
        return new Text(text, 0, 0);
      }

      if (d.checksPass === false) {
        let text =
          theme.fg("success", `✅ wall: ${d.durationSeconds.toFixed(1)}s`) +
          parsedSuffix +
          theme.fg("error", ` 💥 checks failed ${d.checksDuration.toFixed(1)}s`);
        text = appendOutput(text, d.checksOutput);
        return new Text(text, 0, 0);
      }

      if (d.crashed) {
        let text =
          theme.fg("error", `💥 FAIL exit=${d.exitCode} ${d.durationSeconds.toFixed(1)}s`) +
          parsedSuffix;
        text = appendOutput(text, d.tailOutput);
        return new Text(text, 0, 0);
      }

      let text = theme.fg("success", "✅ ");

      const parts: string[] = [`wall: ${d.durationSeconds.toFixed(1)}s`];
      if (d.parsedPrimary !== null) {
        parts.push(`${d.metricName}: ${formatNum(d.parsedPrimary, d.metricUnit)}`);
      }
      text += theme.fg("accent", parts.join(", "));

      if (d.checksPass === true) {
        text += theme.fg("success", ` ✓ checks ${d.checksDuration.toFixed(1)}s`);
      }

      if (d.truncation?.truncated && d.fullOutputPath) {
        text += theme.fg("warning", " (truncated)");
      }

      text = appendOutput(text, d.tailOutput);

      if (expanded && d.truncation?.truncated && d.fullOutputPath) {
        if (d.truncation.truncatedBy === "lines") {
          text +=
            "\n" +
            theme.fg(
              "warning",
              `[Truncated: showing ${d.truncation.outputLines} of ${d.truncation.totalLines} lines. Full output: ${d.fullOutputPath}]`
            );
        } else {
          text +=
            "\n" +
            theme.fg(
              "warning",
              `[Truncated: ${d.truncation.outputLines} lines shown (${formatSize(EXPERIMENT_MAX_BYTES)} limit). Full output: ${d.fullOutputPath}]`
            );
        }
      }

      return new Text(text, 0, 0);
    },
  });
}
