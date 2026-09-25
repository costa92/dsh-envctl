import * as fs from 'node:fs';
import * as path from 'node:path';
import { execa } from 'execa';
import { ValidationError, DshError } from '../errors.js';

export interface GitWorkingTreeStatus {
  isGitRepo: boolean;
  isDirty: boolean;
  commit?: string;
  branch?: string;
  trackingBranch?: string;
}

export function resolvePluginSourcePath(
  pluginName: string,
  explicitSourceRoot?: string
): string {
  const envSourceHome = process.env.DSH_PLUGIN_SOURCE_HOME;
  const baseRoot = explicitSourceRoot || envSourceHome || '/Users/costalong/code/dsh/plugins';
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

export async function cloneManagedGit(
  url: string,
  targetDir: string,
  ref?: string
): Promise<{ commit: string }> {
  if (!path.isAbsolute(targetDir)) {
    throw new ValidationError(`Target directory must be absolute: ${targetDir}`);
  }

  await fs.promises.mkdir(path.dirname(targetDir), { recursive: true });

  const cloneArgs = ['clone', url, targetDir];
  if (ref) {
    cloneArgs.push('--branch', ref);
  }

  await execa('git', cloneArgs, { shell: false, timeout: 60000 });

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
  await execa('git', ['merge', '--ff-only', targetCommitOrRef], {
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
