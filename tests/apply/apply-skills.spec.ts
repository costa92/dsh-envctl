import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyEnvironment } from '../../src/apply/apply.js';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import { loadState } from '../../src/manifest/files.js';
import { renderPlan } from '../../src/output/render.js';

describe('apply skills', () => {
  let tempHome: string;
  let paths: EnvironmentPaths;
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const dshSkill = (name: string) => path.join(paths.dshSkillsDir, name, 'SKILL.md');
  const plan = async () => (await applyEnvironment(paths, { dryRun: true })).plan;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-apply-skills-'));
    paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(paths.managerDir, { recursive: true });
    fs.writeFileSync(paths.manifestFile, 'apiVersion: dshenv/v1\nprofiles: {}\n');
    write(path.join(paths.skillsDir, 'wiki', 'SKILL.md'), 'declared');
    write(dshSkill('mine'), 'hand-made');
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('installs declared skills, records them as owned, and later removes them into trash', async () => {
    const before = await plan();
    expect(before.skillOperations).toEqual([{ kind: 'install', name: 'wiki', reason: expect.any(String) }]);
    expect(before.unmanagedSkills).toEqual(['mine']);
    expect(renderPlan(before)).toMatch(/\+ \[skills\] wiki[\s\S]*Skills not in the manifest[\s\S]*\? mine/);

    expect((await applyEnvironment(paths)).applied).toBe(true);
    expect(fs.readFileSync(dshSkill('wiki'), 'utf8')).toBe('declared');
    expect(Object.keys(loadState(fs.readFileSync(paths.stateFile, 'utf8')).skills ?? {})).toEqual(['wiki']);
    expect((await plan()).hasChanges).toBe(false);

    write(dshSkill('wiki'), 'edited in DSH');
    expect((await plan()).skillOperations[0].reason).toMatch(/edited in DSH/);

    fs.rmSync(path.join(paths.skillsDir, 'wiki'), { recursive: true });
    const removal = await applyEnvironment(paths);
    expect(removal.plan.skillOperations).toMatchObject([{ kind: 'remove', name: 'wiki' }]);
    expect(fs.existsSync(dshSkill('wiki'))).toBe(false);
    const trashed = fs.readdirSync(paths.trashDir).map((entry) => path.join(paths.trashDir, entry, 'skills', 'wiki', 'SKILL.md'));
    expect(trashed.some((file) => fs.existsSync(file) && fs.readFileSync(file, 'utf8') === 'edited in DSH')).toBe(true);
    expect(fs.readFileSync(dshSkill('mine'), 'utf8')).toBe('hand-made');
  });
});
