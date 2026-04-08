/**
 * Bash tool override for autoresearch worktree redirection.
 *
 * When autoresearch mode is active with a worktree, this redirects all bash
 * commands to execute in the worktree directory instead of the main repo.
 * Also injects environment variables so subprocesses know they're in isolation.
 */

import type { ExtensionContext, AgentToolUpdateCallback } from '@mariozechner/pi-coding-agent';
import {
  createBashTool,
  type BashSpawnContext,
  type BashToolInput,
} from '@mariozechner/pi-coding-agent';
import type { AutoresearchRuntime } from '../types/index.js';
import { resolveWorkDir } from '../git/index.js';

// Cache for default bash tools by cwd to avoid recreating
const defaultToolCache = new Map<string, ReturnType<typeof createBashTool>>();

function getDefaultBashTool(cwd: string): ReturnType<typeof createBashTool> {
  let tool = defaultToolCache.get(cwd);
  if (!tool) {
    tool = createBashTool(cwd);
    defaultToolCache.set(cwd, tool);
  }
  return tool;
}

/**
 * Create the redirected bash tool handler.
 * When autoresearch mode is ON with an active worktree, commands execute
 * in the worktree directory with isolation environment variables set.
 */
export function createBashRedirectHandler(
  getRuntime: (ctx: ExtensionContext) => AutoresearchRuntime
) {
  return {
    name: 'bash' as const,
    label: 'bash',
    description:
      'Execute a bash command. Returns stdout and stderr. ' +
      'Output is truncated to last 2000 lines or 50KB (whichever is hit first). ' +
      'When autoresearch mode is ON with a worktree, executes in the worktree directory.',
    parameters: createBashTool('').parameters,

    async execute(
      toolCallId: string,
      params: BashToolInput,
      signal: AbortSignal,
      onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext
    ) {
      const runtime = getRuntime(ctx);

      // No autoresearch mode or no worktree - use default behavior
      if (!runtime.autoresearchMode || !runtime.worktreeDir) {
        const tool = getDefaultBashTool(ctx.cwd);
        return tool.execute(toolCallId, params, signal, onUpdate);
      }

      // Get the effective working directory (worktree)
      const workDir = resolveWorkDir(ctx.cwd, runtime);

      // Create bash tool with worktree as cwd and spawn hook for env vars
      const tool = createBashTool(workDir, {
        spawnHook: (context: BashSpawnContext): BashSpawnContext => ({
          ...context,
          cwd: workDir,
          env: {
            ...context.env,
            PI_AUTORESEARCH: '1',
            PI_WORKTREE_DIR: workDir,
            PI_SOURCE_DIR: ctx.cwd,
          },
        }),
      });

      return tool.execute(toolCallId, params, signal, onUpdate);
    },
  };
}

/**
 * Register the redirected bash tool.
 * This overrides the built-in bash tool to redirect operations to the worktree
 * when autoresearch mode is active.
 */
export function registerRedirectedBashTool(
  pi: {
    registerTool: (tool: ReturnType<typeof createBashRedirectHandler>) => void;
  },
  getRuntime: (ctx: ExtensionContext) => AutoresearchRuntime
): void {
  const tool = createBashRedirectHandler(getRuntime);
  pi.registerTool(tool);
}
