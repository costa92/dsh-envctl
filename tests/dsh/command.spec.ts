import { describe, it, expect } from 'vitest';
import {
  resolveDshCommand,
  probeDsh,
  capabilitiesFor,
  type CommandSpec
} from '../../src/dsh/index.js';

describe('probeDsh', () => {
  const cmd: CommandSpec = { file: 'dsh', args: [] };
  it.each([
    'v0.1.7', '0.1.7garbage', '0.1.7-', '0.1.7.0', '00.01.007',
    '0.1.7-01', '0.1.7-rc.01', 'DSH 0.1.7', ' 0.1.7 ',
    '0.1.70-Authorization_Bearer_doctor-secret',
  ])('rejects output without a strictly valid version line: %j', async stdout => {
    await expect(probeDsh(cmd, async () => ({ stdout, stderr: '' })))
      .rejects.toThrow('Unable to parse DSH runtime version');
  });
  it('selects the independent version line after pnpm command echoes', async () => {
    const stdout = '> harness@0.1.7 dsh /source\r\n> node cli.js --version\r\n\r\n0.1.7-rc.2\r\n';
    expect(await probeDsh(cmd, async () => ({ stdout, stderr: '' })))
      .toEqual({ version: '0.1.7-rc.2', raw: stdout.trim() });
  });
  it('accepts a strict version line from stderr when stdout is empty', async () => {
    expect((await probeDsh(cmd, async () => ({ stdout: '', stderr: '0.1.7\n' }))).version).toBe('0.1.7');
  });
});

describe('resolveDshCommand', () => {
  it('should parse DSH_CLI as JSON array if formatted as array', () => {
    const cmd = resolveDshCommand({
      envDshCli: '["node", "/path/to/dsh.js", "--verbose"]'
    });
    expect(cmd).toEqual({
      file: 'node',
      args: ['/path/to/dsh.js', '--verbose']
    });
  });

  it('should treat malicious shell string in DSH_CLI as literal file and never shell', () => {
    const cmd = resolveDshCommand({
      envDshCli: 'dsh; touch /tmp/pwned'
    });
    expect(cmd).toEqual({
      file: 'dsh; touch /tmp/pwned',
      args: []
    });
  });

  it('should resolve harness source dir to pnpm --dir <sourceDir> dsh', () => {
    const cmd = resolveDshCommand({
      cliHarnessSource: '/Users/costalong/code/dsh/deepseek-harness',
      sourceDirExists: () => true
    });
    expect(cmd).toEqual({
      file: 'pnpm',
      args: ['--dir', '/Users/costalong/code/dsh/deepseek-harness', 'dsh'],
      cwd: '/Users/costalong/code/dsh/deepseek-harness'
    });
  });

  it('should resolve dsh in PATH if no source dir or DSH_CLI', () => {
    const cmd = resolveDshCommand({
      which: (bin) => (bin === 'dsh' ? '/usr/local/bin/dsh' : null),
      sourceDirExists: () => false
    });
    expect(cmd).toEqual({
      file: '/usr/local/bin/dsh',
      args: []
    });
  });

  it('should return null if no command or source directory can be resolved', () => {
    const cmd = resolveDshCommand({
      which: () => null,
      sourceDirExists: () => false
    });
    expect(cmd).toBeNull();
  });
});

describe('capabilitiesFor', () => {
  it('should return capabilities for 0.1.7-rc.2', () => {
    const caps = capabilitiesFor('0.1.7-rc.2');
    expect(caps.discovery.status).toBe('available');
    expect(caps.packageOperations.status).toBe('disabled');
    expect(caps.mutations).toBe(false);
    expect(caps.operationsExport).toBe('@deepseek-ai/dsh-plugin-manager/operations');
  });

  it('should return unsupported capabilities for unknown version', () => {
    const caps = capabilitiesFor('0.0.1');
    expect(caps.discovery.status).toBe('disabled');
    expect(caps.packageOperations.status).toBe('disabled');
    expect(caps.mutations).toBe(false);
    expect(caps.operationsExport).toBeNull();
  });
});
