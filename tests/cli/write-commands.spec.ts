import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { loadManifest } from '../../src/manifest/files.js';
import { OverlaySchema } from '../../src/overlay/schema.js';
import { parse as parseYaml } from 'yaml';

const PKG = '@nanmicoder/dsh-agent-teams';
const NEXT = 'Next: dshenv plan, then dshenv apply --yes.';

describe('CLI manifest write commands', () => {
  let tempHome: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['DSHENV_PROFILE', 'DSHENV_LAYER', 'DSHENV_OVERLAY', 'DSHENV_DSH_URL', 'DSHENV_NPM_CHECK', 'DSH_CLI', 'PATH'];

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
  const manifestText = () => fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8');
  const manifest = () => loadManifest(manifestText());
  const overlay = (name: string) => OverlaySchema.parse(parseYaml(fs.readFileSync(path.join(tempHome, 'envctl', 'overlays', `${name}.yaml`), 'utf8')));
  const createProfile = (name: string) => {
    fs.mkdirSync(path.join(tempHome, 'profiles', name), { recursive: true });
    fs.writeFileSync(path.join(tempHome, 'profiles', name, 'package.json'), JSON.stringify({ name: `dsh-profile-${name}` }));
  };
  const useOverlay = (name: string) => {
    fs.mkdirSync(path.join(tempHome, 'envctl', 'overlays'), { recursive: true });
    fs.writeFileSync(path.join(tempHome, 'envctl', 'overlays', `${name}.yaml`), 'apiVersion: dshenv-overlay/v1\n');
    process.env.DSHENV_OVERLAY = name;
  };

  beforeEach(async () => {
    for (const name of ENV) saved[name] = process.env[name];
    for (const name of ['DSHENV_PROFILE', 'DSHENV_LAYER', 'DSHENV_OVERLAY', 'DSHENV_DSH_URL']) delete process.env[name];
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-write-'));
    await run(['init']);
    createProfile('web');
    await run(['install', `${PKG}@0.1.21`, '-p', 'web']);
  });

  afterEach(() => {
    for (const name of ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe('output', () => {
    it('says each write changed the manifest and names the step that changes DSH', async () => {
      const cases: Array<[string[], string]> = [
        [['disable', 'agent-teams', '-p', 'web'], "Disabled plugin 'agent-teams' in profile 'web'"],
        [['enable', 'agent-teams', '-p', 'web'], "Enabled plugin 'agent-teams' in profile 'web'"],
        [['update', 'agent-teams', '--to', '0.1.22', '-p', 'web'], "Set agent-teams in profile 'web' to 0.1.22"],
        [['config', 'set', 'agent-teams', 'taskPlanning', 'captain', '-p', 'web'], "Set agent-teams config taskPlanning in profile 'web'"],
        [['config', 'unset', 'agent-teams', 'taskPlanning', '-p', 'web'], "Removed agent-teams config taskPlanning in profile 'web'"],
        [['remove', 'agent-teams', '-p', 'web'], "Removed plugin 'agent-teams' from profile 'web'"]
      ];
      for (const [args, text] of cases) {
        const out = await run(args);
        expect(out.code, args.join(' ')).toBe(0);
        expect(out.stdout, args.join(' ')).toBe(`${text} in the manifest. ${NEXT}\n`);
      }
    });

    it('says an install over an existing alias changed its version', async () => {
      const out = await run(['install', `${PKG}@0.1.22`, '-p', 'web']);
      expect(out.stdout).toBe(`Changed agent-teams in profile 'web' from 0.1.21 to 0.1.22 in the manifest. ${NEXT}\n`);
      const same = await run(['install', `${PKG}@0.1.22`, '-p', 'web']);
      expect(same.stdout).toBe(`${PKG} (agent-teams) is already declared at 0.1.22 in profile 'web' in the manifest; nothing changed.\n`);
    });

    it('keeps the JSON of a write as it was', async () => {
      const out = JSON.parse((await run(['disable', 'agent-teams', '-p', 'web', '--json'])).stdout);
      expect(out).toEqual({ status: 'disabled', profile: 'web', alias: 'agent-teams' });
    });
  });

  describe('profile names', () => {
    it('refuses a profile no one declared or created, suggesting the close one, until --new-profile', async () => {
      const before = manifestText();
      const typo = await run(['install', `${PKG}@0.1.21`, '-p', 'wbe']);
      expect(typo.code).toBe(3);
      expect(typo.stderr).toBe(
        "Profile 'wbe' is neither declared in the manifest nor created by DSH; did you mean 'web'? (known profiles: web); pass --new-profile to add it as a new profile\n"
      );
      expect(manifestText()).toBe(before);

      const created = await run(['install', `${PKG}@0.1.21`, '-p', 'wbe', '--new-profile']);
      expect(created.code).toBe(0);
      expect(manifest().profiles.wbe.plugins['agent-teams']).toBeDefined();
    });

    it('lets a profile DSH created but the manifest does not declare yet be written', async () => {
      createProfile('headless');
      expect((await run(['install', `${PKG}@0.1.21`, '-p', 'headless'])).code).toBe(0);
    });

    it('names a profile the manifest does not declare instead of calling it a missing plugin', async () => {
      const out = await run(['disable', 'agent-teams', '-p', 'wbe']);
      expect(out.code).toBe(3);
      expect(out.stderr).toBe("Profile 'wbe' is not declared in the manifest; did you mean 'web'? (declared: web)\n");
    });

    it('says on stderr when the profile came from DSHENV_PROFILE, but not in --json output', async () => {
      process.env.DSHENV_PROFILE = 'web';
      const out = await run(['disable', 'agent-teams']);
      expect(out.code).toBe(0);
      expect(out.stderr).toBe("Using profile 'web' from DSHENV_PROFILE\n");
      const json = await run(['enable', 'agent-teams', '--json']);
      expect(json.stderr).toBe('');
      expect(JSON.parse(json.stdout).status).toBe('enabled');
    });

    it('refuses install without -p and names the profiles, as JSON with --json', async () => {
      const out = await run(['install', `${PKG}@0.1.21`]);
      expect(out.code).toBe(3);
      expect(out.stderr).toBe('Missing -p, --profile <name>: choose one of web, or set DSHENV_PROFILE\n');
      const json = await run(['install', `${PKG}@0.1.21`, '--json']);
      expect(json.code).toBe(3);
      expect(JSON.parse(json.stderr)).toEqual({
        error: { type: 'ValidationError', message: 'Missing -p, --profile <name>: choose one of web, or set DSHENV_PROFILE', exitCode: 3 }
      });
    });

    it('reports a broken overlay selection instead of claiming there is no profile', async () => {
      const out = await run(['disable', 'agent-teams', '--overlay', 'nope']);
      expect(out.code).toBe(3);
      expect(out.stderr).not.toMatch(/no profile exists yet/);
      expect(out.stderr).toMatch(/nope/);
    });

    it('never applies DSHENV_PROFILE to the commands where -p only filters', async () => {
      createProfile('headless');
      await run(['install', `${PKG}@0.1.21`, '-p', 'headless']);
      process.env.DSHENV_PROFILE = 'web';
      const listed = JSON.parse((await run(['list', '--json'])).stdout) as { plugins: Array<{ profile: string }> };
      expect(listed.plugins.map((row) => row.profile).sort()).toEqual(['headless', 'web']);
      for (const args of [['pull', '--dry-run'], ['capture', '-o', path.join(tempHome, 'cap.yaml')], ['overlay', 'show'], ['restarted'], ['web', 'status']]) {
        const out = await run(args);
        expect(out.stderr, args.join(' ')).not.toMatch(/from DSHENV_PROFILE/);
      }
    });
  });

  describe('runtime profile selection', () => {
    it('says a profile it cannot check came from DSHENV_PROFILE', async () => {
      process.env.DSHENV_PROFILE = 'other';
      const out = await run(['runtime']);
      expect(out.code).toBe(3);
      expect(out.stderr).toBe("Profile 'other' (from DSHENV_PROFILE) is not declared in the manifest (declared: web)\n");
    });

    it('offers only declared profiles when -p is missing', async () => {
      createProfile('headless');
      await run(['install', `${PKG}@0.1.21`, '-p', 'sdk', '--new-profile']);
      const out = await run(['runtime']);
      expect(out.code).toBe(3);
      expect(out.stderr).toBe('Missing -p, --profile <name>: choose one of sdk, web, or set DSHENV_PROFILE\n');
    });

    it('still says so when the manifest declares no profile', async () => {
      await run(['remove', 'agent-teams', '-p', 'web']);
      fs.writeFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'apiVersion: dshenv/v1\nprofiles: {}\n');
      const out = await run(['runtime']);
      expect(out.code).toBe(3);
      expect(out.stderr).toBe('The manifest declares no profiles\n');
    });
  });

  describe('plugin names', () => {
    it('takes the package name for its alias, and suggests the alias for a typo', async () => {
      expect((await run(['disable', PKG, '-p', 'web'])).code).toBe(0);
      expect(manifest().profiles.web.plugins['agent-teams'].enabled).toBe(false);
      const typo = await run(['enable', 'agent-team', '-p', 'web']);
      expect(typo.code).toBe(3);
      expect(typo.stderr).toBe("Plugin 'agent-team' not found in profile 'web'; did you mean 'agent-teams'? (aliases: agent-teams)\n");
    });

    it('says a plugin only the overlay declares must be written there', async () => {
      useOverlay('laptop');
      await run(['install', 'dsh-plugin-demo@1.0.0', '-p', 'web', '--as', 'teams2', '--layer', 'overlay']);
      const base = await run(['disable', 'teams2', '-p', 'web', '--layer', 'base']);
      expect(base.code).toBe(3);
      expect(base.stderr).toBe("Plugin 'teams2' is declared in overlay 'laptop', not in the base manifest; use --layer overlay\n");
    });
  });

  describe('config', () => {
    beforeEach(async () => {
      await run(['config', 'set', 'agent-teams', 'team.lead', 'captain', '-p', 'web']);
    });

    it('refuses the path given twice, and a key the config does not have', async () => {
      const twice = await run(['config', 'get', 'agent-teams', 'team.lead', '--path', 'team', '-p', 'web']);
      expect(twice.code).toBe(3);
      expect(twice.stderr).toMatch(/Give the config path once/);

      const missing = await run(['config', 'get', 'agent-teams', 'tema', '-p', 'web', '--json']);
      expect(missing.code).toBe(3);
      expect(missing.stdout).toBe('');
      expect(JSON.parse(missing.stderr)).toEqual({
        error: { type: 'ValidationError', message: "The config of 'agent-teams' in profile 'web' has no 'tema'; did you mean 'team'?", exitCode: 3 }
      });
    });

    it('refuses a source pull ref given both ways', async () => {
      const out = await run(['source', 'pull', tempHome, 'v1', '--ref', 'v2']);
      expect(out.code).toBe(3);
      expect(out.stderr).toBe('Give the ref once: with --ref or as the second argument, not both\n');
    });

    it('unsets one key and drops parents it leaves empty', async () => {
      await run(['config', 'set', 'agent-teams', 'mode', 'fast', '-p', 'web']);
      expect((await run(['config', 'unset', 'agent-teams', 'team.lead', '-p', 'web'])).code).toBe(0);
      expect(manifest().profiles.web.plugins['agent-teams'].patches?.[0].config).toEqual({ mode: 'fast' });
      const again = await run(['config', 'unset', 'agent-teams', 'team.lead', '-p', 'web']);
      expect(again.code).toBe(3);
      expect(again.stderr).toBe("The config of 'agent-teams' in profile 'web' has no 'team.lead'\n");
    });

    it('unsets a key the overlay sets, but not one the base sets', async () => {
      useOverlay('laptop');
      await run(['config', 'set', 'agent-teams', 'mode', 'fast', '-p', 'web', '--layer', 'overlay']);
      expect((await run(['config', 'unset', 'agent-teams', 'mode', '-p', 'web', '--layer', 'overlay'])).code).toBe(0);
      expect(overlay('laptop').profiles?.web?.plugins?.['agent-teams']?.patches?.[0].config).toEqual({});
      const base = await run(['config', 'unset', 'agent-teams', 'team.lead', '-p', 'web', '--layer', 'overlay']);
      expect(base.code).toBe(3);
      expect(base.stderr).toBe("'team.lead' of 'agent-teams' is set in the base manifest, which an overlay cannot remove; use --layer base\n");
    });

    it('refuses a key DSH does not compose for the plugin, unless --force', async () => {
      const fakeDsh = path.join(tempHome, 'fake-dsh.mjs');
      fs.writeFileSync(
        fakeDsh,
        `if (process.argv.includes('--dump-config')) { process.stdout.write(${JSON.stringify(`- id: agent-teams\n  name: '${PKG}'\n  config:\n    taskPlanning: auto\n    team: {}\n`)}); process.exit(0); }\nprocess.exit(1);\n`
      );
      process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);
      const typo = await run(['config', 'set', 'agent-teams', 'taskPlaning', 'captain', '-p', 'web']);
      expect(typo.code).toBe(3);
      expect(typo.stderr).toBe(
        `'taskPlaning' is not a config key of ${PKG}; did you mean 'taskPlanning'? (DSH composes: taskPlanning, team); pass --force to set it anyway\n`
      );
      expect((await run(['config', 'set', 'agent-teams', 'taskPlanning', 'captain', '-p', 'web'])).code).toBe(0);
      expect((await run(['config', 'set', 'agent-teams', 'taskPlaning', 'captain', '-p', 'web', '--force'])).code).toBe(0);
    });
  });

  describe('DSHENV_LAYER', () => {
    it('picks the layer while an overlay is active, says so, and is ignored without one', async () => {
      process.env.DSHENV_LAYER = 'overlay';
      const base = await run(['disable', 'agent-teams', '-p', 'web']);
      expect(base.code).toBe(0);
      expect(base.stderr).toBe('');
      expect(manifest().profiles.web.plugins['agent-teams'].enabled).toBe(false);

      useOverlay('laptop');
      const out = await run(['enable', 'agent-teams', '-p', 'web']);
      expect(out.code).toBe(0);
      expect(out.stderr).toBe("Using layer 'overlay' from DSHENV_LAYER\n");
      expect(overlay('laptop').profiles?.web?.plugins?.['agent-teams']?.enabled).toBe(true);
      expect(manifest().profiles.web.plugins['agent-teams'].enabled).toBe(false);

      expect((await run(['disable', 'agent-teams', '-p', 'web', '--layer', 'base'])).stderr).toBe('');
    });

    it('refuses an invalid value and says where it came from', async () => {
      useOverlay('laptop');
      process.env.DSHENV_LAYER = 'top';
      const out = await run(['disable', 'agent-teams', '-p', 'web']);
      expect(out.code).toBe(3);
      expect(out.stderr).toBe("Invalid --layer 'top'; expected base or overlay (from DSHENV_LAYER)\n");
    });

    it('hides --layer on adopt, which only writes the base', async () => {
      expect((await run(['adopt', '--help'])).stdout).not.toMatch(/--layer/);
      expect((await run(['install', '--help'])).stdout).toMatch(/--layer <layer>\s+layer to write when an overlay is active: base or\s+overlay \(default: \$DSHENV_LAYER\)/);
    });
  });
});

// Stands in for npm on PATH; POSIX only, as Windows would need a .cmd shim.
describe.skipIf(process.platform === 'win32')('CLI install checks npm', () => {
  let tempHome: string;
  const saved: Record<string, string | undefined> = {};

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
  const fakeNpm = (script: string) => {
    const bin = path.join(tempHome, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`;
    delete process.env.DSHENV_NPM_CHECK;
  };

  beforeEach(async () => {
    for (const name of ['PATH', 'DSHENV_NPM_CHECK']) saved[name] = process.env[name];
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-npm-'));
    await run(['init']);
  });

  afterEach(() => {
    for (const name of ['PATH', 'DSHENV_NPM_CHECK']) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('refuses a version npm does not have and names the latest', async () => {
    fakeNpm(`case "$2" in *@9.9.9) exit 0 ;; *) echo 0.1.22 ;; esac`);
    const out = await run(['install', `${PKG}@9.9.9`, '-p', 'web']);
    expect(out.code).toBe(3);
    expect(out.stderr).toBe(`npm has no version 9.9.9 of ${PKG}; the latest is 0.1.22\n`);
  });

  it('refuses a package npm does not have', async () => {
    fakeNpm(`echo "npm error code E404" >&2; exit 1`);
    const out = await run(['install', '@nobody/nothing@1.0.0', '-p', 'web']);
    expect(out.code).toBe(3);
    expect(out.stderr).toBe('npm has no package @nobody/nothing\n');
  });

  it('warns and goes ahead when npm cannot be asked', async () => {
    fakeNpm(`echo "npm error code ENOTFOUND" >&2; exit 1`);
    const out = await run(['install', `${PKG}@0.1.21`, '-p', 'web']);
    expect(out.code).toBe(0);
    expect(out.stderr).toBe(`Could not check ${PKG}@0.1.21 on npm (npm view failed); apply fails if it does not exist\n`);
  });

  it('accepts a version npm has', async () => {
    fakeNpm(`echo '"0.1.21"'`);
    const out = await run(['install', `${PKG}@0.1.21`, '-p', 'web']);
    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
  });
});
