import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EnvironmentPaths } from '../../src/environment/paths.js';
import { loadLock, serializeLock } from '../../src/manifest/files.js';
import {
  assertLockEntryNotRemoteOwned,
  assertNotRemoteOwned,
  describeRemoteDrift,
  findLocalDrift,
  findRemoteLockDrift,
  remoteOwnedKey
} from '../../src/remote/ownership.js';
import { readRemoteConfig, type RemoteConfig } from '../../src/remote/schema.js';
import { FIXTURE_REMOTE_URL, writeRemoteOwnedFixture } from '../helpers/remote-fixture.js';

describe('remote ownership', () => {
  let home: string;
  let paths: EnvironmentPaths;
  let config: RemoteConfig;
  const overlayFile = (name: string) => path.join(paths.overlaysDir, `${name}.yaml`);

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-remote-ownership-'));
    paths = await writeRemoteOwnedFixture(home);
    config = readRemoteConfig(paths)!;
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('reports no drift for untouched files and entries', () => {
    expect(findLocalDrift(paths, config)).toEqual([]);
    expect(findRemoteLockDrift(paths, config)).toEqual([]);
  });

  it('reports modified and missing owned files and ignores local overlays', () => {
    fs.appendFileSync(overlayFile('team'), '# local edit\n');
    fs.rmSync(paths.manifestFile);
    fs.appendFileSync(overlayFile('mine'), '# local edit\n');
    expect(findLocalDrift(paths, config)).toEqual([
      { file: 'manifest.yaml', status: 'missing' },
      { file: 'overlays/team.yaml', status: 'modified' }
    ]);
  });

  it('reports team lock entries changed locally, but not local entries or reformatting', () => {
    const lock = loadLock(fs.readFileSync(paths.lockFile, 'utf8'));
    fs.writeFileSync(paths.lockFile, serializeLock(lock));
    expect(findRemoteLockDrift(paths, config)).toEqual([]);

    delete lock.profiles.web.plugins.shared;
    lock.profiles.web.plugins.demo = {
      package: 'demo-plugin',
      source: { type: 'git', url: 'file:///nonexistent/demo-plugin.git', commit: 'c'.repeat(40) }
    };
    lock.profiles.web.plugins.tool = { package: 'tool', source: { type: 'npm', resolvedVersion: '1.0.0' } };
    fs.writeFileSync(paths.lockFile, serializeLock(lock));
    const entries = findRemoteLockDrift(paths, config);
    expect(entries).toEqual([
      { entry: 'web/demo', status: 'modified' },
      { entry: 'web/shared', status: 'missing' }
    ]);
    expect(describeRemoteDrift([{ file: 'overlays/team.yaml', status: 'modified' }], entries)).toEqual([
      'overlays/team.yaml (modified)',
      'lock entry web/demo (modified)',
      'lock entry web/shared (missing)'
    ]);

    fs.rmSync(paths.lockFile);
    expect(findRemoteLockDrift(paths, config).map((entry) => entry.status)).toEqual(['missing', 'missing']);
  });

  it('refuses to guess about an unparseable local lock', () => {
    fs.writeFileSync(paths.lockFile, '{');
    expect(() => findRemoteLockDrift(paths, config)).toThrow(
      `Cannot parse local lock file ${paths.lockFile}: Invalid JSON in lock file`
    );
  });

  it('names the owner of each guarded file and leaves lock.json to the entry guard', () => {
    expect(remoteOwnedKey(paths, config, paths.manifestFile)).toBe('manifest.yaml');
    expect(remoteOwnedKey(paths, config, overlayFile('mine'))).toBeNull();
    expect(remoteOwnedKey(paths, config, paths.lockFile)).toBeNull();
    expect(() => assertNotRemoteOwned(paths, paths.manifestFile)).toThrow(
      `The base manifest is owned by remote ${FIXTURE_REMOTE_URL}; put local changes in a local overlay and write with --layer overlay`
    );
    expect(() => assertNotRemoteOwned(paths, overlayFile('team'))).toThrow(
      `Overlay 'team' is owned by remote ${FIXTURE_REMOTE_URL}; use a local overlay with a different name`
    );
    expect(() => assertNotRemoteOwned(paths, overlayFile('mine'))).not.toThrow();
    expect(() => assertNotRemoteOwned(paths, paths.lockFile)).not.toThrow();
  });

  it('guards only the entries the team lock pins', () => {
    expect(() => assertLockEntryNotRemoteOwned(paths, 'web', 'shared')).toThrow(
      `Lock entry 'web/shared' is pinned by the team lock of remote ${FIXTURE_REMOTE_URL}; change it in the team repository and run dshenv sync`
    );
    expect(() => assertLockEntryNotRemoteOwned(paths, 'web', 'tool')).not.toThrow();
    expect(() => assertLockEntryNotRemoteOwned(paths, 'cli', 'shared')).not.toThrow();
  });

  it('allows everything without remote.json', () => {
    fs.rmSync(paths.remoteFile);
    expect(() => assertNotRemoteOwned(paths, paths.manifestFile)).not.toThrow();
    expect(() => assertLockEntryNotRemoteOwned(paths, 'web', 'shared')).not.toThrow();
  });
});
