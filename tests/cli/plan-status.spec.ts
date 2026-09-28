import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

describe('CLI plan and status', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-plan-'));
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should return exit code 2 when plan has changes', async () => {
    let stdout = '';
    const io = {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: () => {}
    };

    // Run init
    await runCli(['init', '--dsh-home', tempHome], io);
    stdout = '';

    // Create manifest with missing plugin
    const manifestPath = path.join(tempHome, 'envctl', 'manifest.yaml');
    fs.writeFileSync(
      manifestPath,
      `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      agent-teams:
        package: "@nanmicoder/dsh-agent-teams"
        enabled: true
        source:
          type: npm
          version: "0.1.21"
`
    );

    const code = await runCli(['plan', '--dsh-home', tempHome], io);
    expect(code).toBe(2);
    expect(stdout).toContain('+ [web] @nanmicoder/dsh-agent-teams');
  });

  it('filters status by the alias a profile declares, as well as by package name', async () => {
    const io = { stdout: () => {}, stderr: () => {} };
    await runCli(['init', '--dsh-home', tempHome], io);
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      teams: { package: "@nanmicoder/dsh-agent-teams", source: { type: npm, version: "0.1.21" } }
  ops:
    plugins:
      crew: { package: "@nanmicoder/dsh-agent-teams", source: { type: npm, version: "0.1.21" } }
`
    );
    const status = async (name: string) => {
      let stdout = '';
      const code = await runCli(['status', name, '--json', '--dsh-home', tempHome], {
        stdout: (chunk: string) => { stdout += chunk; },
        stderr: () => {}
      });
      const plugins = code === 3 ? [] : (JSON.parse(stdout) as { plugins: Array<{ profile: string }> }).plugins;
      return { code, profiles: plugins.map((entry) => entry.profile).sort() };
    };

    expect(await status('teams')).toEqual({ code: 2, profiles: ['web'] });
    expect(await status('crew')).toEqual({ code: 2, profiles: ['ops'] });
    expect(await status('@nanmicoder/dsh-agent-teams')).toEqual({ code: 2, profiles: ['ops', 'web'] });
    expect(await status('nope')).toEqual({ code: 3, profiles: [] });
  });

  it('should return exit code 0 when plan is clean and in sync', async () => {
    let stdout = '';
    const io = {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: () => {}
    };

    await runCli(['init', '--dsh-home', tempHome], io);
    stdout = '';

    const code = await runCli(['plan', '--dsh-home', tempHome], io);
    expect(code).toBe(0);
    expect(stdout).toContain('in sync');
  });

  it('should return exit code 5 when plan is blocked by insufficient evidence', async () => {
    const io = {
      stdout: () => {},
      stderr: () => {}
    };
    await runCli(['init', '--dsh-home', tempHome], io);
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      agent-teams:
        package: "@nanmicoder/dsh-agent-teams"
        enabled: true
        source:
          type: npm
          version: "0.1.21"
        patches:
          - id: agent-teams
            config:
              taskPlanning: captain
`
    );
    fs.mkdirSync(path.join(tempHome, 'profiles', 'web', 'node_modules', '@nanmicoder', 'dsh-agent-teams'), {
      recursive: true
    });
    fs.writeFileSync(
      path.join(tempHome, 'profiles', 'web', 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: { '@nanmicoder/dsh-agent-teams': '0.1.21' },
        dsh: { profile: { bundles: ['@nanmicoder/dsh-agent-teams'] } }
      })
    );
    fs.writeFileSync(
      path.join(tempHome, 'profiles', 'web', 'node_modules', '@nanmicoder', 'dsh-agent-teams', 'package.json'),
      JSON.stringify({ name: '@nanmicoder/dsh-agent-teams', version: '0.1.21' })
    );

    const code = await runCli(['plan', '--dsh-home', tempHome], io);
    expect(code).toBe(2);
  });
});
