import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

describe('CLI DSH home resolution', () => {
  let tempRoot: string;
  let previousDshHome: string | undefined;
  let previousCwd: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-home-'));
    previousDshHome = process.env.DSH_HOME;
    previousCwd = process.cwd();
    delete process.env.DSH_HOME;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousDshHome === undefined) {
      delete process.env.DSH_HOME;
    } else {
      process.env.DSH_HOME = previousDshHome;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const silentIo = {
    stdout: () => {},
    stderr: () => {}
  };

  it('should use DSH_HOME when --dsh-home is omitted', async () => {
    const home = path.join(tempRoot, 'from-env');
    process.env.DSH_HOME = home;

    const code = await runCli(['init'], silentIo);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(home, 'envctl', 'manifest.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, 'envctl'))).toBe(false);
  });

  it('should let --dsh-home win over DSH_HOME', async () => {
    process.env.DSH_HOME = path.join(tempRoot, 'from-env');
    const cliHome = path.join(tempRoot, 'from-cli');

    const code = await runCli(['init', '--dsh-home', cliHome], silentIo);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(cliHome, 'envctl', 'manifest.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, 'from-env', 'envctl'))).toBe(false);
  });

  it('should resolve a relative --dsh-home against the current working directory', async () => {
    process.chdir(tempRoot);
    const code = await runCli(['init', '--dsh-home', './rel-home'], silentIo);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(tempRoot, 'rel-home', 'envctl', 'manifest.yaml'))).toBe(true);
  });
});
