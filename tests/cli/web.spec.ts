import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { startFakeDshWeb, type FakeDshWeb } from '../helpers/fake-dsh-web.js';

const PKG = '@nanmicoder/dsh-agent-teams';

describe('CLI web', () => {
  let tempHome: string;
  let fake: FakeDshWeb;
  let previousDshCli: string | undefined;
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
  const recordFile = (profile = 'web') => path.join(tempHome, 'envctl', 'run', `${profile}.json`);
  const record = (profile = 'web') => JSON.parse(fs.readFileSync(recordFile(profile), 'utf8')) as { pid: number; url: string };
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // Stands in for dsh web: prints the fake server's URL like DSH does, then serves until stopped.
  const fakeDsh = (body: string): void => {
    const file = path.join(tempHome, 'fake-dsh.mjs');
    fs.writeFileSync(file, body);
    process.env.DSH_CLI = JSON.stringify([process.execPath, file]);
  };
  const serving = () => fakeDsh(`console.log('dsh web: ${fake.url}'); setInterval(() => {}, 1000);`);

  beforeEach(async () => {
    previousDshCli = process.env.DSH_CLI;
    previousUrl = process.env.DSHENV_DSH_URL;
    delete process.env.DSHENV_DSH_URL;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-web-'));
    fs.mkdirSync(path.join(tempHome, 'envctl'), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      `apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      agent-teams:\n        package: "${PKG}"\n        enabled: true\n        source: { type: npm, version: "0.1.21" }\n`
    );
    fs.mkdirSync(path.join(tempHome, 'profiles', 'web'), { recursive: true });
    fs.writeFileSync(path.join(tempHome, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dependencies: { [PKG]: '0.1.21' } }));
    fake = await startFakeDshWeb({
      bundles: [{ name: PKG, version: '0.1.21', enabled: true, installed: true, optional: false, removable: true, rows: [{ rowId: 'agent-teams', moduleName: PKG, entryId: 'include:agent-teams' }], overrides: [] }],
      plugins: [{ entryId: 'include:agent-teams', moduleName: PKG, enabled: true, fiberPhase: 'active', patchId: 'agent-teams' }]
    });
  });

  afterEach(async () => {
    if (fs.existsSync(recordFile())) {
      try {
        process.kill(-record().pid, 'SIGKILL');
      } catch {
        // Already stopped.
      }
    }
    await fake.close();
    if (previousDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = previousDshCli;
    if (previousUrl === undefined) delete process.env.DSHENV_DSH_URL;
    else process.env.DSHENV_DSH_URL = previousUrl;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('starts dsh web in the background, prints its URL once, and records it privately', async () => {
    serving();
    const started = await run(['web', 'start', '-p', 'web']);
    expect(started.code).toBe(0);
    expect(started.stdout).toMatch(/^Started dsh web for profile web \(pid \d+\)\n/);
    expect(started.stdout).toContain(`  URL: ${fake.url}\n`);
    expect(started.stdout).toContain(`  Log: ${path.join(tempHome, 'envctl', 'run', 'web.log')}\n`);
    expect(started.stdout).toContain('Stop it with: dshenv web stop -p web\n');
    expect(fs.statSync(recordFile()).mode & 0o777).toBe(0o600);
    expect(alive(record().pid)).toBe(true);

    const again = await run(['web', 'start', '-p', 'web']);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/^dsh web for profile web is already running \(pid \d+\)\n/);
    expect(again.stdout).toContain(`  URL: ${fake.url}\n`);
  });

  it('lets runtime use the dsh web it started when DSHENV_DSH_URL is not set', async () => {
    serving();
    await run(['web', 'start', '-p', 'web']);
    const out = await run(['runtime', '-p', 'web']);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain(`  loaded  agent-teams  ${PKG}\n`);
    expect(out.stdout).not.toContain('SECRET-TOKEN-123');
  });

  it('reports status without the token, and stops dsh web with everything it started', async () => {
    serving();
    expect((await run(['web', 'status'])).stdout).toBe('No dsh web started by dshenv.\n');
    await run(['web', 'start', '-p', 'web']);
    const { pid } = record();

    const status = await run(['web', 'status']);
    expect(status.stdout).toBe(`web  running  pid ${pid}  ${fake.origin.replace('http://', '')}\n`);
    expect(status.stdout).not.toContain('SECRET-TOKEN-123');
    const json = JSON.parse((await run(['web', 'status', '--json'])).stdout);
    expect(json).toEqual({ webs: [expect.objectContaining({ profile: 'web', pid, running: true, endpoint: fake.origin.replace('http://', '') })] });
    expect(JSON.stringify(json)).not.toContain('SECRET-TOKEN-123');

    const stopped = await run(['web', 'stop', '-p', 'web']);
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toBe(`Stopped dsh web for profile web (pid ${pid})\n`);
    expect(alive(pid)).toBe(false);
    expect(fs.existsSync(recordFile())).toBe(false);
    expect((await run(['web', 'stop', '-p', 'web'])).stdout).toBe('No dsh web started by dshenv is running for profile web.\n');
  });

  it('notices a dsh web that stopped on its own, and starts a new one in its place', async () => {
    serving();
    await run(['web', 'start', '-p', 'web']);
    const { pid } = record();
    process.kill(-pid, 'SIGKILL');
    while (alive(pid)) await new Promise((resolve) => setTimeout(resolve, 20));

    expect((await run(['web', 'status'])).stdout).toBe(`web  not running  pid ${pid}\n`);
    const runtime = await run(['runtime', '-p', 'web']);
    expect(runtime.code).toBe(3);
    expect(runtime.stderr).toMatch(/DSHENV_DSH_URL is not set and no dsh web started by 'dshenv web start' is running for profile web/);

    const restarted = await run(['web', 'start', '-p', 'web']);
    expect(restarted.stdout).toMatch(/^Started dsh web/);
    expect(record().pid).not.toBe(pid);
    expect((await run(['web', 'stop', '-p', 'web'])).stdout).toMatch(/^Stopped/);
  });

  it('refuses a profile that does not exist yet and explains a profile without a web app', async () => {
    serving();
    const missing = await run(['web', 'start', '-p', 'nope']);
    expect(missing.code).toBe(3);
    expect(missing.stderr).toMatch(/Profile 'nope' does not exist; start DSH with --profile nope once/);

    fakeDsh(`console.error("error: unknown option '--no-open'"); process.exit(1);`);
    const headless = await run(['web', 'start', '-p', 'web']);
    expect(headless.code).toBe(1);
    expect(headless.stderr).toMatch(/did not start dsh web: error: unknown option '--no-open'/);
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  it('passes a fixed port to dsh web', async () => {
    fakeDsh(`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(tempHome, 'args.json'))}, JSON.stringify(process.argv.slice(2))); console.log('dsh web: ${fake.url}'); setInterval(() => {}, 1000);`);
    await run(['web', 'start', '-p', 'web', '--port', '3090']);
    expect(JSON.parse(fs.readFileSync(path.join(tempHome, 'args.json'), 'utf8'))).toEqual(['--profile', 'web', '--no-open', '--port', '3090']);
    expect((await run(['web', 'start', '-p', 'web', '--port', 'x'])).stderr).toMatch(/--port must be an integer from 0 to 65535/);
  });
  it('refuses a profile name that would leave the profiles or run directory', async () => {
    serving();
    fs.mkdirSync(path.join(tempHome, 'outside', 'x'), { recursive: true });
    fs.writeFileSync(path.join(tempHome, 'outside', 'x', 'package.json'), '{}');
    fs.writeFileSync(path.join(tempHome, 'keep.json'), '{}');
    for (const args of [['web', 'start', '-p', '../outside/x'], ['web', 'stop', '-p', '../../keep'], ['web', 'start', '-p', '..']]) {
      const out = await run(args);
      expect(out.code).toBe(3);
      expect(out.stderr).toMatch(/Invalid profile name/);
    }
    expect(fs.existsSync(path.join(tempHome, 'keep.json'))).toBe(true);
  });

  it('starts one dsh web when two starts race, and the other reports it running', async () => {
    fakeDsh(`setTimeout(() => console.log('dsh web: ${fake.url}'), 300); setInterval(() => {}, 1000);`);
    const results = await Promise.all([run(['web', 'start', '-p', 'web']), run(['web', 'start', '-p', 'web'])]);
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(results.map((result) => result.stdout.split(' ')[0]).sort()).toEqual(['Started', 'dsh']);
    const { pid } = record();
    expect(results.every((result) => result.stdout.includes(`pid ${pid})`))).toBe(true);
  });
});
