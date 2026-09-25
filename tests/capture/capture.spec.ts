import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { captureEnvironment, initEnvironment } from '../../src/capture/capture.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';
import { readEnvironmentInventory } from '../../src/inventory/profile-reader.js';

describe('captureEnvironment and initEnvironment', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-capture-test-'));
    const webProfile = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(path.join(webProfile, 'node_modules', '@nanmicoder', 'dsh-agent-teams'), { recursive: true });

    fs.writeFileSync(
      path.join(webProfile, 'profile.json'),
      JSON.stringify({
        name: 'web',
        plugins: {
          '@nanmicoder/dsh-agent-teams': { enabled: true }
        }
      })
    );

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

  it('should capture environment accurately without creating state.json', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const inventory = await readEnvironmentInventory(paths);
    const doc = captureEnvironment(paths, inventory);

    expect(doc.apiVersion).toBe('dshenv-capture/v1');
    expect(doc.manifest.apiVersion).toBe('dshenv/v1');
    expect(doc.lock.apiVersion).toBe('dshenv-lock/v1');
    expect(doc.manifest.profiles.web.plugins['agent-teams']).toBeDefined();
    expect(doc.manifest.profiles.web.plugins['agent-teams'].package).toBe('@nanmicoder/dsh-agent-teams');
    expect(doc.manifest.profiles.web.plugins['agent-teams'].source).toEqual({
      type: 'npm',
      version: '0.1.21'
    });

    // Ensure state.json was not created
    expect(fs.existsSync(paths.stateFile)).toBe(false);
  });

  it('should initialize empty environment when files do not exist', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    await initEnvironment(paths);

    expect(fs.existsSync(paths.manifestFile)).toBe(true);
    expect(fs.existsSync(paths.lockFile)).toBe(true);
    expect(fs.existsSync(paths.stateFile)).toBe(true);

    // Re-running init should fail
    await expect(initEnvironment(paths)).rejects.toThrow();
  });
});
