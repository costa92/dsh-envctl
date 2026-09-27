import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from '../../src/cli.js';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import { loadLock, serializeLock } from '../../src/manifest/files.js';
import { lockEntryDigest } from '../../src/remote/lock-entries.js';
import { readRemoteConfig, sha256Hex } from '../../src/remote/schema.js';
import {
  TEAM_LOCK,
  TEAM_MANIFEST,
  TEAM_OVERLAY,
  commitTeamFiles,
  commitTeamSideBranch,
  createTeamRepo,
  teamHead,
  type TeamRepo
} from '../helpers/team-repo.js';

const LOCAL_MANIFEST = 'apiVersion: dshenv/v1\nprofiles: {}\n';
const LOCAL_TEAM_OVERLAY = 'apiVersion: dshenv-overlay/v1\n# local team overlay\n';

describe('CLI remote', () => {
  let root: string;
  let home: string;
  let paths: EnvironmentPaths;
  let team: TeamRepo;
  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', home], {
      stdout: (chunk) => { stdout += chunk; },
      stderr: (chunk) => { stderr += chunk; }
    });
    return { code, stdout, stderr };
  };
  const read = (file: string) => fs.readFileSync(file, 'utf8');
  const overlayFile = (name: string) => path.join(paths.overlaysDir, `${name}.yaml`);

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-remote-'));
    home = path.join(root, 'home');
    paths = resolveEnvironmentPaths({ cliDshHome: home });
    team = await createTeamRepo(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('previews a subscription with exit 2 and leaves nothing behind', async () => {
    const { code, stdout } = await run(['remote', 'add', team.url]);
    expect(code).toBe(2);
    expect(stdout).toContain('Files:\n  + manifest.yaml\n  + overlays/team.yaml\n');
    expect(stdout).toContain('Lock entries:\n  + web/shared\n');
    expect(stdout).toContain('+ [web] shared-plugin (shared)');
    expect(stdout).toContain('Re-run with --yes to accept.');
    expect(fs.existsSync(paths.manifestFile)).toBe(false);
    expect(fs.existsSync(paths.remoteFile)).toBe(false);
    expect(fs.existsSync(paths.remoteDir)).toBe(false);
  });

  it('reports the preview as JSON', async () => {
    const { code, stdout } = await run(['remote', 'add', team.url, '--json']);
    expect(code).toBe(2);
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({
      status: 'pending',
      url: team.url,
      branch: 'main',
      path: 'envctl',
      from: null,
      to: await teamHead(team),
      files: { added: ['manifest.yaml', 'overlays/team.yaml'], modified: [], removed: [] },
      lockEntries: { added: ['web/shared'], modified: [], removed: [] }
    });
    expect(Object.keys(parsed)).toEqual(['status', 'url', 'branch', 'path', 'from', 'to', 'files', 'lockEntries', 'plan']);
    expect(parsed.plan.operations.some((op: { kind: string; alias: string }) => op.kind === 'install' && op.alias === 'shared')).toBe(true);
  });

  it('accepts with --yes and pins the branch tip', async () => {
    const { code, stdout } = await run(['remote', 'add', team.url, '--yes']);
    expect(code).toBe(0);
    expect(stdout).toContain('Next: dshenv plan, then dshenv apply --yes.');
    expect(read(paths.manifestFile)).toBe(TEAM_MANIFEST);
    expect(loadLock(read(paths.lockFile))).toEqual(loadLock(TEAM_LOCK));
    expect(read(overlayFile('team'))).toBe(TEAM_OVERLAY);
    expect(fs.existsSync(paths.stateFile)).toBe(false);
    expect(readRemoteConfig(paths)).toMatchObject({
      url: team.url,
      branch: 'main',
      path: 'envctl',
      commit: await teamHead(team),
      files: { 'manifest.yaml': sha256Hex(TEAM_MANIFEST) },
      lockEntries: { web: { shared: lockEntryDigest(loadLock(TEAM_LOCK).profiles.web.plugins.shared) } }
    });
    expect(fs.existsSync(path.join(paths.remoteDir, 'repo.git', 'HEAD'))).toBe(true);
  });

  it('refuses a second subscription', async () => {
    await run(['remote', 'add', team.url, '--yes']);
    const { code, stderr } = await run(['remote', 'add', team.url, '--yes']);
    expect(code).toBe(3);
    expect(stderr).toContain('A remote is already configured');
  });

  it('refuses a local manifest without --replace', async () => {
    fs.mkdirSync(paths.managerDir, { recursive: true });
    fs.writeFileSync(paths.manifestFile, LOCAL_MANIFEST);
    const { code, stderr } = await run(['remote', 'add', team.url, '--yes']);
    expect(code).toBe(3);
    expect(stderr).toContain('already exists; pass --replace');
    expect(read(paths.manifestFile)).toBe(LOCAL_MANIFEST);
    expect(fs.existsSync(paths.remoteFile)).toBe(false);
    expect(fs.existsSync(paths.remoteDir)).toBe(false);
  });

  it('merges into a local lock and refuses a clashing local entry without --replace', async () => {
    fs.mkdirSync(paths.managerDir, { recursive: true });
    const localLock = serializeLock({
      apiVersion: 'dshenv-lock/v1',
      profiles: { web: { plugins: { shared: { package: 'shared-plugin', source: { type: 'npm', resolvedVersion: '0.9.0' } } } } }
    });
    fs.writeFileSync(paths.lockFile, localLock);
    const refused = await run(['remote', 'add', team.url, '--yes']);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain("Local lock entry 'web/shared' already exists; pass --replace");
    expect(read(paths.lockFile)).toBe(localLock);

    fs.writeFileSync(
      paths.lockFile,
      serializeLock({
        apiVersion: 'dshenv-lock/v1',
        profiles: { cli: { plugins: { helper: { package: 'helper', source: { type: 'npm', resolvedVersion: '1.0.0' } } } } }
      })
    );
    expect((await run(['remote', 'add', team.url, '--yes'])).code).toBe(0);
    const lock = loadLock(read(paths.lockFile));
    expect(Object.keys(lock.profiles).sort()).toEqual(['cli', 'web']);
    expect(lock.profiles.web.plugins.shared.source).toEqual({ type: 'npm', resolvedVersion: '1.0.0' });
  });

  it('--replace overwrites local files after a snapshot that rollback restores', async () => {
    fs.mkdirSync(paths.overlaysDir, { recursive: true });
    fs.writeFileSync(paths.manifestFile, LOCAL_MANIFEST);
    fs.writeFileSync(overlayFile('team'), LOCAL_TEAM_OVERLAY);
    expect((await run(['remote', 'add', team.url, '--replace', '--yes'])).code).toBe(0);
    expect(read(paths.manifestFile)).toBe(TEAM_MANIFEST);
    expect(read(overlayFile('team'))).toBe(TEAM_OVERLAY);
    const [snapshot] = fs.readdirSync(paths.backupsDir);
    expect(read(path.join(paths.backupsDir, snapshot, 'manifest.yaml'))).toBe(LOCAL_MANIFEST);
    expect(read(path.join(paths.backupsDir, snapshot, 'overlays', 'team.yaml'))).toBe(LOCAL_TEAM_OVERLAY);

    expect((await run(['rollback', '--yes'])).code).toBe(0);
    expect(read(paths.manifestFile)).toBe(LOCAL_MANIFEST);
    expect(read(overlayFile('team'))).toBe(LOCAL_TEAM_OVERLAY);
    expect(fs.existsSync(paths.remoteFile)).toBe(false);
    expect(fs.existsSync(paths.lockFile)).toBe(false);
  });

  it.each([
    ['https://user:token@example.com/team.git', [], 'Git URL must not embed credentials'],
    [null, ['--path', '../envctl'], "Invalid --path '../envctl'"],
    [null, ['--branch', 'bad branch'], "Invalid --branch 'bad branch'"]
  ])('rejects bad input %s %j', async (url, extra, message) => {
    const { code, stderr } = await run(['remote', 'add', url ?? team.url, ...extra]);
    expect(code).toBe(3);
    expect(stderr).toContain(message);
  });

  it('follows --branch and --path', async () => {
    await commitTeamSideBranch(team, 'release', { 'config/manifest.yaml': TEAM_MANIFEST }, 'release layout');
    expect((await run(['remote', 'add', team.url, '--branch', 'release', '--path', 'config', '--yes'])).code).toBe(0);
    const config = readRemoteConfig(paths)!;
    expect(config).toMatchObject({ branch: 'release', path: 'config' });
    expect(config.files).toEqual({ 'manifest.yaml': sha256Hex(TEAM_MANIFEST) });
    expect(config.lockEntries).toEqual({});
    expect(fs.existsSync(paths.lockFile)).toBe(false);
  });

  it('refuses invalid remote content and reports git failures with exit 1', async () => {
    await commitTeamFiles(team, { 'envctl/manifest.yaml': 'apiVersion: nope\n' }, 'broken');
    const invalid = await run(['remote', 'add', team.url, '--yes']);
    expect(invalid.code).toBe(3);
    expect(invalid.stderr).toContain('Remote file envctl/manifest.yaml: Invalid manifest schema');
    expect(fs.existsSync(paths.remoteDir)).toBe(false);

    const missing = await run(['remote', 'add', `file://${root}/missing.git`]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/^git clone failed: \S/);
    expect(fs.existsSync(paths.remoteDir)).toBe(false);
  });

  it('shows the subscription and the remote files and lock entries changed locally', async () => {
    await run(['remote', 'add', team.url, '--yes']);
    fs.appendFileSync(overlayFile('team'), '# local edit\n');
    fs.writeFileSync(paths.lockFile, serializeLock({ apiVersion: 'dshenv-lock/v1', profiles: {} }));
    const text = await run(['remote', 'show']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`Remote: ${team.url}`);
    expect(text.stdout).toContain('Files:\n  manifest.yaml\n  overlays/team.yaml (modified)\n');
    expect(text.stdout).toContain('Lock entries:\n  web/shared (missing)\n');
    expect(JSON.parse((await run(['remote', 'show', '--json'])).stdout)).toEqual({
      subscribed: true,
      url: team.url,
      branch: 'main',
      path: 'envctl',
      commit: await teamHead(team),
      files: ['manifest.yaml', 'overlays/team.yaml'],
      lockEntries: ['web/shared'],
      drift: [{ file: 'overlays/team.yaml', status: 'modified' }],
      lockDrift: [{ entry: 'web/shared', status: 'missing' }]
    });

    fs.writeFileSync(paths.lockFile, '{');
    const broken = await run(['remote', 'show']);
    expect(broken.code).toBe(3);
    expect(broken.stderr).toContain(`Cannot parse local lock file ${paths.lockFile}`);
  });

  it('shows that nothing is subscribed', async () => {
    expect(await run(['remote', 'show'])).toMatchObject({ code: 0, stdout: 'No remote configured.\n' });
    expect(JSON.parse((await run(['remote', 'show', '--json'])).stdout)).toEqual({ subscribed: false });
  });

  it('removes the subscription only with --yes and leaves the files writable', async () => {
    await run(['remote', 'add', team.url, '--yes']);
    const refused = await run(['remote', 'remove']);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain('Refusing to remove the remote without --yes');
    expect((await run(['install', 'extra-plugin@1.0.0', '-p', 'web'])).code).toBe(3);

    expect((await run(['remote', 'remove', '--yes'])).code).toBe(0);
    expect(fs.existsSync(paths.remoteFile)).toBe(false);
    expect(fs.existsSync(paths.remoteDir)).toBe(false);
    expect(read(paths.manifestFile)).toBe(TEAM_MANIFEST);
    expect((await run(['install', 'extra-plugin@1.0.0', '-p', 'web'])).code).toBe(0);

    const again = await run(['remote', 'remove', '--yes']);
    expect(again.code).toBe(3);
    expect(again.stderr).toContain('No remote is configured');
  });
});
