/**
 * Integration tests for worktree and git operations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

// ============================================================================
// Worktree Integration Tests
// ============================================================================
describe('Worktree Integration', () => {
  let testDir: string;
  let repoDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-worktree-'));
    repoDir = path.join(testDir, `repo-${Date.now()}`);
    fs.mkdirSync(repoDir, { recursive: true });

    execSync('git init', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: repoDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Repo');
    execSync('git add README.md', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "Initial commit"', { cwd: repoDir, stdio: 'ignore' });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('main worktree stays on original branch when creating worktree', () => {
    const sessionId = 'test-session-branch-check';
    const worktreePath = path.join(repoDir, 'autoresearch', sessionId);
    const branchName = `autoresearch/${sessionId}`;

    const originalBranch = execSync('git branch --show-current', {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();
    expect(['main', 'master']).toContain(originalBranch);

    execSync(`git branch ${branchName}`, { cwd: repoDir, stdio: 'ignore' });

    const mainBranchAfterCreate = execSync('git branch --show-current', {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();
    expect(mainBranchAfterCreate).toBe(originalBranch);

    execSync(`git worktree add ${worktreePath} ${branchName}`, { cwd: repoDir, stdio: 'ignore' });

    const mainBranchAfterWorktree = execSync('git branch --show-current', {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();
    expect(mainBranchAfterWorktree).toBe(originalBranch);

    const worktreeBranch = execSync('git branch --show-current', {
      cwd: worktreePath,
      encoding: 'utf8',
    }).trim();
    expect(worktreeBranch).toBe(branchName);
  });

  it('creates worktree with branch', () => {
    const sessionId = 'test-session-1';
    const worktreePath = path.join(repoDir, 'autoresearch', sessionId);
    const branchName = `autoresearch/${sessionId}`;

    execSync(`git branch ${branchName}`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git worktree add ${worktreePath} ${branchName}`, { cwd: repoDir, stdio: 'ignore' });

    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, '.git'))).toBe(true);

    const worktreeGit = fs.readFileSync(path.join(worktreePath, '.git'), 'utf-8');
    expect(worktreeGit).toContain('gitdir');

    const branch = execSync('git branch --show-current', {
      cwd: worktreePath,
      encoding: 'utf8',
    }).trim();
    expect(branch).toBe(branchName);
  });

  it('removes worktree and branch on cleanup', () => {
    const sessionId = 'test-session-cleanup';
    const worktreePath = path.join(repoDir, 'autoresearch', sessionId);
    const branchName = `autoresearch/${sessionId}`;

    execSync(`git branch ${branchName}`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git worktree add ${worktreePath} ${branchName}`, { cwd: repoDir, stdio: 'ignore' });

    expect(fs.existsSync(worktreePath)).toBe(true);

    execSync(`git worktree remove ${worktreePath}`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git branch -D ${branchName}`, { cwd: repoDir, stdio: 'ignore' });

    expect(fs.existsSync(worktreePath)).toBe(false);

    const branches = execSync('git branch -a', { cwd: repoDir, encoding: 'utf8' });
    expect(branches).not.toContain(branchName);
  });

  it('worktree has independent working directory', () => {
    const sessionId = 'test-session-isolate';
    const worktreePath = path.join(repoDir, 'autoresearch', sessionId);
    const branchName = `autoresearch/${sessionId}`;

    execSync(`git branch ${branchName}`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git worktree add ${worktreePath} ${branchName}`, { cwd: repoDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(worktreePath, 'worktree-only.txt'), 'in worktree');
    expect(fs.existsSync(path.join(repoDir, 'worktree-only.txt'))).toBe(false);

    fs.writeFileSync(path.join(repoDir, 'main-only.txt'), 'in main');
    expect(fs.existsSync(path.join(worktreePath, 'main-only.txt'))).toBe(false);
  });

  it('worktree shares git history with main repo', () => {
    const sessionId = 'test-session-history';
    const worktreePath = path.join(repoDir, 'autoresearch', sessionId);
    const branchName = `autoresearch/${sessionId}`;

    execSync(`git branch ${branchName}`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git worktree add ${worktreePath} ${branchName}`, { cwd: repoDir, stdio: 'ignore' });

    const mainLog = execSync('git log --oneline', { cwd: repoDir, encoding: 'utf8' });
    const worktreeLog = execSync('git log --oneline', { cwd: worktreePath, encoding: 'utf8' });

    expect(worktreeLog).toBe(mainLog);
  });
});

// ============================================================================
// Global Gitignore Integration Tests
// ============================================================================
describe('Global Gitignore Integration', () => {
  let testDir: string;
  let repoDir: string;
  let globalGitignorePath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-gitignore-'));
    repoDir = path.join(testDir, `repo-${Date.now()}`);
    fs.mkdirSync(repoDir, { recursive: true });

    execSync('git init', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: repoDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Repo');
    execSync('git add README.md', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "Initial commit"', { cwd: repoDir, stdio: 'ignore' });

    globalGitignorePath = path.join(testDir, 'global-gitignore');
    execSync(`git config --local core.excludesFile ${globalGitignorePath}`, {
      cwd: repoDir,
      stdio: 'ignore',
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('adds autoresearch/ to global gitignore', () => {
    fs.writeFileSync(globalGitignorePath, '');

    const pattern = 'autoresearch/\n';
    fs.appendFileSync(globalGitignorePath, pattern);

    const content = fs.readFileSync(globalGitignorePath, 'utf-8');
    expect(content).toContain('autoresearch/');
  });

  it('prevents duplicate entries in gitignore', () => {
    const pattern = 'autoresearch/\n';
    fs.writeFileSync(globalGitignorePath, pattern);

    const content = fs.readFileSync(globalGitignorePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim() === 'autoresearch/');
    expect(lines.length).toBe(1);
  });

  it('autoresearch directory is ignored by git', () => {
    fs.writeFileSync(globalGitignorePath, 'autoresearch/\n');

    const autoresearchDir = path.join(repoDir, 'autoresearch');
    fs.mkdirSync(autoresearchDir, { recursive: true });
    fs.writeFileSync(path.join(autoresearchDir, 'test.txt'), 'test');

    const status = execSync('git status --porcelain', {
      cwd: repoDir,
      encoding: 'utf8',
    });
    expect(status).not.toContain('autoresearch/');
  });

  it('ignores all autoresearch subdirectories', () => {
    fs.writeFileSync(globalGitignorePath, 'autoresearch/\n');

    const subdirs = ['session-1', 'session-2', 'session-abc123'];
    for (const subdir of subdirs) {
      const dir = path.join(repoDir, 'autoresearch', subdir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'file.txt'), 'test');
    }

    const status = execSync('git status --porcelain', {
      cwd: repoDir,
      encoding: 'utf8',
    });
    expect(status).not.toContain('autoresearch/');
  });
});
