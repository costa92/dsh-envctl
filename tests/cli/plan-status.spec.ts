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
});
