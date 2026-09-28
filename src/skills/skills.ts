import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentPaths } from '../environment/paths.js';
import { calculateSourceDigest } from '../source/local.js';

// name -> content digest of each skill directory
export interface SkillInventory {
  // envctl/skills: what the manifest declares
  declared: Record<string, string>;
  // $DSH_HOME/skills: what DSH loads
  live: Record<string, string>;
}

export interface SkillOperation {
  kind: 'install' | 'update' | 'remove';
  name: string;
  reason: string;
}

const SkillNameRegex = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

// The same entries calculateSourceDigest skips, so a copy digests like its source.
const SKIPPED = new Set(['node_modules', '.git', '.DS_Store']);

async function readSkillDigests(dir: string): Promise<Record<string, string>> {
  if (!fs.existsSync(dir)) {
    return {};
  }
  const digests: Record<string, string> = {};
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && SkillNameRegex.test(entry.name)) {
      digests[entry.name] = await calculateSourceDigest(path.join(dir, entry.name));
    }
  }
  return digests;
}

export async function readSkillInventory(paths: EnvironmentPaths): Promise<SkillInventory> {
  return { declared: await readSkillDigests(paths.skillsDir), live: await readSkillDigests(paths.dshSkillsDir) };
}

// `owned` holds the digest each skill had when both sides last matched (state.skills).
export function planSkills(
  skills: SkillInventory,
  owned: Record<string, string> | undefined
): { operations: SkillOperation[]; unmanaged: string[] } {
  const operations: SkillOperation[] = [];
  const unmanaged: string[] = [];
  for (const [name, digest] of Object.entries(skills.declared)) {
    const live = skills.live[name];
    if (live === undefined) {
      operations.push({ kind: 'install', name, reason: 'Skill is declared but not in DSH_HOME/skills' });
    } else if (live !== digest) {
      const editedInDsh = owned?.[name] === digest;
      operations.push({
        kind: 'update',
        name,
        reason: editedInDsh
          ? "Skill was edited in DSH; run 'dshenv pull' to keep the edits, or apply to overwrite them (the DSH copy goes to trash)"
          : 'Skill changed in the manifest'
      });
    }
  }
  for (const name of Object.keys(skills.live)) {
    if (skills.declared[name] !== undefined) {
      continue;
    }
    if (owned?.[name] !== undefined) {
      operations.push({ kind: 'remove', name, reason: 'Owned skill is no longer declared; apply moves it to trash' });
    } else {
      unmanaged.push(name);
    }
  }
  return { operations, unmanaged };
}

export async function copySkillDir(from: string, to: string): Promise<void> {
  await fs.promises.cp(from, to, {
    recursive: true,
    filter: (source) => !SKIPPED.has(path.basename(source)) && !fs.lstatSync(source).isSymbolicLink()
  });
}

// Replaces `target` with a copy of `source` (or removes it when source is null), keeping the old one under `trash`.
// Returns how to undo it.
export async function replaceSkillDir(source: string | null, target: string, trash: string): Promise<() => Promise<void>> {
  const staging = source ? `${target}.dshenv-${process.pid}-${Date.now()}` : null;
  if (source && staging) {
    await copySkillDir(source, staging);
  }
  const hadTarget = fs.existsSync(target);
  if (hadTarget) {
    await fs.promises.mkdir(path.dirname(trash), { recursive: true });
    await fs.promises.rename(target, trash);
  }
  if (staging) {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.rename(staging, target);
  }
  return async () => {
    await fs.promises.rm(target, { recursive: true, force: true });
    if (hadTarget) {
      await fs.promises.rename(trash, target);
    }
  };
}

export async function applySkillOperation(paths: EnvironmentPaths, operation: SkillOperation, trashRoot: string): Promise<() => Promise<void>> {
  const source = operation.kind === 'remove' ? null : path.join(paths.skillsDir, operation.name);
  return replaceSkillDir(source, path.join(paths.dshSkillsDir, operation.name), path.join(trashRoot, 'skills', operation.name));
}
