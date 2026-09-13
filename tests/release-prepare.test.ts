import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { prepareRelease, VALIDATION_FILES } from '../scripts/release/prepare';
import { commitFixture, fixtureGit, initFixture } from './helpers/release-git';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ubercube-release-'));
  const inputs = [
    'src/server/index.ts', 'src/shared/protocol.ts', 'src/client/main.ts', 'public/index.html',
    'scripts/build.ts', 'scripts/release/server.sh', 'package.json', 'bun.lock', 'tsconfig.json', 'vercel.json', ...VALIDATION_FILES,
    '.env', '.runtime/private-token.json', 'node_modules/ignored.js',
  ];
  for (const file of inputs) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), `fixture ${file}\n`);
  }
  await initFixture(root);
  return root;
}
async function cleanup(root: string) {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('ubercube-release-')) throw new Error('Unsafe fixture cleanup');
  await rm(root, { recursive: true, force: true });
}

test('release snapshot and transfer archives contain only frozen allowlisted inputs', async () => {
  const root = await fixture();
  try {
    const release = await prepareRelease(root, '20260913-190001');
    const manifest = await Bun.file(join(release, 'manifest.json')).json() as { file: string; sha: string; size: number }[];
    expect(manifest.map(row => row.file)).toEqual([
      'bun.lock', 'package.json', 'public/index.html', 'scripts/build.ts', 'src/client/input-button.ts', 'src/client/main.ts',
      'src/client/terrain.worker.ts', 'src/server/index.ts', 'src/shared/protocol.ts', 'tsconfig.json', 'vercel.json',
    ]);
    for (const row of manifest) {
      const contents = await readFile(join(release, 'source', row.file));
      expect(createHash('sha1').update(contents).digest('hex')).toBe(row.sha);
      expect(contents.length).toBe(row.size);
    }
    const metadata = await Bun.file(join(release, 'release.json')).json();
    expect(metadata.git).toEqual({ sha: await fixtureGit(root, 'rev-parse', 'HEAD'), branch: 'main' });
    for (const [archive, expected] of [
      ['server', ['src/server/index.ts', 'src/shared/protocol.ts', 'server.sha256']],
      ['validation', VALIDATION_FILES],
    ] as const) {
      const path = join(release, `${archive}.tar.gz`);
      expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(metadata.archives[archive]);
      const child = Bun.spawn(['tar', '-tzf', path], { stdout: 'pipe', stderr: 'pipe' });
      expect((await new Response(child.stdout).text()).trim().split(/\r?\n/)).toEqual([...expected]);
      expect(await child.exited).toBe(0);
    }
    const before = await readFile(join(release, 'source/src/server/index.ts'), 'utf8');
    await writeFile(join(root, 'src/server/index.ts'), 'later working copy changes');
    expect(await readFile(join(release, 'source/src/server/index.ts'), 'utf8')).toBe(before);
    await expect(prepareRelease(root, '20260913-190001')).rejects.toThrow();
    expect(await readFile(join(release, 'source/src/server/index.ts'), 'utf8')).toBe(before);
  } finally { await cleanup(root); }
});

test('invalid release IDs cannot escape the output directory', async () => {
  const root = await fixture();
  try {
    for (const id of ['../other', '20260913/190001', '20260913-190001/../other', 'release', '20260913-190001\n']) {
      await expect(prepareRelease(root, id)).rejects.toThrow('Release id');
    }
    expect(await readdir(join(root, '.runtime'))).toEqual(['private-token.json']);
  } finally { await cleanup(root); }
});

test('release rejects linked input directories and linked output parents', async () => {
  const root = await fixture();
  const external = await fixture();
  try {
    await symlink(join(external, 'public'), join(root, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(prepareRelease(root, '20260913-190001')).rejects.toThrow('symbolic link');
    if (process.platform === 'win32') await rmdir(join(root, 'src', 'linked'));
    else await unlink(join(root, 'src', 'linked'));
    await symlink(join(external, '.runtime'), join(root, '.runtime', 'releases'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(prepareRelease(root, '20260913-190001')).rejects.toThrow('symbolic link');
    expect(await readdir(join(external, '.runtime'))).toEqual(['private-token.json']);
  } finally { await cleanup(root); await cleanup(external); }
});

test('missing required test inputs and private key files abort before creating a release', async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'public', 'private.key'), 'do not publish');
    await expect(prepareRelease(root, '20260913-190001')).rejects.toThrow('Unsupported release input');
    await rm(join(root, 'public', 'private.key'));
    await rm(join(root, VALIDATION_FILES[0]));
    await expect(prepareRelease(root, '20260913-190001')).rejects.toThrow();
    expect(await readdir(join(root, '.runtime'))).toEqual(['private-token.json']);
  } finally { await cleanup(root); }
});

test('release changes distinguish added, modified and removed client and server files', async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, 'ops'));
    await Bun.write(join(root, 'ops/deployed-client.json'), JSON.stringify([
      { file: 'src/server/index.ts', sha: 'previous' }, { file: 'public/removed.png', sha: 'previous' },
    ]));
    await Bun.write(join(root, 'ops/deployed-server.json'), JSON.stringify([
      { file: 'src/server/index.ts', sha256: createHash('sha256').update(await readFile(join(root, 'src/server/index.ts'))).digest('hex') },
      { file: 'src/shared/removed.ts', sha256: 'previous' },
    ]));
    await commitFixture(root);
    const release = await prepareRelease(root, '20260913-190001');
    const changes = await Bun.file(join(release, 'changes.json')).json();
    expect(changes.client.changed).toEqual(['src/server/index.ts']);
    expect(changes.client.added).toContain('public/index.html');
    expect(changes.client.removed).toEqual(['public/removed.png']);
    expect(changes.server).toEqual({ baseline: 'ops/deployed-server.json', added: ['src/shared/protocol.ts'], changed: [], removed: ['src/shared/removed.ts'] });
  } finally { await cleanup(root); }
});

test('edits during archive creation leave an incomplete release without a deployable manifest', async () => {
  const root = await fixture();
  const spawn = Bun.spawn.bind(Bun);
  const mock = spyOn(Bun, 'spawn').mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
    if (Array.isArray(args[0]) && args[0][0] === 'tar') writeFileSync(join(root, 'src/server/index.ts'), 'changed after snapshot');
    return spawn(...args);
  }) as typeof Bun.spawn);
  try {
    await expect(prepareRelease(root, '20260913-190001')).rejects.toThrow('Input changed while preparing release');
    expect(await Bun.file(join(root, '.runtime/releases/20260913-190001/manifest.json')).exists()).toBe(false);
    expect(await Bun.file(join(root, '.runtime/releases/20260913-190001/release.json')).exists()).toBe(false);
  } finally { mock.mockRestore(); await cleanup(root); }
});

test('preparation rejects modified, staged and untracked files before freezing a release', async () => {
  for (const change of ['modified', 'staged', 'untracked'] as const) {
    const root = await fixture();
    try {
      await Bun.write(join(root, change === 'untracked' ? 'src/client/new.ts' : 'src/client/main.ts'), 'uncommitted');
      if (change === 'staged') await fixtureGit(root, 'add', 'src/client/main.ts');
      await expect(prepareRelease(root, '20260913-190001')).rejects.toThrow('clean Git worktree');
      expect(await Bun.file(join(root, '.runtime/releases/20260913-190001/release.json')).exists()).toBe(false);
    } finally { await cleanup(root); }
  }
});

test('preparation rejects worktree CRLF bytes that differ from the committed LF blob', async () => {
  const root = await fixture();
  try {
    await Bun.write(join(root, '.gitattributes'), '*.ts text eol=lf\n');
    await commitFixture(root);
    const file = join(root, 'src/client/main.ts');
    await Bun.write(file, (await Bun.file(file).text()).replaceAll('\n', '\r\n'));
    await fixtureGit(root, 'add', 'src/client/main.ts');
    await expect(prepareRelease(root, '20260913-190001')).rejects.toThrow('committed Git blob');
  } finally { await cleanup(root); }
});
