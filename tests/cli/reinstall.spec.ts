import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as YAML from 'yaml';
import { runCli } from '../../src/cli.js';

describe('CLI install over an existing alias', () => {
  let tempHome: string;
  const run = async (args: string[]) => {
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], { stdout: () => {}, stderr: (chunk) => { stderr += chunk; } });
    return { code, stderr };
  };
  const readYaml = (file: string) => YAML.parse(fs.readFileSync(path.join(tempHome, 'envctl', file), 'utf8'));

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-reinstall-'));
    await run(['init']);
    await run(['install', 'demo-plugin@1.0.0', '--profile', 'web', '--as', 'demo']);
    await run(['config', 'set', 'demo', 'mode', 'fast', '--profile', 'web']);
    await run(['disable', 'demo', '--profile', 'web']);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('only replaces the source in the base manifest, keeping patches and the enabled state', async () => {
    expect((await run(['install', 'demo-plugin@1.0.1', '--profile', 'web', '--as', 'demo'])).code).toBe(0);
    const demo = readYaml('manifest.yaml').profiles.web.plugins.demo;
    expect(demo.source).toEqual({ type: 'npm', version: '1.0.1' });
    expect(demo.enabled).toBe(false);
    expect(demo.patches).toEqual([{ id: 'demo', config: { mode: 'fast' } }]);
  });

  it('only overrides the source in an overlay when the plugin already exists', async () => {
    fs.mkdirSync(path.join(tempHome, 'envctl', 'overlays'), { recursive: true });
    fs.writeFileSync(path.join(tempHome, 'envctl', 'overlays', 'laptop.yaml'), 'apiVersion: dshenv-overlay/v1\n');
    await run(['overlay', 'use', 'laptop']);
    expect((await run(['install', 'demo-plugin@1.0.1', '--profile', 'web', '--as', 'demo', '--layer', 'overlay'])).code).toBe(0);
    expect(readYaml('overlays/laptop.yaml').profiles.web.plugins.demo).toEqual({ source: { type: 'npm', version: '1.0.1' } });
  });
});
