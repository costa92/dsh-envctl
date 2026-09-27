import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { setProfileBundleEnabled } from '../../src/apply/bundles.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';

describe('setProfileBundleEnabled profile lock', () => {
  let tempHome: string;
  let packageJson: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-bundles-lock-'));
    const profileDir = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(profileDir, { recursive: true });
    packageJson = path.join(profileDir, 'package.json');
    fs.writeFileSync(packageJson, JSON.stringify({ dsh: { profile: { bundles: ['a'] } } }));
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  const bundles = (): string[] =>
    (JSON.parse(fs.readFileSync(packageJson, 'utf8')) as { dsh: { profile: { bundles: string[] } } }).dsh.profile.bundles;

  it('writes package.json while holding package.json.lock and releases it', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    expect(await setProfileBundleEnabled(paths, 'web', 'b', true)).toBe(-1);
    expect(bundles()).toEqual(['a', 'b']);
    expect(fs.existsSync(`${packageJson}.lock`)).toBe(false);
  });

  it('waits for a lock held by DSH before reading package.json', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.writeFileSync(`${packageJson}.lock`, '999999\n', { mode: 0o600 });
    // DSH finishes its own write (adding c) and releases the lock; dshenv must build on that write.
    setTimeout(() => {
      fs.writeFileSync(packageJson, JSON.stringify({ dsh: { profile: { bundles: ['a', 'c'] } } }));
      fs.rmSync(`${packageJson}.lock`, { force: true });
    }, 300);
    expect(await setProfileBundleEnabled(paths, 'web', 'b', true)).toBe(-1);
    expect(bundles()).toEqual(['a', 'c', 'b']);
    expect(fs.existsSync(`${packageJson}.lock`)).toBe(false);
  });
});
