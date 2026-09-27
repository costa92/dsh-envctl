import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { resolveDshCommand } from '../../src/dsh/command.js';

describe('test isolation from a real dsh', () => {
  it('resolves dsh on PATH to the stub, which exits 127 without doing anything', async () => {
    const command = resolveDshCommand({ envDshCli: '' });
    expect(command?.file).toMatch(/dshenv-test-bin-[^/]+\/dsh$/);
    const result = await execa(command!.file, ['--profile', 'web', '--dump-config'], { reject: false });
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe('');
  });

  it('starts every test without a DSH_CLI from the developer shell', () => {
    expect(process.env.DSH_CLI).toBeUndefined();
  });
});
