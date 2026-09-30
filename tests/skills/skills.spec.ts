import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import { applySkillOperation, planSkills, readSkillInventory, replaceSkillDir } from '../../src/resources/skill.js';

describe('planSkills', () => {
  it('installs a declared skill DSH lacks and updates one whose content differs', () => {
    const { operations, unmanaged } = planSkills({ declared: { a: 'd1', b: 'd2' }, live: { b: 'old' } }, { b: 'old' });
    expect(operations).toEqual([
      { resource: 'skill', kind: 'install', name: 'a', reason: 'Skill is declared but not in DSH_HOME/skills' },
      { resource: 'skill', kind: 'update', name: 'b', reason: 'Skill changed in the manifest' }
    ]);
    expect(unmanaged).toEqual([]);
  });

  it('points to pull when only DSH changed the skill', () => {
    const { operations } = planSkills({ declared: { a: 'same' }, live: { a: 'edited' } }, { a: 'same' });
    expect(operations[0].reason).toMatch(/edited in DSH.*dshenv pull.*trash/);
  });

  it('does not point to pull for a team skill edited in DSH, since pull refuses it', () => {
    const { operations } = planSkills({ declared: { a: 'same' }, live: { a: 'edited' }, remote: ['a'] }, { a: 'same' });
    expect(operations[0].reason).not.toMatch(/pull/);
    expect(operations[0].reason).toMatch(/edited in DSH.*team repository.*trash/);
  });

  it('removes an owned skill the manifest dropped and reports the others as unmanaged', () => {
    const { operations, unmanaged } = planSkills({ declared: {}, live: { owned: 'x', mine: 'y' } }, { owned: 'x' });
    expect(operations).toEqual([{ resource: 'skill', kind: 'remove', name: 'owned', reason: 'Owned skill is no longer declared; apply moves it to trash' }]);
    expect(unmanaged).toEqual(['mine']);
  });
});

describe('skill files', () => {
  let tempHome: string;
  let paths: EnvironmentPaths;
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-skills-'));
    paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    write(path.join(paths.skillsDir, 'wiki', 'SKILL.md'), 'v2');
    write(path.join(paths.skillsDir, 'wiki', 'refs', 'a.md'), 'ref');
    write(path.join(paths.dshSkillsDir, 'wiki', 'SKILL.md'), 'v1');
    write(path.join(paths.dshSkillsDir, 'loose.md'), 'not a skill directory');
    fs.mkdirSync(path.join(paths.dshSkillsDir, '.hidden'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('inventories skill directories on both sides by digest', async () => {
    const inventory = await readSkillInventory(paths);
    expect(Object.keys(inventory.declared)).toEqual(['wiki']);
    expect(Object.keys(inventory.live)).toEqual(['wiki']);
    expect(inventory.declared.wiki).not.toBe(inventory.live.wiki);
  });

  it('replaces the DSH copy, keeps the old one in trash, and undoes it', async () => {
    const trash = path.join(paths.trashDir, 'apply-1');
    const undo = await applySkillOperation(paths, { resource: 'skill', kind: 'update', name: 'wiki', reason: '' }, trash);
    expect(fs.readFileSync(path.join(paths.dshSkillsDir, 'wiki', 'refs', 'a.md'), 'utf8')).toBe('ref');
    expect(fs.readFileSync(path.join(trash, 'skills', 'wiki', 'SKILL.md'), 'utf8')).toBe('v1');
    const inventory = await readSkillInventory(paths);
    expect(inventory.live.wiki).toBe(inventory.declared.wiki);

    await undo();
    expect(fs.readFileSync(path.join(paths.dshSkillsDir, 'wiki', 'SKILL.md'), 'utf8')).toBe('v1');
    expect(fs.existsSync(path.join(paths.dshSkillsDir, 'wiki', 'refs'))).toBe(false);
  });

  it('moves a removed skill into trash', async () => {
    const trash = path.join(paths.trashDir, 'apply-2');
    await applySkillOperation(paths, { resource: 'skill', kind: 'remove', name: 'wiki', reason: '' }, trash);
    expect(fs.existsSync(path.join(paths.dshSkillsDir, 'wiki'))).toBe(false);
    expect(fs.readFileSync(path.join(trash, 'skills', 'wiki', 'SKILL.md'), 'utf8')).toBe('v1');
  });
});

describe('replaceSkillDir failures', () => {
  let dir: string;
  const source = () => path.join(dir, 'source');
  const target = () => path.join(dir, 'dsh-skills', 'wiki');
  const trash = () => path.join(dir, 'trash', 'wiki');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-skill-replace-'));
    fs.mkdirSync(source());
    fs.writeFileSync(path.join(source(), 'SKILL.md'), 'new');
    fs.mkdirSync(target(), { recursive: true });
    fs.writeFileSync(path.join(target(), 'SKILL.md'), 'old');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves no staging copy in DSH skills when copying fails', async () => {
    vi.spyOn(fs.promises, 'cp').mockImplementationOnce(async (_from, to) => {
      fs.mkdirSync(String(to));
      throw new Error('ENOSPC');
    });
    await expect(replaceSkillDir(source(), target(), trash())).rejects.toThrow(/ENOSPC/);
    expect(fs.readdirSync(path.dirname(target()))).toEqual(['wiki']);
    expect(fs.readFileSync(path.join(target(), 'SKILL.md'), 'utf8')).toBe('old');
  });

  it('puts the old skill back when the new copy cannot take its place', async () => {
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename')
      .mockImplementationOnce(rename)
      .mockRejectedValueOnce(new Error('EXDEV'))
      .mockImplementation(rename);
    await expect(replaceSkillDir(source(), target(), trash())).rejects.toThrow(/EXDEV/);
    expect(fs.readdirSync(path.dirname(target()))).toEqual(['wiki']);
    expect(fs.readFileSync(path.join(target(), 'SKILL.md'), 'utf8')).toBe('old');
  });
});
