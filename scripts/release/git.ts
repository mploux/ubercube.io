import { createHash } from 'node:crypto';

export interface GitCommit { sha: string; branch: string }

export function commitSha(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) throw new Error('A full 40-character Git commit SHA is required.');
  return value;
}

async function git(root: string, args: string[], allowFailure = false) {
  const child = Bun.spawn(['git', ...args], {
    cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, stdout: 'pipe', stderr: 'pipe',
  });
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code && !allowFailure) throw new Error(`Git ${args[0]} failed; check the repository and remote access. Command output is omitted to protect credentials.`);
  return { code, output: output.trim() };
}

export async function cleanCommit(root: string): Promise<GitCommit> {
  if ((await git(root, ['status', '--porcelain=v1', '--untracked-files=all'])).output) throw new Error('Release requires a clean Git worktree and index, including untracked files. Commit the intended changes first.');
  const sha = commitSha((await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).output);
  const branch = (await git(root, ['symbolic-ref', '--short', 'HEAD'])).output;
  return { sha, branch };
}

export async function committedFiles(root: string, sha: string, files: Map<string, Uint8Array>): Promise<void> {
  const entries = (await git(root, ['ls-tree', '-r', '-z', commitSha(sha)])).output.split('\0').filter(Boolean);
  const blobs = new Map(entries.map(entry => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
    return match ? [match[3], match[2]] : ['', ''];
  }));
  for (const [file, bytes] of files) {
    const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (blobs.get(file) !== hash) throw new Error(`Release file differs from the committed Git blob: ${file}. Use the committed LF bytes and include every release file in Git.`);
  }
}

export async function pushedCommit(root: string, sha: string, branch: string, repository?: string): Promise<void> {
  commitSha(sha);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || (await git(root, ['check-ref-format', `refs/heads/${branch}`], true)).code) throw new Error('Invalid Git branch.');
  if (repository) {
    const remote = (await git(root, ['remote', 'get-url', 'origin'])).output;
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote);
    if (match?.[1] !== repository) throw new Error('Git origin must match the configured GitHub repository without embedded credentials.');
  }
  const reference = `refs/heads/${branch}`;
  const remote = (await git(root, ['ls-remote', '--exit-code', 'origin', reference], true));
  const line = remote.output.split(/\r?\n/).find(line => line.endsWith(`\t${reference}`));
  if (remote.code || !line) throw new Error('Commit is not verified as pushed: the requested origin branch is unavailable.');
  const tip = commitSha(line.split('\t')[0]);
  if ((await git(root, ['cat-file', '-e', `${tip}^{commit}`], true)).code) throw new Error('Remote branch advanced; fetch it explicitly before verifying pushed ancestry.');
  if ((await git(root, ['merge-base', '--is-ancestor', sha, tip], true)).code) throw new Error('Commit is not pushed on the requested origin branch.');
}
