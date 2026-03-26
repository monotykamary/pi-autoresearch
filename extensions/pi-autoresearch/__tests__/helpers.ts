/**
 * Shared test utilities and helpers
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

/**
 * Create a temporary directory for tests
 */
export function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Create a fresh git repository for testing
 */
export function createTestRepo(parentDir: string): string {
  const repoDir = path.join(parentDir, `repo-${Date.now()}`);
  fs.mkdirSync(repoDir, { recursive: true });

  execSync('git init', { cwd: repoDir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'ignore' });
  execSync('git config user.name "Test User"', { cwd: repoDir, stdio: 'ignore' });

  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Repo');
  execSync('git add README.md', { cwd: repoDir, stdio: 'ignore' });
  execSync('git commit -m "Initial commit"', { cwd: repoDir, stdio: 'ignore' });

  return repoDir;
}

/**
 * Clean up test directories
 */
export function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Get current git branch name
 */
export function getCurrentBranch(repoDir: string): string {
  return execSync('git branch --show-current', { cwd: repoDir, encoding: 'utf8' }).trim();
}

/**
 * Create a file with content in a directory
 */
export function writeFile(dir: string, filename: string, content: string): void {
  fs.writeFileSync(path.join(dir, filename), content);
}

/**
 * Check if a path exists
 */
export function pathExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make a commit in a git repo
 */
export function makeCommit(
  repoDir: string,
  message: string,
  files?: Record<string, string>
): string {
  if (files) {
    for (const [filename, content] of Object.entries(files)) {
      writeFile(repoDir, filename, content);
      execSync(`git add "${filename}"`, { cwd: repoDir, stdio: 'ignore' });
    }
  }
  execSync(`git commit -m "${message}" --allow-empty`, { cwd: repoDir, stdio: 'ignore' });
  return execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();
}

/**
 * Create a worktree branch and worktree directory
 */
export function createWorktree(
  repoDir: string,
  sessionId: string
): { branchName: string; worktreePath: string } {
  const branchName = `autoresearch/${sessionId}`;
  const worktreePath = path.join(repoDir, 'autoresearch', sessionId);

  execSync(`git branch "${branchName}"`, { cwd: repoDir, stdio: 'ignore' });
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execSync(`git worktree add "${worktreePath}" "${branchName}"`, { cwd: repoDir, stdio: 'ignore' });

  return { branchName, worktreePath };
}

/**
 * Extension path for loading the extension
 */
export const EXTENSION_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'index.ts'
);
