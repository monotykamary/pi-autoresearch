/**
 * Redirected file tools for autoresearch worktree isolation.
 *
 * When autoresearch mode is active with an isolated worktree, these wrappers
 * redirect file operations (read, edit, write) to the worktree directory.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  createReadTool,
  createEditTool,
  createWriteTool,
  type ReadOperations,
  type EditOperations,
  type WriteOperations,
} from "@mariozechner/pi-coding-agent";
import type { AutoresearchRuntime } from "../types/index.js";

/**
 * Resolve a path for file operations during autoresearch mode.
 */
function resolveAutoresearchPath(
  inputPath: string,
  ctxCwd: string,
  runtime: AutoresearchRuntime
): string {
  if (!runtime.autoresearchMode || !runtime.worktreeDir) {
    return path.resolve(ctxCwd, inputPath);
  }

  const worktreeDir = runtime.worktreeDir;

  if (path.isAbsolute(inputPath)) {
    // If path is already within worktree, use as-is (don't double-redirect)
    const relativeToWorktree = path.relative(worktreeDir, inputPath);
    if (!relativeToWorktree.startsWith("..") && !path.isAbsolute(relativeToWorktree)) {
      return inputPath;
    }

    // Check if inputPath is within ctxCwd using path.relative
    // If relative path starts with "..", it's outside ctxCwd
    const relativeToCwd = path.relative(ctxCwd, inputPath);
    if (!relativeToCwd.startsWith("..") && !path.isAbsolute(relativeToCwd)) {
      // Path is within ctxCwd, redirect to worktree
      return path.join(worktreeDir, relativeToCwd);
    }
    // Path is outside ctxCwd, use as-is
    return inputPath;
  }

  // Relative path - resolve against worktree
  return path.join(worktreeDir, inputPath);
}

/**
 * Create redirected read operations that resolve paths to the worktree.
 * @internal - exported for testing
 */
export function createReadOperations(
  ctxCwd: string,
  runtime: AutoresearchRuntime
): ReadOperations {
  return {
    readFile: (absolutePath: string) => {
      const resolved = resolveAutoresearchPath(absolutePath, ctxCwd, runtime);
      return fs.promises.readFile(resolved);
    },
    access: async (absolutePath: string) => {
      const resolved = resolveAutoresearchPath(absolutePath, ctxCwd, runtime);
      await fs.promises.access(resolved, fs.constants.R_OK);
    },
    detectImageMimeType: async (absolutePath: string) => {
      const resolved = resolveAutoresearchPath(absolutePath, ctxCwd, runtime);
      const ext = path.extname(resolved).toLowerCase();
      if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
      if (ext === ".png") return "image/png";
      if (ext === ".gif") return "image/gif";
      if (ext === ".webp") return "image/webp";
      return null;
    },
  };
}

/**
 * Create redirected edit operations that resolve paths to the worktree.
 * @internal - exported for testing
 */
export function createEditOperations(
  ctxCwd: string,
  runtime: AutoresearchRuntime
): EditOperations {
  return {
    readFile: (absolutePath: string) => {
      const resolved = resolveAutoresearchPath(absolutePath, ctxCwd, runtime);
      return fs.promises.readFile(resolved);
    },
    writeFile: async (absolutePath: string, content: string) => {
      const resolved = resolveAutoresearchPath(absolutePath, ctxCwd, runtime);
      // Create parent directories like the built-in write tool
      const parentDir = path.dirname(resolved);
      await fs.promises.mkdir(parentDir, { recursive: true });
      await fs.promises.writeFile(resolved, content, "utf-8");
    },
    access: async (absolutePath: string) => {
      const resolved = resolveAutoresearchPath(absolutePath, ctxCwd, runtime);
      await fs.promises.access(resolved, fs.constants.R_OK | fs.constants.W_OK);
    },
  };
}

/**
 * Create redirected write operations that resolve paths to the worktree.
 * @internal - exported for testing
 */
export function createWriteOperations(
  ctxCwd: string,
  runtime: AutoresearchRuntime
): WriteOperations {
  return {
    writeFile: async (absolutePath: string, content: string) => {
      const resolved = resolveAutoresearchPath(absolutePath, ctxCwd, runtime);
      // Create parent directories like the built-in write tool
      const parentDir = path.dirname(resolved);
      await fs.promises.mkdir(parentDir, { recursive: true });
      await fs.promises.writeFile(resolved, content, "utf-8");
    },
    mkdir: async (dir: string) => {
      const resolved = resolveAutoresearchPath(dir, ctxCwd, runtime);
      await fs.promises.mkdir(resolved, { recursive: true });
    },
  };
}

/**
 * Register redirected versions of read, edit, and write tools.
 * These override the built-in tools to redirect file operations to the worktree
 * when autoresearch mode is active.
 */
export function registerRedirectedFileTools(
  pi: ExtensionAPI,
  getRuntime: (ctx: ExtensionContext) => AutoresearchRuntime
) {
  // Register read tool with redirected operations
  pi.registerTool({
    ...createReadTool(""),
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const runtime = getRuntime(ctx);
      const ops = createReadOperations(ctx.cwd, runtime);
      const tool = createReadTool(ctx.cwd, { operations: ops });
      // AgentTool.execute has 4 params, we ignore ctx for the inner tool call
      return tool.execute(toolCallId, params, signal, onUpdate) as ReturnType<Parameters<typeof pi.registerTool>[0]['execute']>;
    },
  });

  // Register edit tool with redirected operations
  pi.registerTool({
    ...createEditTool(""),
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const runtime = getRuntime(ctx);
      const ops = createEditOperations(ctx.cwd, runtime);
      const tool = createEditTool(ctx.cwd, { operations: ops });
      return tool.execute(toolCallId, params, signal, onUpdate) as ReturnType<Parameters<typeof pi.registerTool>[0]['execute']>;
    },
  });

  // Register write tool with redirected operations
  pi.registerTool({
    ...createWriteTool(""),
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const runtime = getRuntime(ctx);
      const ops = createWriteOperations(ctx.cwd, runtime);
      const tool = createWriteTool(ctx.cwd, { operations: ops });
      return tool.execute(toolCallId, params, signal, onUpdate) as ReturnType<Parameters<typeof pi.registerTool>[0]['execute']>;
    },
  });
}
