import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { cleanCommit, committedFiles } from './git';

export const RELEASE_ID = /^\d{8}-\d{6}$/;
export const VALIDATION_FILES = [
  ...['buildings', 'terrain-generation', 'terrain-colors', 'server', 'transport', 'lifecycle', 'wire', 'movement',
    'grenade-flight', 'input-backlog', 'input-button', 'deployment-origins', 'death-events', 'rpg', 'rpg-network',
    'gameplay-actions', 'gameplay-network', 'lag-compensation'].map(name => `tests/${name}.test.ts`),
  'src/client/terrain.worker.ts', 'src/client/input-button.ts',
];
const BUILD_FILES = ['scripts/build.ts', 'package.json', 'bun.lock', 'tsconfig.json', 'vercel.json'];
const digest = (bytes: Uint8Array, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');

async function regularFiles(root: string, relative: string): Promise<string[]> {
  if (!/^[\w./-]+$/.test(relative) || relative.split('/').some(part => !part || part.startsWith('.'))) {
    throw new Error(`Unsafe release path: ${relative}`);
  }
  const file = join(root, relative);
  const info = await lstat(file);
  if (info.isSymbolicLink()) throw new Error(`Release input is a symbolic link: ${relative}`);
  if (info.isDirectory()) {
    const result: string[] = [];
    for (const name of (await readdir(file)).sort()) result.push(...await regularFiles(root, `${relative}/${name}`));
    return result;
  }
  if (!info.isFile() || /\.(?:pem|key|pfx|p12|env)$/i.test(relative)) throw new Error(`Unsupported release input: ${relative}`);
  return [relative];
}

export async function prepareRelease(root: string, id: string): Promise<string> {
  if (id.length !== 15 || !RELEASE_ID.test(id)) throw new Error('Release id must be YYYYMMDD-HHMMSS');
  root = resolve(root);
  const release = join(root, '.runtime', 'releases', id);
  const source = join(release, 'source');
  const sourceFiles = [...await regularFiles(root, 'src'), ...await regularFiles(root, 'public')];
  for (const file of BUILD_FILES) sourceFiles.push(...await regularFiles(root, file));
  const inputs = [...new Set([...sourceFiles, ...VALIDATION_FILES, 'scripts/release/server.sh'])].sort();
  for (const file of inputs) {
    // Inspect every ancestor: a regular leaf can still sit inside a linked directory.
    const parts = file.split('/');
    for (let count = 1; count <= parts.length; count++) {
      if ((await lstat(join(root, ...parts.slice(0, count)))).isSymbolicLink()) throw new Error(`Release input is a symbolic link: ${file}`);
    }
    if (!(await lstat(join(root, file))).isFile()) throw new Error(`Release input is not a regular file: ${file}`);
  }
  const git = await cleanCommit(root);
  const snapshots = new Map<string, Uint8Array>();
  for (const file of inputs) snapshots.set(file, new Uint8Array(await Bun.file(join(root, file)).arrayBuffer()));
  await committedFiles(root, git.sha, snapshots);
  await mkdir(join(root, '.runtime'), { recursive: true });
  if ((await lstat(join(root, '.runtime'))).isSymbolicLink()) throw new Error('Release output cannot use a symbolic link');
  await mkdir(join(root, '.runtime', 'releases'), { recursive: true });
  if ((await lstat(join(root, '.runtime', 'releases'))).isSymbolicLink()) throw new Error('Release output cannot use a symbolic link');
  await mkdir(release); // Existing and partial releases are never overwritten.
  for (const file of sourceFiles) {
    await mkdir(dirname(join(source, file)), { recursive: true });
    await writeFile(join(source, file), snapshots.get(file)!);
  }
  const manifest = sourceFiles.sort().map(file => ({ file, sha: digest(snapshots.get(file)!, 'sha1'), size: snapshots.get(file)!.length }));
  await writeFile(join(release, 'source.sha256'), sourceFiles.map(file => `${digest(snapshots.get(file)!)}  ${file}\n`).join(''));
  const serverFiles = sourceFiles.filter(file => /^src\/(server|shared)\//.test(file));
  if (!serverFiles.includes('src/server/index.ts') || !serverFiles.some(file => file.startsWith('src/shared/'))) {
    throw new Error('Release must contain the server entry point and shared code');
  }
  const serverChecksums = serverFiles.map(file => `${digest(snapshots.get(file)!)}  ${file}\n`).join('');
  await writeFile(join(release, 'server.sha256'), serverChecksums);
  const archives: Record<string, string> = {};
  for (const [name, files] of [['server', serverFiles], ['validation', VALIDATION_FILES]] as const) {
    const staging = join(release, `${name}-files`);
    for (const file of files) {
      await mkdir(dirname(join(staging, file)), { recursive: true });
      await writeFile(join(staging, file), snapshots.get(file)!);
    }
    if (name === 'server') await writeFile(join(staging, 'server.sha256'), serverChecksums);
    const entries = [...files, ...(name === 'server' ? ['server.sha256'] : [])];
    const archive = join(release, `${name}.tar.gz`);
    const child = Bun.spawn(['tar', '-czf', archive, '-C', staging, ...entries], { stdout: 'pipe', stderr: 'pipe' });
    const error = await new Response(child.stderr).text();
    if (await child.exited) throw new Error(`Could not create ${name} archive: ${error}`);
    archives[name] = digest(new Uint8Array(await Bun.file(archive).arrayBuffer()));
  }
  await writeFile(join(release, 'server.sh'), snapshots.get('scripts/release/server.sh')!);
  await writeFile(join(release, 'archives.sha256'), Object.entries(archives).map(([name, sha]) => `${sha}  ${name}.tar.gz\n`).join(''));
  const changes: Record<string, unknown> = {};
  for (const [scope, baselineFile, current] of [
    ['client', 'ops/deployed-client.json', manifest.map(row => [row.file, row.sha] as const)],
    ['server', 'ops/deployed-server.json', serverFiles.map(file => [file, digest(snapshots.get(file)!)] as const)],
  ] as const) {
    const baseline = Bun.file(join(root, baselineFile));
    const exists = await baseline.exists();
    const previous = new Map<string, string>(exists
      ? (await baseline.json() as { file: string; sha?: string; sha256?: string }[]).map(row => [row.file, row.sha ?? row.sha256!])
      : []);
    const next = new Map(current);
    changes[scope] = {
      baseline: exists ? baselineFile : null,
      added: current.filter(([file]) => !previous.has(file)).map(([file]) => file),
      changed: current.filter(([file, hash]) => previous.has(file) && previous.get(file) !== hash).map(([file]) => file),
      removed: [...previous.keys()].filter(file => !next.has(file)).sort(),
    };
  }
  await writeFile(join(release, 'changes.json'), JSON.stringify(changes, null, 2) + '\n');
  for (const [file, snapshot] of snapshots) {
    if ((await lstat(join(root, file))).isSymbolicLink() || digest(new Uint8Array(await Bun.file(join(root, file)).arrayBuffer())) !== digest(snapshot)) {
      throw new Error(`Input changed while preparing release: ${file}; use a new release id after validation`);
    }
  }
  const finalSources = [...await regularFiles(root, 'src'), ...await regularFiles(root, 'public'), ...BUILD_FILES].sort();
  if (JSON.stringify(finalSources) !== JSON.stringify(sourceFiles)) throw new Error('Source file list changed while preparing release');
  if ((await cleanCommit(root)).sha !== git.sha) throw new Error('Git HEAD changed while preparing release.');
  // A failed preparation has no manifest and cannot be submitted to Vercel.
  await writeFile(join(release, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(release, 'release.json'), JSON.stringify({ id, git, createdAt: new Date().toISOString(), files: manifest.length, archives }, null, 2) + '\n');
  return release;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length !== 1 || !args[0].startsWith('--id=')) throw new Error('Usage: bun scripts/release/prepare.ts --id=YYYYMMDD-HHMMSS');
  console.log(await prepareRelease(process.cwd(), args[0].slice(5)));
}
