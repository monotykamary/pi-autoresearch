/**
 * init_experiment tool implementation
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { Text } from '@mariozechner/pi-tui';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { AutoresearchRuntime } from '../types/index.js';
import { InitParams } from './schemas.js';
import {
  resolveWorkDir,
  validateWorkDir,
  createAutoresearchWorktree,
  getDisplayWorktreePath,
} from '../git/index.js';
import { resetForReinit } from '../state/index.js';

interface InitToolContext {
  pi: ExtensionAPI;
  getRuntime: (ctx: ExtensionContext) => AutoresearchRuntime;
  getSessionKey: (ctx: ExtensionContext) => string;
  startWatcher?: (ctx: ExtensionContext) => void;
}

export function registerInitExperiment(pi: ExtensionAPI, ctx: InitToolContext) {
  pi.registerTool({
    name: 'init_experiment',
    label: 'Init Experiment',
    description:
      'Initialize the experiment session. Call once before the first run_experiment to set the name, primary metric, unit, and direction. Writes the config header to autoresearch.jsonl.',
    promptSnippet:
      'Initialize experiment session (name, metric, unit, direction). Call once before first run.',
    promptGuidelines: [
      'Call init_experiment exactly once at the start of an autoresearch session, before the first run_experiment.',
      'If autoresearch.jsonl already exists with a config, do NOT call init_experiment again.',
      'If the optimization target changes (different benchmark, metric, or workload), call init_experiment again to insert a new config header and reset the baseline.',
    ],
    parameters: InitParams,

    async execute(_toolCallId, params, _signal, _onUpdate, extCtx) {
      const runtime = ctx.getRuntime(extCtx);
      const state = runtime.state;

      // Auto-create worktree if not already exists (for direct tool calls without /autoresearch)
      let worktreeCreated = false;
      if (!runtime.worktreeDir) {
        const worktreePath = await createAutoresearchWorktree(
          ctx.pi,
          extCtx.cwd,
          ctx.getSessionKey(extCtx)
        );
        if (worktreePath) {
          runtime.worktreeDir = worktreePath;
          worktreeCreated = true;
        } else {
          return {
            content: [
              {
                type: 'text',
                text: '❌ Worktree creation failed — experiments require isolated worktree',
              },
            ],
            details: {},
          };
        }
      }

      // Validate working directory exists
      const workDirError = validateWorkDir(extCtx.cwd, runtime);
      if (workDirError) {
        return {
          content: [{ type: 'text', text: `❌ ${workDirError}` }],
          details: {},
        };
      }

      const workDir = resolveWorkDir(extCtx.cwd, runtime);
      const jsonlPath = path.join(workDir, 'autoresearch.jsonl');
      const isReinit = fs.existsSync(jsonlPath);

      state.name = params.name;
      state.metricName = params.metric_name;
      state.metricUnit = params.metric_unit ?? '';
      if (params.direction === 'lower' || params.direction === 'higher') {
        state.bestDirection = params.direction;
      }
      state.targetValue = params.target_value ?? null;

      // Start a new segment
      if (isReinit) {
        resetForReinit(state, true);
      }

      // Write config header to jsonl
      try {
        const config = JSON.stringify({
          type: 'config',
          name: state.name,
          metricName: state.metricName,
          metricUnit: state.metricUnit,
          bestDirection: state.bestDirection,
          targetValue: state.targetValue,
          segment: state.currentSegment,
        });
        if (isReinit) {
          fs.appendFileSync(jsonlPath, config + '\n');
        } else {
          fs.writeFileSync(jsonlPath, config + '\n');
        }
      } catch (e) {
        return {
          content: [
            {
              type: 'text',
              text: `⚠️ Failed to write autoresearch.jsonl: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          details: {},
        };
      }

      runtime.autoresearchMode = true;

      // Start watcher if not already running and we have a worktree
      if (ctx.startWatcher && runtime.worktreeDir && !runtime.jsonlWatcher) {
        ctx.startWatcher(extCtx);
      }

      // File watcher will update UI when JSONL changes

      const reinitNote = isReinit
        ? ' (re-initialized — previous results archived, new baseline needed)'
        : '';
      const targetNote =
        state.targetValue !== null
          ? `\nTarget: ${state.targetValue}${state.metricUnit} (${state.bestDirection} is better) — loop stops when reached`
          : '';
      const worktreeNote = worktreeCreated
        ? `\n📁 Created isolated worktree: ${getDisplayWorktreePath(extCtx.cwd, runtime.worktreeDir!)}`
        : '';
      const workDirNote = workDir !== extCtx.cwd ? `\nWorking directory: ${workDir}` : '';
      return {
        content: [
          {
            type: 'text',
            text: `✅ Experiment initialized: "${state.name}"${reinitNote}\nMetric: ${state.metricName} (${state.metricUnit || 'unitless'}, ${state.bestDirection} is better)${targetNote}${worktreeNote}${workDirNote}\nConfig written to autoresearch.jsonl. Now run the baseline with run_experiment.`,
          },
        ],
        details: {},
      };
    },

    renderCall(args, theme) {
      let text = theme.fg('toolTitle', theme.bold('init_experiment '));
      text += theme.fg('accent', args.name ?? '');
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const t = result.content[0];
      return new Text(t?.type === 'text' ? t.text : '', 0, 0);
    },
  });
}
