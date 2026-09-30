import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';
import { loadManifest } from '../../src/manifest/files.js';

const PATCH_FILE = `# Your patch layer for this dsh profile
- id: locale
  name: "@deepseek-ai/dsh-client-locale"
  config:
    preference: zh
- id: skill-filesystem
  config:
    customSkillDirs:
      - /home/me/skills
`;

describe('CLI pull', () => {
  let tempHome: string;
  const patchFile = () => path.join(tempHome, 'profiles', 'web', 'cordis.patch.yml');
  const manifest = () => loadManifest(fs.readFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), 'utf8'));
  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], {
      stdout: (chunk) => { stdout += chunk; },
      stderr: (chunk) => { stderr += chunk; }
    });
    return { code, stdout, stderr };
  };

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-pull-'));
    const profileDir = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
    fs.writeFileSync(patchFile(), PATCH_FILE);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('reports DSH entries in plan, pulls them, and leaves plan clean', async () => {
    expect((await run(['init'])).code).toBe(0);
    const plan = await run(['plan']);
    expect(plan.code).toBe(0);
    expect(plan.stdout).toContain('? [web] locale, skill-filesystem');

    const preview = await run(['pull', '--dry-run']);
    expect(preview.code).toBe(2);
    expect(preview.stdout).toContain('[web] from DSH: + locale, + skill-filesystem');
    expect(fs.readFileSync(patchFile(), 'utf8')).toBe(PATCH_FILE);

    const pulled = await run(['pull']);
    expect(pulled.code).toBe(0);
    expect(pulled.stdout).toContain("(base 1, overlay 'local' 1)");
    expect(pulled.stdout).toContain("overlay 'local', now selected");
    expect(manifest().profiles.web.patches?.map((entry) => entry.id)).toEqual(['locale']);

    const after = await run(['plan']);
    expect(after.code).toBe(0);
    expect(after.stderr).toContain('overlay: local (file)');
    expect(after.stdout).not.toMatch(/Planned operations|Patch entries not in the manifest/);
    expect((await run(['pull'])).stdout).toContain('Nothing to pull');
  });

  it('rejects an unknown --prefer and machine-local entries under --no-overlay', async () => {
    await run(['init']);
    expect((await run(['pull', '--prefer', 'both'])).code).toBe(3);
    const refused = await run(['pull', '--no-overlay']);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toMatch(/machine-local paths/);
  });

  it('says what adopt already recorded when taking over the patch entries then fails', async () => {
    await run(['capture', '--output', path.join(tempHome, 'capture.yaml')]);
    const adopted = await run(['adopt', '--from', path.join(tempHome, 'capture.yaml'), '--no-overlay', '--yes']);
    expect(adopted.code).toBe(3);
    expect(adopted.stderr).toMatch(/^Adopted 1 plugin\(s\) across profile\(s\): web, but taking over their patch entries failed: .*machine-local paths.*; fix that and run dshenv pull/m);
    // The adoption itself stands: running adopt again is not needed, only the pull.
    expect(Object.keys(manifest().profiles.web.plugins)).toHaveLength(1);
    expect(fs.existsSync(path.join(tempHome, 'envctl', 'state.json'))).toBe(true);
    expect(fs.readFileSync(patchFile(), 'utf8')).toBe(PATCH_FILE);
    expect((await run(['pull'])).code).toBe(0);
  });

  it('takes the patch entries over when adopting a profile', async () => {
    const captured = await run(['capture', '--output', path.join(tempHome, 'capture.yaml')]);
    expect(captured.code).toBe(0);
    expect(fs.readFileSync(path.join(tempHome, 'capture.yaml'), 'utf8')).toContain('2 patch entries outside the manifest');

    const adopted = await run(['adopt', '--from', path.join(tempHome, 'capture.yaml'), '--yes']);
    expect(adopted.code).toBe(0);
    expect(adopted.stdout).toContain('[web] from DSH: + locale, + skill-filesystem');
    expect(manifest().profiles.web.patches?.map((entry) => entry.id)).toEqual(['locale']);
    expect((await run(['plan'])).stdout).toContain('No changes planned');
  });
});
