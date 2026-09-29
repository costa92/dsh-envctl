import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

describe('CLI rollback and gc', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-rb-'));
    await runCli(['init', '--dsh-home', tempHome]);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should refuse rollback without --yes', async () => {
    let stderr = '';
    const code = await runCli(['rollback', '--dsh-home', tempHome], {
      stdout: () => {},
      stderr: (chunk) => {
        stderr += chunk;
      }
    });
    expect(code).toBe(3);
    expect(stderr).toMatch(/--yes/);
  });

  describe('when there is nothing it can restore', () => {
    const envctl = (...parts: string[]) => path.join(tempHome, 'envctl', ...parts);
    const run = async (args: string[]) => {
      let stderr = '';
      const code = await runCli([...args, '--dsh-home', tempHome], {
        stdout: () => {},
        stderr: (chunk) => {
          stderr += chunk;
        }
      });
      return { code, stderr };
    };
    const current = () => ['manifest.yaml', 'lock.json', 'state.json'].map((file) => (fs.existsSync(envctl(file)) ? fs.readFileSync(envctl(file), 'utf8') : null));
    const snapshot = (id: string, files: Record<string, string>) => {
      fs.mkdirSync(envctl('backups', id), { recursive: true });
      for (const [file, content] of Object.entries(files)) fs.writeFileSync(envctl('backups', id, file), content);
    };

    beforeEach(() => {
      fs.writeFileSync(envctl('manifest.yaml'), 'apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins: {}\n');
    });

    it('fails with exit 3 and changes nothing when no snapshot exists', async () => {
      const before = current();
      const out = await run(['rollback', '--yes']);
      expect(out.code).toBe(3);
      expect(out.stderr).toMatch(/No environment snapshots found/);
      expect(current()).toEqual(before);
    });

    it('fails with exit 3 and changes nothing for an operation id no snapshot has', async () => {
      snapshot('2026-01-01T00-00-00-000Z-apply-aaa', { 'manifest.yaml': 'apiVersion: dshenv/v1\nprofiles: {}\n' });
      const before = current();
      const out = await run(['rollback', 'apply-zzz', '--yes']);
      expect(out.code).toBe(3);
      expect(out.stderr).toMatch(/Snapshot not found for operation: apply-zzz/);
      expect(current()).toEqual(before);
    });

    it('never picks a snapshot that was still being copied', async () => {
      fs.mkdirSync(envctl('backups', '.2026-01-01T00-00-00-000Z-apply-aaa.partial'), { recursive: true });
      const before = current();
      const out = await run(['rollback', '--yes']);
      expect(out.code).toBe(3);
      expect(out.stderr).toMatch(/No environment snapshots found/);
      expect(current()).toEqual(before);
    });

    it('refuses a snapshot whose files do not parse, and changes nothing', async () => {
      snapshot('2026-01-01T00-00-00-000Z-apply-aaa', { 'manifest.yaml': 'apiVersion: dshenv/v1\nprofiles: [\n', 'lock.json': '{' });
      const before = current();
      const out = await run(['rollback', '--yes']);
      expect(out.code).toBe(3);
      expect(out.stderr).toMatch(/Snapshot 2026-01-01T00-00-00-000Z-apply-aaa .*manifest\.yaml/);
      expect(current()).toEqual(before);
      expect(fs.readdirSync(envctl('backups'))).toEqual(['2026-01-01T00-00-00-000Z-apply-aaa']);
    });
  });

  it('should refuse gc without --yes', async () => {
    let stderr = '';
    const code = await runCli(['gc', '--dsh-home', tempHome], {
      stdout: () => {},
      stderr: (chunk) => {
        stderr += chunk;
      }
    });
    expect(code).toBe(3);
    expect(stderr).toMatch(/--yes/);
  });

  it('should dry-run gc with empty trash', async () => {
    let stdout = '';
    const code = await runCli(['gc', '--dry-run', '--dsh-home', tempHome], {
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: () => {}
    });
    expect(code).toBe(0);
    expect(stdout).toMatch(/Would delete 0/);
  });
});
