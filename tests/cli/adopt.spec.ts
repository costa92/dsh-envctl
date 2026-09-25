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
});
