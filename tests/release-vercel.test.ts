import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { createApi, deploymentCommit, loadRelease, main, parseManifest, parseProduction, productionAliases, readToken, verifyResource } from '../scripts/release/vercel';
import type { ManifestFile } from '../scripts/release/vercel';
import { cleanCommit, committedFiles, pushedCommit } from '../scripts/release/git';
import { commitFixture, fixtureGit, initFixture, pushFixture } from './helpers/release-git';

const config = parseProduction({
  projectId: 'prj_example', teamId: 'team_example', projectName: 'ubercube-test',
  frontendOrigin: 'https://www.example.com', frontendAliases: ['www.example.com', 'example.com'],
  gameOrigin: 'https://game.example.com', bunVersion: '1.3.11',
  gitRepository: 'example/game', productionBranch: 'main',
});
const entry = (file: string, body = file): ManifestFile => ({ file, sha: createHash('sha1').update(body).digest('hex'), size: Buffer.byteLength(body) });
const required = ['scripts/build.ts', 'package.json', 'bun.lock', 'tsconfig.json', 'vercel.json', 'public/index.html'];

async function fixture(run: (root: string) => Promise<void>) {
  const base = resolve(tmpdir());
  const root = await mkdtemp(join(base, 'ubercube-release-vercel-'));
  try { await run(root); }
  finally {
    if (!root.startsWith(base + sep)) throw new Error('Fixture escaped temporary directory');
    await rm(root, { recursive: true, force: true });
  }
}

test('release configuration rejects endpoints carrying credentials or paths and malformed project scope', () => {
  for (const gameOrigin of ['http://game.example.com', 'https://user:password@game.example.com', 'https://game.example.com/path', 'https://game.example.com:443', 'https://game.example.com?token=private']) {
    expect(() => parseProduction({ ...config, gameOrigin })).toThrow();
  }
  expect(() => parseProduction({ ...config, frontendAliases: ['elsewhere.example.com'] })).toThrow();
  expect(() => parseProduction({ ...config, frontendAliases: ['www.example.com', 'www.example.com'] })).toThrow();
  expect(() => parseProduction({ ...config, projectId: '../../other' })).toThrow();
});

test('manifest boundaries reject traversal, hidden credentials, case collisions and invalid hashes', () => {
  const files = required.map(file => entry(file));
  expect(parseManifest(files)).toEqual(files);
  for (const file of ['src/../private', '/src/a.ts', 'src\\a.ts', 'src//a.ts', 'public/.env', '.runtime/vercel-cli/auth.json', 'scripts/private.ts', 'public/../.env', 'src/a.ts.']) {
    expect(() => parseManifest([...files, entry(file)])).toThrow();
  }
  expect(() => parseManifest([...files, entry('PUBLIC/INDEX.HTML')])).toThrow();
  expect(() => parseManifest([...files, { ...entry('src/test.ts'), sha: 'invalid' }])).toThrow();
  expect(() => parseManifest([...files, { ...entry('src/test.ts'), size: -1 }])).toThrow();
  expect(() => parseManifest(files.filter(file => file.file !== 'bun.lock'))).toThrow();
});

test('credentials prioritize the environment, fail closed, and never expose token values in errors', async () => {
  await fixture(async root => {
    await Bun.write(join(root, 'auth.json'), JSON.stringify({ token: 'file-token' }));
    expect(await readToken(root, { VERCEL_TOKEN: 'environment-token', VERCEL_AUTH_FILE: 'missing.json' })).toBe('environment-token');
    expect(await readToken(root, { VERCEL_AUTH_FILE: 'auth.json' })).toBe('file-token');
    expect(await readToken(root, { VERCEL_TOKEN: '', VERCEL_AUTH_FILE: 'auth.json' })).toBe('file-token');
    await expect(readToken(root, { VERCEL_TOKEN: 'secret\nheader' })).rejects.toThrow('Invalid Vercel token');
    await Bun.write(join(root, 'auth.json'), '{"token": "private-secret"');
    try { await readToken(root, { VERCEL_AUTH_FILE: 'auth.json' }); throw new Error('Expected rejection'); }
    catch (error) { expect(String(error)).not.toContain('private-secret'); }
  });
});

test('blank credential template fields fall back to the local private authentication file', async () => {
  await fixture(async root => {
    await Bun.write(join(root, '.runtime/vercel-cli/auth.json'), JSON.stringify({ token: 'local-token' }));
    expect(await readToken(root, { VERCEL_TOKEN: '', VERCEL_AUTH_FILE: '' })).toBe('local-token');
    expect(await readToken(root, { VERCEL_TOKEN: '  ', VERCEL_AUTH_FILE: '  ' })).toBe('local-token');
  });
});

test('authenticated requests stay on the Vercel API origin and refuse redirects', async () => {
  let requests = 0;
  const api = createApi(config, 'test-token', async (url, options) => {
    requests++;
    expect(url.origin).toBe('https://api.vercel.com');
    expect(url.searchParams.get('teamId')).toBe(config.teamId);
    expect(options.redirect).toBe('error');
    expect((options.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    return Response.json({ ok: true });
  });
  expect(await api('/v9/projects/prj_example', 'GET', undefined, { Authorization: 'wrong' }, { teamId: 'wrong' })).toEqual({ ok: true });
  for (const path of ['https://elsewhere.example/path', '//elsewhere.example/path', '/v9/../secrets', '/v9/projects?token=private', '/v9/projects#fragment', '/v9/./projects']) {
    await expect(api(path)).rejects.toThrow('Invalid Vercel API path');
  }
  expect(requests).toBe(1);
  const redirect = createApi(config, 'test-token', async () => new Response('secret response', { status: 302, headers: { Location: 'https://elsewhere.example' } }));
  await expect(redirect('/v9/projects')).rejects.toThrow('HTTP 302');
});

test('API failure messages omit server bodies, tokens and underlying network errors', async () => {
  for (const fetcher of [
    async () => new Response('secret-token', { status: 403 }),
    async () => { throw new Error('secret-token in redirected URL'); },
  ]) {
    const api = createApi(config, 'secret-token', fetcher);
    try { await api('/v9/projects'); throw new Error('Expected rejection'); }
    catch (error) { expect(String(error)).not.toContain('secret-token'); }
  }
});

test('every production alias must match the explicit baseline before changing production', async () => {
  const api = createApi(config, 'test-token', async url => Response.json({ deploymentId: url.pathname.endsWith('/www.example.com') ? 'dpl_old' : 'dpl_new' }));
  await expect(productionAliases(api, config, 'dpl_old')).rejects.toThrow('Production changed at example.com');
  expect((await productionAliases(api, config)).map(alias => alias.deploymentId)).toEqual(['dpl_old', 'dpl_new']);
});

test('a prepared release loads frozen bytes and rejects modified or unlisted source files', async () => {
  await fixture(async root => {
    const release = join(root, '.runtime/releases/20260913-123456');
    const files = [...required, 'src/client/main.ts'].map(file => entry(file));
    for (const file of files) {
      await Bun.write(join(release, 'source', file.file), file.file);
      await Bun.write(join(root, file.file), file.file);
    }
    await Bun.write(join(release, 'manifest.json'), JSON.stringify(files));
    const sha = await initFixture(root);
    await Bun.write(join(release, 'release.json'), JSON.stringify({ git: { sha, branch: 'main' } }));
    const frozen = await loadRelease(root, release);
    expect(frozen.files.length).toBe(files.length);
    expect(frozen.git.sha).toBe(sha);
    await Bun.write(join(root, 'src/client/main.ts'), 'unrelated working copy changes');
    expect(Buffer.from(frozen.bytes.get('src/client/main.ts')!).toString()).toBe('src/client/main.ts');
    await Bun.write(join(release, 'source/src/client/main.ts'), 'changed snapshot');
    await expect(loadRelease(root, release)).rejects.toThrow('Frozen source changed');
    await Bun.write(join(release, 'source/src/client/main.ts'), 'src/client/main.ts');
    await Bun.write(join(release, 'source/src/private.key'), 'unlisted');
    await expect(loadRelease(root, release)).rejects.toThrow('Unlisted files');
    await expect(loadRelease(root, '../elsewhere')).rejects.toThrow('prepared .runtime/releases');
  });
});

test('release validation rejects a directory junction into files outside the snapshot', async () => {
  await fixture(async root => {
    const release = join(root, '.runtime/releases/20260913-123456');
    const external = join(root, 'outside');
    await mkdir(external, { recursive: true });
    for (const file of required) {
      const path = join(release, 'source', file);
      await mkdir(dirname(path), { recursive: true }); await Bun.write(path, file);
    }
    await Bun.write(join(external, 'private.ts'), 'private');
    await symlink(external, join(release, 'source/src'), process.platform === 'win32' ? 'junction' : 'dir');
    await Bun.write(join(release, 'manifest.json'), JSON.stringify([...required.map(file => entry(file)), entry('src/private.ts', 'private')]));
    await expect(loadRelease(root, release)).rejects.toThrow('symbolic links');
  });
});

test('mutation commands require explicit baselines and backend readiness before reading credentials', async () => {
  await expect(main(['stage', '--release=.runtime/releases/20260913-123456'], '/missing')).rejects.toThrow('explicit dpl_');
  await expect(main(['promote', '--baseline=dpl_old'], '/missing')).rejects.toThrow('backend-ready');
  await expect(main(['rollback', '--deployment=dpl_old', '--baseline=dpl_current'], '/missing')).rejects.toThrow('backend-ready');
  await expect(main(['promote', '--baseline=dpl_old', '--backend-ready=false'], '/missing')).rejects.toThrow('Invalid or duplicate');
  await expect(main(['stage', '--baseline=dpl_old', '--baseline=dpl_new'], '/missing')).rejects.toThrow('Invalid or duplicate');
  await expect(main(['rollback', '--deployment=dpl_old', '--baseline=dpl_current', '--backend-ready'], '/missing')).rejects.toThrow('full 40-character Git');
});

test('pushed provenance checks the live remote branch, rejects local-only commits and accepts retained ancestors', async () => {
  await fixture(async root => {
    const first = await initFixture(root);
    await pushFixture(root);
    await pushedCommit(root, first, 'main');
    await Bun.write(join(root, 'new.txt'), 'local commit');
    const second = await commitFixture(root);
    await expect(pushedCommit(root, second, 'main')).rejects.toThrow('not pushed');
    await expect(pushedCommit(root, first, 'missing')).rejects.toThrow('unavailable');
    await expect(pushedCommit(root, first, '../main')).rejects.toThrow('Invalid Git branch');
    await expect(pushedCommit(root, first, 'main', config.gitRepository)).rejects.toThrow('origin must match');
    await fixtureGit(root, 'push', 'origin', 'main');
    await pushedCommit(root, second, 'main');
    await pushedCommit(root, first, 'main');
    await expect(committedFiles(root, first, new Map([['new.txt', Buffer.from('local commit')]]))).rejects.toThrow('committed Git blob');
    expect(await cleanCommit(root)).toEqual({ sha: second, branch: 'main' });
  });
});

test('deployment provenance requires a genuine Git source with matching repository and immutable commit', () => {
  const sha = '1'.repeat(40), other = '2'.repeat(40);
  const value = { gitSource: { type: 'github', repoId: 123, sha }, meta: { githubCommitSha: sha } };
  expect(deploymentCommit(value, '123', sha)).toBe(sha);
  expect(deploymentCommit({}, '123')).toBeNull();
  expect(() => deploymentCommit({ meta: { githubCommitSha: sha } }, '123', sha)).toThrow('no Git-source provenance');
  expect(() => deploymentCommit(value, '456', sha)).toThrow('linked GitHub');
  expect(() => deploymentCommit(value, '123', other)).toThrow('expected commit');
  expect(() => deploymentCommit({ ...value, meta: { githubCommitSha: other } }, '123', sha)).toThrow('expected commit');
});

test('public verification records raw hashes while tolerating only the terminal Bun debug ID value', () => {
  const local = Buffer.from(`console.log('same');\n\n//# debugId=${'1'.repeat(32)}\n//# sourceMappingURL=main.js.map\n`);
  const served = Buffer.from(local.toString().replace('1'.repeat(32), '2'.repeat(32)));
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const proof = verifyResource('/main.js', local, served);
  expect(proof.sha256).toBe(hash(served));
  expect(proof.expectedSha256).toBe(hash(local));
  expect(proof.sha256).not.toBe(proof.expectedSha256);
  expect(proof.comparisonSha256).toBe(hash(Buffer.from(local.toString().replace('1'.repeat(32), '0'.repeat(32)))));
  expect(proof.ignoredMetadata).toContain('terminal JavaScript');
  expect(verifyResource('/main.js', local, local).ignoredMetadata).toBeUndefined();
  for (const body of [
    served.toString().replace("console.log('same')", "console.log('changed')"),
    served.toString().replace('main.js.map', 'different.js.map'),
    served.toString().replace('2'.repeat(32), '2'.repeat(31)),
    served.toString().replace(/\/\/# debugId=.*\n/, ''),
    served.toString() + 'console.log("after trailer");\n',
    '\uFEFF' + served.toString(),
  ]) expect(() => verifyResource('/main.js', local, Buffer.from(body))).toThrow('differs from the frozen build');
  for (const path of ['/styles.css', '/index.html', '/asset.bin']) {
    expect(() => verifyResource(path, local, served)).toThrow('differs from the frozen build');
  }
  const embedded = `const text = "//# debugId=${'1'.repeat(32)}";\n`;
  expect(() => verifyResource('/main.js', Buffer.from(embedded), Buffer.from(embedded.replace('1'.repeat(32), '2'.repeat(32))))).toThrow('differs from the frozen build');
  const misplaced = `//# debugId=${'1'.repeat(32)}\nconsole.log('same');\n//# sourceMappingURL=main.js.map\n`;
  expect(() => verifyResource('/main.js', Buffer.from(misplaced), Buffer.from(misplaced.replace('1'.repeat(32), '2'.repeat(32))))).toThrow('differs from the frozen build');
  expect(() => verifyResource('/main.js', Buffer.concat([Buffer.from([0x80]), local]), Buffer.concat([Buffer.from([0x81]), served]))).toThrow('differs from the frozen build');
});

test('Git staging rejects dirty and unpushed releases; automatic Git deployments verify without staging metadata', async () => {
  await fixture(async root => {
    const release = join(root, '.runtime/releases/20260913-123456');
    await Bun.write(join(root, 'ops/production.json'), JSON.stringify(config));
    const files: ManifestFile[] = [];
    for (const file of [...required, 'src/client/main.ts']) {
      const body = file === 'scripts/build.ts' ? "await Bun.write('dist/client/index.html', 'fixture');" : file;
      await Bun.write(join(root, file), body);
      await Bun.write(join(release, 'source', file), body);
      files.push(entry(file, body));
    }
    let sha = await initFixture(root);
    await pushFixture(root);
    await Bun.write(join(release, 'manifest.json'), JSON.stringify(files));
    await Bun.write(join(release, 'release.json'), JSON.stringify({ git: { sha, branch: 'main' } }));
    await Bun.write(join(root, '.runtime/vercel-cli/auth.json'), JSON.stringify({ token: 'test-token' }));
    const requests: { path: string; method?: string; body?: any }[] = [];
    let liveId = 'dpl_old';
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (url: URL, options: RequestInit) => {
      const body = options.body ? JSON.parse(String(options.body)) : undefined;
      requests.push({ path: url.pathname, method: options.method, body });
      if (url.origin === config.frontendOrigin) return new Response('fixture');
      if (url.pathname === `/v9/projects/${config.projectId}`) return Response.json({ id: config.projectId, name: config.projectName, outputDirectory: 'dist/client', link: { type: 'github', repoId: 123, org: 'example', repo: 'game', productionBranch: 'main' } });
      if (url.pathname.endsWith('/env')) return Response.json({ envs: [{ key: 'PUBLIC_GAME_SERVER_URL', target: ['production'], value: config.gameOrigin }] });
      if (url.pathname.startsWith('/v4/aliases/')) return Response.json({ deploymentId: liveId });
      if (url.pathname === '/v13/deployments') return Response.json({ id: 'dpl_new' });
      if (url.pathname === '/v13/deployments/dpl_new') return Response.json({ id: 'dpl_new', projectId: config.projectId, target: 'production', readyState: 'READY', gitSource: { type: 'github', repoId: 123, sha }, meta: { githubCommitSha: sha } });
      throw new Error('Unexpected API request');
    }) as typeof fetch);
    const spawn = Bun.spawn.bind(Bun);
    // Model a GitHub remote with an isolated local bare repository; no network or real repository mutations.
    const gitMock = spyOn(Bun, 'spawn').mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
      if (Array.isArray(args[0]) && args[0].join(' ') === 'git remote get-url origin') {
        return spawn([process.execPath, '-e', `console.log('https://github.com/${config.gitRepository}.git')`], args[1]);
      }
      return spawn(...args);
    }) as typeof Bun.spawn);
    try {
      await Bun.write(join(root, 'src/client/main.ts'), 'dirty');
      await expect(main(['stage', `--release=${release}`, '--baseline=dpl_old'], root)).rejects.toThrow('clean Git worktree');
      expect(requests).toHaveLength(0);
      await Bun.write(join(root, 'src/client/main.ts'), 'src/client/main.ts');
      await Bun.write(join(root, 'README.md'), 'local-only commit');
      sha = await commitFixture(root);
      await Bun.write(join(release, 'release.json'), JSON.stringify({ git: { sha, branch: 'main' } }));
      await expect(main(['stage', `--release=${release}`, '--baseline=dpl_old'], root)).rejects.toThrow('not pushed');
      expect(requests.some(request => request.method === 'POST')).toBe(false);
      await fixtureGit(root, 'push', 'origin', 'main');
      await main(['stage', `--release=${release}`, '--baseline=dpl_old'], root);
      const mutations = requests.filter(request => request.method === 'POST');
      expect(mutations).toHaveLength(1);
      expect(mutations[0].path).toBe('/v13/deployments');
      expect(mutations[0].body.gitSource).toEqual({ type: 'github', repoId: '123', ref: sha, sha });
      expect(mutations[0].body.files).toBeUndefined();
      expect(requests.some(request => request.path === '/v2/files')).toBe(false);
      expect((await Bun.file(join(release, 'deployment.json')).json()).commit).toBe(sha);
      await unlink(join(release, 'deployment.json'));
      liveId = 'dpl_new';
      await main(['verify', `--release=${release}`, '--deployment=dpl_new', `--commit=${sha}`, '--ref=main'], root);
      const verification = await Bun.file(join(release, 'verification.json')).json();
      expect(verification.commit).toBe(sha);
      expect(verification.deploymentId).toBe('dpl_new');
      expect(verification.resources).toHaveLength(1);
    } finally { gitMock.mockRestore(); fetchMock.mockRestore(); }
  });
}, 15000);
