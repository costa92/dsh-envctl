import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { loadManifest } from '../../src/manifest/files.js';

const PKG = '@nanmicoder/dsh-agent-teams';

describe('CLI surface', () => {
  let tempHome: string;

  const run = async (args: string[], home = true) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli(home ? [...args, '--dsh-home', tempHome] : args, {
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: (chunk) => {
        stderr += chunk;
      }
    });
    return { code, stdout, stderr };
  };
  const manifestFile = () => path.join(tempHome, 'envctl', 'manifest.yaml');
  const manifest = () => loadManifest(fs.readFileSync(manifestFile(), 'utf8'));

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-surface-'));
    await run(['init']);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe('status and plan', () => {
    beforeEach(async () => {
      await run(['install', `${PKG}@0.1.21`, '-p', 'web']);
      await run(['install', 'dsh-plugin-other@1.0.0', '-p', 'headless', '--new-profile']);
    });

    it('shows the rows of the plugin status is asked about, and counts declared profiles', async () => {
      const all = await run(['status']);
      expect(all.stdout).toContain('Profiles monitored: 2\n');
      expect(all.stdout).toMatch(/web\s+@nanmicoder\/dsh-agent-teams\s+drifted/);
      expect(all.stdout).toMatch(/headless\s+dsh-plugin-other\s+drifted/);

      const one = await run(['status', 'agent-teams']);
      expect(one.stdout).toMatch(/web\s+@nanmicoder\/dsh-agent-teams\s+drifted/);
      expect(one.stdout).not.toContain('dsh-plugin-other');
    });

    it('limits plan and status to one profile with -p', async () => {
      const plan = await run(['plan', '-p', 'web']);
      expect(plan.code).toBe(2);
      expect(plan.stdout).toContain('[web]');
      expect(plan.stdout).not.toContain('[headless]');

      const status = await run(['status', '-p', 'headless']);
      expect(status.stdout).toContain('dsh-plugin-other');
      expect(status.stdout).not.toContain(PKG);
    });
  });

  describe('usage errors', () => {
    it('exits 3 on a missing argument, an unknown option or an unknown command, and keeps the suggestion', async () => {
      const missing = await run(['install']);
      expect(missing.code).toBe(3);
      expect(missing.stderr).toMatch(/missing required argument 'spec'/);

      const unknownOption = await run(['plan', '--bogus']);
      expect(unknownOption.code).toBe(3);
      expect(unknownOption.stderr).toMatch(/unknown option '--bogus'/);

      const requiredOption = await run(['update', 'agent-teams', '-p', 'web']);
      expect(requiredOption.code).toBe(3);
      expect(requiredOption.stderr).toMatch(/required option '--to <version>' not specified/);

      const typo = await run(['instal']);
      expect(typo.code).toBe(3);
      expect(typo.stderr).toMatch(/Did you mean install\?/);
    });

    it('reports a usage error as JSON with --json', async () => {
      const out = await run(['install', '--json']);
      expect(out.code).toBe(3);
      expect(out.stdout).toBe('');
      const error = JSON.parse(out.stderr) as { error: { type: string; message: string; exitCode: number } };
      expect(error.error).toEqual({ type: 'ValidationError', message: "missing required argument 'spec'", exitCode: 3 });
    });

    it('still exits 0 for help and version, and shows help when run without a command', async () => {
      expect((await run(['--help'], false)).code).toBe(0);
      expect((await run(['-v'], false)).code).toBe(0);
      const bare = await run([], false);
      expect(bare.code).toBe(0);
      expect(bare.stdout).toContain('Usage: dshenv');
    });
  });

  describe('help', () => {
    it('groups commands and lists examples, data flow and environment variables', async () => {
      const help = (await run(['--help'], false)).stdout;
      for (const heading of ['Getting started:', 'Everyday:', 'Plugins:', 'Tools & runtime:', 'Sources & team:', 'Maintenance:', 'Examples:', 'Environment variables:']) {
        expect(help).toContain(heading);
      }
      for (const name of ['DSH_HOME', 'DSH_CLI', 'DSHENV_PROFILE', 'DSHENV_LAYER', 'DSHENV_OVERLAY', 'DSHENV_DSH_URL']) {
        expect(help).toContain(name);
      }
      expect(help).toMatch(/remote sync\s+team repository -> local envctl/);
      // Kept for old scripts, but not advertised.
      expect(help).not.toMatch(/^\s+sync\b/m);
      expect(help).not.toMatch(/^\s+restarted\b/m);
      expect(help).not.toContain('uninstall');
      expect(help).toMatch(/^\s+mark-restarted\b/m);
    });

    it('shows global options in subcommand help and marks required options', async () => {
      expect((await run(['apply', '--help'], false)).stdout).toMatch(/Global Options:[\s\S]*--json/);
      expect((await run(['update', '--help'], false)).stdout).toMatch(/--to <version>\s+\(required\)/);
      expect((await run(['adopt', '--help'], false)).stdout).toMatch(/-f, --from <file>\s+\(required\)/);
      const config = (await run(['config', '--help'], false)).stdout;
      expect(config).toMatch(/get \[options\] <alias> \[dottedPath\]\s+\S+/);
      expect(config).toMatch(/validate \[options\] <alias>\s+\S+/);
      expect(config).toMatch(/set \[options\] <alias> <dottedPath> <value>\s+\S+/);
      expect((await run(['remove', '--help'], false)).stdout).not.toContain('--yes');
    });
  });

  describe('--yes', () => {
    beforeEach(async () => {
      await run(['install', `${PKG}@0.1.21`, '-p', 'web']);
    });

    it('previews apply and exits 2 without --yes, like apply --dry-run', async () => {
      const preview = await run(['apply']);
      expect(preview.code).toBe(2);
      expect(preview.stdout).toContain(PKG);
      expect(preview.stderr).toMatch(/Re-run with --yes to apply/);
      expect(fs.existsSync(path.join(tempHome, 'profiles', 'web'))).toBe(false);

      expect((await run(['apply', '--dry-run'])).code).toBe(2);
    });

    it('exits 0 from apply --dry-run when nothing would change', async () => {
      await run(['remove', 'agent-teams', '-p', 'web', '-y']);
      const clean = await run(['apply', '--dry-run']);
      expect(clean.code).toBe(0);
      expect((await run(['apply'])).code).toBe(0);
    });

    it('previews gc without --yes', async () => {
      const trash = path.join(tempHome, 'envctl', 'trash', 'old');
      fs.mkdirSync(trash, { recursive: true });
      const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      fs.utimesSync(trash, old, old);
      const preview = await run(['gc']);
      expect(preview.code).toBe(2);
      expect(preview.stderr).toMatch(/Re-run with --yes/);
      expect(fs.existsSync(trash)).toBe(true);
      expect((await run(['gc', '--yes'])).code).toBe(0);
      expect(fs.existsSync(trash)).toBe(false);
      expect((await run(['gc'])).code).toBe(0);
    });

    it('previews adopt without --yes and writes nothing', async () => {
      fs.mkdirSync(path.join(tempHome, 'profiles', 'headless'), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, 'profiles', 'headless', 'package.json'),
        JSON.stringify({ name: 'dsh-profile-headless', private: true, dependencies: { 'dsh-plugin-other': '1.0.0' }, dsh: { profile: { bundles: ['dsh-plugin-other'] } } })
      );
      fs.mkdirSync(path.join(tempHome, 'profiles', 'headless', 'node_modules', 'dsh-plugin-other'), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, 'profiles', 'headless', 'node_modules', 'dsh-plugin-other', 'package.json'),
        JSON.stringify({ name: 'dsh-plugin-other', version: '1.0.0' })
      );
      const candidate = path.join(tempHome, 'capture.yaml');
      const captured = await run(['capture', '-p', 'headless', '-o', candidate]);
      expect(captured.stderr).toBe('');
      const before = fs.readFileSync(manifestFile(), 'utf8');

      const preview = await run(['adopt', '-f', candidate]);
      expect(preview.code).toBe(2);
      expect(preview.stdout).toContain('dsh-plugin-other');
      expect(preview.stderr).toMatch(/Re-run with --yes to adopt/);
      expect(fs.readFileSync(manifestFile(), 'utf8')).toBe(before);

      expect((await run(['adopt', '-f', candidate, '--yes'])).code).toBe(0);
      expect(manifest().profiles.headless.plugins).toHaveProperty('plugin-other');
    });

    it('still accepts -y on remove, where there is nothing to confirm', async () => {
      expect((await run(['remove', 'agent-teams', '-p', 'web', '-y'])).code).toBe(0);
      expect(manifest().profiles.web.plugins).toEqual({});
    });
  });

  describe('renamed commands', () => {
    it('runs mark-restarted, and restarted still works', async () => {
      expect((await run(['mark-restarted'])).stdout).toMatch(/Cleared restart-required for 0 plugin/);
      expect((await run(['restarted'])).code).toBe(0);
    });

    it('runs remote sync, and the top-level sync still works', async () => {
      expect((await run(['remote', '--help'], false)).stdout).toMatch(/^\s+sync \[options\]/m);
      const remote = await run(['remote', 'sync']);
      const top = await run(['sync']);
      expect(remote.code).toBe(3);
      expect(remote.stderr).toMatch(/No remote is configured/);
      expect(top).toEqual(remote);
    });

    it('treats uninstall as remove', async () => {
      await run(['install', `${PKG}@0.1.21`, '-p', 'web']);
      expect((await run(['uninstall', 'agent-teams', '-p', 'web'])).code).toBe(0);
      expect(manifest().profiles.web.plugins).toEqual({});
    });
  });

  describe('list and overlays', () => {
    it('lists plugins as a table with a header, and says what to do when there are none', async () => {
      const empty = await run(['list']);
      expect(empty.stdout).toBe('No plugins declared. Add one with: dshenv install <spec> -p <profile>\n');

      await run(['install', `${PKG}@0.1.21`, '-p', 'web']);
      const lines = (await run(['list'])).stdout.trimEnd().split('\n');
      expect(lines[0]).toMatch(/^PROFILE\s+ALIAS\s+PACKAGE\s+VERSION\s+ENABLED\s+INSTALLED$/);
      expect(lines[1]).toMatch(/^web\s+agent-teams\s+@nanmicoder\/dsh-agent-teams\s+0\.1\.21\s+yes\s+no$/);
    });

    it('creates an overlay that loads, refuses to overwrite one, and lists it', async () => {
      expect((await run(['overlay', 'list'])).stdout).toBe('No overlays. Create one with: dshenv overlay create <name>\n');

      const created = await run(['overlay', 'create', 'laptop']);
      expect(created.code).toBe(0);
      expect(created.stdout).toContain(path.join(tempHome, 'envctl', 'overlays', 'laptop.yaml'));
      expect((await run(['plan', '--overlay', 'laptop'])).code).toBe(0);

      const again = await run(['overlay', 'create', 'laptop']);
      expect(again.code).toBe(3);
      expect(again.stderr).toMatch(/already exists/);
      expect((await run(['overlay', 'list'])).stdout).toBe('  laptop\n');
      expect((await run(['overlay', 'create', '../x'])).code).toBe(3);
    });
  });
});
