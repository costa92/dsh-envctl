import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { loadManifest } from '../../src/manifest/files.js';

describe('reserved object keys as profile names or aliases', () => {
  let tempHome: string;
  const run = async (args: string[]) => {
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], { stdout: () => {}, stderr: (chunk) => { stderr += chunk; } });
    return { code, stderr };
  };
  const manifestFile = () => path.join(tempHome, 'envctl', 'manifest.yaml');

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-reserved-'));
    await run(['init']);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it.each([
    [['-p', 'constructor']],
    [['-p', '__proto__']],
    [['-p', 'web', '--as', '__proto__']],
    [['-p', 'web', '--as', 'constructor']],
    [['-p', 'web', '--as', 'prototype']]
  ])('refuses install %j with a validation error and leaves the manifest alone', async (extra) => {
    const before = fs.readFileSync(manifestFile(), 'utf8');
    const { code, stderr } = await run(['install', 'demo-plugin@1.0.0', ...extra]);
    expect(code).toBe(3);
    expect(stderr).toMatch(/reserved/);
    expect(fs.readFileSync(manifestFile(), 'utf8')).toBe(before);
  });

  it.each(['constructor', 'prototype'])('rejects %j as a profile name or alias in the manifest', (name) => {
    const asProfile = `apiVersion: dshenv/v1\nprofiles:\n  ${name}:\n    plugins: {}\n`;
    const asAlias = `apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      ${name}: { package: demo-plugin, source: { type: npm, version: "1.0.0" } }\n`;
    expect(() => loadManifest(asProfile)).toThrow(/reserved/);
    expect(() => loadManifest(asAlias)).toThrow(/reserved/);
  });
});
