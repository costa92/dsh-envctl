import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { readEnvironmentInventory } from '../../src/inventory/profile-reader.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';

describe('readEnvironmentInventory', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-inv-test-'));
    const webProfile = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(path.join(webProfile, 'node_modules', '@nanmicoder', 'dsh-agent-teams'), { recursive: true });

    // Write profile.json
    fs.writeFileSync(
      path.join(webProfile, 'profile.json'),
      JSON.stringify({
        name: 'web',
        plugins: {
          '@nanmicoder/dsh-agent-teams': {
            enabled: true
          },
          'missing-plugin': {
            enabled: true
          }
        }
      })
    );

    // Write package.json for @nanmicoder/dsh-agent-teams
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

  it('should inventory profiles and classify sources without network', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const inventory = await readEnvironmentInventory(paths);

    expect(inventory.profiles.web).toBeDefined();
    const web = inventory.profiles.web;
    expect(web.plugins['@nanmicoder/dsh-agent-teams']).toBeDefined();
    expect(web.plugins['@nanmicoder/dsh-agent-teams'].installed).toBe(true);
    expect(web.plugins['@nanmicoder/dsh-agent-teams'].version).toBe('0.1.21');
    expect(web.plugins['@nanmicoder/dsh-agent-teams'].sourceType).toBe('npm');

    expect(web.plugins['missing-plugin']).toBeDefined();
    expect(web.plugins['missing-plugin'].installed).toBe(false);
  });

  it('should detect symlinks and classify local links safely', async () => {
    const localDir = path.join(tempHome, 'local-pkg');
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(
      path.join(localDir, 'package.json'),
      JSON.stringify({ name: 'my-local-pkg', version: '1.0.0' })
    );

    const webProfile = path.join(tempHome, 'profiles', 'web');
    fs.symlinkSync(localDir, path.join(webProfile, 'node_modules', 'my-local-pkg'), 'dir');

    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const inventory = await readEnvironmentInventory(paths);

    const pkg = inventory.profiles.web.plugins['my-local-pkg'];
    expect(pkg).toBeDefined();
    expect(pkg.installed).toBe(true);
    expect(pkg.isSymlink).toBe(true);
    expect(pkg.isExternalSymlink).toBe(true);
    expect(pkg.sourceType).toBe('local-link');
  });
});
