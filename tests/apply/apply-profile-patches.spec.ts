import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as YAML from 'yaml';
import { applyEnvironment } from '../../src/apply/apply.js';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import { readProfilePatchState } from '../../src/profile-patches/entries.js';

describe('apply profile patches', () => {
  let tempHome: string;
  let paths: EnvironmentPaths;
  const patchFile = () => path.join(tempHome, 'profiles', 'web', 'cordis.patch.yml');
  const writeManifest = (patches: string) =>
    fs.writeFileSync(paths.manifestFile, `apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins: {}\n${patches}`);

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-apply-profile-patches-'));
    paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(paths.managerDir, { recursive: true });
    const profileDir = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
    fs.writeFileSync(patchFile(), '# user header\n- id: user-owned\n  config: { a: 1 }\n');
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('writes the declared entries into one profile block, leaves other entries alone, and converges', async () => {
    writeManifest(`    patches:
      - id: locale
        name: "@deepseek-ai/dsh-client-locale"
        config: { preference: zh }
      - id: expr
        disabled: { __jsExpr: "env.X === '1'" }
`);
    const result = await applyEnvironment(paths);
    expect(result.applied).toBe(true);

    const content = fs.readFileSync(patchFile(), 'utf8');
    expect(content).toContain("disabled: !!js env.X === '1'");
    const state = readProfilePatchState(content, 'web');
    expect(state.block?.isDigestValid).toBe(true);
    expect(state.block?.entries.map((entry) => entry.id)).toEqual(['locale', 'expr']);
    expect(state.unmanaged).toEqual([{ id: 'user-owned', config: { a: 1 } }]);
    expect((await applyEnvironment(paths, { dryRun: true })).plan.operations).toEqual([]);

    writeManifest('');
    await applyEnvironment(paths);
    expect(YAML.parse(fs.readFileSync(patchFile(), 'utf8'))).toEqual([{ id: 'user-owned', config: { a: 1 } }]);
  });
});
