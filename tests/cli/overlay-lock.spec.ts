import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { writeOverlayFixture } from '../helpers/overlay-fixture.js';

describe('CLI lock never outranks the effective manifest', () => {
  let tempHome: string;
  const envctl = () => path.join(tempHome, 'envctl');
  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], {
      stdout: (chunk) => { stdout += chunk; },
      stderr: (chunk) => { stderr += chunk; }
    });
    return { code, stdout, stderr };
  };
  const planOps = async (args: string[]) => {
    const { stdout } = await run([...args, 'plan', '--json']);
    return (JSON.parse(stdout) as { operations: Array<Record<string, unknown>> }).operations;
  };
  const writeLock = (plugins: Record<string, unknown>) =>
    fs.writeFileSync(path.join(envctl(), 'lock.json'), JSON.stringify({ apiVersion: 'dshenv-lock/v1', profiles: { web: { plugins } } }));
  const overrideSharedVersion = (version: string) =>
    fs.appendFileSync(
      path.join(envctl(), 'overlays', 'laptop.yaml'),
      `      shared:\n        source: { type: npm, version: "${version}" }\n`
    );

  beforeEach(() => {
    delete process.env.DSHENV_OVERLAY;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-overlay-lock-'));
    writeOverlayFixture(tempHome);
    writeLock({ shared: { package: 'shared-plugin', source: { type: 'npm', resolvedVersion: '1.0.0' } } });
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('plans the overlay version when the lock holds the base version', async () => {
    overrideSharedVersion('1.5.0');
    const ops = await planOps(['--overlay', 'laptop']);
    expect(ops).toContainEqual(expect.objectContaining({ kind: 'update', alias: 'shared', targetVersion: '1.5.0' }));
  });

  it('does not leak an overlay update into a base-only plan', async () => {
    expect((await run(['--overlay', 'laptop', 'update', 'shared', '-p', 'web', '--to', '1.1.0', '--layer', 'overlay'])).code).toBe(0);
    const ops = await planOps(['--no-overlay']);
    expect(ops.filter((op) => op.alias === 'shared')).toEqual([]);
  });

  it('keeps the overlay version after a base update', async () => {
    overrideSharedVersion('1.5.0');
    expect((await run(['--overlay', 'laptop', 'update', 'shared', '-p', 'web', '--to', '9.9.9', '--layer', 'base'])).code).toBe(0);
    const ops = await planOps(['--overlay', 'laptop']);
    expect(ops).toContainEqual(expect.objectContaining({ kind: 'update', alias: 'shared', targetVersion: '1.5.0' }));
  });

  it('blocks an overlay git url instead of reusing the commit locked for another url', async () => {
    fs.appendFileSync(
      path.join(envctl(), 'manifest.yaml'),
      '      gitty:\n        package: gitty-plugin\n        source: { type: git, url: "https://example.com/gitty.git" }\n'
    );
    fs.appendFileSync(
      path.join(envctl(), 'overlays', 'laptop.yaml'),
      '      gitty:\n        source: { type: git, url: "https://example.com/fork.git" }\n'
    );
    writeLock({ gitty: { package: 'gitty-plugin', source: { type: 'git', url: 'https://example.com/gitty.git', commit: 'abcdef1234567' } } });
    const { code, stdout } = await run(['--overlay', 'laptop', 'plan', '--json']);
    expect(code).toBe(5);
    expect(stdout).not.toContain('abcdef1234567');
    const ops = (JSON.parse(stdout) as { operations: Array<Record<string, unknown>> }).operations;
    expect(ops).toContainEqual(expect.objectContaining({ kind: 'blocked', alias: 'gitty' }));
  });
});
