import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execa } from 'execa';
import {
  inspectGitWorkingTree,
  resolvePluginSourcePath,
  safeFastForwardManagedGit,
  managedGitSourceDir,
  packageNameFromGitUrl
} from '../../src/source/git.js';

describe('Managed Git Source Lifecycle', () => {
  let tempDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-git-test-'));
    repoDir = path.join(tempDir, 'my-plugin');
    fs.mkdirSync(repoDir, { recursive: true });

    // Initialize git repo
    await execa('git', ['init'], { cwd: repoDir });
    await execa('git', ['config', 'user.name', 'Tester'], { cwd: repoDir });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });

    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'my-plugin', version: '1.0.0', dsh: { bundle: {} } }));
    await execa('git', ['add', '.'], { cwd: repoDir });
    await execa('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should inspect clean git working tree accurately', async () => {
    const status = await inspectGitWorkingTree(repoDir);
    expect(status.isGitRepo).toBe(true);
    expect(status.isDirty).toBe(false);
    expect(status.commit).toBe((await execa('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim());
  });

  it('should detect dirty git working tree and block operations', async () => {
    // Modify file without commit
    fs.writeFileSync(path.join(repoDir, 'uncommitted.txt'), 'dirty content');

    const status = await inspectGitWorkingTree(repoDir);
    expect(status.isGitRepo).toBe(true);
    expect(status.isDirty).toBe(true);

    // Attempting fast-forward or checkout on dirty tree should reject
    await expect(safeFastForwardManagedGit(repoDir, 'HEAD')).rejects.toThrow(/dirty working tree/i);
  });

  it.each(['main', 'origin/main'])('fast-forwards a clone to the upstream commit when given %s', async (ref) => {
    await execa('git', ['branch', '-M', 'main'], { cwd: repoDir });
    const cloneDir = path.join(tempDir, 'clone');
    await execa('git', ['clone', repoDir, cloneDir]);
    fs.writeFileSync(path.join(repoDir, 'index.js'), '// v2\n');
    await execa('git', ['add', '.'], { cwd: repoDir });
    await execa('git', ['commit', '-m', 'v2'], { cwd: repoDir });
    const upstream = (await execa('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();

    const result = await safeFastForwardManagedGit(cloneDir, ref);

    expect(result.newCommit).toBe(upstream);
    expect(result.previousCommit).not.toBe(upstream);
  });

  it.each(['HEAD', 'HEAD~1'])('keeps %s as a revision of the checkout instead of an upstream branch', async (ref) => {
    await execa('git', ['branch', '-M', 'main'], { cwd: repoDir });
    await execa('git', ['branch', 'feature'], { cwd: repoDir });
    const cloneDir = path.join(tempDir, 'clone');
    await execa('git', ['clone', '--branch', 'feature', repoDir, cloneDir]);
    fs.writeFileSync(path.join(cloneDir, 'local.js'), '// local\n');
    await execa('git', ['add', '.'], { cwd: cloneDir });
    await execa('git', ['-c', 'user.name=Tester', '-c', 'user.email=test@example.com', 'commit', '-m', 'local'], { cwd: cloneDir });
    for (const version of ['v2', 'v3']) {
      fs.writeFileSync(path.join(repoDir, 'index.js'), `// ${version}\n`);
      await execa('git', ['add', '.'], { cwd: repoDir });
      await execa('git', ['commit', '-m', version], { cwd: repoDir });
    }
    const checkout = (await execa('git', ['rev-parse', 'HEAD'], { cwd: cloneDir })).stdout.trim();

    // origin/HEAD and origin/HEAD~1 point at the upstream default branch, which is not what the caller asked for.
    const result = await safeFastForwardManagedGit(cloneDir, ref);

    expect(result.newCommit).toBe(checkout);
  });

  it('should resolve managed plugin source path correctly', () => {
    const sourceRoot = '/custom/plugins';
    const resolved = resolvePluginSourcePath('agent-teams', sourceRoot);
    expect(resolved).toBe(path.resolve('/custom/plugins/agent-teams'));
  });

  it('should place managed clones under envctl/sources', () => {
    const dir = managedGitSourceDir('/tmp/dsh/envctl', 'web', '@scope/my-plugin');
    expect(dir).toBe(path.resolve('/tmp/dsh/envctl/sources/web/@scope_my-plugin'));
    expect(packageNameFromGitUrl('https://github.com/ex/my-plugin.git')).toBe('my-plugin');
  });
});
