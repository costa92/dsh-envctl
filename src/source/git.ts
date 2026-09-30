import * as fs from 'node:fs';
import * as path from 'node:path';
import { execa } from 'execa';
import { ValidationError, DshError } from '../errors.js';
import { isValidProfileName } from '../manifest/schema.js';

export interface GitWorkingTreeStatus {
  isGitRepo: boolean;
  isDirty: boolean;
  commit?: string;
  branch?: string;
  trackingBranch?: string;
}

function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function managedGitSourceDir(
  managerDir: string,
  profileName: string,
  packageName: string
): string {
  if (!isValidProfileName(profileName)) {
    throw new ValidationError(`Invalid profile name: ${profileName}`);
  }
  const safePackage = packageName.replaceAll('/', '_').replaceAll('\\', '_');
  if (!/^[-A-Za-z0-9._@]+$/.test(safePackage) || safePackage.startsWith('.')) {
    throw new ValidationError(`Invalid package name for managed source: ${packageName}`);
  }
  const dir = path.join(path.resolve(managerDir), 'sources', profileName, safePackage);
  if (!isPathInside(managerDir, dir)) {
    throw new ValidationError(`Managed source path escapes envctl: ${dir}`);
  }
  return dir;
}

export function packageNameFromGitUrl(url: string): string {
  // A local repository on Windows is a path with backslashes.
  const trimmed = url.replace(/[\\/]+$/, '').replace(/\.git$/i, '');
  const segment = trimmed.split(/[\\/]/).filter(Boolean).pop();
  if (!segment) {
    throw new ValidationError(`Cannot derive package name from git URL: ${url}`);
  }
  return segment;
}

export function resolvePluginSourcePath(
  pluginName: string,
  explicitSourceRoot?: string
): string {
  const baseRoot = explicitSourceRoot || process.env.DSH_PLUGIN_SOURCE_HOME;
  if (!baseRoot) {
    throw new ValidationError('No plugin source root: pass one or set DSH_PLUGIN_SOURCE_HOME');
  }
  const sanitizedName = pluginName.includes('/') ? pluginName.split('/')[1] : pluginName;
  return path.resolve(baseRoot, sanitizedName);
}

export async function inspectGitWorkingTree(
  repoDir: string
): Promise<GitWorkingTreeStatus> {
  if (!fs.existsSync(repoDir)) {
    return { isGitRepo: false, isDirty: false };
  }

  const gitDir = path.join(repoDir, '.git');
  if (!fs.existsSync(gitDir)) {
    return { isGitRepo: false, isDirty: false };
  }

  try {
    const statusRes = await execa('git', ['status', '--porcelain'], {
      cwd: repoDir,
      shell: false,
      timeout: 10000
    });
    const isDirty = statusRes.stdout.trim().length > 0;

    const commitRes = await execa('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      shell: false,
      timeout: 5000
    });
    const commit = commitRes.stdout.trim();

    let branch: string | undefined;
    try {
      const branchRes = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: repoDir,
        shell: false,
        timeout: 5000
      });
      branch = branchRes.stdout.trim() !== 'HEAD' ? branchRes.stdout.trim() : undefined;
    } catch {
      // detached head
    }

    return {
      isGitRepo: true,
      isDirty,
      commit,
      branch
    };
  } catch {
    return { isGitRepo: false, isDirty: false };
  }
}

// git reads an argument starting with '-' as an option, wherever it stands.
function assertNotOptionLike(kind: string, value: string): void {
  if (value.startsWith('-')) {
    throw new ValidationError(`${kind} must not start with -: ${value}`);
  }
}

export async function cloneManagedGit(
  url: string,
  targetDir: string,
  ref?: string
): Promise<{ commit: string }> {
  if (!path.isAbsolute(targetDir)) {
    throw new ValidationError(`Target directory must be absolute: ${targetDir}`);
  }

  assertNotOptionLike('Git URL', url);
  if (ref) {
    assertNotOptionLike('Git ref', ref);
  }

  await fs.promises.mkdir(path.dirname(targetDir), { recursive: true });

  await execa('git', ['clone', ...(ref ? ['--branch', ref] : []), '--', url, targetDir], { shell: false, timeout: 60000 });

  const commitRes = await execa('git', ['rev-parse', 'HEAD'], {
    cwd: targetDir,
    shell: false,
    timeout: 5000
  });

  return { commit: commitRes.stdout.trim() };
}

export async function safeFastForwardManagedGit(
  repoDir: string,
  targetCommitOrRef: string
): Promise<{ previousCommit: string; newCommit: string }> {
  assertNotOptionLike('Git ref', targetCommitOrRef);
  const status = await inspectGitWorkingTree(repoDir);
  if (!status.isGitRepo) {
    throw new ValidationError(`Directory is not a git repository: ${repoDir}`);
  }
  if (status.isDirty) {
    throw new DshError(
      `Refusing to update Git source with dirty working tree at ${repoDir}. Commit or stash changes manually before proceeding.`,
      1
    );
  }

  const previousCommit = status.commit || 'unknown';

  await execa('git', ['fetch', '--all'], { cwd: repoDir, shell: false, timeout: 30000 });
  // A bare branch name would resolve to the local branch, which never moves on its own; follow its upstream copy.
  // show-ref matches whole ref names only, so revisions such as HEAD~1 keep their meaning; origin/HEAD is not a branch.
  const upstream =
    targetCommitOrRef === 'HEAD'
      ? null
      : await execa('git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${targetCommitOrRef}`], {
          cwd: repoDir,
          shell: false,
          reject: false,
          timeout: 5000
        });
  const target = upstream?.exitCode === 0 ? `origin/${targetCommitOrRef}` : targetCommitOrRef;
  await execa('git', ['merge', '--ff-only', target], {
    cwd: repoDir,
    shell: false,
    timeout: 10000
  });

  const newCommitRes = await execa('git', ['rev-parse', 'HEAD'], {
    cwd: repoDir,
    shell: false,
    timeout: 5000
  });

  return {
    previousCommit,
    newCommit: newCommitRes.stdout.trim()
  };
}
