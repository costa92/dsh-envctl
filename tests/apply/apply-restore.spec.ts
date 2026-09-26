import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyEnvironment } from '../../src/apply/apply.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';
import { applyPatchBlock } from '../../src/patch/patch.js';

// Fake DSH: `remove` succeeds, `add` always fails.
const FAKE_DSH = `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('0.1.7-rc.2');
  process.exit(0);
}
if (!args.includes('remove')) process.exit(1);
const profileDir = path.join(process.env.DSH_HOME, 'profiles', args[args.indexOf('--profile') + 1]);
const packageName = args.at(-1);
const pkgJsonPath = path.join(profileDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
delete pkg.dependencies[packageName];
fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2));
fs.rmSync(path.join(profileDir, 'node_modules', packageName), { recursive: true, force: true });
`;

describe('applyEnvironment profile restore on failure', () => {
  let tempHome: string;
  let previousDshCli: string | undefined;
  let profileDir: string;

  const readBundles = (): string[] =>
    (JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } };
    }).dsh.profile.bundles;
  const patchFile = (): string => path.join(profileDir, 'cordis.patch.yml');

  function setup(options: {
    manifestPlugins: string;
    installed: string[];
    bundles: string[];
    owned?: string[];
    patchContent?: string;
  }): void {
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      `apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n${options.manifestPlugins}`
    );
    const ownership = Object.fromEntries(
      (options.owned ?? []).map((name) => [
        name,
        { package: name, alias: name, sourceType: 'npm', adoptedAt: '2026-01-01T00:00:00.000Z', adoptedBy: 'test' }
      ])
    );
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'state.json'),
      JSON.stringify({
        apiVersion: 'dshenv-state/v1',
        lastApplied: '2026-01-01T00:00:00.000Z',
        appliedLockHash: '',
        profiles: {},
        ownership: { web: ownership }
      })
    );
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, 'package.json'),
      JSON.stringify(
        {
          name: 'dsh-profile-web',
          private: true,
          dependencies: Object.fromEntries(options.installed.map((name) => [name, '1.0.0'])),
          dsh: { profile: { bundles: options.bundles } }
        },
        null,
        2
      )
    );
    for (const name of options.installed) {
      fs.mkdirSync(path.join(profileDir, 'node_modules', name), { recursive: true });
      fs.writeFileSync(
        path.join(profileDir, 'node_modules', name, 'package.json'),
        JSON.stringify({ name, version: '1.0.0' })
      );
    }
    if (options.patchContent !== undefined) {
      fs.writeFileSync(patchFile(), options.patchContent);
    }
  }

  beforeEach(() => {
    previousDshCli = process.env.DSH_CLI;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-apply-restore-test-'));
    fs.mkdirSync(path.join(tempHome, 'envctl'), { recursive: true });
    profileDir = path.join(tempHome, 'profiles', 'web');
    const fakeDsh = path.join(tempHome, 'fake-dsh.mjs');
    fs.writeFileSync(fakeDsh, FAKE_DSH);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);
  });

  afterEach(() => {
    if (previousDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = previousDshCli;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should undo bundle and patch edits when a later DSH command fails', async () => {
    const userPatch = '# user-owned settings\nfoo: 1\n';
    setup({
      manifestPlugins: `      a-toggle:
        package: a-toggle
        enabled: false
        source: { type: npm, version: "1.0.0" }
      b-patched:
        package: b-patched
        source: { type: npm, version: "1.0.0" }
        patches:
          - id: b-patched
            config: { mode: new }
      c-new:
        package: c-new
        source: { type: npm, version: "1.0.0" }
`,
      installed: ['a-toggle', 'b-patched'],
      bundles: ['a-toggle', 'b-patched'],
      patchContent: userPatch
    });

    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    await expect(applyEnvironment(paths)).rejects.toThrow(/exited with code 1/);

    expect(readBundles()).toEqual(['a-toggle', 'b-patched']);
    expect(fs.readFileSync(patchFile(), 'utf8')).toBe(userPatch);
  });

  it('should restore a patch file that did not exist before apply by removing it', async () => {
    setup({
      manifestPlugins: `      b-patched:
        package: b-patched
        source: { type: npm, version: "1.0.0" }
        patches:
          - id: b-patched
            config: { mode: new }
      c-new:
        package: c-new
        source: { type: npm, version: "1.0.0" }
`,
      installed: ['b-patched'],
      bundles: ['b-patched']
    });

    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    await expect(applyEnvironment(paths)).rejects.toThrow(/exited with code 1/);

    expect(fs.existsSync(patchFile())).toBe(false);
  });

  it('should keep a completed DSH remove while undoing edits of failed operations', async () => {
    const ownedPatch = applyPatchBlock('', 'web', 'a-owned', 'a-owned', { keep: true });
    setup({
      manifestPlugins: `      z-new:
        package: z-new
        source: { type: npm, version: "1.0.0" }
`,
      installed: ['a-owned'],
      bundles: ['a-owned'],
      owned: ['a-owned'],
      patchContent: ownedPatch
    });

    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    await expect(applyEnvironment(paths)).rejects.toThrow(/exited with code 1/);

    // The package is gone, so re-selecting its bundle would make it look like an in-box plugin.
    expect(readBundles()).not.toContain('a-owned');
    expect(fs.readFileSync(patchFile(), 'utf8')).not.toContain('plugin=a-owned');
  });
});
