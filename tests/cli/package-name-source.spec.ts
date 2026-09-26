import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execa } from 'execa';
import * as YAML from 'yaml';
import { runCli } from '../../src/cli.js';

describe('package names come from the source when it can be read', () => {
  let tempHome: string;
  const run = async (args: string[]) => {
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], { stdout: () => {}, stderr: (chunk) => { stderr += chunk; } });
    return { code, stderr };
  };
  const plugins = () => YAML.parse(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8')).profiles?.web?.plugins ?? {};
  const makeSource = (dir: string, name?: string) => {
    fs.mkdirSync(dir, { recursive: true });
    if (name) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  };

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-pkgname-'));
    await run(['init']);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('reads the package name of a local directory', async () => {
    const dir = path.join(tempHome, 'src', 'foo-src');
    makeSource(dir, '@me/foo');
    expect((await run(['install', dir, '--profile', 'web'])).code).toBe(0);
    expect(plugins()['foo-src']).toMatchObject({ package: '@me/foo', source: { type: 'local-link', path: dir } });
  });

  it('falls back to the directory name when there is no package.json', async () => {
    const dir = path.join(tempHome, 'src', 'bare-plugin');
    makeSource(dir);
    expect((await run(['install', dir, '--profile', 'web'])).code).toBe(0);
    expect(plugins()['bare-plugin'].package).toBe('bare-plugin');
  });

  it('takes --package for a git URL and rejects it for npm specs', async () => {
    expect((await run(['install', 'https://example.com/x/foo-repo.git#abc1234', '--profile', 'web', '--package', '@me/foo'])).code).toBe(0);
    expect(plugins()['foo-repo'].package).toBe('@me/foo');
    const npm = await run(['install', 'demo-plugin@1.0.0', '--profile', 'web', '--package', 'other']);
    expect(npm.code).toBe(3);
    expect(npm.stderr).toMatch(/--package only applies to git and local sources/);
  });

  it('names a managed clone after the package.json in the repository', async () => {
    const upstream = path.join(tempHome, 'upstream', 'demo-repo');
    makeSource(upstream, '@me/demo');
    await execa('git', ['init', '-q'], { cwd: upstream });
    await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'init', '--allow-empty'], { cwd: upstream });
    await execa('git', ['add', '.'], { cwd: upstream });
    await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'pkg'], { cwd: upstream });

    expect((await run(['source', 'clone', upstream, '--profile', 'web'])).code).toBe(0);
    expect(plugins()['demo-repo'].package).toBe('@me/demo');
    expect(fs.readdirSync(path.join(tempHome, 'envctl', 'sources', 'web'))).toEqual(['@me_demo']);
    expect(fs.readdirSync(path.join(tempHome, 'envctl', 'sources')).filter((name) => name.startsWith('.'))).toEqual([]);
  });
});
