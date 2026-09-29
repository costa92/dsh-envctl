import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { loadManifest } from '../../src/manifest/files.js';

const PKG = '@nanmicoder/dsh-agent-teams';

describe('CLI -p, --profile', () => {
  let tempHome: string;
  let previousProfile: string | undefined;

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
  const manifest = () => loadManifest(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8'));

  beforeEach(async () => {
    previousProfile = process.env.DSHENV_PROFILE;
    delete process.env.DSHENV_PROFILE;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-profile-'));
    await run(['init']);
    await run(['install', `${PKG}@0.1.21`, '-p', 'web']);
    // A profile DSH created that the manifest does not declare yet.
    fs.mkdirSync(path.join(tempHome, 'profiles', 'headless'), { recursive: true });
    fs.writeFileSync(path.join(tempHome, 'profiles', 'headless', 'package.json'), JSON.stringify({ name: 'dsh-profile-headless' }));
  });

  afterEach(() => {
    if (previousProfile === undefined) delete process.env.DSHENV_PROFILE;
    else process.env.DSHENV_PROFILE = previousProfile;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('names the profiles to choose from when -p is missing and DSHENV_PROFILE is not set', async () => {
    for (const args of [['disable', 'agent-teams'], ['tools', 'list'], ['web', 'stop'], ['purge', 'agent-teams', '--dry-run'], ['config', 'get', 'agent-teams']]) {
      const out = await run(args);
      expect(out.code, args.join(' ')).toBe(3);
      expect(out.stderr).toBe('Missing -p, --profile <name>: choose one of headless, web, or set DSHENV_PROFILE\n');
    }
    expect(manifest().profiles.web.plugins['agent-teams'].enabled).not.toBe(false);
  });

  it('says so when there is no profile to choose from', async () => {
    fs.rmSync(path.join(tempHome, 'profiles'), { recursive: true, force: true });
    fs.rmSync(path.join(tempHome, 'envctl'), { recursive: true, force: true });
    const out = await run(['web', 'stop']);
    expect(out.code).toBe(3);
    expect(out.stderr).toBe('Missing -p, --profile <name>: no profile exists yet; pass -p <name> or set DSHENV_PROFILE\n');
  });

  it('uses DSHENV_PROFILE when -p is missing, and -p over it', async () => {
    process.env.DSHENV_PROFILE = 'web';
    expect((await run(['disable', 'agent-teams'])).code).toBe(0);
    expect(manifest().profiles.web.plugins['agent-teams'].enabled).toBe(false);

    process.env.DSHENV_PROFILE = 'headless';
    const explicit = await run(['enable', 'agent-teams', '-p', 'web']);
    expect(explicit.code).toBe(0);
    expect(manifest().profiles.web.plugins['agent-teams'].enabled).toBe(true);
  });

  it('refuses an invalid DSHENV_PROFILE and says where it came from', async () => {
    process.env.DSHENV_PROFILE = '../outside';
    const out = await run(['disable', 'agent-teams']);
    expect(out.code).toBe(3);
    expect(out.stderr).toMatch(/Invalid profile name: \.\.\/outside \(from DSHENV_PROFILE\)/);
  });

  it('keeps optional filters meaning every profile, whatever DSHENV_PROFILE says', async () => {
    await run(['install', `${PKG}@0.1.21`, '-p', 'headless']);
    process.env.DSHENV_PROFILE = 'web';
    const listed = JSON.parse((await run(['list', '--json'])).stdout) as { plugins: Array<{ profile: string }> };
    expect(listed.plugins.map((row) => row.profile).sort()).toEqual(['headless', 'web']);
  });

  it('lets runtime take DSHENV_PROFILE, and names the profiles when several are declared', async () => {
    await run(['install', `${PKG}@0.1.21`, '-p', 'headless']);
    delete process.env.DSHENV_DSH_URL;
    const missing = await run(['runtime']);
    expect(missing.code).toBe(3);
    expect(missing.stderr).toBe('Missing -p, --profile <name>: choose one of headless, web, or set DSHENV_PROFILE\n');

    process.env.DSHENV_PROFILE = 'web';
    const fromEnv = await run(['runtime']);
    expect(fromEnv.code).toBe(3);
    expect(fromEnv.stderr).toMatch(/no dsh web started by 'dshenv web start' is running for profile web/);
  });

  it('describes -p the same way on every command', async () => {
    const required = (await run(['disable', '--help'])).stdout;
    expect(required).toMatch(/-p, --profile <name>\s+target profile \(default: \$DSHENV_PROFILE\)/);
    for (const args of [['web', 'start', '--help'], ['runtime', '--help'], ['tools', 'config', '--help']]) {
      expect((await run(args)).stdout, args.join(' ')).toMatch(/-p, --profile <name>\s+target profile \(default: \$DSHENV_PROFILE\)/);
    }
    for (const args of [['list', '--help'], ['pull', '--help'], ['overlay', 'show', '--help'], ['restarted', '--help'], ['capture', '--help'], ['web', 'status', '--help']]) {
      expect((await run(args)).stdout, args.join(' ')).toMatch(/-p, --profile <name>\s+only this profile \(default: all\)/);
    }
  });
});

describe('CLI one spelling per operation', () => {
  let tempHome: string;

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
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-spelling-'));
    await run(['init']);
    await run(['install', `${PKG}@0.1.21`, '-p', 'web']);
    await run(['config', 'set', 'agent-teams', 'taskPlanning', 'captain', '-p', 'web']);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('reads a nested config field with a positional path, and still with --path', async () => {
    const positional = await run(['config', 'get', 'agent-teams', 'taskPlanning', '-p', 'web', '--json']);
    expect(positional.code).toBe(0);
    expect(JSON.parse(positional.stdout)).toBe('captain');
    const legacy = await run(['config', 'get', 'agent-teams', '-p', 'web', '--path', 'taskPlanning', '--json']);
    expect(JSON.parse(legacy.stdout)).toBe('captain');

    const help = (await run(['config', 'get', '--help'])).stdout;
    expect(help).toMatch(/Usage: dshenv config get \[options\] <alias> \[dottedPath\]/);
    expect(help).not.toContain('--path');
  });

  it('shows one spelling for the source pull ref', async () => {
    const help = (await run(['source', 'pull', '--help'])).stdout;
    expect(help).toMatch(/Usage: dshenv source pull \[options\] \[targetDir\]\n/);
    expect(help).toContain('--ref <ref>');
  });

  it('calls the plugin argument <alias> everywhere, alias or package name', async () => {
    expect((await run(['purge', '--help'])).stdout).toMatch(/Usage: dshenv purge \[options\] <alias>/);
    expect((await run(['status', '--help'])).stdout).toMatch(/Usage: dshenv status \[options\] \[alias\]/);
  });
});
