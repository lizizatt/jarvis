import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const EXEC_OPTIONS = { encoding: 'utf8' as const, maxBuffer: 8 * 1024 * 1024, timeout: 15_000 };

export async function validateGitRoot(inputPath: string): Promise<{ path: string; branch: string | null }> {
  const canonical = await realpath(inputPath);
  if (!(await stat(canonical)).isDirectory()) throw new Error('Repository path must be a directory');
  const { stdout } = await execFileAsync('git', ['-C', canonical, 'rev-parse', '--show-toplevel'], EXEC_OPTIONS);
  if ((await realpath(stdout.trim())) !== canonical) throw new Error('Path must be the root of a Git checkout');
  const branch = await git(canonical, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
  return { path: canonical, branch: branch.trim() || null };
}

export async function repositoryStatus(repositoryPath: string): Promise<unknown> {
  const [porcelain, hasCommit] = await Promise.all([
    git(repositoryPath, ['status', '--porcelain=v2', '--branch']),
    git(repositoryPath, ['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false),
  ]);
  const recent = hasCommit ? await git(repositoryPath, ['log', '-5', '--pretty=format:%H%x09%h%x09%s%x09%aI']) : '';
  const lines = porcelain.split('\n');
  const branch = lines.find((line) => line.startsWith('# branch.head '))?.slice(14) ?? null;
  const upstream = lines.find((line) => line.startsWith('# branch.upstream '))?.slice(18) ?? null;
  const aheadBehind = lines.find((line) => line.startsWith('# branch.ab '))?.match(/\+(\d+) -(\d+)/);
  return {
    branch,
    upstream,
    ahead: Number(aheadBehind?.[1] ?? 0),
    behind: Number(aheadBehind?.[2] ?? 0),
    // Untracked ('?') and ignored ('!') files don't count as dirty; only tracked changes and conflicts do.
    dirty: lines.some((line) => /^[12u]/.test(line)),
    entries: lines.filter((line) => /^[12u?!]/.test(line)),
    recentCommits: recent ? recent.split('\n').map((line) => {
      const [hash, shortHash, subject, authoredAt] = line.split('\t');
      return { hash, shortHash, subject, authoredAt };
    }) : [],
  };
}

export async function repositoryDiff(repositoryPath: string, staged: boolean): Promise<string> {
  return git(repositoryPath, staged ? ['diff', '--cached', '--no-ext-diff'] : ['diff', '--no-ext-diff']);
}

export interface RepositoryStatusFile { status: string; path: string }

// git diff/--cached omit untracked files, so this covers what repositoryStatus's dirty flag actually reports.
export async function repositoryStatusFiles(repositoryPath: string): Promise<RepositoryStatusFile[]> {
  const output = await git(repositoryPath, ['status', '--porcelain=v1']);
  return output.split('\n').filter(Boolean).map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
}

export async function pullRequest(repositoryPath: string): Promise<unknown> {
  try {
    const output = await execFileAsync('gh', ['pr', 'view',
      '--json', 'number,title,state,url,isDraft,headRefName,baseRefName,statusCheckRollup'],
    { ...EXEC_OPTIONS, cwd: repositoryPath });
    return { available: true, pullRequest: normalizePullRequest(JSON.parse(output.stdout) as unknown) };
  } catch (error) {
    const cause = error as NodeJS.ErrnoException & { stderr?: string };
    return { available: false, reason: cause.code === 'ENOENT' ? 'gh_not_installed' : 'no_pull_request_or_unauthenticated',
      detail: cause.stderr?.trim().slice(0, 500) || undefined };
  }
}

export function normalizePullRequest(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const pullRequest = value as Record<string, unknown>;
  const rollup = Array.isArray(pullRequest.statusCheckRollup) ? pullRequest.statusCheckRollup : [];
  const checks = rollup.map((entry) => {
    const check = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {};
    return {
      name: firstString(check.name, check.context, check.workflowName) ?? 'Check',
      state: firstString(check.conclusion, check.state, check.status) ?? 'UNKNOWN',
    };
  });
  return { ...pullRequest, checks };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && Boolean(value));
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', repositoryPath, ...args], EXEC_OPTIONS)).stdout;
}
