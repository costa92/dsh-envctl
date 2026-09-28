import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import { applySkillOperation, planSkills, readSkillInventory } from '../../src/skills/skills.js';

describe('planSkills', () => {
  it('installs a declared skill DSH lacks and updates one whose content differs', () => {
    const { operations, unmanaged } = planSkills({ declared: { a: 'd1', b: 'd2' }, live: { b: 'old' } }, { b: 'old' });
    expect(operations).toEqual([
      { kind: 'install', name: 'a', reason: 'Skill is declared but not in DSH_HOME/skills' },
      { kind: 'update', name: 'b', reason: 'Skill changed in the manifest' }
    ]);
    expect(unmanaged).toEqual([]);
  });

  it('points to pull when only DSH changed the skill', () => {
    const { operations } = planSkills({ declared: { a: 'same' }, live: { a: 'edited' } }, { a: 'same' });
    expect(operations[0].reason).toMatch(/edited in DSH.*dshenv pull.*trash/);
  });

  it('removes an owned skill the manifest dropped and reports the others as unmanaged', () => {
    const { operations, unmanaged } = planSkills({ declared: {}, live: { owned: 'x', mine: 'y' } }, { owned: 'x' });
    expect(operations).toEqual([{ kind: 'remove', name: 'owned', reason: 'Owned skill is no longer declared; apply moves it to trash' }]);
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
    const undo = await applySkillOperation(paths, { kind: 'update', name: 'wiki', reason: '' }, trash);
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
    await applySkillOperation(paths, { kind: 'remove', name: 'wiki', reason: '' }, trash);
    expect(fs.existsSync(path.join(paths.dshSkillsDir, 'wiki'))).toBe(false);
    expect(fs.readFileSync(path.join(trash, 'skills', 'wiki', 'SKILL.md'), 'utf8')).toBe('v1');
  });
});
