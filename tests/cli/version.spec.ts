import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { runCli } from '../../src/cli.js';

const packageJson = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

describe('CLI version', () => {
  it('prints the package.json version and exits with code 0', async () => {
    let stdout = '';
    let stderr = '';
    const io = {
      stdout: (chunk: string) => {
        stdout += chunk;
      },
      stderr: (chunk: string) => {
        stderr += chunk;
      }
    };

    const code = await runCli(['--version'], io);
    expect(code).toBe(0);
    expect(stdout).toBe(`${packageJson.version}\n`);
    expect(stderr).toBe('');
  });
});
