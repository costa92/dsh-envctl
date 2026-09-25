import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

describe('CLI apply', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-apply-'));
    const managerDir = path.join(tempHome, 'envctl');
    fs.mkdirSync(managerDir, { recursive: true });

    fs.writeFileSync(
      path.join(managerDir, 'manifest.yaml'),
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

    fs.writeFileSync(
      path.join(managerDir, 'lock.json'),
      `{
  "apiVersion": "dshenv-lock/v1",
  "profiles": {
    "web": {
      "plugins": {
        "agent-teams": {
          "package": "@nanmicoder/dsh-agent-teams",
          "source": {
            "type": "npm",
            "resolvedVersion": "0.1.21"
          }
        }
      }
    }
  }
}`
    );

    fs.writeFileSync(
      path.join(managerDir, 'state.json'),
      `{
  "apiVersion": "dshenv-state/v1",
  "lastApplied": "2026-01-01T00:00:00.000Z",
  "appliedLockHash": "",
  "profiles": {}
}`
    );
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should support dry-run apply via CLI apply --dry-run', async () => {
    let stdout = '';
    const io = {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: () => {}
    };

    const code = await runCli(['apply', '--dry-run', '--dsh-home', tempHome], io);
    expect(code).toBe(0);
    expect(stdout).toContain('[DRY-RUN]');
    expect(stdout).toContain('@nanmicoder/dsh-agent-teams');
  });

  it('should apply changes via CLI apply --yes', async () => {
    let stdout = '';
    const io = {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: () => {}
    };

    const code = await runCli(['apply', '--yes', '--dsh-home', tempHome], io);
    expect(code).toBe(0);
    expect(stdout).toContain('Successfully applied');
  });
});
