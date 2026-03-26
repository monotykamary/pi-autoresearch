/**
 * Git worktree management for autoresearch isolation
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutoresearchRuntime, AutoresearchConfig } from "../types/index.js";

/** Read autoresearch.config.json from the given directory */
export function readConfig(cwd: string): AutoresearchConfig {
  try {
    const configPath = path.join(cwd, "autoresearch.config.json");
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

/** Read maxExperiments from autoresearch.config.json */
export function readMaxExperiments(cwd: string): number | null {
  const config = readConfig(cwd);
  return typeof config.maxIterations === "number" && config.maxIterations > 0
    ? Math.floor(config.maxIterations)
    : null;
}

/**
 * Resolve the effective working directory.
 * Reads workingDir from autoresearch.config.json in ctxCwd.
 * Returns ctxCwd if not set. Supports relative (resolved against ctxCwd) and absolute paths.
 *
 * When in autoresearch mode with an active worktree, returns the worktree directory.
 */
export function resolveWorkDir(
  ctxCwd: string,
  runtime?: AutoresearchRuntime
): string {
  // Worktree takes precedence when in autoresearch mode
  if (runtime?.worktreeDir) {
    return runtime.worktreeDir;
  }

  const config = readConfig(ctxCwd);
  if (!config.workingDir) return ctxCwd;
  return path.isAbsolute(config.workingDir)
    ? config.workingDir
    : path.resolve(ctxCwd, config.workingDir);
}

/** Validate that the resolved working directory exists */
export function validateWorkDir(
  ctxCwd: string,
  runtime?: AutoresearchRuntime
): string | null {
  const workDir = resolveWorkDir(ctxCwd, runtime);
  if (workDir === ctxCwd) return null;
  try {
    const stat = fs.statSync(workDir);
    if (!stat.isDirectory()) {
      return `workingDir "${workDir}" (from autoresearch.config.json) is not a directory.`;
    }
  } catch {
    return `workingDir "${workDir}" (from autoresearch.config.json) does not exist.`;
  }
  return null;
}

/** Get the worktree path for display purposes (relative if inside project) */
export function getDisplayWorktreePath(
  ctxCwd: string,
  worktreePath: string | null
): string | null {
  if (!worktreePath) return null;
  if (worktreePath.startsWith(ctxCwd)) {
    return path.relative(ctxCwd, worktreePath) || ".";
  }
  return worktreePath;
}

/**
 * Create a git worktree for autoresearch isolation.
 * Worktree is created at: <ctxCwd>/autoresearch/<sessionId>/
 * Returns the worktree path or null if creation failed.
 */
export async function createAutoresearchWorktree(
  pi: ExtensionAPI,
  ctxCwd: string,
  sessionId: string
): Promise<string | null> {
  const worktreeName = `autoresearch/${sessionId}`;
  const worktreePath = path.join(ctxCwd, worktreeName);

  // Check if worktree already exists
  try {
    const result = await pi.exec(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: ctxCwd, timeout: 10000 }
    );
    if (result.stdout.includes(worktreePath)) {
      if (fs.existsSync(worktreePath)) {
        return worktreePath;
      }
      // Worktree entry exists but directory is missing — prune and recreate
      await pi.exec("git", ["worktree", "prune"], {
        cwd: ctxCwd,
        timeout: 5000,
      });
    }
  } catch {
    // Git worktree list failed, proceed to try creation
  }

  // Create the autoresearch directory if it doesn't exist
  const autoresearchDir = path.join(ctxCwd, "autoresearch");
  if (!fs.existsSync(autoresearchDir)) {
    fs.mkdirSync(autoresearchDir, { recursive: true });
  }

  // Create a branch for this worktree
  const branchName = `autoresearch/${sessionId}`;

  try {
    // Check if branch exists
    const branchResult = await pi.exec(
      "git",
      ["branch", "--list", branchName],
      { cwd: ctxCwd, timeout: 5000 }
    );
    if (!branchResult.stdout.trim()) {
      // Create branch from current HEAD without switching (just create the ref)
      const createResult = await pi.exec(
        "git",
        ["branch", branchName],
        { cwd: ctxCwd, timeout: 10000 }
      );
      if (createResult.code !== 0) {
        return null;
      }
    }

    // Create worktree
    const worktreeResult = await pi.exec(
      "git",
      ["worktree", "add", worktreePath, branchName],
      { cwd: ctxCwd, timeout: 30000 }
    );

    if (worktreeResult.code !== 0) {
      return null;
    }

    return worktreePath;
  } catch {
    return null;
  }
}

/**
 * Remove a git worktree and its associated branch.
 */
export async function removeAutoresearchWorktree(
  pi: ExtensionAPI,
  ctxCwd: string,
  worktreePath: string
): Promise<void> {
  try {
    // Remove the worktree
    await pi.exec(
      "git",
      ["worktree", "remove", "--force", worktreePath],
      { cwd: ctxCwd, timeout: 30000 }
    );

    // Extract branch name from path
    const branchName = path.relative(ctxCwd, worktreePath);

    // Try to delete the branch
    await pi.exec("git", ["branch", "-D", branchName], {
      cwd: ctxCwd,
      timeout: 10000,
    });

    // Clean up empty autoresearch directory
    const autoresearchDir = path.join(ctxCwd, "autoresearch");
    try {
      if (fs.existsSync(autoresearchDir)) {
        const entries = fs.readdirSync(autoresearchDir);
        if (entries.length === 0) {
          fs.rmdirSync(autoresearchDir);
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  } catch {
    // Ignore errors during cleanup
  }
}

/** Get protected autoresearch files that should not be reverted */
export function getProtectedFiles(): string[] {
  return [
    "autoresearch.jsonl",
    "autoresearch.md",
    "autoresearch.ideas.md",
    "autoresearch.sh",
    "autoresearch.checks.sh",
  ];
}
