import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import { readJournalEntries } from '../../src/io/journal.js';
import { loadLock, serializeLock } from '../../src/manifest/files.js';
import { cloneRemoteRepo, fetchBranch } from '../../src/remote/git.js';
import { readRemoteConfig, remoteRepoDir } from '../../src/remote/schema.js';
import { acceptSync, prepareSync } from '../../src/remote/sync.js';
import { TEAM_MANIFEST, TEAM_OVERLAY, commitTeamFiles, createTeamRepo, type TeamRepo } from '../helpers/team-repo.js';

const failOn = vi.hoisted(() => ({ file: null as string | null, then: null as string | null }));

vi.mock('../../src/io/atomic-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/io/atomic-file.js')>();
  return {
    ...actual,
    // Fails the first write to one file, like a full disk or a permission error in the middle of a sync.
    writeAtomic: async (file: string, contents: string | Uint8Array, mode?: 'create' | 'overwrite') => {
      if (file === failOn.file) {
        failOn.file = failOn.then;
        failOn.then = null;
        throw new Error(`injected write failure: ${file.split(/[\\/]/).pop()}`);
      }
      return actual.writeAtomic(file, contents, mode);
    }
  };
});

const LOCAL_OVERLAY = 'apiVersion: dshenv-overlay/v1\n';
const TEAM_LOCK_V2 = `${JSON.stringify(
  {
    apiVersion: 'dshenv-lock/v1',
    profiles: { web: { plugins: { shared: { package: 'shared-plugin', source: { type: 'npm', resolvedVersion: '1.1.0' } } } } }
  },
  null,
  2
)}\n`;

describe('acceptSync failure recovery', () => {
  let root: string;
  let paths: EnvironmentPaths;
  let team: TeamRepo;
  let repoDir: string;
  const read = (file: string) => fs.readFileSync(file, 'utf8');
  const overlayFile = (name: string) => path.join(paths.overlaysDir, `${name}.yaml`);

  beforeEach(async () => {
    failOn.file = null;
    failOn.then = null;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-remote-sync-restore-'));
    paths = resolveEnvironmentPaths({ cliDshHome: path.join(root, 'home') });
    team = await createTeamRepo(root);
    repoDir = remoteRepoDir(paths);
    await cloneRemoteRepo(team.url, repoDir);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function prepare(replace = false) {
    return prepareSync({
      paths,
      repoDir,
      subscription: { url: team.url, branch: 'main', path: 'envctl' },
      target: await fetchBranch(repoDir, 'main'),
      previous: readRemoteConfig(paths),
      replace,
      selection: null
    });
  }

  // A subscribed environment whose lock also holds a local entry.
  async function subscribeWithLocalEntry(): Promise<void> {
    await acceptSync(paths, await prepare());
    const lock = loadLock(read(paths.lockFile));
    lock.profiles.web.plugins.tool = { package: 'tool', source: { type: 'npm', resolvedVersion: '1.0.0' } };
    fs.writeFileSync(paths.lockFile, serializeLock(lock));
    fs.writeFileSync(overlayFile('mine'), LOCAL_OVERLAY);
  }

  it('restores every file and the pinned commit when a file write fails midway', async () => {
    await subscribeWithLocalEntry();
    const remoteBefore = read(paths.remoteFile);
    const lockBefore = read(paths.lockFile);
    await commitTeamFiles(
      team,
      {
        'envctl/manifest.yaml': `${TEAM_MANIFEST}# v2\n`,
        'envctl/overlays/a-new.yaml': TEAM_OVERLAY,
        'envctl/overlays/team.yaml': `${TEAM_OVERLAY}# v2\n`
      },
      'v2'
    );
    const preview = await prepare();
    failOn.file = overlayFile('team');

    await expect(acceptSync(paths, preview)).rejects.toThrow('injected write failure');
    expect(read(paths.manifestFile)).toBe(TEAM_MANIFEST);
    expect(read(overlayFile('team'))).toBe(TEAM_OVERLAY);
    expect(fs.existsSync(overlayFile('a-new'))).toBe(false);
    expect(read(overlayFile('mine'))).toBe(LOCAL_OVERLAY);
    expect(read(paths.lockFile)).toBe(lockBefore);
    expect(read(paths.remoteFile)).toBe(remoteBefore);
    expect((await readJournalEntries(paths)).map((entry) => entry.type)).toContain('sync-rollback');
  });

  it('restores the files and the lock when writing the merged lock fails', async () => {
    await subscribeWithLocalEntry();
    const remoteBefore = read(paths.remoteFile);
    const lockBefore = read(paths.lockFile);
    await commitTeamFiles(team, { 'envctl/manifest.yaml': `${TEAM_MANIFEST}# v2\n`, 'envctl/lock.json': TEAM_LOCK_V2 }, 'v2');
    const preview = await prepare();
    expect(preview.lockEntries.modified).toEqual(['web/shared']);
    failOn.file = paths.lockFile;

    await expect(acceptSync(paths, preview)).rejects.toThrow('injected write failure');
    expect(read(paths.manifestFile)).toBe(TEAM_MANIFEST);
    expect(read(paths.lockFile)).toBe(lockBefore);
    expect(read(paths.remoteFile)).toBe(remoteBefore);
  });

  it('brings back a removed overlay when writing remote.json fails', async () => {
    await subscribeWithLocalEntry();
    const remoteBefore = read(paths.remoteFile);
    const lockBefore = read(paths.lockFile);
    await commitTeamFiles(
      team,
      { 'envctl/manifest.yaml': `${TEAM_MANIFEST}# v2\n`, 'envctl/overlays/team.yaml': null, 'envctl/lock.json': TEAM_LOCK_V2 },
      'v2'
    );
    const preview = await prepare();
    expect(preview.files.removed).toEqual(['overlays/team.yaml']);
    failOn.file = paths.remoteFile;

    await expect(acceptSync(paths, preview)).rejects.toThrow('injected write failure: remote.json');
    expect(read(paths.manifestFile)).toBe(TEAM_MANIFEST);
    expect(read(overlayFile('team'))).toBe(TEAM_OVERLAY);
    expect(read(overlayFile('mine'))).toBe(LOCAL_OVERLAY);
    expect(read(paths.lockFile)).toBe(lockBefore);
    expect(read(paths.remoteFile)).toBe(remoteBefore);
    expect((await readJournalEntries(paths)).map((entry) => entry.type)).toContain('sync-rollback');
  });

  it('removes new files and leaves no remote.json when a first subscription fails', async () => {
    fs.mkdirSync(paths.overlaysDir, { recursive: true });
    fs.writeFileSync(paths.manifestFile, 'apiVersion: dshenv/v1\nprofiles: {}\n');
    const preview = await prepare(true);
    failOn.file = overlayFile('team');

    await expect(acceptSync(paths, preview)).rejects.toThrow('injected write failure');
    expect(read(paths.manifestFile)).toBe('apiVersion: dshenv/v1\nprofiles: {}\n');
    expect(fs.existsSync(paths.lockFile)).toBe(false);
    expect(fs.existsSync(overlayFile('team'))).toBe(false);
    expect(fs.existsSync(paths.remoteFile)).toBe(false);
  });

  it('names the rollback command when restoring the snapshot also fails', async () => {
    await subscribeWithLocalEntry();
    await commitTeamFiles(team, { 'envctl/manifest.yaml': `${TEAM_MANIFEST}# v2\n`, 'envctl/overlays/team.yaml': `${TEAM_OVERLAY}# v2\n` }, 'v2');
    const preview = await prepare();
    failOn.file = overlayFile('team');
    failOn.then = paths.manifestFile;

    const err = await acceptSync(paths, preview).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const entries = await readJournalEntries(paths);
    const started = entries.find((entry) => entry.type === 'sync-started' && entry.details?.to === preview.to);
    const operationId = started!.operationId;
    expect((err as Error).message).toBe(
      'injected write failure: team.yaml; restoring the snapshot also failed (injected write failure: manifest.yaml), ' +
        `run dshenv rollback ${operationId} --yes`
    );
    expect(entries.filter((entry) => entry.operationId === operationId).map((entry) => entry.type)).toEqual([
      'sync-started',
      'sync-rollback-failed'
    ]);
  });
});
