import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execa } from 'execa';
import { runCli } from '../../src/cli.js';
import { loadManifest, loadLock, serializeManifest } from '../../src/manifest/files.js';
import { buildPlan } from '../../src/planner/plan.js';
import { readEnvironmentInventory } from '../../src/inventory/profile-reader.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';

describe('CLI source clone --profile', () => {
  let tempHome: string;
  let upstream: string;

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-src-clone-'));
    upstream = path.join(tempHome, 'upstream', 'demo-plugin');
    fs.mkdirSync(upstream, { recursive: true });
    await execa('git', ['init'], { cwd: upstream });
    await execa('git', ['config', 'user.name', 'Tester'], { cwd: upstream });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: upstream });
    fs.writeFileSync(path.join(upstream, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0', dsh: { bundle: {} } }));
    await execa('git', ['add', '.'], { cwd: upstream });
    await execa('git', ['commit', '-m', 'init'], { cwd: upstream });
    await runCli(['init', '--dsh-home', tempHome]);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should clone into envctl/sources and lock the commit so plan is install not blocked', async () => {
    const code = await runCli([
      'source',
      'clone',
      upstream,
      '--profile',
      'web',
      '--as',
      'demo',
      '--dsh-home',
      tempHome
    ]);
    expect(code).toBe(0);

    const cloneDir = path.join(tempHome, 'envctl', 'sources', 'web', 'demo-plugin');
    expect(fs.existsSync(path.join(cloneDir, 'package.json'))).toBe(true);

    const manifest = loadManifest(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8'));
    expect(manifest.profiles.web.plugins.demo.source.type).toBe('git');

    const lock = loadLock(fs.readFileSync(path.join(tempHome, 'envctl', 'lock.json'), 'utf8'));
    const gitLock = lock.profiles.web.plugins.demo.source;
    expect(gitLock.type).toBe('git');
    if (gitLock.type === 'git') {
      expect(gitLock.commit.length).toBeGreaterThan(6);
    }

    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const inventory = await readEnvironmentInventory(paths);
    const plan = buildPlan(manifest, lock, inventory);
    expect(plan.operations.some((op) => op.kind === 'blocked')).toBe(false);
    expect(plan.operations.some((op) => op.kind === 'install' && op.alias === 'demo')).toBe(true);
  });

  it('should update the lock commit on source pull --profile', async () => {
    await runCli([
      'source', 'clone', upstream, '--profile', 'web', '--as', 'demo', '--dsh-home', tempHome
    ]);
    fs.writeFileSync(path.join(upstream, 'extra.txt'), 'second');
    await execa('git', ['add', '.'], { cwd: upstream });
    await execa('git', ['commit', '-m', 'second'], { cwd: upstream });
    const newHead = (await execa('git', ['rev-parse', 'HEAD'], { cwd: upstream })).stdout.trim();
    const branch = (await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: upstream })).stdout.trim();

    const code = await runCli([
      'source', 'pull', '--profile', 'web', '--as', 'demo', '--ref', `origin/${branch}`, '--dsh-home', tempHome
    ]);
    expect(code).toBe(0);
    const lock = loadLock(fs.readFileSync(path.join(tempHome, 'envctl', 'lock.json'), 'utf8'));
    const gitLock = lock.profiles.web.plugins.demo.source;
    expect(gitLock.type).toBe('git');
    if (gitLock.type === 'git') {
      expect(gitLock.commit).toBe(newHead);
    }
  });

  it('should report the only managed clone via source status --profile', async () => {
    await runCli([
      'source', 'clone', upstream, '--profile', 'web', '--as', 'demo', '--dsh-home', tempHome
    ]);
    let stdout = '';
    const code = await runCli(
      ['source', 'status', '--profile', 'web', '--json', '--dsh-home', tempHome],
      {
        stdout: (chunk) => {
          stdout += chunk;
        },
        stderr: () => {}
      }
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { dir: string; git: { isGitRepo: boolean; isDirty: boolean } };
    expect(parsed.git.isGitRepo).toBe(true);
    expect(parsed.git.isDirty).toBe(false);
    expect(parsed.dir).toContain(`${path.join('envctl', 'sources', 'web', 'demo-plugin')}`);
  });

  it('should require --as when a profile has multiple Git plugins', async () => {
    await runCli([
      'source', 'clone', upstream, '--profile', 'web', '--as', 'demo', '--dsh-home', tempHome
    ]);
    const manifestFile = path.join(tempHome, 'envctl', 'manifest.yaml');
    const manifest = loadManifest(fs.readFileSync(manifestFile, 'utf8'));
    manifest.profiles.web.plugins.other = {
      ...manifest.profiles.web.plugins.demo,
      package: 'other-plugin'
    };
    fs.writeFileSync(manifestFile, serializeManifest(manifest));

    let stderr = '';
    const code = await runCli(
      ['source', 'status', '--profile', 'web', '--dsh-home', tempHome],
      {
        stdout: () => {},
        stderr: (chunk) => {
          stderr += chunk;
        }
      }
    );

    expect(code).toBe(3);
    expect(stderr).toContain('requires --as');
  });

  it('keeps a concurrent clone when a second clone of the same package fails', async () => {
    const run = (args: string[]) => runCli([...args, '--dsh-home', tempHome], { stdout: () => {}, stderr: () => {} });
    const codes = await Promise.all([
      run(['source', 'clone', upstream, '--profile', 'web', '--as', 'demo']),
      run(['source', 'clone', upstream, '--profile', 'web', '--as', 'demo'])
    ]);

    expect(codes.sort()).toEqual([0, 3]);
    expect(fs.existsSync(path.join(tempHome, 'envctl', 'sources', 'web', 'demo-plugin', 'package.json'))).toBe(true);
  });

  it('leaves the manifest untouched when the lock file is corrupt', async () => {
    const manifestFile = path.join(tempHome, 'envctl', 'manifest.yaml');
    const before = fs.readFileSync(manifestFile, 'utf8');
    fs.writeFileSync(path.join(tempHome, 'envctl', 'lock.json'), '{not json');

    const code = await runCli(
      ['source', 'clone', upstream, '--profile', 'web', '--as', 'demo', '--dsh-home', tempHome],
      { stdout: () => {}, stderr: () => {} }
    );

    expect(code).not.toBe(0);
    expect(fs.readFileSync(manifestFile, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(tempHome, 'envctl', 'sources', 'web', 'demo-plugin'))).toBe(false);
  });

  it('puts the manifest back and removes the clone when writing the lock fails', async () => {
    const manifestFile = path.join(tempHome, 'envctl', 'manifest.yaml');
    const lockFile = path.join(tempHome, 'envctl', 'lock.json');
    const before = fs.readFileSync(manifestFile, 'utf8');
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === lockFile) throw new Error('ENOSPC: no space left on device');
      return rename(from, to);
    });
    try {
      const code = await runCli(
        ['source', 'clone', upstream, '--profile', 'web', '--as', 'demo', '--dsh-home', tempHome],
        { stdout: () => {}, stderr: () => {} }
      );
      expect(code).not.toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
    expect(fs.readFileSync(manifestFile, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(tempHome, 'envctl', 'sources', 'web', 'demo-plugin'))).toBe(false);
  });

  it('writes the lock entry on source pull --profile even when the lock has none yet', async () => {
    await runCli(['source', 'clone', upstream, '--profile', 'web', '--as', 'demo', '--dsh-home', tempHome]);
    fs.rmSync(path.join(tempHome, 'envctl', 'lock.json'));
    fs.writeFileSync(path.join(upstream, 'extra.txt'), 'second');
    await execa('git', ['add', '.'], { cwd: upstream });
    await execa('git', ['commit', '-m', 'second'], { cwd: upstream });
    const newHead = (await execa('git', ['rev-parse', 'HEAD'], { cwd: upstream })).stdout.trim();
    const branch = (await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: upstream })).stdout.trim();

    const code = await runCli(
      ['source', 'pull', '--profile', 'web', '--as', 'demo', '--ref', `origin/${branch}`, '--dsh-home', tempHome],
      { stdout: () => {}, stderr: () => {} }
    );
    expect(code).toBe(0);
    const lock = loadLock(fs.readFileSync(path.join(tempHome, 'envctl', 'lock.json'), 'utf8'));
    expect(lock.profiles.web.plugins.demo).toEqual({ package: 'demo-plugin', source: { type: 'git', url: upstream, commit: newHead } });
  });

  it('keeps patches and the enabled state when cloning over an existing alias', async () => {
    const run = (args: string[]) => runCli([...args, '--dsh-home', tempHome], { stdout: () => {}, stderr: () => {} });
    await run(['install', 'demo-plugin@1.0.0', '--profile', 'web', '--as', 'demo']);
    await run(['config', 'set', 'demo', 'mode', 'fast', '--profile', 'web']);
    await run(['disable', 'demo', '--profile', 'web']);

    expect(await run(['source', 'clone', upstream, '--profile', 'web', '--as', 'demo'])).toBe(0);
    const demo = loadManifest(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8')).profiles.web.plugins.demo;
    expect(demo.source.type).toBe('git');
    expect(demo.enabled).toBe(false);
    expect(demo.patches).toEqual([{ id: 'demo', config: { mode: 'fast' } }]);
  });
});
