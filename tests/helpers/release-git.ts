import { join } from 'node:path';

export async function fixtureGit(root: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(['git', '-c', 'user.name=Release Fixture', '-c', 'user.email=release@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code) throw new Error(`Fixture Git ${args[0]} failed: ${error}`);
  return output.trim();
}

export async function commitFixture(root: string): Promise<string> {
  await fixtureGit(root, 'add', '--all');
  await fixtureGit(root, 'commit', '-m', 'Fixture snapshot');
  return fixtureGit(root, 'rev-parse', 'HEAD');
}

export async function initFixture(root: string): Promise<string> {
  await Bun.write(join(root, '.gitignore'), '.runtime/\nnode_modules/\n.env\n');
  await fixtureGit(root, 'init', '--initial-branch=main');
  return commitFixture(root);
}

export async function pushFixture(root: string): Promise<void> {
  const remote = join(root, '.runtime/origin.git').replaceAll('\\', '/');
  await fixtureGit(root, 'init', '--bare', remote);
  await fixtureGit(root, 'remote', 'add', 'origin', remote);
  await fixtureGit(root, 'push', 'origin', 'HEAD:refs/heads/main');
}
