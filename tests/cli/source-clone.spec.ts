import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    fs.writeFileSync(path.join(upstream, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0' }));
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
});
