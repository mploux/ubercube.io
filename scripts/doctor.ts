import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import production from '../ops/production.json';

const root = resolve(import.meta.dir, '..');
const checks: { name: string; ready: boolean; required: boolean; detail: string }[] = [];
checks.push({ name: 'Bun', ready: Bun.version === production.bunVersion, required: true,
  detail: `${Bun.version}; release builds use ${production.bunVersion}` });
for (const file of ['node_modules/three/package.json', 'node_modules/typescript/bin/tsc',
  'node_modules/@types/bun/package.json', 'public/assets/LICENSE.txt']) {
  checks.push({ name: file, ready: existsSync(resolve(root, file)), required: true,
    detail: file.startsWith('node_modules') ? 'Install with bun install --frozen-lockfile' : 'Required repository asset' });
}
const credentialFile = process.env.VERCEL_AUTH_FILE || resolve(root, '.runtime/vercel-cli/auth.json');
checks.push({ name: 'Vercel credentials', ready: !!process.env.VERCEL_TOKEN || existsSync(credentialFile), required: false,
  detail: 'Presence only; validity and permissions are checked by release:vercel status. Never print credentials.' });
for (const command of ['git', 'ssh', 'scp', 'tar']) {
  checks.push({ name: command, ready: !!Bun.which(command), required: command === 'git',
    detail: command === 'git' ? 'Required for commit provenance and isolated release tests.'
      : 'Needed for server deployment; availability does not prove authentication or sandbox access.' });
}
checks.push({ name: 'Original Java reference', ready: existsSync(resolve(root, '../ubercube/src/main/java')), required: false,
  detail: 'Read-only reference; not required to build or run the tests.' });
console.log(JSON.stringify({ readyToDevelop: checks.every(check => !check.required || check.ready), checks }, null, 2));
if (checks.some(check => check.required && !check.ready)) process.exitCode = 1;
