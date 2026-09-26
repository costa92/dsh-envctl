import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

describe('CLI restarted', () => {
  let tempHome: string;
  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], {
      stdout: (chunk) => { stdout += chunk; },
      stderr: (chunk) => { stderr += chunk; }
    });
    return { code, stdout, stderr };
  };
  const state = () => JSON.parse(fs.readFileSync(path.join(tempHome, 'envctl', 'state.json'), 'utf8'));
  const pending = (pkg: string) => ({ package: pkg, status: 'restart-required', installedVersion: '1.0.0', lastVerified: 'x' });

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-restarted-'));
    await run(['init']);
    for (const profile of ['web', 'api']) {
      const profileDir = path.join(tempHome, 'profiles', profile);
      fs.mkdirSync(path.join(profileDir, 'node_modules', 'demo-plugin'), { recursive: true });
      fs.writeFileSync(path.join(profileDir, 'node_modules', 'demo-plugin', 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0' }));
      fs.writeFileSync(
        path.join(profileDir, 'package.json'),
        JSON.stringify({ dependencies: { 'demo-plugin': '1.0.0' }, dsh: { profile: { bundles: ['demo-plugin'] } } })
      );
    }
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      demo: { package: demo-plugin, source: { type: npm, version: "1.0.0" } }
  api:
    plugins:
      demo: { package: demo-plugin, source: { type: npm, version: "1.0.0" } }
`
    );
    const current = state();
    current.profiles = {
      web: { plugins: { 'demo-plugin': pending('demo-plugin'), 'gone-plugin': pending('gone-plugin') } },
      api: { plugins: { 'demo-plugin': pending('demo-plugin') } }
    };
    fs.writeFileSync(path.join(tempHome, 'envctl', 'state.json'), JSON.stringify(current));
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('clears restart-required for one profile, dropping plugins that are no longer installed', async () => {
    expect(JSON.parse((await run(['status', '--json'])).stdout).status).toBe('restart-required');

    const { code, stdout } = await run(['restarted', '--profile', 'web', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ status: 'restarted', cleared: [{ profile: 'web', package: 'demo-plugin' }, { profile: 'web', package: 'gone-plugin' }] });

    const after = state();
    expect(after.profiles.web.plugins).toEqual({ 'demo-plugin': expect.objectContaining({ status: 'healthy', installedVersion: '1.0.0' }) });
    expect(after.profiles.api.plugins['demo-plugin'].status).toBe('restart-required');
  });

  it('clears every profile without --profile and reports a healthy environment', async () => {
    const { code, stdout } = await run(['restarted']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Cleared restart-required for 3 plugin\(s\)/);
    expect(JSON.parse((await run(['status', '--json'])).stdout).status).toBe('healthy');
  });
});
