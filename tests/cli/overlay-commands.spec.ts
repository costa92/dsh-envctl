import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { writeOverlayFixture } from '../helpers/overlay-fixture.js';

describe('CLI overlay commands', () => {
  let tempHome: string;
  const selectionFile = () => path.join(tempHome, 'envctl', 'overlay-selection.json');
  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], {
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: (chunk) => {
        stderr += chunk;
      }
    });
    return { code, stdout, stderr };
  };

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-overlay-cmd-'));
    writeOverlayFixture(tempHome);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('persists and clears the selection', async () => {
    expect((await run(['overlay', 'use', 'laptop'])).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(selectionFile(), 'utf8')).overlay).toBe('laptop');
    const plan = await run(['plan', '--json']);
    expect(JSON.parse(plan.stdout).overlay).toEqual({ name: 'laptop', via: 'file' });

    expect((await run(['overlay', 'use', '--none'])).code).toBe(0);
    expect(fs.existsSync(selectionFile())).toBe(false);
  });

  it('refuses to select a missing or invalid overlay', async () => {
    const missing = await run(['overlay', 'use', 'ghost']);
    expect(missing.code).toBe(3);
    expect(fs.existsSync(selectionFile())).toBe(false);

    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'overlays', 'broken.yaml'),
      'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      ghost:\n        remove: true\n'
    );
    expect((await run(['overlay', 'use', 'broken'])).code).toBe(3);
    expect(fs.existsSync(selectionFile())).toBe(false);
  });

  it('requires exactly one of a name or --none', async () => {
    expect((await run(['overlay', 'use'])).code).toBe(3);
    expect((await run(['overlay', 'use', 'laptop', '--none'])).code).toBe(3);
  });

  it('lists overlays and marks the active one', async () => {
    fs.writeFileSync(path.join(tempHome, 'envctl', 'overlays', 'server.yaml'), 'apiVersion: dshenv-overlay/v1\n');
    await run(['overlay', 'use', 'laptop']);
    const text = await run(['overlay', 'list']);
    expect(text.stdout).toBe('* laptop (file)\n  server\n');
    const json = await run(['overlay', 'list', '--json', '--overlay', 'server']);
    expect(JSON.parse(json.stdout)).toEqual({
      active: { name: 'server', via: 'flag' },
      overlays: [
        { name: 'laptop', active: false },
        { name: 'server', active: true }
      ]
    });
  });

  it('shows the merged manifest with provenance', async () => {
    const json = await run(['overlay', 'show', '--json', '--overlay', 'laptop']);
    const parsed = JSON.parse(json.stdout);
    expect(Object.keys(parsed.manifest.profiles.web.plugins).sort()).toEqual(['extra', 'shared']);
    expect(parsed.provenance.web.extra.origin).toBe('overlay:laptop');

    const text = await run(['overlay', 'show', '--overlay', 'laptop', '--profile', 'web']);
    expect(text.stderr).toBe('overlay: laptop (flag)\n');
    expect(text.stdout).toBe('web extra extra-plugin origin=overlay:laptop\nweb shared shared-plugin origin=base\n');
  });

  it('marks overlay files whose names cannot be selected', async () => {
    fs.writeFileSync(path.join(tempHome, 'envctl', 'overlays', 'has space.yaml'), 'apiVersion: dshenv-overlay/v1\n');
    const text = await run(['overlay', 'list']);
    expect(text.stdout).toBe('  has space (invalid name)\n  laptop\n');
    const json = await run(['overlay', 'list', '--json']);
    expect(JSON.parse(json.stdout).overlays).toEqual([
      { name: 'has space', active: false, invalid: true },
      { name: 'laptop', active: false }
    ]);
  });

  it('reports the selection in the same shape as list and show', async () => {
    const selected = await run(['overlay', 'use', 'laptop', '--json']);
    expect(JSON.parse(selected.stdout)).toEqual({ status: 'selected', overlay: { name: 'laptop', via: 'file' } });
    const cleared = await run(['overlay', 'use', '--none', '--json']);
    expect(JSON.parse(cleared.stdout)).toEqual({ status: 'selected', overlay: null });
  });

  it('warns that DSHENV_OVERLAY still wins after overlay use', async () => {
    const previous = process.env.DSHENV_OVERLAY;
    fs.writeFileSync(path.join(tempHome, 'envctl', 'overlays', 'server.yaml'), 'apiVersion: dshenv-overlay/v1\n');
    process.env.DSHENV_OVERLAY = 'server';
    try {
      const result = await run(['overlay', 'use', 'laptop']);
      expect(result.code).toBe(0);
      expect(JSON.parse(fs.readFileSync(selectionFile(), 'utf8')).overlay).toBe('laptop');
      expect(result.stderr).toContain("DSHENV_OVERLAY=server takes precedence over the saved overlay in this shell");
    } finally {
      if (previous === undefined) delete process.env.DSHENV_OVERLAY;
      else process.env.DSHENV_OVERLAY = previous;
    }
  });
});
