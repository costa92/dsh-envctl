import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { loadManifest } from '../../src/manifest/files.js';

describe('Convenience Plugin CLI Commands', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-plugin-cmd-'));
    await runCli(['init', '--dsh-home', tempHome]);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should install a new npm plugin into manifest via dshenv install', async () => {
    let stdout = '';
    const io = {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: () => {}
    };

    const code = await runCli(
      ['install', '@nanmicoder/dsh-agent-teams@0.1.21', '--profile', 'web', '--dsh-home', tempHome],
      io
    );
    expect(code).toBe(0);
    expect(stdout).toContain('Installed');

    const manifest = loadManifest(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8'));
    expect(manifest.profiles.web.plugins['agent-teams']).toBeDefined();
    expect(manifest.profiles.web.plugins['agent-teams'].package).toBe('@nanmicoder/dsh-agent-teams');
    expect(manifest.profiles.web.plugins['agent-teams'].source).toEqual({
      type: 'npm',
      version: '0.1.21'
    });
  });

  it('declares a bundle that ships with DSH through the in-box: spec', async () => {
    let stderr = '';
    const io = { stdout: () => {}, stderr: (chunk: string) => { stderr += chunk; } };
    expect(await runCli(['install', 'in-box:@deepseek-ai/dsh-acp-app', '--profile', 'acp', '--dsh-home', tempHome], io)).toBe(0);

    const manifest = loadManifest(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8'));
    expect(manifest.profiles.acp.plugins['acp-app']).toEqual({
      package: '@deepseek-ai/dsh-acp-app',
      enabled: true,
      source: { type: 'in-box' }
    });

    expect(await runCli(['install', 'in-box:@deepseek-ai/dsh-base@0.1.7', '--profile', 'acp', '--dsh-home', tempHome], io)).not.toBe(0);
    expect(stderr).toMatch(/in-box.*no version/);
    expect(await runCli(['install', 'in-box:@deepseek-ai/dsh-base', '--package', 'x', '--profile', 'acp', '--dsh-home', tempHome], io)).not.toBe(0);
  });

  it('should enable and disable a plugin via dshenv enable / disable', async () => {
    // First install
    await runCli(
      ['install', '@nanmicoder/dsh-agent-teams@0.1.21', '--profile', 'web', '--dsh-home', tempHome]
    );

    // Disable
    let stdout = '';
    const io = {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: () => {}
    };
    const disCode = await runCli(['disable', 'agent-teams', '--profile', 'web', '--dsh-home', tempHome], io);
    expect(disCode).toBe(0);

    let manifest = loadManifest(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8'));
    expect(manifest.profiles.web.plugins['agent-teams'].enabled).toBe(false);

    // Enable again
    stdout = '';
    const enCode = await runCli(['enable', 'agent-teams', '--profile', 'web', '--dsh-home', tempHome], io);
    expect(enCode).toBe(0);

    manifest = loadManifest(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8'));
    expect(manifest.profiles.web.plugins['agent-teams'].enabled).toBe(true);
  });

  it('should remove a plugin via dshenv remove', async () => {
    await runCli(
      ['install', '@nanmicoder/dsh-agent-teams@0.1.21', '--profile', 'web', '--dsh-home', tempHome]
    );

    let stdout = '';
    const io = {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: () => {}
    };

    const remCode = await runCli(['remove', 'agent-teams', '--profile', 'web', '--dsh-home', tempHome, '--yes'], io);
    expect(remCode).toBe(0);
    expect(stdout).toContain('Removed');

    const manifest = loadManifest(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8'));
    expect(manifest.profiles.web.plugins['agent-teams']).toBeUndefined();
  });
});
