import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

describe('CLI writes never leave an unloadable manifest', () => {
  let tempHome: string;
  const manifestFile = () => path.join(tempHome, 'envctl', 'manifest.yaml');
  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], {
      stdout: (chunk) => { stdout += chunk; },
      stderr: (chunk) => { stderr += chunk; }
    });
    return { code, stdout, stderr };
  };

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-valid-'));
    const profileDir = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(path.join(profileDir, 'node_modules', 'dsh-plugin-foo'), { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, 'node_modules', 'dsh-plugin-foo', 'package.json'),
      JSON.stringify({ name: 'dsh-plugin-foo', version: '1.0.0' })
    );
    fs.writeFileSync(
      path.join(profileDir, 'package.json'),
      JSON.stringify({ dependencies: { 'dsh-plugin-foo': '1.0.0' }, dsh: { profile: { bundles: ['dsh-plugin-foo'] } } })
    );
    await run(['init']);
    await run(['install', 'dsh-plugin-foo@1.0.0', '--profile', 'web']);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('refuses to install the same package under a second alias', async () => {
    const before = fs.readFileSync(manifestFile(), 'utf8');
    const { code, stderr } = await run(['install', 'dsh-plugin-foo@1.0.0', '--profile', 'web', '--as', 'bar']);
    expect(code).toBe(3);
    expect(stderr).toMatch(/Duplicate package "dsh-plugin-foo"/);
    expect(fs.readFileSync(manifestFile(), 'utf8')).toBe(before);
    expect((await run(['list'])).code).toBe(0);
  });

  it('refuses a local path whose directory name is not a valid package name', async () => {
    const before = fs.readFileSync(manifestFile(), 'utf8');
    const { code } = await run(['install', path.join(tempHome, 'My Plugin'), '--profile', 'web']);
    expect(code).toBe(3);
    expect(fs.readFileSync(manifestFile(), 'utf8')).toBe(before);
  });
});
