import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { startFakeDshWeb, type FakeDshWeb, type FakeDshWebOptions } from '../helpers/fake-dsh-web.js';

const PKG = '@nanmicoder/dsh-agent-teams';

describe('CLI runtime', () => {
  let tempHome: string;
  let fake: FakeDshWeb | undefined;
  let previousUrl: string | undefined;

  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], {
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: (chunk) => {
        stderr += chunk;
      }
    });
    return { code, stdout, stderr };
  };

  const writeManifest = (profiles: string): void => {
    fs.writeFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), `apiVersion: dshenv/v1\nprofiles:\n${profiles}`);
  };
  const webProfile = (enabled = true): string =>
    `  web:\n    plugins:\n      agent-teams:\n        package: "${PKG}"\n        enabled: ${enabled}\n        source:\n          type: npm\n          version: "0.1.21"\n`;
  const writeProfileJson = (dependencies: Record<string, string>): void => {
    const dir = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies }));
  };

  const agentTeamsBundle = (overrides: Record<string, unknown> = {}) => ({
    name: PKG,
    version: '0.1.21',
    enabled: true,
    installed: true,
    optional: false,
    removable: true,
    rows: [{ rowId: 'agent-teams', moduleName: PKG, entryId: 'include:agent-teams' }],
    overrides: [],
    ...overrides
  });
  const agentTeamsEntry = (fiberPhase: string | null) => ({ entryId: 'include:agent-teams', moduleName: PKG, enabled: true, fiberPhase, patchId: 'agent-teams' });

  const serve = async (options: FakeDshWebOptions): Promise<FakeDshWeb> => {
    fake = await startFakeDshWeb(options);
    process.env.DSHENV_DSH_URL = fake.url;
    return fake;
  };

  const expectNoSecrets = (out: { stdout: string; stderr: string }): void => {
    for (const text of [out.stdout, out.stderr]) {
      expect(text).not.toContain('SECRET-TOKEN-123');
      expect(text).not.toContain('COOKIE-VALUE-456');
    }
  };

  beforeEach(() => {
    previousUrl = process.env.DSHENV_DSH_URL;
    delete process.env.DSHENV_DSH_URL;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-runtime-'));
    fs.mkdirSync(path.join(tempHome, 'envctl'), { recursive: true });
    writeManifest(webProfile());
    writeProfileJson({ [PKG]: '0.1.21' });
  });

  afterEach(async () => {
    await fake?.close();
    fake = undefined;
    if (previousUrl === undefined) delete process.env.DSHENV_DSH_URL;
    else process.env.DSHENV_DSH_URL = previousUrl;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('reports a loaded plugin and exits 0', async () => {
    await serve({ bundles: [agentTeamsBundle()], plugins: [agentTeamsEntry('active')] });
    const out = await run(['runtime']);
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/^Runtime check for profile web \(127\.0\.0\.1:\d+\)\n/);
    expect(out.stdout).toContain(`  loaded  agent-teams  ${PKG}\n`);
    expect(out.stdout).toContain('Versions are not checked');
    expectNoSecrets(out);
  });

  it('prints JSON with the same exit code', async () => {
    const server = await serve({ bundles: [agentTeamsBundle()], plugins: [agentTeamsEntry('active')] });
    const out = await run(['runtime', '--json']);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      profile: 'web',
      endpoint: new URL(server.origin).host,
      results: [{ alias: 'agent-teams', package: PKG, expected: 'enabled', result: 'loaded' }]
    });
    expectNoSecrets(out);
  });

  it('exits 2 while a plugin is loading', async () => {
    await serve({ bundles: [agentTeamsBundle()], plugins: [agentTeamsEntry('loading')] });
    expect((await run(['runtime'])).code).toBe(2);
  });

  it('exits 5 and shows the restart hint when a plugin that owes a restart is not loaded', async () => {
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'state.json'),
      JSON.stringify({
        apiVersion: 'dshenv-state/v1',
        lastApplied: '2026-01-01T00:00:00.000Z',
        appliedLockHash: '',
        profiles: { web: { plugins: { [PKG]: { package: PKG, status: 'restart-required' } } } }
      })
    );
    await serve({ bundles: [agentTeamsBundle({ enabled: false })], plugins: [] });
    const out = await run(['runtime']);
    expect(out.code).toBe(5);
    expect(out.stdout).toContain(`not-loaded  agent-teams  ${PKG} (restart DSH, then run dshenv restarted)`);
  });

  it('exits 5 when a disabled plugin is still loaded', async () => {
    writeManifest(webProfile(false));
    await serve({ bundles: [agentTeamsBundle()], plugins: [agentTeamsEntry('active')] });
    const out = await run(['runtime']);
    expect(out.code).toBe(5);
    expect(out.stdout).toContain('still-loaded');
  });

  it('exits 2 while DSH has not yet hot-reloaded a deselected plugin', async () => {
    writeManifest(webProfile(false));
    await serve({ bundles: [agentTeamsBundle({ enabled: false })], plugins: [agentTeamsEntry('active')] });
    const out = await run(['runtime']);
    expect(out.code).toBe(2);
    expect(out.stdout).toContain('loading');
    expect(out.stdout).toContain('(deselected on disk; waiting for DSH to hot-reload it)');
  });

  it('exits 1 when the running dsh has packages this profile does not', async () => {
    await serve({ bundles: [agentTeamsBundle(), agentTeamsBundle({ name: '@acme/other' })], plugins: [agentTeamsEntry('active')] });
    const out = await run(['runtime']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/DSH at 127\.0\.0\.1:\d+ does not look like profile web/);
    expectNoSecrets(out);
  });

  it('exits 1 when a declared dependency of the profile is unknown to the running dsh', async () => {
    await serve({ bundles: [], plugins: [] });
    const out = await run(['runtime']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/does not look like profile web/);
  });

  it('exits 1 when the profile has no package.json', async () => {
    fs.rmSync(path.join(tempHome, 'profiles', 'web', 'package.json'));
    await serve({ bundles: [agentTeamsBundle()], plugins: [agentTeamsEntry('active')] });
    const out = await run(['runtime']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/Profile web has no package\.json/);
  });

  it('exits 1 without leaking the token when dsh web is unreachable', async () => {
    const server = await serve({});
    await server.close();
    fake = undefined;
    const out = await run(['runtime']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/Could not reach DSH at 127\.0\.0\.1:\d+: ECONNREFUSED/);
    expectNoSecrets(out);
  });

  it('exits 3 when DSHENV_DSH_URL is not set', async () => {
    const out = await run(['runtime']);
    expect(out.code).toBe(3);
    expect(out.stderr).toMatch(/DSHENV_DSH_URL is not set/);
  });

  it('exits 3 when several profiles are declared and --profile is missing', async () => {
    writeManifest(`${webProfile()}  cli:\n    plugins: {}\n`);
    await serve({ bundles: [agentTeamsBundle()], plugins: [agentTeamsEntry('active')] });
    const out = await run(['runtime']);
    expect(out.code).toBe(3);
    expect(out.stderr).toMatch(/several profiles \(web, cli\); pass --profile/);
    expect((await run(['runtime', '--profile', 'web'])).code).toBe(0);
  });

  it('exits 3 for a profile the manifest does not declare', async () => {
    await serve({ bundles: [agentTeamsBundle()], plugins: [agentTeamsEntry('active')] });
    const out = await run(['runtime', '--profile', 'nope']);
    expect(out.code).toBe(3);
    expect(out.stderr).toMatch(/Profile 'nope' is not declared in the manifest/);
  });

  it('exits 3 for a remote host unless --allow-remote is given', async () => {
    process.env.DSHENV_DSH_URL = 'http://10.0.0.5:3080/?token=SECRET-TOKEN-123';
    const out = await run(['runtime']);
    expect(out.code).toBe(3);
    expect(out.stderr).toMatch(/pass --allow-remote/);
    expectNoSecrets(out);
  });

  it('says so when the profile declares no plugins', async () => {
    writeManifest('  web:\n    plugins: {}\n');
    writeProfileJson({});
    await serve({ bundles: [], plugins: [] });
    const out = await run(['runtime']);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe('No plugins declared for profile web.\n');
  });
});
