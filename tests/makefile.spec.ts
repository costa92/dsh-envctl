import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Every target here depends on `build`, which empties and rewrites lib/ while other tests or a running
// bin/dshenv.js may read it; `pnpm install` already built lib/ through the prepare script.
const KEEP_LIB = ['-o', 'build'];

describe('Makefile demo paths', () => {
  let userHome: string;

  beforeEach(() => {
    userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-make-home-'));
  });

  afterEach(() => {
    fs.rmSync(userHome, { recursive: true, force: true });
  });

  it('creates the default demo home below the current user home', async () => {
    await execa('make', [...KEEP_LIB, 'demo-gc'], {
      cwd: projectDir,
      env: { ...process.env, HOME: userHome }
    });

    expect(fs.existsSync(path.join(userHome, 'code', 'dsh', 'dsh-demo'))).toBe(true);
  });

  it('reports an actionable error when the Harness source is missing', async () => {
    const missingHarness = path.join(userHome, 'missing-harness');
    const result = await execa('make', [...KEEP_LIB, 'demo-doctor', `HARNESS_SOURCE=${missingHarness}`], {
      cwd: projectDir,
      env: { ...process.env, HOME: userHome },
      reject: false
    });

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(`Harness source directory not found: ${missingHarness}`);
    expect(fs.existsSync(missingHarness)).toBe(false);
  });

  it('requires DSH_VERSION for the DSH smoke test', async () => {
    const result = await execa('make', [...KEEP_LIB, 'smoke-dsh'], {
      cwd: projectDir,
      env: { ...process.env, HOME: userHome, DSH_VERSION: '' },
      reject: false
    });

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('Set DSH_VERSION, e.g. make smoke-dsh DSH_VERSION=0.1.7-rc.2');
  });

  it('requires DSH_VERSION for the DSH end-to-end test', async () => {
    const result = await execa('make', [...KEEP_LIB, 'e2e-dsh'], {
      cwd: projectDir,
      env: { ...process.env, HOME: userHome, DSH_VERSION: '' },
      reject: false
    });

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('Set DSH_VERSION, e.g. make e2e-dsh DSH_VERSION=0.1.7-rc.2');
  });
});
