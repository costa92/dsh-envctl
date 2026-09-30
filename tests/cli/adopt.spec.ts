import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

describe('CLI adopt', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-adopt-'));
    const webProfile = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(path.join(webProfile, 'node_modules', '@nanmicoder', 'dsh-agent-teams'), { recursive: true });

    fs.writeFileSync(
      path.join(webProfile, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: {
          '@nanmicoder/dsh-agent-teams': '^0.1.21'
        },
        dsh: {
          profile: {
            bundles: ['@nanmicoder/dsh-agent-teams']
          }
        }
      })
    );

    fs.writeFileSync(
      path.join(webProfile, 'node_modules', '@nanmicoder', 'dsh-agent-teams', 'package.json'),
      JSON.stringify({
        name: '@nanmicoder/dsh-agent-teams',
        version: '0.1.21',
        _resolved: 'https://registry.npmjs.org/@nanmicoder/dsh-agent-teams/-/dsh-agent-teams-0.1.21.tgz'
      })
    );
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should adopt candidate manifest via CLI adopt --from <file>', async () => {
    const candidatePath = path.join(tempHome, 'candidate.yaml');
    fs.writeFileSync(
      candidatePath,
      `apiVersion: dshenv-capture/v1
manifest:
  apiVersion: dshenv/v1
  profiles:
    web:
      plugins:
        agent-teams:
          package: "@nanmicoder/dsh-agent-teams"
          enabled: true
          source:
            type: npm
            version: "0.1.21"
lock:
  apiVersion: dshenv-lock/v1
  profiles:
    web:
      plugins:
        agent-teams:
          package: "@nanmicoder/dsh-agent-teams"
          source:
            type: npm
            resolvedVersion: "0.1.21"
warnings: []
`
    );

    let stdout = '';
    const io = {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: () => {}
    };

    const code = await runCli(['adopt', '--from', candidatePath, '--dsh-home', tempHome, '--yes'], io);
    expect(code).toBe(0);
    expect(stdout).toContain('Adopted');
    expect(stdout).toContain('@nanmicoder/dsh-agent-teams');
  });

  it('leaves a plugin the active overlay already declares where it is, in the preview and with --yes', async () => {
    const run = async (args: string[]) => {
      let stdout = '';
      let stderr = '';
      const code = await runCli([...args, '--dsh-home', tempHome], {
        stdout: (chunk) => { stdout += chunk; },
        stderr: (chunk) => { stderr += chunk; }
      });
      return { code, stdout, stderr };
    };
    await run(['init']);
    await run(['overlay', 'create', 'local']);
    await run(['overlay', 'use', 'local']);
    expect((await run(['install', '@nanmicoder/dsh-agent-teams@0.1.21', '-p', 'web', '--layer', 'overlay', '--no-npm-check'])).code).toBe(0);
    const candidate = path.join(tempHome, 'capture.yaml');
    expect((await run(['capture', '-o', candidate])).code).toBe(0);
    const base = fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8');

    // adopt only writes the base, so an active overlay needs no --layer.
    const preview = await run(['adopt', candidate]);
    expect(preview.stderr).toBe('');
    expect(preview.stdout).toBe('Nothing to adopt: every plugin in the candidate is already adopted.\n');
    expect(preview.code).toBe(0);

    expect((await run(['adopt', candidate, '--yes'])).code).toBe(0);
    expect((await run(['adopt', candidate, '--layer', 'base'])).code).toBe(0);
    expect(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8')).toBe(base);
  });
});
