import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EnvironmentLock, PluginLockEntry } from '../../src/domain.js';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import { readJournalEntries } from '../../src/io/journal.js';
import { loadLock, serializeLock } from '../../src/manifest/files.js';
import type { OverlaySelection } from '../../src/overlay/selection.js';
import { cloneRemoteRepo, fetchBranch } from '../../src/remote/git.js';
import { lockEntryDigest } from '../../src/remote/lock-entries.js';
import { readRemoteConfig, remoteRepoDir, sha256Hex } from '../../src/remote/schema.js';
import { acceptSync, prepareSync } from '../../src/remote/sync.js';
import {
  TEAM_LOCK,
  TEAM_MANIFEST,
  TEAM_OVERLAY,
  commitTeamFiles,
  createTeamRepo,
  rewriteTeamHistory,
  type TeamRepo
} from '../helpers/team-repo.js';

const LOCAL_OVERLAY = 'apiVersion: dshenv-overlay/v1\n';
const NO_ENTRY_CHANGES = { added: [], modified: [], removed: [] };
const npmEntry = (pkg: string, version: string): PluginLockEntry => ({ package: pkg, source: { type: 'npm', resolvedVersion: version } });
const lockOf = (profiles: Record<string, Record<string, PluginLockEntry>>): EnvironmentLock => ({
  apiVersion: 'dshenv-lock/v1',
  profiles: Object.fromEntries(Object.entries(profiles).map(([profile, plugins]) => [profile, { plugins }]))
});
const teamLock = (plugins: Record<string, PluginLockEntry>) => `${JSON.stringify(lockOf({ web: plugins }), null, 2)}\n`;

describe('remote sync engine', () => {
  let root: string;
  let paths: EnvironmentPaths;
  let team: TeamRepo;
  let repoDir: string;
  const read = (file: string) => fs.readFileSync(file, 'utf8');
  const overlayFile = (name: string) => path.join(paths.overlaysDir, `${name}.yaml`);
  const readLock = () => loadLock(read(paths.lockFile));
  const writeLock = (lock: EnvironmentLock) => {
    fs.mkdirSync(paths.managerDir, { recursive: true });
    fs.writeFileSync(paths.lockFile, serializeLock(lock));
  };

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-remote-sync-'));
    paths = resolveEnvironmentPaths({ cliDshHome: path.join(root, 'home') });
    team = await createTeamRepo(root);
    repoDir = remoteRepoDir(paths);
    await cloneRemoteRepo(team.url, repoDir);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function prepare(
    options: { previous?: boolean; replace?: boolean; discardLocalChanges?: boolean; selection?: OverlaySelection | null } = {}
  ) {
    return prepareSync({
      paths,
      repoDir,
      subscription: { url: team.url, branch: 'main', path: 'envctl' },
      target: await fetchBranch(repoDir, 'main'),
      previous: options.previous ? readRemoteConfig(paths) : null,
      replace: options.replace,
      discardLocalChanges: options.discardLocalChanges,
      selection: options.selection ?? null
    });
  }

  async function subscribe(): Promise<string> {
    const preview = await prepare();
    await acceptSync(paths, preview);
    return preview.to;
  }

  it('previews a first subscription without writing anything', async () => {
    const preview = await prepare();
    expect(preview.status).toBe('pending');
    expect(preview.from).toBeNull();
    expect(preview.files).toEqual({ added: ['manifest.yaml', 'overlays/team.yaml'], modified: [], removed: [] });
    expect(preview.lockEntries).toEqual({ added: ['web/shared'], modified: [], removed: [] });
    expect(preview.plan.operations.some((op) => op.kind === 'install' && op.alias === 'shared')).toBe(true);
    expect(fs.existsSync(paths.manifestFile)).toBe(false);
    expect(fs.existsSync(paths.lockFile)).toBe(false);
    expect(fs.existsSync(paths.remoteFile)).toBe(false);
  });

  it('accepts: writes the files byte for byte, merges the lock, pins the commit and journals the sync', async () => {
    const commit = await subscribe();
    expect(read(paths.manifestFile)).toBe(TEAM_MANIFEST);
    expect(read(overlayFile('team'))).toBe(TEAM_OVERLAY);
    expect(readLock()).toEqual(loadLock(TEAM_LOCK));
    expect(fs.existsSync(paths.stateFile)).toBe(false);
    expect(readRemoteConfig(paths)).toEqual({
      apiVersion: 'dshenv-remote/v1',
      url: team.url,
      branch: 'main',
      path: 'envctl',
      commit,
      files: {
        'manifest.yaml': sha256Hex(TEAM_MANIFEST),
        'overlays/team.yaml': sha256Hex(TEAM_OVERLAY)
      },
      lockEntries: { web: { shared: lockEntryDigest(loadLock(TEAM_LOCK).profiles.web.plugins.shared) } }
    });
    expect((await readJournalEntries(paths)).map((entry) => entry.type)).toEqual(['sync-started', 'sync-completed']);
  });

  it('refuses existing local files unless replacing', async () => {
    fs.mkdirSync(paths.overlaysDir, { recursive: true });
    fs.writeFileSync(paths.manifestFile, 'apiVersion: dshenv/v1\nprofiles: {}\n');
    await expect(prepare()).rejects.toThrow(
      `Local file ${paths.manifestFile} already exists; pass --replace to overwrite it with the remote copy (a snapshot is taken first)`
    );
    fs.rmSync(paths.manifestFile);
    fs.writeFileSync(overlayFile('team'), LOCAL_OVERLAY);
    await expect(prepare()).rejects.toThrow(`Local file ${overlayFile('team')} already exists`);
    expect((await prepare({ replace: true })).files.added).toContain('overlays/team.yaml');
  });

  it('keeps local lock entries on the first subscription', async () => {
    writeLock(lockOf({ web: { tool: npmEntry('tool', '1.0.0') }, cli: { helper: npmEntry('helper', '1.0.0') } }));
    const preview = await prepare();
    expect(preview.lockEntries).toEqual({ added: ['web/shared'], modified: [], removed: [] });
    await acceptSync(paths, preview);
    expect(readLock()).toEqual(lockOf({
      web: { shared: npmEntry('shared-plugin', '1.0.0'), tool: npmEntry('tool', '1.0.0') },
      cli: { helper: npmEntry('helper', '1.0.0') }
    }));
    expect(Object.keys(readRemoteConfig(paths)!.lockEntries)).toEqual(['web']);
  });

  it('refuses a local lock entry the team lock would replace unless replacing', async () => {
    writeLock(lockOf({ web: { shared: npmEntry('shared-plugin', '0.9.0') } }));
    await expect(prepare()).rejects.toThrow(
      "Local lock entry 'web/shared' already exists; pass --replace to overwrite it with the remote entry (a snapshot is taken first)"
    );
    const preview = await prepare({ replace: true });
    expect(preview.lockEntries.added).toEqual(['web/shared']);
    expect(preview.lock).toEqual(loadLock(TEAM_LOCK));
  });

  it('creates no lock file when neither side has one', async () => {
    await commitTeamFiles(team, { 'envctl/lock.json': null }, 'no lock');
    const preview = await prepare();
    expect(preview.lockEntries).toEqual(NO_ENTRY_CHANGES);
    expect(preview.lock).toBeNull();
    await acceptSync(paths, preview);
    expect(fs.existsSync(paths.lockFile)).toBe(false);
    expect(readRemoteConfig(paths)!.lockEntries).toEqual({});
  });

  it('is up to date when the pinned commit is current and nothing changed locally', async () => {
    const commit = await subscribe();
    expect(await prepare({ previous: true })).toMatchObject({
      status: 'up-to-date',
      from: commit,
      to: commit,
      files: NO_ENTRY_CHANGES,
      lockEntries: NO_ENTRY_CHANGES
    });
  });

  it('is still up to date after local entries are added to the lock', async () => {
    await subscribe();
    const lock = readLock();
    lock.profiles.web.plugins.tool = { package: 'tool', source: { type: 'local-link', path: '/opt/tool', digest: 'd1' } };
    writeLock(lock);
    expect((await prepare({ previous: true })).status).toBe('up-to-date');
  });

  it('classifies added, modified and removed files', async () => {
    await subscribe();
    await commitTeamFiles(
      team,
      { 'envctl/manifest.yaml': `${TEAM_MANIFEST}# v2\n`, 'envctl/overlays/team.yaml': null, 'envctl/overlays/new.yaml': TEAM_OVERLAY },
      'v2'
    );
    const preview = await prepare({ previous: true });
    expect(preview.status).toBe('pending');
    expect(preview.files).toEqual({ added: ['overlays/new.yaml'], modified: ['manifest.yaml'], removed: ['overlays/team.yaml'] });
    expect(preview.lockEntries).toEqual(NO_ENTRY_CHANGES);
  });

  it('syncs team skills file by file and removes emptied skill directories', async () => {
    await subscribe();
    await commitTeamFiles(team, { 'envctl/skills/wiki/SKILL.md': 'v1', 'envctl/skills/wiki/refs/a.md': 'ref' }, 'skills');
    const added = await prepare({ previous: true });
    expect(added.files.added).toEqual(['skills/wiki/SKILL.md', 'skills/wiki/refs/a.md']);
    await acceptSync(paths, added);
    expect(read(path.join(paths.skillsDir, 'wiki', 'refs', 'a.md'))).toBe('ref');

    await commitTeamFiles(team, { 'envctl/skills/wiki/SKILL.md': null, 'envctl/skills/wiki/refs/a.md': null }, 'drop skill');
    await acceptSync(paths, await prepare({ previous: true }));
    expect(fs.existsSync(path.join(paths.skillsDir, 'wiki'))).toBe(false);
  });

  it('keeps a team skill script executable', async () => {
    await subscribe();
    const script = path.join(team.work, 'envctl', 'skills', 'wiki', 'run.sh');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, '#!/bin/sh\n', { mode: 0o755 });
    await commitTeamFiles(team, { 'envctl/skills/wiki/SKILL.md': 'v1' }, 'skills');
    await acceptSync(paths, await prepare({ previous: true }));
    expect(fs.statSync(path.join(paths.skillsDir, 'wiki', 'run.sh')).mode & 0o111).not.toBe(0);
    expect(fs.statSync(path.join(paths.skillsDir, 'wiki', 'SKILL.md')).mode & 0o111).toBe(0);
  });

  it('plans the skill changes a sync brings before it is accepted', async () => {
    await subscribe();
    await commitTeamFiles(team, { 'envctl/skills/wiki/SKILL.md': 'v1' }, 'skills');
    const added = await prepare({ previous: true });
    expect(added.plan.skillOperations).toMatchObject([{ kind: 'install', name: 'wiki' }]);
    expect(fs.existsSync(paths.skillsDir)).toBe(false);

    await acceptSync(paths, added);
    fs.cpSync(path.join(paths.skillsDir, 'wiki'), path.join(paths.dshSkillsDir, 'wiki'), { recursive: true });
    await commitTeamFiles(team, { 'envctl/skills/wiki/SKILL.md': 'v2' }, 'edit skill');
    expect((await prepare({ previous: true })).plan.skillOperations).toMatchObject([{ kind: 'update', name: 'wiki' }]);

    await commitTeamFiles(team, { 'envctl/skills/wiki/SKILL.md': null }, 'drop skill');
    const dropped = (await prepare({ previous: true })).plan;
    expect(dropped.skillOperations).toEqual([]);
    expect(dropped.unmanagedSkills).toEqual(['wiki']);
  });

  it('merges team lock updates entry by entry and keeps local entries', async () => {
    await subscribe();
    const lock = readLock();
    lock.profiles.web.plugins.tool = npmEntry('tool', '1.0.0');
    writeLock(lock);
    await commitTeamFiles(
      team,
      { 'envctl/lock.json': teamLock({ shared: npmEntry('shared-plugin', '1.1.0'), extra: npmEntry('extra-plugin', '1.0.0') }) },
      'lock v2'
    );
    const preview = await prepare({ previous: true });
    expect(preview.status).toBe('pending');
    expect(preview.files).toEqual(NO_ENTRY_CHANGES);
    expect(preview.lockEntries).toEqual({ added: ['web/extra'], modified: ['web/shared'], removed: [] });
    await acceptSync(paths, preview);
    expect(readLock()).toEqual(lockOf({
      web: { shared: npmEntry('shared-plugin', '1.1.0'), extra: npmEntry('extra-plugin', '1.0.0'), tool: npmEntry('tool', '1.0.0') }
    }));
    expect(Object.keys(readRemoteConfig(paths)!.lockEntries.web)).toEqual(['extra', 'shared']);

    await commitTeamFiles(team, { 'envctl/lock.json': null }, 'drop lock');
    const dropped = await prepare({ previous: true });
    expect(dropped.lockEntries).toEqual({ added: [], modified: [], removed: ['web/extra', 'web/shared'] });
    await acceptSync(paths, dropped);
    expect(readLock()).toEqual(lockOf({ web: { tool: npmEntry('tool', '1.0.0') } }));
    expect(readRemoteConfig(paths)!.lockEntries).toEqual({});
  });

  it('keeps an emptied lock file and local overlays when the remote stops providing a lock', async () => {
    await subscribe();
    fs.writeFileSync(overlayFile('mine'), LOCAL_OVERLAY);
    await commitTeamFiles(team, { 'envctl/lock.json': null }, 'drop lock');
    const preview = await prepare({ previous: true });
    expect(preview.files).toEqual(NO_ENTRY_CHANGES);
    expect(preview.lockEntries).toEqual({ added: [], modified: [], removed: ['web/shared'] });
    await acceptSync(paths, preview);
    expect(readLock()).toEqual(lockOf({}));
    expect(read(overlayFile('mine'))).toBe(LOCAL_OVERLAY);
    expect(Object.keys(readRemoteConfig(paths)!.files)).toEqual(['manifest.yaml', 'overlays/team.yaml']);
  });

  it('refuses a non fast-forward update', async () => {
    await subscribe();
    await rewriteTeamHistory(team, { 'envctl/manifest.yaml': `${TEAM_MANIFEST}# rewritten\n` });
    await expect(prepare({ previous: true })).rejects.toThrow(/does not descend from the pinned commit/);
  });

  it('refuses local edits to owned files and entries unless discarding them', async () => {
    await subscribe();
    fs.appendFileSync(paths.manifestFile, '# local edit\n');
    fs.rmSync(overlayFile('team'));
    const lock = readLock();
    lock.profiles.web.plugins.shared = npmEntry('shared-plugin', '9.9.9');
    lock.profiles.web.plugins.tool = npmEntry('tool', '1.0.0');
    writeLock(lock);
    await expect(prepare({ previous: true })).rejects.toThrow(
      'Remote-owned files and lock entries were changed locally: manifest.yaml (modified), overlays/team.yaml (missing), lock entry web/shared (modified); move the changes into a local overlay, or pass --discard-local-changes to overwrite them'
    );
    const preview = await prepare({ previous: true, discardLocalChanges: true });
    expect(preview.status).toBe('pending');
    expect(preview.files.modified).toEqual(['manifest.yaml', 'overlays/team.yaml']);
    expect(preview.lockEntries.modified).toEqual(['web/shared']);
    await acceptSync(paths, preview);
    expect(read(paths.manifestFile)).toBe(TEAM_MANIFEST);
    expect(read(overlayFile('team'))).toBe(TEAM_OVERLAY);
    expect(readLock()).toEqual(lockOf({ web: { shared: npmEntry('shared-plugin', '1.0.0'), tool: npmEntry('tool', '1.0.0') } }));
  });

  it('refuses an unparseable local lock, even when discarding local changes', async () => {
    await subscribe();
    fs.writeFileSync(paths.lockFile, '{');
    for (const discardLocalChanges of [false, true]) {
      await expect(prepare({ previous: true, discardLocalChanges })).rejects.toThrow(
        `Cannot parse local lock file ${paths.lockFile}: Invalid JSON in lock file`
      );
    }
    expect(read(paths.lockFile)).toBe('{');
  });

  it('refuses a new remote file that clashes with a local one', async () => {
    await subscribe();
    fs.writeFileSync(overlayFile('new'), LOCAL_OVERLAY);
    await commitTeamFiles(team, { 'envctl/overlays/new.yaml': TEAM_OVERLAY }, 'add new');
    await expect(prepare({ previous: true })).rejects.toThrow(
      `Local file ${overlayFile('new')} is not owned by the remote, but the remote now provides it; move it aside, then sync again`
    );
  });

  it('refuses a new team lock entry that clashes with a local entry', async () => {
    await subscribe();
    const lock = readLock();
    lock.profiles.web.plugins.extra = npmEntry('extra-plugin', '0.9.0');
    writeLock(lock);
    await commitTeamFiles(
      team,
      { 'envctl/lock.json': teamLock({ shared: npmEntry('shared-plugin', '1.0.0'), extra: npmEntry('extra-plugin', '1.0.0') }) },
      'pin extra'
    );
    for (const discardLocalChanges of [false, true]) {
      await expect(prepare({ previous: true, discardLocalChanges })).rejects.toThrow(
        "Local lock entry 'web/extra' is not owned by the remote, but the remote lock now pins it; remove the local entry, then sync again"
      );
    }
  });

  it('previews the plan with the active local overlay and refuses to remove the active overlay', async () => {
    await subscribe();
    fs.writeFileSync(
      overlayFile('laptop'),
      'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      laptop:\n        package: laptop-plugin\n        source: { type: npm, version: "1.0.0" }\n'
    );
    await commitTeamFiles(team, { 'envctl/overlays/team.yaml': null }, 'drop team overlay');
    const preview = await prepare({ previous: true, selection: { name: 'laptop', via: 'flag' } });
    expect(preview.plan.operations.some((op) => op.kind === 'install' && op.alias === 'laptop')).toBe(true);
    await expect(prepare({ previous: true, selection: { name: 'team', via: 'file' } })).rejects.toThrow(
      "The active overlay 'team' is removed by the remote; select another overlay with dshenv overlay use, then sync again"
    );
  });

  it('refuses an update the active local overlay no longer merges with', async () => {
    await subscribe();
    fs.writeFileSync(overlayFile('laptop'), 'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      shared:\n        enabled: true\n');
    await commitTeamFiles(
      team,
      { 'envctl/manifest.yaml': 'apiVersion: dshenv/v1\nprofiles: {}\n', 'envctl/lock.json': null, 'envctl/overlays/team.yaml': null },
      'empty base'
    );
    await expect(prepare({ previous: true, selection: { name: 'laptop', via: 'flag' } })).rejects.toThrow(/must declare package and source/);
  });
});
