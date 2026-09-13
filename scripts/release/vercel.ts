import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { cleanCommit, commitSha, committedFiles, pushedCommit } from './git';
import type { GitCommit } from './git';

export interface Production {
  projectId: string; teamId: string; projectName: string; frontendOrigin: string;
  frontendAliases: string[]; gameOrigin: string; bunVersion: string;
  gitRepository: string; productionBranch: string;
}
export interface ManifestFile { file: string; sha: string; size: number }
type Fetcher = (url: URL, options: RequestInit) => Promise<Response>;
const digest = (bytes: Uint8Array, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const deploymentId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^dpl_[A-Za-z0-9]+$/.test(value)) throw new Error('An explicit dpl_ deployment ID is required.');
  return value;
};
const origin = (value: unknown): string => {
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9.-]+$/.test(value) || new URL(value).origin !== value) throw new Error('Expected an HTTPS origin without credentials, path or port.');
  return value;
};

export function parseProduction(value: unknown): Production {
  const config = value as Production;
  if (!config || !/^prj_[A-Za-z0-9]+$/.test(config.projectId) || !/^team_[A-Za-z0-9]+$/.test(config.teamId)
    || !/^[a-z0-9-]+$/.test(config.projectName) || !/^\d+\.\d+\.\d+$/.test(config.bunVersion)
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.gitRepository)
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(config.productionBranch)) throw new Error('Invalid production project configuration.');
  origin(config.frontendOrigin); origin(config.gameOrigin);
  if (!Array.isArray(config.frontendAliases) || !config.frontendAliases.length
    || config.frontendAliases.some(alias => typeof alias !== 'string' || !/^[a-z0-9.-]+$/.test(alias))
    || new Set(config.frontendAliases).size !== config.frontendAliases.length
    || !config.frontendAliases.includes(new URL(config.frontendOrigin).hostname)) throw new Error('Invalid production aliases.');
  return config;
}

export function parseManifest(value: unknown): ManifestFile[] {
  if (!Array.isArray(value) || !value.length) throw new Error('A non-empty frozen manifest is required.');
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry.file !== 'string' || !/^[A-Za-z0-9_.\/-]+$/.test(entry.file)
      || entry.file.split('/').some((part: string) => !part || part.startsWith('.') || part.endsWith('.'))
      || !(entry.file.startsWith('src/') || entry.file.startsWith('public/')
        || ['scripts/build.ts', 'package.json', 'bun.lock', 'tsconfig.json', 'vercel.json'].includes(entry.file))
      || !/^[0-9a-f]{40}$/.test(entry.sha) || !Number.isSafeInteger(entry.size) || entry.size < 0
      || seen.has(entry.file.toLowerCase())) throw new Error('Invalid, duplicate or unsafe manifest entry.');
    seen.add(entry.file.toLowerCase());
  }
  for (const file of ['scripts/build.ts', 'package.json', 'bun.lock', 'tsconfig.json', 'vercel.json', 'public/index.html']) {
    if (!seen.has(file)) throw new Error('The frozen manifest is missing a required build file.');
  }
  return value;
}

export async function readToken(root: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  let token: unknown = env.VERCEL_TOKEN?.trim() || undefined;
  if (token === undefined) {
    try { token = JSON.parse(await readFile(resolve(root, env.VERCEL_AUTH_FILE?.trim() || '.runtime/vercel-cli/auth.json'), 'utf8')).token; }
    catch { throw new Error('Set VERCEL_TOKEN or a readable VERCEL_AUTH_FILE containing a token.'); }
  }
  if (typeof token !== 'string' || !token.trim() || /[\s\x00-\x1f\x7f]/.test(token)) throw new Error('Invalid Vercel token configuration.');
  return token;
}

export function createApi(config: Production, token: string, fetcher: Fetcher = fetch) {
  return async (path: string, method = 'GET', body?: BodyInit, headers: Record<string, string> = {}, query: Record<string, string> = {}) => {
    if (!/^\/v\d+\/[A-Za-z0-9_./-]+$/.test(path) || path.split('/').some(part => part === '..' || part === '.')) throw new Error('Invalid Vercel API path.');
    const url = new URL(path, 'https://api.vercel.com');
    url.search = new URLSearchParams({ ...query, teamId: config.teamId }).toString();
    let response: Response;
    try {
      response = await fetcher(url, { method, body, headers: { ...headers, Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30000) });
    } catch { throw new Error('Vercel request failed; inspect status before retrying a mutation.'); }
    if (!response.ok) throw new Error(`Vercel request failed with HTTP ${response.status}; response bodies are omitted to protect secrets.`);
    if (response.status === 204) return {};
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch { throw new Error('Vercel returned an invalid JSON response.'); }
  };
}
type Api = ReturnType<typeof createApi>;

async function regularPath(root: string, target: string) {
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || rel.startsWith(sep) || resolve(root, rel) !== target) throw new Error('Release path escaped its root.');
  let path = root;
  if ((await lstat(path)).isSymbolicLink()) throw new Error('Release paths must not contain symbolic links.');
  for (const part of rel.split(sep)) {
    path = resolve(path, part);
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Release paths must not contain symbolic links.');
  }
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Release files must not contain symbolic links.');
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error('Release files must be regular files.');
  }
  return files.sort();
}

export async function loadRelease(root: string, directory: string) {
  const release = resolve(root, directory);
  const releaseParent = resolve(root, '.runtime/releases');
  if (dirname(release) !== releaseParent || !/^\d{8}-\d{6}$/.test(relative(releaseParent, release))) throw new Error('Use a prepared .runtime/releases/YYYYMMDD-HHMMSS directory.');
  await regularPath(root, resolve(release, 'manifest.json'));
  const manifestBytes = await readFile(resolve(release, 'manifest.json'));
  const files = parseManifest(JSON.parse(manifestBytes.toString('utf8')));
  const source = resolve(release, 'source');
  await regularPath(root, source);
  const bytes = new Map<string, Uint8Array>();
  for (const file of files) {
    const path = resolve(source, file.file);
    await regularPath(source, path);
    if (!(await lstat(path)).isFile()) throw new Error('Manifest paths must refer to regular files.');
    const data = await readFile(path);
    if (data.byteLength !== file.size || digest(data, 'sha1') !== file.sha) throw new Error(`Frozen source changed: ${file.file}`);
    bytes.set(file.file, data);
  }
  const actual = (await listFiles(source)).filter(file => !file.startsWith('dist/'));
  if (JSON.stringify(actual) !== JSON.stringify(files.map(file => file.file).sort())) throw new Error('Unlisted files exist in the frozen source.');
  await regularPath(root, resolve(release, 'release.json'));
  const { git } = JSON.parse(await readFile(resolve(release, 'release.json'), 'utf8')) as { git: GitCommit };
  commitSha(git?.sha);
  if (typeof git.branch !== 'string' || !git.branch) throw new Error('Release Git branch is missing. Prepare a committed release.');
  await committedFiles(root, git.sha, bytes);
  return { release, source, files, bytes, git, manifestSha256: digest(manifestBytes) };
}

export async function productionAliases(api: Api, config: Production, expected?: string) {
  if (expected !== undefined) deploymentId(expected);
  return Promise.all(config.frontendAliases.map(async alias => {
    const result = await api(`/v4/aliases/${alias}`);
    const id = deploymentId(result.deploymentId);
    if (expected !== undefined && id !== expected) throw new Error(`Production changed at ${alias}; inspect status and choose the baseline explicitly.`);
    return { alias, deploymentId: id };
  }));
}

export function deploymentCommit(value: { gitSource?: { type?: string; repoId?: number | string; sha?: string }; meta?: { githubCommitSha?: string } }, repoId: string, expected?: string) {
  const source = value.gitSource;
  if (!source) {
    if (expected) throw new Error('Deployment has no Git-source provenance; file-upload releases cannot be promoted or verified as a commit.');
    return null;
  }
  if (source.type !== 'github' || String(source.repoId) !== repoId) throw new Error('Deployment Git source does not match the linked GitHub repository.');
  const sha = commitSha(source.sha);
  if ((value.meta?.githubCommitSha && value.meta.githubCommitSha !== sha) || (expected && sha !== commitSha(expected))) throw new Error('Deployment Git commit does not match the expected commit.');
  return sha;
}

export function verifyResource(path: string, expected: Uint8Array, actual: Uint8Array): {
  path: string; sha256: string; expectedSha256: string; comparisonSha256: string; ignoredMetadata?: string;
} {
  const proof = { path, sha256: digest(actual), expectedSha256: digest(expected) };
  if (proof.sha256 === proof.expectedSha256) return { ...proof, comparisonSha256: proof.sha256 };
  if (path.endsWith('.js')) {
    // Bun's source-map debug ID can differ between build environments; preserve executable bytes and the URL.
    const trailer = /(\n\/\/# debugId=)[0-9a-fA-F]{32}(\n\/\/# sourceMappingURL=[^\r\n]+\.map\n?)$/;
    const local = Buffer.from(expected).toString('latin1'), served = Buffer.from(actual).toString('latin1');
    if (trailer.test(local) && trailer.test(served)) {
      const replacement = `$1${'0'.repeat(32)}$2`;
      const comparisonSha256 = digest(Buffer.from(local.replace(trailer, replacement), 'latin1'));
      if (comparisonSha256 === digest(Buffer.from(served.replace(trailer, replacement), 'latin1'))) {
        return { ...proof, comparisonSha256, ignoredMetadata: 'Bun debugId value in the terminal JavaScript source-map trailer.' };
      }
    }
  }
  throw new Error(`Public resource differs from the frozen build: ${path}`);
}

async function deployment(api: Api, config: Production, repoId: string, id: string, ready = false, expected?: string) {
  const value = await api(`/v13/deployments/${deploymentId(id)}`);
  if (value.id !== id || value.projectId !== config.projectId || value.target !== 'production') throw new Error('Deployment does not belong to the configured production project.');
  if (ready && value.readyState !== 'READY') throw new Error('Deployment is not READY. Run status before promotion.');
  const commit = deploymentCommit(value, repoId, expected);
  return { id, url: value.url, readyState: value.readyState, target: value.target, commit };
}

async function buildFrozen(root: string, release: Awaited<ReturnType<typeof loadRelease>>, config: Production) {
  if (Bun.version !== config.bunVersion) throw new Error(`Build requires Bun ${config.bunVersion}.`);
  const output = resolve(release.source, 'dist');
  const existing = await lstat(output).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (existing) {
    await regularPath(release.source, output);
    if (!existing.isDirectory()) throw new Error('Build output must be a regular directory.');
  }
  // This exact subtree belongs to the prepared release; old outputs must not pass verification.
  if (dirname(output) !== release.source) throw new Error('Unsafe build output path.');
  await rm(output, { recursive: true, force: true });
  const child = Bun.spawn([process.execPath, resolve(release.source, 'scripts/build.ts')], {
    cwd: release.source, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, VERCEL: '1', PUBLIC_GAME_SERVER_URL: config.gameOrigin }, stdout: 'pipe', stderr: 'pipe',
  });
  const [code] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error('Frozen client build failed. Run the existing build script against this snapshot to inspect it.');
  await loadRelease(root, release.release);
}

const usage = `Vercel release commands (Bun; read-only Git provenance checks):
  status [--deployment=dpl_ID] [--commit=FULL_SHA] [--ref=main]
  stage --release=.runtime/releases/YYYYMMDD-HHMMSS --baseline=dpl_CURRENT [--ref=BRANCH]
  promote --release=.runtime/releases/YYYYMMDD-HHMMSS --baseline=dpl_CURRENT --backend-ready [--ref=BRANCH]
  verify --release=.runtime/releases/YYYYMMDD-HHMMSS [--deployment=dpl_ID] [--commit=FULL_SHA] [--ref=BRANCH]
  rollback --deployment=dpl_KNOWN_GOOD --commit=FULL_SHA --baseline=dpl_CURRENT --backend-ready [--ref=main]
Normally push main and verify the resulting GitHub deployment. Stage builds an already-pushed commit without assigning domains.
Promote/rollback require a clean checkout and a Git-source deployment from a verified pushed commit.
Credentials: VERCEL_TOKEN, then VERCEL_AUTH_FILE, then local .runtime/vercel-cli/auth.json.
`;

export async function main(args = process.argv.slice(2), root = resolve(import.meta.dir, '../..')) {
  if (!args.length || args[0] === '--help') { console.log(usage); return; }
  const [command, ...rest] = args;
  const allowed: Record<string, string[]> = { status: ['deployment', 'commit', 'ref'], stage: ['release', 'baseline', 'ref'], promote: ['release', 'baseline', 'backend-ready', 'ref'], verify: ['release', 'deployment', 'commit', 'ref'], rollback: ['deployment', 'baseline', 'backend-ready', 'commit', 'ref'] };
  if (!allowed[command]) throw new Error('Unknown release command. Use --help.');
  const flags = new Map<string, string>();
  for (const argument of rest) {
    const match = /^--([a-z-]+)(?:=(.+))?$/.exec(argument);
    if (!match || !allowed[command].includes(match[1]) || flags.has(match[1]) || (match[1] !== 'backend-ready' && !match[2]) || (match[1] === 'backend-ready' && match[2])) throw new Error('Invalid or duplicate command option. Use --help.');
    flags.set(match[1], match[2] ?? 'true');
  }
  const baseline = ['stage', 'promote', 'rollback'].includes(command) ? deploymentId(flags.get('baseline')) : undefined;
  if (['promote', 'rollback'].includes(command) && !flags.has('backend-ready')) throw new Error('Verify the compatible backend, then pass --backend-ready.');
  const expectedCommit = flags.has('commit') || command === 'rollback' ? commitSha(flags.get('commit')) : undefined;
  const config = parseProduction(JSON.parse(await readFile(resolve(root, 'ops/production.json'), 'utf8')));
  if (['stage', 'promote', 'rollback'].includes(command)) await cleanCommit(root);
  if (expectedCommit) await pushedCommit(root, expectedCommit, flags.get('ref') ?? config.productionBranch, config.gitRepository);
  const api = createApi(config, await readToken(root));
  const project = await api(`/v9/projects/${config.projectId}`);
  if (project.id !== config.projectId || project.name !== config.projectName || project.outputDirectory !== 'dist/client'
    || project.link?.type !== 'github' || `${project.link.org}/${project.link.repo}` !== config.gitRepository
    || project.link.productionBranch !== config.productionBranch || !/^\d+$/.test(String(project.link.repoId))) throw new Error('Unexpected Vercel project or linked Git repository configuration.');
  const repoId = String(project.link.repoId);
  if (command === 'status') {
    const aliases = await productionAliases(api, config);
    const id = flags.get('deployment');
    const deployments = await Promise.all([...new Set(id ? [deploymentId(id)] : aliases.map(alias => alias.deploymentId))].map(id => deployment(api, config, repoId, id, false, expectedCommit)));
    console.log(JSON.stringify({ aliases, deployments }, null, 2)); return;
  }
  if (command === 'rollback') {
    const target = await deployment(api, config, repoId, deploymentId(flags.get('deployment')), true, expectedCommit);
    await productionAliases(api, config, baseline);
    await api(`/v10/projects/${config.projectId}/promote/${target.id}`, 'POST', '{}', { 'Content-Type': 'application/json' });
    console.log(`Rollback promotion requested for ${target.id}. Run status to verify all domains.`); return;
  }
  if (!flags.get('release')) throw new Error('A prepared --release directory is required.');
  const release = await loadRelease(root, flags.get('release')!);
  if (expectedCommit && expectedCommit !== release.git.sha) throw new Error('The requested commit does not match the prepared release.');
  await pushedCommit(root, release.git.sha, flags.get('ref') ?? release.git.branch, config.gitRepository);
  const statePath = resolve(release.release, 'deployment.json');
  if (command === 'stage') {
    if (await Bun.file(statePath).exists()) throw new Error('This release already has deployment metadata. Inspect status; prepare a new release to stage again.');
    const environments = await api(`/v9/projects/${config.projectId}/env`);
    const game = environments.envs?.filter((item: { key: string; target: string[] }) => item.key === 'PUBLIC_GAME_SERVER_URL' && item.target?.includes('production'));
    if (!Array.isArray(game) || game.length !== 1 || game[0].value !== config.gameOrigin) throw new Error('Unexpected production game endpoint configuration.');
    await productionAliases(api, config, baseline);
    await buildFrozen(root, release, config);
    await cleanCommit(root);
    await pushedCommit(root, release.git.sha, flags.get('ref') ?? release.git.branch, config.gitRepository);
    await productionAliases(api, config, baseline);
    const result = await api('/v13/deployments', 'POST', JSON.stringify({ name: config.projectName, project: config.projectId, target: 'production', autoAssignCustomDomains: false, gitSource: { type: 'github', repoId, ref: release.git.sha, sha: release.git.sha }, meta: { releaseBaseline: baseline, releaseManifestSha256: release.manifestSha256 } }), { 'Content-Type': 'application/json' }, { forceNew: '1' });
    const id = deploymentId(result.id);
    await Bun.write(statePath, JSON.stringify({ id, baseline, commit: release.git.sha, manifestSha256: release.manifestSha256, createdAt: new Date().toISOString() }, null, 2) + '\n');
    await productionAliases(api, config, baseline);
    console.log(`Staged ${id}; production domains remain on ${baseline}. Run status --deployment=${id}.`); return;
  }
  const state = command === 'verify' && flags.has('deployment') ? null : JSON.parse(await readFile(statePath, 'utf8'));
  if (state && (state.manifestSha256 !== release.manifestSha256 || state.commit !== release.git.sha)) throw new Error('Deployment metadata does not match this frozen manifest and commit.');
  const target = await deployment(api, config, repoId, deploymentId(flags.get('deployment') ?? state?.id), true, release.git.sha);
  if (command === 'promote') {
    if (state.baseline !== baseline) throw new Error('The promotion baseline differs from the staged baseline.');
    await productionAliases(api, config, baseline);
    await api(`/v10/projects/${config.projectId}/promote/${target.id}`, 'POST', '{}', { 'Content-Type': 'application/json' });
    await Bun.write(resolve(release.release, 'promotion.json'), JSON.stringify({ id: target.id, baseline, requestedAt: new Date().toISOString() }, null, 2) + '\n');
    console.log(`Promotion requested for ${target.id}. Run status, then verify.`); return;
  }
  const aliases = await productionAliases(api, config, target.id);
  await buildFrozen(root, release, config);
  const output = resolve(release.source, 'dist/client');
  const resources: ReturnType<typeof verifyResource>[] = [];
  for (const file of (await listFiles(output)).filter(file => !file.endsWith('.map'))) {
    const path = file === 'index.html' ? '/' : `/${file}`;
    const response = await fetch(new URL(path, config.frontendOrigin), { redirect: 'error', signal: AbortSignal.timeout(30000), cache: 'no-store' });
    if (!response.ok) throw new Error(`Public resource failed with HTTP ${response.status}: ${path}`);
    resources.push(verifyResource(path, await readFile(resolve(output, file)), new Uint8Array(await response.arrayBuffer())));
  }
  await productionAliases(api, config, target.id);
  await Bun.write(resolve(release.release, 'verification.json'), JSON.stringify({ deploymentId: target.id, commit: target.commit, verifiedAt: new Date().toISOString(), aliases, resources, excluded: 'Source maps: Vercel may restrict public access.' }, null, 2) + '\n');
  console.log(`Verified ${resources.length} public resources and all production aliases for ${target.id}.`);
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : 'Release operation failed.'); process.exitCode = 1; });
