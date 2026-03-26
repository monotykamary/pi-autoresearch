/**
 * Integration tests for file redirection operations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

describe('File Redirection Integration', () => {
  let testDir: string;
  let repoDir: string;
  let worktreePath: string;
  let mainCwd: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-redirect-'));
    repoDir = path.join(testDir, `repo-${Date.now()}`);
    mainCwd = repoDir;
    fs.mkdirSync(repoDir, { recursive: true });

    execSync('git init', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: repoDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Repo');
    execSync('git add README.md', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "Initial commit"', { cwd: repoDir, stdio: 'ignore' });

    const sessionId = 'test-session-redirect';
    worktreePath = path.join(repoDir, 'autoresearch', sessionId);
    const branchName = `autoresearch/${sessionId}`;

    fs.mkdirSync(path.join(repoDir, 'autoresearch'), { recursive: true });
    execSync(`git branch ${branchName}`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git worktree add ${worktreePath} ${branchName}`, { cwd: repoDir, stdio: 'ignore' });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('writes files to worktree when autoresearch is ON', async () => {
    const { createWriteOperations } = await import('../../src/tools/file-redirect.js');

    const runtime = {
      autoresearchMode: true,
      worktreeDir: worktreePath,
    };

    const ops = createWriteOperations(mainCwd, runtime);
    await ops.writeFile('src/test.ts', 'export const foo = 42;');

    const worktreeFile = path.join(worktreePath, 'src', 'test.ts');
    const mainRepoFile = path.join(mainCwd, 'src', 'test.ts');

    expect(fs.existsSync(worktreeFile)).toBe(true);
    expect(fs.existsSync(mainRepoFile)).toBe(false);

    const content = fs.readFileSync(worktreeFile, 'utf-8');
    expect(content).toBe('export const foo = 42;');
  });

  it('writes files to main repo when autoresearch is OFF', async () => {
    const { createWriteOperations } = await import('../../src/tools/file-redirect.js');

    const runtime = {
      autoresearchMode: false,
      worktreeDir: null,
    };

    const ops = createWriteOperations(mainCwd, runtime);
    await ops.writeFile('src/main.ts', 'export const bar = "hello";');

    const mainRepoFile = path.join(mainCwd, 'src', 'main.ts');
    expect(fs.existsSync(mainRepoFile)).toBe(true);

    const content = fs.readFileSync(mainRepoFile, 'utf-8');
    expect(content).toBe('export const bar = "hello";');
  });

  it('reads files from worktree when autoresearch is ON', async () => {
    const { createReadOperations } = await import('../../src/tools/file-redirect.js');

    const runtime = {
      autoresearchMode: true,
      worktreeDir: worktreePath,
    };

    fs.mkdirSync(path.join(worktreePath, 'data'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, 'data', 'config.json'), '{"key": "worktree-value"}');

    const ops = createReadOperations(mainCwd, runtime);
    const content = await ops.readFile('data/config.json');
    expect(content.toString()).toBe('{"key": "worktree-value"}');
  });

  it('reads files from main repo when autoresearch is OFF', async () => {
    const { createReadOperations } = await import('../../src/tools/file-redirect.js');

    const runtime = {
      autoresearchMode: false,
      worktreeDir: null,
    };

    fs.mkdirSync(path.join(mainCwd, 'data'), { recursive: true });
    fs.writeFileSync(path.join(mainCwd, 'data', 'config.json'), '{"key": "main-value"}');

    const ops = createReadOperations(mainCwd, runtime);
    const content = await ops.readFile('data/config.json');
    expect(content.toString()).toBe('{"key": "main-value"}');
  });

  it('edit operations redirect to worktree', async () => {
    const { createEditOperations } = await import('../../src/tools/file-redirect.js');

    const runtime = {
      autoresearchMode: true,
      worktreeDir: worktreePath,
    };

    fs.mkdirSync(path.join(worktreePath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, 'src', 'app.ts'), 'const x = 1;');
    fs.mkdirSync(path.join(mainCwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(mainCwd, 'src', 'app.ts'), 'const x = 1;');

    const ops = createEditOperations(mainCwd, runtime);
    const original = await ops.readFile('src/app.ts');
    expect(original.toString()).toBe('const x = 1;');

    const absolutePath = path.join(mainCwd, 'src', 'app.ts');
    await ops.writeFile(absolutePath, 'const x = 2;');

    const worktreeContent = fs.readFileSync(path.join(worktreePath, 'src', 'app.ts'), 'utf-8');
    const mainRepoContent = fs.readFileSync(path.join(mainCwd, 'src', 'app.ts'), 'utf-8');

    expect(worktreeContent).toBe('const x = 2;');
    expect(mainRepoContent).toBe('const x = 1;');
  });

  it('mkdir creates directories in worktree', async () => {
    const { createWriteOperations } = await import('../../src/tools/file-redirect.js');

    const runtime = {
      autoresearchMode: true,
      worktreeDir: worktreePath,
    };

    const ops = createWriteOperations(mainCwd, runtime);
    await ops.mkdir('very/deep/nested/dir');

    const worktreeDir = path.join(worktreePath, 'very', 'deep', 'nested', 'dir');
    expect(fs.existsSync(worktreeDir)).toBe(true);
    expect(fs.statSync(worktreeDir).isDirectory()).toBe(true);

    const mainRepoDir = path.join(mainCwd, 'very', 'deep', 'nested', 'dir');
    expect(fs.existsSync(mainRepoDir)).toBe(false);
  });

  it('external paths are not redirected', async () => {
    const { createWriteOperations } = await import('../../src/tools/file-redirect.js');

    const runtime = {
      autoresearchMode: true,
      worktreeDir: worktreePath,
    };

    const ops = createWriteOperations(mainCwd, runtime);
    const externalDir = path.join(testDir, 'external-location');
    fs.mkdirSync(externalDir, { recursive: true });
    const externalFile = path.join(externalDir, 'outside.txt');

    await ops.writeFile(externalFile, 'external content');

    expect(fs.existsSync(externalFile)).toBe(true);
    expect(fs.readFileSync(externalFile, 'utf-8')).toBe('external content');

    const worktreeVersion = path.join(worktreePath, 'external-location', 'outside.txt');
    expect(fs.existsSync(worktreeVersion)).toBe(false);
  });

  it('access checks work in worktree', async () => {
    const { createReadOperations } = await import('../../src/tools/file-redirect.js');

    const runtime = {
      autoresearchMode: true,
      worktreeDir: worktreePath,
    };

    fs.writeFileSync(path.join(worktreePath, 'readable.txt'), 'can read this');

    const ops = createReadOperations(mainCwd, runtime);
    await expect(ops.access('readable.txt')).resolves.toBeUndefined();
    await expect(ops.access('nonexistent.txt')).rejects.toThrow();
  });
});
