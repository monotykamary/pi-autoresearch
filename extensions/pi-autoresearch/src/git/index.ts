/**
 * Git worktree management for autoresearch isolation
 */

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutoresearchRuntime, AutoresearchConfig } from "../types/index.js";

/** Get the path to the global gitignore file */
function getGlobalGitignorePath(): string | null {
  try {
    // Check if core.excludesfile is set
    const result = execSync("git config --global core.excludesfile", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const configured = result.trim();
    if (configured) return configured;
  } catch {
    // Not configured, fall through to default
  }

  // Default locations by platform
  // Check env vars first (allows testing with fake home), then os.homedir()
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const candidates = [
    path.join(home, ".gitignore"),
    path.join(home, ".gitignore_global"),
    path.join(home, ".config", "git", "ignore"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Default to ~/.gitignore if nothing exists
  return path.join(home, ".gitignore");
}

/** Ensure autoresearch/ is in the global gitignore */
function ensureGlobalGitignore(): void {
  try {
    const gitignorePath = getGlobalGitignorePath();
    if (!gitignorePath) return;

    const pattern = "autoresearch/";
    let content = "";

    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, "utf-8");
      // Already present?
      if (content.split(/\r?\n/).some((line) => line.trim() === pattern)) {
        return;
      }
    }

    // Ensure parent directory exists
    const parentDir = path.dirname(gitignorePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // Append with a comment
    const entry = content.endsWith("\n") || content === ""
      ? `# pi-autoresearch worktrees\n${pattern}\n`
      : `\n# pi-autoresearch worktrees\n${pattern}\n`;

    fs.appendFileSync(gitignorePath, entry, "utf-8");
  } catch {
    // Silently fail — this is a convenience, not a requirement
  }
}

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

/** Detect autoresearch worktree by looking for autoresearch.jsonl in git worktrees */
export function detectAutoresearchWorktree(ctxCwd: string, sessionId?: string): string | null {
  try {
    // List all worktrees
    const output = execSync("git worktree list --porcelain", {
      cwd: ctxCwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });

    const lines = output.trim().split("\n");
    for (const line of lines) {
      // Porcelain format: "worktree <path>"
      if (line.startsWith("worktree ")) {
        const worktreePath = line.slice(9).trim();
        
        // If sessionId provided, only match worktrees for that session
        if (sessionId) {
          const expectedSuffix = path.join("autoresearch", sessionId);
          if (!worktreePath.endsWith(expectedSuffix)) {
            continue;  // Skip worktrees for other sessions
          }
        }
        
        // Check if this worktree has autoresearch.jsonl
        const jsonlPath = path.join(worktreePath, "autoresearch.jsonl");
        if (fs.existsSync(jsonlPath)) {
          return worktreePath;
        }
      }
    }
  } catch {
    // Git command failed or no worktrees
  }
  return null;
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

    // Ensure global gitignore ignores autoresearch worktrees
    ensureGlobalGitignore();

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
