import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { runCli } from '../../src/cli.js';
import type { RunResult, Runner } from '../../src/self-update/self-update.js';

const version = (JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))) as { version: string }).version;
const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);

function runner(latest: string): { run: Runner; calls: string[] } {
  const calls: string[] = [];
  const run: Runner = async (file, args): Promise<RunResult> => {
    const key = [file, ...args].join(' ');
    calls.push(key);
    if (key === 'npm view @costa92/dshenv@latest version --prefer-online') return { exitCode: 0, stdout: latest, stderr: '' };
    if (key === 'npm root -g') return { exitCode: 0, stdout: path.dirname(repoRoot), stderr: '' };
    if (key.startsWith('npm install -g')) return { exitCode: 0, stdout: '', stderr: '' };
    return { exitCode: 1, stdout: '', stderr: 'not found' };
  };
  return { run, calls };
}

async function cli(args: string[], run: Runner): Promise<{ code: number; out: string }> {
  let out = '';
  const code = await runCli(args, { stdout: (chunk) => (out += chunk), stderr: () => {}, selfUpdateRunner: run });
  return { code, out };
}

describe('CLI self-update', () => {
  it('exits 2 from --check when a newer version exists', async () => {
    const { run } = runner('99.0.0');
    const { code, out } = await cli(['self-update', '--check'], run);
    expect(code).toBe(2);
    expect(out).toBe(`dshenv 99.0.0 is available (installed ${version}); run: dshenv self-update\n`);
  });

  it('reports JSON and exits 0 when up to date', async () => {
    const { run } = runner(version);
    const { code, out } = await cli(['self-update', '--json'], run);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ status: 'up-to-date', current: version, target: version });
  });

  it('updates through npm when dshenv sits under the npm global root', async () => {
    const { run, calls } = runner('99.0.0');
    const { code, out } = await cli(['self-update'], run);
    expect(code).toBe(0);
    expect(calls.at(-1)).toBe('npm install -g @costa92/dshenv@99.0.0 --prefer-online');
    expect(out).toContain(`Updated dshenv ${version} -> 99.0.0`);
  });
});
