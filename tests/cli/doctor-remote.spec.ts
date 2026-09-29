import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from '../../src/cli.js';
import { loadLock, serializeLock } from '../../src/manifest/files.js';
import { FIXTURE_REMOTE_URL, OWNED_LOCK, writeRemoteOwnedFixture } from '../helpers/remote-fixture.js';

describe('CLI doctor with a remote subscription', () => {
  let home: string;
  let binDir: string;
  let previousDshCli: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-doctor-remote-'));
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-doctor-remote-bin-'));
    // A Node script, not a shell script, so the fake also runs on Windows.
    const fakeDsh = path.join(binDir, 'fake-dsh.mjs');
    fs.writeFileSync(fakeDsh, "if (process.argv[2] === '--version') console.log('0.1.7-rc.2');\n");
    previousDshCli = process.env.DSH_CLI;
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);
  });

  afterEach(() => {
    if (previousDshCli === undefined) {
      delete process.env.DSH_CLI;
    } else {
      process.env.DSH_CLI = previousDshCli;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  const doctor = async (json: boolean) => {
    let stdout = '';
    const code = await runCli(['doctor', ...(json ? ['--json'] : []), '--dsh-home', home], {
      stdout: (chunk) => { stdout += chunk; },
      stderr: () => {}
    });
    return { code, stdout };
  };

  it('reports the pinned commit and remote files and lock entries changed locally', async () => {
    const paths = await writeRemoteOwnedFixture(home);
    fs.appendFileSync(path.join(paths.overlaysDir, 'team.yaml'), '# local edit\n');
    const lock = loadLock(OWNED_LOCK);
    lock.profiles.web.plugins.shared = { package: 'shared-plugin', source: { type: 'npm', resolvedVersion: '9.9.9' } };
    lock.profiles.web.plugins.tool = { package: 'tool', source: { type: 'npm', resolvedVersion: '1.0.0' } };
    fs.writeFileSync(paths.lockFile, serializeLock(lock));

    const text = await doctor(false);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`  URL: ${FIXTURE_REMOTE_URL}`);
    expect(text.stdout).toContain(`  Pinned Commit: ${'a'.repeat(40)}`);
    expect(text.stdout).toContain('  Local Changes: overlays/team.yaml (modified), lock entry web/shared (modified)\n');

    const json = JSON.parse((await doctor(true)).stdout);
    expect(json.remote).toEqual({
      url: FIXTURE_REMOTE_URL,
      branch: 'main',
      path: 'envctl',
      commit: 'a'.repeat(40),
      drift: [{ file: 'overlays/team.yaml', status: 'modified' }],
      lockDrift: [{ entry: 'web/shared', status: 'modified' }]
    });
  });

  it('reports no local changes when the files and entries match the pin', async () => {
    await writeRemoteOwnedFixture(home);
    expect((await doctor(false)).stdout).toContain('  Local Changes: none');
  });

  it('exits 3 when subscribed and the local lock cannot be parsed', async () => {
    const paths = await writeRemoteOwnedFixture(home);
    fs.writeFileSync(paths.lockFile, '{');
    expect((await doctor(false)).code).toBe(3);
  });

  it('adds nothing without remote.json', async () => {
    const text = await doctor(false);
    expect(text.code).toBe(0);
    expect(text.stdout).not.toContain('Remote:');
    expect(JSON.parse((await doctor(true)).stdout)).not.toHaveProperty('remote');
  });
});
