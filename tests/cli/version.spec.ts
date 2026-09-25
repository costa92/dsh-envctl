import { describe, it, expect } from 'vitest';
import { runCli } from '../../src/cli.js';

describe('CLI version', () => {
  it('should print version and exit with code 0', async () => {
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
    expect(stdout).toBe('0.1.0\n');
    expect(stderr).toBe('');
  });
});
