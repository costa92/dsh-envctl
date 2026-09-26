import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { loadManifest } from '../../src/manifest/files.js';

describe('CLI list, config and update', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-list-'));
    await runCli(['init', '--dsh-home', tempHome]);
    await runCli([
      'install',
      '@nanmicoder/dsh-agent-teams@0.1.21',
      '--profile',
      'web',
      '--dsh-home',
      tempHome
    ]);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should list declared plugins as JSON', async () => {
    let stdout = '';
    const code = await runCli(['list', '--json', '--dsh-home', tempHome], {
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: () => {}
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { plugins: Array<{ alias: string; package: string }> };
    expect(parsed.plugins.some((row) => row.alias === 'agent-teams')).toBe(true);
  });

  it('should set config in the manifest and read it back', async () => {
    const setCode = await runCli(
      ['config', 'set', 'agent-teams', 'taskPlanning', 'captain', '--profile', 'web', '--dsh-home', tempHome]
    );
    expect(setCode).toBe(0);
    const manifest = loadManifest(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8'));
    expect(manifest.profiles.web.plugins['agent-teams'].patches?.[0].config).toEqual({ taskPlanning: 'captain' });

    let stdout = '';
    const getCode = await runCli(
      ['config', 'get', 'agent-teams', '--profile', 'web', '--path', 'taskPlanning', '--json', '--dsh-home', tempHome],
      {
        stdout: (chunk) => {
          stdout += chunk;
        },
        stderr: () => {}
      }
    );
    expect(getCode).toBe(0);
    expect(JSON.parse(stdout)).toBe('captain');
  });

  it('should update the declared npm version', async () => {
    const code = await runCli(
      ['update', 'agent-teams', '--profile', 'web', '--to', '0.1.22', '--dsh-home', tempHome]
    );
    expect(code).toBe(0);
    const manifest = loadManifest(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8'));
    const source = manifest.profiles.web.plugins['agent-teams'].source;
    expect(source.type).toBe('npm');
    if (source.type === 'npm') {
      expect(source.version).toBe('0.1.22');
    }
  });
});
