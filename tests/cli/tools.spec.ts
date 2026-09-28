import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { loadManifest } from '../../src/manifest/files.js';

const DUMPS: Record<string, string> = {
  web: `- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: true
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: standard
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    plugins:
      - id: tool-bash
        name: '@deepseek-ai/dsh-tool-bash'
        disabled: !!js process.platform === 'win32'
      - id: tool-web
        name: '@deepseek-ai/dsh-tool-web'
`,
  headless: `- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetchMaxOutputChars: 1000
`
};

describe('CLI tools', () => {
  let tempHome: string;
  let previousDshCli: string | undefined;

  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], {
      stdout: (chunk) => { stdout += chunk; },
      stderr: (chunk) => { stderr += chunk; }
    });
    return { code, stdout, stderr };
  };
  const manifest = () => loadManifest(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8'));

  beforeEach(() => {
    previousDshCli = process.env.DSH_CLI;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-tools-'));
    fs.mkdirSync(path.join(tempHome, 'envctl'), { recursive: true });
    fs.writeFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins: {}\n');
    for (const profile of Object.keys(DUMPS)) {
      fs.mkdirSync(path.join(tempHome, 'profiles', profile), { recursive: true });
      fs.writeFileSync(path.join(tempHome, 'profiles', profile, 'package.json'), '{}');
    }
    const fakeDsh = path.join(tempHome, 'fake-dsh.mjs');
    fs.writeFileSync(fakeDsh, `
const args = process.argv.slice(2);
const dumps = ${JSON.stringify(DUMPS)};
if (args.includes('--dump-config')) { process.stdout.write(dumps[args[args.indexOf('--profile') + 1]]); process.exit(0); }
process.exit(1);
`);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);
  });

  afterEach(() => {
    if (previousDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = previousDshCli;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('lists the tools an agent of the default preset gets, by category', async () => {
    const result = await run(['tools', 'list', '-p', 'web']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Tools in profile 'web', preset 'standard' (default)");
    expect(result.stdout).toMatch(/Terminal\n {2}~ tool-bash +@deepseek-ai\/dsh-tool-bash +off when process\.platform === 'win32'/);
    expect(result.stdout).toMatch(/Network\n {2}\+ tool-web/);

    const json = JSON.parse((await run(['tools', 'list', '-p', 'web', '--json'])).stdout);
    expect(json.tools).toContainEqual(expect.objectContaining({ id: 'tool-web', category: 'network', state: 'on' }));
  });

  it('turns a preset tool off by pinning the whole preset in the manifest, and plan says so', async () => {
    const result = await run(['tools', 'disable', 'tool-web', '-p', 'web']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Disabled tool 'tool-web' in preset 'standard' of profile 'web'/);
    expect(result.stdout).toMatch(/pinned.*DSH upgrades/);

    const [patch] = manifest().profiles.web.patches!;
    expect(patch).toMatchObject({ id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset' });
    const plugins = (patch.config as { plugins: Record<string, unknown>[] }).plugins;
    expect(plugins[0].disabled).toEqual({ __jsExpr: "process.platform === 'win32'" });
    expect(plugins[1]).toMatchObject({ id: 'tool-web', disabled: true });

    expect((await run(['plan'])).stdout).toMatch(/Pinned agent presets[^\n]*\n {2}! \[web\] preset-standard/);
  });

  it('writes a small patch for a top-level tool and reads or sets its config', async () => {
    expect((await run(['tools', 'config', 'tool-web', '-p', 'headless'])).stdout).toContain('"fetchMaxOutputChars": 1000');
    const set = await run(['tools', 'config', 'tool-web', 'search.maxResults', '3', '-p', 'headless']);
    expect(set.code).toBe(0);
    expect(manifest().profiles.headless.patches).toEqual([
      { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetchMaxOutputChars: 1000, search: { maxResults: 3 } } }
    ]);
    expect((await run(['tools', 'config', 'tool-web', 'search.maxResults', '-p', 'headless'])).stdout.trim()).toBe('3');

    await run(['tools', 'disable', 'tool-web', '-p', 'headless']);
    expect(manifest().profiles.headless.patches).toEqual([
      { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetchMaxOutputChars: 1000, search: { maxResults: 3 } }, disabled: true }
    ]);
  });

  it('refuses a base-layer write the active overlay would override', async () => {
    fs.mkdirSync(path.join(tempHome, 'envctl', 'overlays'), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'overlays', 'local.yaml'),
      `apiVersion: dshenv-overlay/v1
profiles:
  web:
    patches:
      - id: preset-standard
        name: '@deepseek-ai/dsh-agent-preset'
        config:
          id: standard
          machineOnly: /home/me
          plugins:
            - id: tool-web
              name: '@deepseek-ai/dsh-tool-web'
`
    );
    expect((await run(['tools', 'disable', 'tool-web', '-p', 'web', '--overlay', 'local'])).stderr).toMatch(/--layer base or --layer overlay/);
    const refused = await run(['tools', 'disable', 'tool-web', '-p', 'web', '--overlay', 'local', '--layer', 'base']);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/overlay 'local' declares 'preset-standard'.*--layer overlay/);
    expect(manifest().profiles.web.patches).toBeUndefined();

    const json = JSON.parse((await run(['tools', 'config', 'tool-web', 'x.y', '1', '-p', 'web', '--overlay', 'local', '--layer', 'overlay', '--json'])).stdout);
    expect(json.status).toBe('set');
  });

  it('keeps both edits when two commands change the same preset at once', async () => {
    const results = await Promise.all([
      run(['tools', 'disable', 'tool-web', '-p', 'web']),
      run(['tools', 'enable', 'tool-bash', '-p', 'web'])
    ]);
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    const plugins = (manifest().profiles.web.patches![0].config as { plugins: Record<string, unknown>[] }).plugins;
    expect(plugins).toEqual([
      expect.objectContaining({ id: 'tool-bash', disabled: false }),
      expect.objectContaining({ id: 'tool-web', disabled: true })
    ]);
  });

  it('refuses a profile that does not exist yet and a tool outside the composition', async () => {
    const missing = await run(['tools', 'list', '-p', 'nope']);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toMatch(/Profile 'nope' does not exist/);
    expect(fs.existsSync(path.join(tempHome, 'profiles', 'nope'))).toBe(false);

    const unknown = await run(['tools', 'enable', 'tool-lsp', '-p', 'web']);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toMatch(/not part of this profile/);
  });
});
