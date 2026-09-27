import * as fs from 'node:fs';
import * as path from 'node:path';
import { execa } from 'execa';

export interface TeamRepo {
  bare: string;
  work: string;
  url: string;
}

export const TEAM_MANIFEST = `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      shared:
        package: shared-plugin
        source: { type: npm, version: "1.0.0" }
`;

export const TEAM_LOCK = `${JSON.stringify(
  {
    apiVersion: 'dshenv-lock/v1',
    profiles: { web: { plugins: { shared: { package: 'shared-plugin', source: { type: 'npm', resolvedVersion: '1.0.0' } } } } }
  },
  null,
  2
)}\n`;

export const TEAM_OVERLAY = `apiVersion: dshenv-overlay/v1
profiles:
  web:
    plugins:
      shared:
        enabled: false
`;

export const TEAM_FILES: Record<string, string> = {
  'envctl/manifest.yaml': TEAM_MANIFEST,
  'envctl/lock.json': TEAM_LOCK,
  'envctl/overlays/team.yaml': TEAM_OVERLAY,
  'envctl/state.json': '{"ignored":true}\n',
  'README.md': '# team config\n'
};

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execa('git', args, { cwd })).stdout.trim();
}

function writeFiles(root: string, files: Record<string, string | null>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    if (content === null) {
      fs.rmSync(file, { force: true });
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }
}

// A bare repository reached through file:// stands in for the team's hosted repository; no network is used.
export async function createTeamRepo(root: string, files: Record<string, string> = TEAM_FILES): Promise<TeamRepo> {
  const bare = path.join(root, 'team.git');
  const work = path.join(root, 'team-work');
  await execa('git', ['init', '--quiet', '--bare', '--initial-branch=main', bare]);
  await execa('git', ['init', '--quiet', '--initial-branch=main', work]);
  await git(work, ['config', 'user.name', 'Tester']);
  await git(work, ['config', 'user.email', 'test@example.com']);
  await git(work, ['config', 'commit.gpgsign', 'false']);
  await git(work, ['config', 'tag.gpgsign', 'false']);
  await git(work, ['remote', 'add', 'origin', `file://${bare}`]);
  const repo: TeamRepo = { bare, work, url: `file://${bare}` };
  await commitTeamFiles(repo, files, 'initial');
  return repo;
}

export async function commitTeamFiles(
  repo: TeamRepo,
  files: Record<string, string | null>,
  message: string,
  branch = 'main'
): Promise<string> {
  writeFiles(repo.work, files);
  await git(repo.work, ['add', '-A']);
  await git(repo.work, ['commit', '--quiet', '--allow-empty', '-m', message]);
  await git(repo.work, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
  return git(repo.work, ['rev-parse', 'HEAD']);
}

// Commits on a branch forked from the current tip and returns to main, so main's history is untouched.
export async function commitTeamSideBranch(
  repo: TeamRepo,
  branch: string,
  files: Record<string, string | null>,
  message: string
): Promise<string> {
  await git(repo.work, ['checkout', '--quiet', '-b', branch]);
  try {
    return await commitTeamFiles(repo, files, message, branch);
  } finally {
    await git(repo.work, ['checkout', '--quiet', 'main']);
  }
}

// Replaces the tip commit and force-pushes, as a team rewriting published history would.
export async function rewriteTeamHistory(repo: TeamRepo, files: Record<string, string | null>): Promise<string> {
  writeFiles(repo.work, files);
  await git(repo.work, ['add', '-A']);
  await git(repo.work, ['commit', '--quiet', '--amend', '--allow-empty', '-m', 'rewritten']);
  await git(repo.work, ['push', '--quiet', '--force', 'origin', 'HEAD:refs/heads/main']);
  return git(repo.work, ['rev-parse', 'HEAD']);
}

export async function tagTeamCommit(repo: TeamRepo, tag: string, commit: string): Promise<void> {
  await git(repo.work, ['tag', tag, commit]);
  await git(repo.work, ['push', '--quiet', 'origin', `refs/tags/${tag}`]);
}

export async function teamHead(repo: TeamRepo): Promise<string> {
  return git(repo.work, ['rev-parse', 'HEAD']);
}
