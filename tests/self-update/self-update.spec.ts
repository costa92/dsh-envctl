import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectInstallMethod, resolveTargetVersion, selfUpdate, type RunResult, type Runner } from '../../src/self-update/self-update.js';

const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: '' });

function fakeRunner(responses: Record<string, RunResult>): { run: Runner; calls: string[] } {
  const calls: string[] = [];
  const run: Runner = async (file, args) => {
    const key = [file, ...args].join(' ');
    calls.push(key);
    return responses[key] ?? { exitCode: 1, stdout: '', stderr: `unexpected: ${key}` };
  };
  return { run, calls };
}

describe('self-update', () => {
  let home: string;
  let npmRoot: string;
  let pnpmRoot: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-self-update-'));
    npmRoot = path.join(home, 'npm', 'lib', 'node_modules');
    pnpmRoot = path.join(home, 'pnpm', 'global', '5', 'node_modules');
    fs.mkdirSync(path.join(npmRoot, '@costa92', 'dshenv'), { recursive: true });
    fs.mkdirSync(path.join(pnpmRoot, '@costa92', 'dshenv'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const roots = (): Record<string, RunResult> => ({ 'npm root -g': ok(`${npmRoot}\n`), 'pnpm root -g': ok(`${pnpmRoot}\n`) });

  it('looks up the latest version online so a fresh release is not hidden by the cache', async () => {
    const { run, calls } = fakeRunner({ 'npm view @costa92/dshenv@latest version --prefer-online': ok('0.2.1\n') });
    expect(await resolveTargetVersion(run)).toBe('0.2.1');
    expect(calls).toEqual(['npm view @costa92/dshenv@latest version --prefer-online']);
  });

  it('refuses a --to that is not an exact version before asking the registry', async () => {
    const { run, calls } = fakeRunner({});
    await expect(resolveTargetVersion(run, 'latest')).rejects.toThrow(/exact version/);
    expect(calls).toEqual([]);
  });

  it('reports a registry failure with npm\'s first error line', async () => {
    const { run } = fakeRunner({
      'npm view @costa92/dshenv@9.9.9 version --prefer-online': { exitCode: 1, stdout: '', stderr: 'npm error code E404\nmore' }
    });
    await expect(resolveTargetVersion(run, '9.9.9')).rejects.toThrow(/9\.9\.9.*npm error code E404/);
  });

  it.each([
    ['npm', () => path.join(npmRoot, '@costa92', 'dshenv')],
    ['pnpm', () => path.join(pnpmRoot, '@costa92', 'dshenv')]
  ] as const)('detects a global %s install', async (method, packageRoot) => {
    const { run } = fakeRunner(roots());
    expect(await detectInstallMethod(run, packageRoot())).toBe(method);
  });

  it('does not treat a linked checkout as a global install', async () => {
    const checkout = path.join(home, 'code', 'dshenv');
    fs.mkdirSync(checkout, { recursive: true });
    fs.symlinkSync(checkout, path.join(npmRoot, '@costa92', 'linked'));
    const { run } = fakeRunner(roots());
    expect(await detectInstallMethod(run, path.join(npmRoot, '@costa92', 'linked'))).toBeNull();
  });

  it('installs the target with the package manager that installed dshenv', async () => {
    const { run, calls } = fakeRunner({
      ...roots(),
      'npm view @costa92/dshenv@latest version --prefer-online': ok('0.2.1'),
      'pnpm add -g @costa92/dshenv@0.2.1': ok('')
    });
    const result = await selfUpdate({ currentVersion: '0.2.0', packageRoot: path.join(pnpmRoot, '@costa92', 'dshenv'), run });
    expect(result).toEqual({ status: 'updated', current: '0.2.0', target: '0.2.1', method: 'pnpm', command: 'pnpm add -g @costa92/dshenv@0.2.1' });
    expect(calls.at(-1)).toBe('pnpm add -g @costa92/dshenv@0.2.1');
  });

  it('only reports with --check and installs nothing', async () => {
    const { run, calls } = fakeRunner({ 'npm view @costa92/dshenv@latest version --prefer-online': ok('0.2.1') });
    const result = await selfUpdate({ currentVersion: '0.2.0', packageRoot: '/x', check: true, run });
    expect(result).toEqual({ status: 'available', current: '0.2.0', target: '0.2.1' });
    expect(calls).toHaveLength(1);
  });

  it('does nothing when already on the target version', async () => {
    const { run, calls } = fakeRunner({ 'npm view @costa92/dshenv@latest version --prefer-online': ok('0.2.0') });
    expect((await selfUpdate({ currentVersion: '0.2.0', packageRoot: '/x', run })).status).toBe('up-to-date');
    expect(calls).toHaveLength(1);
  });

  it('refuses to replace a non-global install and says how to update it', async () => {
    const { run, calls } = fakeRunner({ ...roots(), 'npm view @costa92/dshenv@latest version --prefer-online': ok('0.2.1') });
    await expect(selfUpdate({ currentVersion: '0.2.0', packageRoot: path.join(home, 'code', 'dshenv'), run })).rejects.toThrow(
      /cannot replace itself.*npm install -g @costa92\/dshenv@0\.2\.1/
    );
    expect(calls.some((call) => call.includes('install -g') || call.includes('add -g'))).toBe(false);
  });

  it('surfaces a failed install', async () => {
    const { run } = fakeRunner({
      ...roots(),
      'npm view @costa92/dshenv@0.1.3 version --prefer-online': ok('0.1.3'),
      'npm install -g @costa92/dshenv@0.1.3 --prefer-online': { exitCode: 243, stdout: '', stderr: 'npm error code EACCES' }
    });
    await expect(
      selfUpdate({ currentVersion: '0.2.0', packageRoot: path.join(npmRoot, '@costa92', 'dshenv'), to: '0.1.3', run })
    ).rejects.toThrow(/npm install -g @costa92\/dshenv@0\.1\.3 --prefer-online' failed: npm error code EACCES/);
  });
});
