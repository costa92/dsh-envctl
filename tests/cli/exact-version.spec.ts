import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

describe('CLI exact npm versions', () => {
  let tempHome: string;
  const manifestFile = () => path.join(tempHome, 'envctl', 'manifest.yaml');
  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], {
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: (chunk) => {
        stderr += chunk;
      }
    });
    return { code, stdout, stderr };
  };

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-exact-'));
    await run(['init']);
    await run(['install', 'demo-plugin@1.0.0', '--profile', 'web']);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it.each([['demo-other'], ['demo-other@^1.0.0'], ['demo-other@latest']])(
    'refuses install %s without an exact version and leaves the manifest unchanged',
    async (spec) => {
      const before = fs.readFileSync(manifestFile(), 'utf8');
      const { code, stderr } = await run(['install', spec, '--profile', 'web']);
      expect(code).toBe(3);
      expect(stderr).toMatch(/needs an exact version: demo-other@<x\.y\.z>/);
      expect(fs.readFileSync(manifestFile(), 'utf8')).toBe(before);
    }
  );

  it('refuses update --to with a range', async () => {
    const before = fs.readFileSync(manifestFile(), 'utf8');
    const { code, stderr } = await run(['update', 'demo-plugin', '--profile', 'web', '--to', '^2.0.0']);
    expect(code).toBe(3);
    expect(stderr).toMatch(/--to must be an exact version such as 1\.2\.3/);
    expect(fs.readFileSync(manifestFile(), 'utf8')).toBe(before);
  });

  it('skips declared-but-missing packages whose spec is a range when capturing', async () => {
    const profileDir = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, 'package.json'),
      JSON.stringify({
        dependencies: { 'ranged-plugin': '^1.0.0', 'pinned-plugin': '1.0.0' },
        dsh: { profile: { bundles: [] } }
      })
    );
    const { code, stdout } = await run(['capture', '--json']);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout) as {
      manifest: { profiles: Record<string, { plugins: Record<string, { package: string }> }> };
      warnings: string[];
    };
    const packages = Object.values(doc.manifest.profiles.web.plugins).map((plugin) => plugin.package);
    expect(packages).toContain('pinned-plugin');
    expect(packages).not.toContain('ranged-plugin');
    expect(doc.warnings.some((warning) => /ranged-plugin.*exact version/.test(warning))).toBe(true);
  });
});
