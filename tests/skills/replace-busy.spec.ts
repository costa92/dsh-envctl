import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { replaceSkillDir } from '../../src/skills/skills.js';

// Only Windows refuses to move a directory while a file in it is open (DSH reading a skill, say); POSIX never does.
describe.runIf(process.platform === 'win32')('replaceSkillDir while a file in the skill is open', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-skill-busy-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('waits for the reader to close it instead of failing', async () => {
    const source = path.join(dir, 'source');
    const target = path.join(dir, 'skills', 'demo');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), 'new\n');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'old\n');

    const reader = fs.openSync(path.join(target, 'SKILL.md'), 'r');
    const closing = new Promise<void>((resolve) =>
      setTimeout(() => {
        fs.closeSync(reader);
        resolve();
      }, 200)
    );
    try {
      await replaceSkillDir(source, target, path.join(dir, 'trash', 'demo'));
    } finally {
      await closing;
    }
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe('new\n');
    expect(fs.readFileSync(path.join(dir, 'trash', 'demo', 'SKILL.md'), 'utf8')).toBe('old\n');
  });
});
