import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cloneRemoteRepo, fetchBranch } from '../../src/remote/git.js';
import { loadLock } from '../../src/manifest/files.js';
import { lockEntryDigest } from '../../src/remote/lock-entries.js';
import { compareRemoteKeys, sha256Hex } from '../../src/remote/schema.js';
import { loadRemoteSnapshot } from '../../src/remote/snapshot.js';
import { TEAM_LOCK, TEAM_MANIFEST, TEAM_OVERLAY, commitTeamFiles, createTeamRepo } from '../helpers/team-repo.js';

describe('loadRemoteSnapshot', () => {
  let root: string;
  let repoDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-remote-snapshot-'));
    repoDir = path.join(root, 'repo.git');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function snapshotOf(files: Record<string, string>, remotePath = 'envctl') {
    const team = await createTeamRepo(root, files);
    await cloneRemoteRepo(team.url, repoDir);
    return loadRemoteSnapshot(repoDir, await fetchBranch(repoDir, 'main'), remotePath);
  }

  it('adopts only the manifest, the lock and top-level overlays', async () => {
    const snapshot = await snapshotOf({
      'envctl/manifest.yaml': TEAM_MANIFEST,
      'envctl/lock.json': TEAM_LOCK,
      'envctl/overlays/team.yaml': TEAM_OVERLAY,
      'envctl/overlays/nested/deep.yaml': TEAM_OVERLAY,
      'envctl/overlays/notes.txt': 'notes\n',
      'envctl/state.json': '{}\n',
      'envctl/overlay-selection.json': '{}\n',
      'envctl/dshenv.lock': '{}\n',
      'envctl/backups/x/manifest.yaml': 'old\n',
      'envctl/sources/web/p/package.json': '{}\n',
      'manifest.yaml': 'outside the path\n'
    });
    expect(Object.keys(snapshot.files).sort(compareRemoteKeys)).toEqual(['manifest.yaml', 'overlays/team.yaml']);
    expect(snapshot.digests).toEqual({
      'manifest.yaml': sha256Hex(TEAM_MANIFEST),
      'overlays/team.yaml': sha256Hex(TEAM_OVERLAY)
    });
    expect(snapshot.files['manifest.yaml'].toString('utf8')).toBe(TEAM_MANIFEST);
    expect(snapshot.manifest.profiles.web.plugins.shared.package).toBe('shared-plugin');
    expect(snapshot.lock).toEqual(loadLock(TEAM_LOCK));
    expect(snapshot.lockEntries).toEqual({ web: { shared: lockEntryDigest(loadLock(TEAM_LOCK).profiles.web.plugins.shared) } });
  });

  it('reads the repository root with path "."', async () => {
    const snapshot = await snapshotOf(
      { 'manifest.yaml': TEAM_MANIFEST, 'overlays/team.yaml': TEAM_OVERLAY, 'envctl/manifest.yaml': 'ignored\n' },
      '.'
    );
    expect(Object.keys(snapshot.files).sort(compareRemoteKeys)).toEqual(['manifest.yaml', 'overlays/team.yaml']);
    expect(snapshot.lock).toBeNull();
    expect(snapshot.lockEntries).toEqual({});
  });

  it('refuses a commit without a manifest', async () => {
    await expect(snapshotOf({ 'envctl/lock.json': TEAM_LOCK })).rejects.toThrow(/has no envctl\/manifest\.yaml/);
  });

  it.each([
    ['manifest', { 'envctl/manifest.yaml': 'apiVersion: nope\n' }, /Remote file envctl\/manifest\.yaml: Invalid manifest schema/],
    ['lock', { 'envctl/manifest.yaml': TEAM_MANIFEST, 'envctl/lock.json': '{' }, /Remote file envctl\/lock\.json: Invalid JSON in lock file/],
    [
      'overlay schema',
      { 'envctl/manifest.yaml': TEAM_MANIFEST, 'envctl/overlays/bad.yaml': 'apiVersion: dshenv-overlay/v1\nunknown: 1\n' },
      /Remote file envctl\/overlays\/bad\.yaml: Invalid overlay schema/
    ],
    [
      'unmergeable overlay',
      {
        'envctl/manifest.yaml': TEAM_MANIFEST,
        'envctl/overlays/bad.yaml': 'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      ghost:\n        remove: true\n'
      },
      /Remote file envctl\/overlays\/bad\.yaml: .*cannot remove a plugin that is not in the base manifest/
    ],
    [
      'overlay name',
      { 'envctl/manifest.yaml': TEAM_MANIFEST, 'envctl/overlays/bad name.yaml': 'apiVersion: dshenv-overlay/v1\n' },
      /Remote overlay envctl\/overlays\/bad name\.yaml has an invalid name/
    ],
    [
      'lock with a local-link entry',
      {
        'envctl/manifest.yaml': TEAM_MANIFEST,
        'envctl/lock.json': JSON.stringify({
          apiVersion: 'dshenv-lock/v1',
          profiles: { web: { plugins: { mine: { package: 'mine', source: { type: 'local-link', path: '/home/someone/mine' } } } } }
        })
      },
      /Remote file envctl\/lock\.json: Lock entry 'web\/mine' has a local-link source; a team lock cannot pin machine-local paths/
    ],
    [
      'lock with a local-file entry',
      {
        'envctl/manifest.yaml': TEAM_MANIFEST,
        'envctl/lock.json': JSON.stringify({
          apiVersion: 'dshenv-lock/v1',
          profiles: { cli: { plugins: { pkg: { package: 'pkg', source: { type: 'local-file', path: '/tmp/pkg', digest: 'abc' } } } } }
        })
      },
      /Lock entry 'cli\/pkg' has a local-file source/
    ],
    [
      'manifest with a local-file plugin',
      {
        'envctl/manifest.yaml': `${TEAM_MANIFEST}      mine:\n        package: mine\n        source: { type: local-file, path: /home/someone/mine }\n`
      },
      /^Remote file envctl\/manifest\.yaml: Plugin 'web\/mine' has a local-file source; a team configuration cannot reference machine-local paths$/
    ],
    [
      'overlay with a local-link plugin',
      {
        'envctl/manifest.yaml': TEAM_MANIFEST,
        'envctl/overlays/dev.yaml':
          'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      shared:\n        source: { type: local-link, path: /etc }\n'
      },
      /^Remote file envctl\/overlays\/dev\.yaml: Plugin 'web\/shared' has a local-link source; a team configuration cannot reference machine-local paths$/
    ],
    [
      'pair of overlays differing only by case',
      { 'envctl/manifest.yaml': TEAM_MANIFEST, 'envctl/overlays/Team.yaml': TEAM_OVERLAY, 'envctl/overlays/team.yaml': TEAM_OVERLAY },
      /^Remote overlays envctl\/overlays\/Team\.yaml and envctl\/overlays\/team\.yaml differ only by case$/
    ]
  ])('refuses an invalid %s', async (_label, files, message) => {
    await expect(snapshotOf(files)).rejects.toThrow(message);
  });

  it('refuses a symlink in place of an adopted file', async () => {
    const team = await createTeamRepo(root, { 'envctl/real.yaml': TEAM_MANIFEST });
    fs.symlinkSync('real.yaml', path.join(team.work, 'envctl', 'manifest.yaml'));
    const commit = await commitTeamFiles(team, {}, 'symlink');
    await cloneRemoteRepo(team.url, repoDir);
    await fetchBranch(repoDir, 'main');
    await expect(loadRemoteSnapshot(repoDir, commit, 'envctl')).rejects.toThrow('Remote file envctl/manifest.yaml must be a regular file');
  });
});
