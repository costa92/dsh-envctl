import { describe, it, expect } from 'vitest';
import {
  resolveDshCommand,
  probeDsh,
  capabilitiesFor,
  type CommandSpec
} from '../../src/dsh/index.js';

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
    expect(caps).toEqual({
      discovery: true,
      mutations: false,
      operationsExport: '@deepseek-ai/dsh-plugin-manager/operations'
    });
  });

  it('should return unsupported capabilities for unknown version', () => {
    const caps = capabilitiesFor('0.0.1');
    expect(caps).toEqual({
      discovery: false,
      mutations: false,
      operationsExport: null
    });
  });
});
