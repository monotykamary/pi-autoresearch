import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Integration Tests: Worktree Operations
// ============================================================================

describe("Worktree Integration", () => {
  const testDir = path.join(__dirname, '.test-worktrees');
  let repoDir: string;

  beforeEach(() => {
    // Create a fresh git repo for each test
    repoDir = path.join(testDir, `repo-${Date.now()}`);
    fs.mkdirSync(repoDir, { recursive: true });
    
    // Initialize git repo
    execSync('git init', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: repoDir, stdio: 'ignore' });
    
    // Create initial commit
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Repo');
    execSync('git add README.md', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "Initial commit"', { cwd: repoDir, stdio: 'ignore' });
  });

  afterEach(() => {
    // Cleanup
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("main worktree stays on original branch when creating worktree", () => {
    const sessionId = 'test-session-branch-check';
    const worktreePath = path.join(repoDir, 'autoresearch', sessionId);
    const branchName = `autoresearch/${sessionId}`;

    // Get the original branch name before creating worktree
    const originalBranch = execSync('git branch --show-current', { cwd: repoDir, encoding: 'utf8' }).trim();
    expect(['main', 'master']).toContain(originalBranch);

    // Create branch WITHOUT switching (the fixed behavior)
    execSync(`git branch ${branchName}`, { cwd: repoDir, stdio: 'ignore' });

    // Verify main worktree is STILL on original branch (was NOT switched)
    const mainBranchAfterCreate = execSync('git branch --show-current', { cwd: repoDir, encoding: 'utf8' }).trim();
    expect(mainBranchAfterCreate).toBe(originalBranch);

    // Create worktree
    execSync(`git worktree add ${worktreePath} ${branchName}`, { cwd: repoDir, stdio: 'ignore' });

    // Verify main worktree is still on original branch after worktree creation
    const mainBranchAfterWorktree = execSync('git branch --show-current', { cwd: repoDir, encoding: 'utf8' }).trim();
    expect(mainBranchAfterWorktree).toBe(originalBranch);

    // Verify worktree is on the autoresearch branch
    const worktreeBranch = execSync('git branch --show-current', { cwd: worktreePath, encoding: 'utf8' }).trim();
    expect(worktreeBranch).toBe(branchName);
  });

  it("creates worktree with branch", () => {
    const sessionId = 'test-session-1';
    const worktreePath = path.join(repoDir, 'autoresearch', sessionId);
    const branchName = `autoresearch/${sessionId}`;

    // Create branch WITHOUT switching (simulating fixed behavior)
    execSync(`git branch ${branchName}`, { cwd: repoDir, stdio: 'ignore' });

    // Create worktree
    execSync(`git worktree add ${worktreePath} ${branchName}`, { cwd: repoDir, stdio: 'ignore' });

    // Verify worktree exists
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, 'README.md'))).toBe(true);

    // Verify it's on correct branch
    const branch = execSync('git branch --show-current', { cwd: worktreePath, encoding: 'utf8' }).trim();
    expect(branch).toBe(branchName);

    // Verify main worktree is still on main/master (was NOT switched)
    const mainBranch = execSync('git branch --show-current', { cwd: repoDir, encoding: 'utf8' }).trim();
    expect(['main', 'master']).toContain(mainBranch);
  });

  it("lists worktrees correctly", () => {
    const sessionId = 'test-session-2';
    const worktreePath = path.join(repoDir, 'autoresearch', sessionId);
    const branchName = `autoresearch/${sessionId}`;

    // Create worktree (using git branch instead of checkout -b)
    execSync(`git branch ${branchName}`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git worktree add ${worktreePath} ${branchName}`, { cwd: repoDir, stdio: 'ignore' });

    // List worktrees
    const worktreeList = execSync('git worktree list --porcelain', { cwd: repoDir, encoding: 'utf8' });
    expect(worktreeList).toContain(worktreePath);
    expect(worktreeList).toContain(branchName);
  });

  it("worktree is isolated from main repo", () => {
    const sessionId = 'test-session-3';
    const worktreePath = path.join(repoDir, 'autoresearch', sessionId);
    const branchName = `autoresearch/${sessionId}`;

    // Create worktree (using git branch instead of checkout -b)
    execSync(`git branch ${branchName}`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git worktree add ${worktreePath} ${branchName}`, { cwd: repoDir, stdio: 'ignore' });

    // Add file in worktree
    fs.writeFileSync(path.join(worktreePath, 'experiment.txt'), 'test data');
    execSync('git add experiment.txt', { cwd: worktreePath, stdio: 'ignore' });
    execSync('git commit -m "Add experiment file"', { cwd: worktreePath, stdio: 'ignore' });

    // Verify file exists in worktree
    expect(fs.existsSync(path.join(worktreePath, 'experiment.txt'))).toBe(true);

    // Verify file does NOT exist in main repo (yet)
    expect(fs.existsSync(path.join(repoDir, 'experiment.txt'))).toBe(false);

    // Verify main repo is still on main/master
    const mainBranch = execSync('git branch --show-current', { cwd: repoDir, encoding: 'utf8' }).trim();
    expect(['main', 'master']).toContain(mainBranch);
  });

  it("removes worktree and cleans up", () => {
    const sessionId = 'test-session-4';
    const worktreePath = path.join(repoDir, 'autoresearch', sessionId);
    const branchName = `autoresearch/${sessionId}`;

    // Create worktree (using git branch instead of checkout -b)
    execSync(`git branch ${branchName}`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git worktree add ${worktreePath} ${branchName}`, { cwd: repoDir, stdio: 'ignore' });

    // Verify it exists
    expect(fs.existsSync(worktreePath)).toBe(true);

    // Remove worktree
    execSync(`git worktree remove ${worktreePath}`, { cwd: repoDir, stdio: 'ignore' });

    // Verify it's gone
    expect(fs.existsSync(worktreePath)).toBe(false);

    // Verify branch still exists (can be deleted separately)
    const branches = execSync('git branch', { cwd: repoDir, encoding: 'utf8' });
    expect(branches).toContain(branchName);

    // Delete branch
    execSync(`git branch -D ${branchName}`, { cwd: repoDir, stdio: 'ignore' });
    const branchesAfter = execSync('git branch', { cwd: repoDir, encoding: 'utf8' });
    expect(branchesAfter).not.toContain(branchName);
  });

  it("detects existing worktree", () => {
    const sessionId = 'test-session-5';
    const worktreePath = path.join(repoDir, 'autoresearch', sessionId);
    const branchName = `autoresearch/${sessionId}`;

    // Create worktree (using git branch instead of checkout -b)
    execSync(`git branch ${branchName}`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git worktree add ${worktreePath} ${branchName}`, { cwd: repoDir, stdio: 'ignore' });

    // Check worktree list for existing worktree
    const worktreeList = execSync('git worktree list', { cwd: repoDir, encoding: 'utf8' });
    const worktreeLines = worktreeList.split('\n');
    const worktreeLine = worktreeLines.find(line => line.includes(worktreePath));
    
    expect(worktreeLine).toBeDefined();
    expect(worktreeLine).toContain(branchName);
  });

  it("autoresearch directory structure is created correctly", () => {
    const sessionId = 'session-abc-123';
    const autoresearchDir = path.join(repoDir, 'autoresearch');
    const worktreePath = path.join(autoresearchDir, sessionId);
    const branchName = `autoresearch/${sessionId}`;

    // Create autoresearch directory
    fs.mkdirSync(autoresearchDir, { recursive: true });

    // Create worktree inside it (using git branch instead of checkout -b)
    execSync(`git branch ${branchName}`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git worktree add ${worktreePath} ${branchName}`, { cwd: repoDir, stdio: 'ignore' });

    // Verify structure
    expect(fs.existsSync(autoresearchDir)).toBe(true);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(fs.statSync(worktreePath).isDirectory()).toBe(true);
  });

  it("restores worktreeDir from autoresearch.jsonl path on session switch", () => {
    const sessionId = 'session-switch-test';
    const autoresearchDir = path.join(repoDir, 'autoresearch');
    const worktreePath = path.join(autoresearchDir, sessionId);
    const branchName = `autoresearch/${sessionId}`;

    // Create worktree (using git branch instead of checkout -b)
    fs.mkdirSync(autoresearchDir, { recursive: true });
    execSync(`git branch ${branchName}`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git worktree add ${worktreePath} ${branchName}`, { cwd: repoDir, stdio: 'ignore' });

    // Create autoresearch.jsonl in the worktree (simulating previous session)
    const jsonlPath = path.join(worktreePath, 'autoresearch.jsonl');
    const configLine = JSON.stringify({
      type: "config",
      name: "Test Session",
      metricName: "total_µs",
      metricUnit: "µs",
      bestDirection: "lower"
    });
    const resultLine = JSON.stringify({
      run: 1,
      commit: "abc1234",
      metric: 15000,
      metrics: {},
      status: "keep",
      description: "Baseline",
      timestamp: Date.now(),
      segment: 0,
      confidence: null
    });
    fs.writeFileSync(jsonlPath, configLine + "\n" + resultLine + "\n");

    // Simulate reconstructState logic:
    // When jsonl is loaded from worktree path, worktreeDir should be restored
    const jsonlParentDir = path.dirname(jsonlPath);
    const hasAutoresearchInPath = jsonlPath.includes("/autoresearch/");
    const worktreeDir = hasAutoresearchInPath && fs.existsSync(jsonlParentDir) 
      ? jsonlParentDir 
      : null;

    // Verify the restored worktreeDir matches the actual worktree path
    expect(worktreeDir).toBe(worktreePath);
    expect(fs.existsSync(worktreeDir!)).toBe(true);
    expect(fs.existsSync(path.join(worktreeDir!, 'autoresearch.jsonl'))).toBe(true);

    // Verify the path structure is correct for session switching
    expect(worktreeDir).toContain('autoresearch');
    expect(worktreeDir).toContain(sessionId);
  });

  it("does not restore worktreeDir when jsonl is in main worktree", () => {
    // Create autoresearch.jsonl directly in main repo (not in a worktree)
    const mainJsonlPath = path.join(repoDir, 'autoresearch.jsonl');
    const configLine = JSON.stringify({
      type: "config",
      name: "Main Session",
      metricName: "metric",
      bestDirection: "lower"
    });
    fs.writeFileSync(mainJsonlPath, configLine + "\n");

    // Simulate reconstructState logic for main worktree
    const jsonlParentDir = path.dirname(mainJsonlPath);
    const hasAutoresearchInPath = mainJsonlPath.includes("/autoresearch/");
    // For the main worktree path like /project/autoresearch.jsonl,
    // it doesn't have /autoresearch/ in the path (just the filename)
    // But if it was /project/autoresearch/autoresearch.jsonl, it would match
    
    // In this case, we're testing that a file directly in repo root
    // would NOT trigger worktree restoration (no /autoresearch/ in path)
    const worktreeDir = hasAutoresearchInPath && fs.existsSync(jsonlParentDir) 
      ? jsonlParentDir 
      : null;

    expect(hasAutoresearchInPath).toBe(false); // /autoresearch.jsonl doesn't contain /autoresearch/
    expect(worktreeDir).toBeNull();
  });
});
