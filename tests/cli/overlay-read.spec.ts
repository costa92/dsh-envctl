import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { writeOverlayFixture } from '../helpers/overlay-fixture.js';

describe('CLI overlay-aware reads', () => {
  let tempHome: string;
  let previousEnv: string | undefined;

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
  const selectInFile = (name: string) =>
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'overlay-selection.json'),
      JSON.stringify({ apiVersion: 'dshenv-overlay-selection/v1', overlay: name })
    );

  beforeEach(() => {
    previousEnv = process.env.DSHENV_OVERLAY;
    delete process.env.DSHENV_OVERLAY;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-overlay-read-'));
    writeOverlayFixture(tempHome);
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.DSHENV_OVERLAY;
    else process.env.DSHENV_OVERLAY = previousEnv;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('plans against the base only when no overlay is active, with unchanged output', async () => {
    const { code, stdout } = await run(['plan', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).not.toHaveProperty('overlay');
  });

  it('plans against the merged manifest with --overlay', async () => {
    const { code, stdout } = await run(['plan', '--json', '--overlay', 'laptop']);
    expect(code).toBe(2);
    const plan = JSON.parse(stdout);
    expect(plan.overlay).toEqual({ name: 'laptop', via: 'flag' });
    expect(plan.operations.map((op: { kind: string; package: string }) => [op.kind, op.package])).toEqual([['install', 'extra-plugin']]);
    expect(plan.unmanaged).toEqual([{ profile: 'web', package: 'heavy-plugin' }]);
  });

  it('prints the overlay banner in text output', async () => {
    selectInFile('laptop');
    const { stdout } = await run(['plan']);
    expect(stdout.startsWith('overlay: laptop (file)\n')).toBe(true);
  });

  it('reads the selection from DSHENV_OVERLAY', async () => {
    process.env.DSHENV_OVERLAY = 'laptop';
    const { stdout } = await run(['plan', '--json']);
    expect(JSON.parse(stdout).overlay).toEqual({ name: 'laptop', via: 'env' });
  });

  it('fails instead of falling back when the selected overlay is missing', async () => {
    selectInFile('ghost');
    const { code, stderr } = await run(['plan']);
    expect(code).toBe(3);
    expect(stderr).toMatch(/Overlay 'ghost' not found/);
  });

  it('lets --no-overlay override a persisted selection', async () => {
    selectInFile('laptop');
    const { code } = await run(['plan', '--no-overlay']);
    expect(code).toBe(0);
  });

  it('rejects --overlay together with --no-overlay', async () => {
    const { code, stderr } = await run(['plan', '--overlay', 'laptop', '--no-overlay']);
    expect(code).toBe(3);
    expect(stderr).toMatch(/--overlay and --no-overlay cannot be used together/);
  });

  it('warns when the overlay differs from the last apply', async () => {
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'state.json'),
      JSON.stringify({ apiVersion: 'dshenv-state/v1', lastApplied: 'x', appliedLockHash: '', profiles: {}, appliedOverlay: 'server' })
    );
    const { stderr } = await run(['plan', '--overlay', 'laptop']);
    expect(stderr).toContain('overlay changed since last apply: server → laptop');
  });

  it('adds origin to list output', async () => {
    const json = await run(['list', '--json', '--overlay', 'laptop']);
    const rows = JSON.parse(json.stdout).plugins as Array<{ alias: string | null; origin: string | null }>;
    expect(rows.find((row) => row.alias === 'shared')?.origin).toBe('base');
    expect(rows.find((row) => row.alias === 'extra')?.origin).toBe('overlay:laptop');

    const text = await run(['list', '--overlay', 'laptop']);
    expect(text.stdout).toContain('overlay: laptop (flag)');
    expect(text.stdout).toContain('origin=overlay:laptop');

    const plain = await run(['list']);
    expect(plain.stdout).not.toContain('origin=');
  });

  it('includes the overlay in status JSON', async () => {
    const { stdout } = await run(['status', '--json', '--overlay', 'laptop']);
    expect(JSON.parse(stdout).overlay).toEqual({ name: 'laptop', via: 'flag' });
  });

  it('reads overlay patch config through config get', async () => {
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'overlays', 'laptop.yaml'),
      `apiVersion: dshenv-overlay/v1
profiles:
  web:
    plugins:
      shared:
        patches:
          - id: shared
            config: { mode: solo }
`
    );
    const { code, stdout } = await run(['config', 'get', 'shared', '--profile', 'web', '--path', 'mode', '--json', '--overlay', 'laptop']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toBe('solo');
  });

  it('finds overlay-only git plugins for source status --profile', async () => {
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'overlays', 'laptop.yaml'),
      `apiVersion: dshenv-overlay/v1
profiles:
  web:
    plugins:
      demo:
        package: demo-plugin
        source: { type: git, url: "https://example.com/o/demo.git" }
`
    );
    const { code, stdout } = await run(['source', 'status', '--profile', 'web', '--json', '--overlay', 'laptop']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).dir).toBe(path.join(tempHome, 'envctl', 'sources', 'web', 'demo-plugin'));
  });

  it('warns and prints the banner on apply --dry-run', async () => {
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'state.json'),
      JSON.stringify({ apiVersion: 'dshenv-state/v1', lastApplied: 'x', appliedLockHash: '', profiles: {} })
    );
    const { stdout, stderr } = await run(['apply', '--dry-run', '--overlay', 'laptop']);
    expect(stderr).toContain('overlay changed since last apply: none → laptop');
    expect(stdout.startsWith('overlay: laptop (flag)\n')).toBe(true);
    expect(stdout).toContain('extra-plugin');
  });
});
