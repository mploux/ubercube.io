import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import production from '../ops/production.json';

const root = resolve(import.meta.dir, '..');
const args = Bun.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--server')) throw new Error('Usage: bun run doctor [--server]');
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
  const executable = process.platform === 'win32' && ['ssh', 'scp'].includes(command) ? `${command}.exe` : command;
  checks.push({ name: command, ready: !!Bun.which(executable), required: command === 'git',
    detail: command === 'git' ? 'Required for commit provenance and isolated release tests.'
      : 'Needed for server deployment; run doctor --server to verify SSH and scoped sudo access.' });
}
checks.push({ name: 'Original Java reference', ready: existsSync(resolve(root, '../ubercube/src/main/java')), required: false,
  detail: 'Read-only reference; not required to build or run the tests.' });
const readyToDevelop = checks.every(check => !check.required || check.ready);
let readyToDeployServer: boolean | undefined;
if (args[0] === '--server') {
  readyToDeployServer = false;
  let detail = 'SSH or scoped sudo failed. Check the dedicated SSH profile and request network/subprocess permission if sandboxed; see docs/releasing.md.';
  try {
    const ssh = Bun.which(process.platform === 'win32' ? 'ssh.exe' : 'ssh');
    if (!ssh) throw new Error('OpenSSH is unavailable');
    const child = Bun.spawn([ssh, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
      production.sshTarget, 'sudo -n /usr/local/libexec/ubercube-release check'],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 20000 });
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error('Server access check failed');
    const result = JSON.parse(output);
    const expectedHash = createHash('sha256').update(new Uint8Array(await Bun.file(resolve(root, 'scripts/release/server.sh')).arrayBuffer())).digest('hex');
    readyToDeployServer = result.ready === true && result.service === production.serviceName
      && Number.isInteger(result.serviceUid) && result.serviceUid > 0 && result.helperSha256 === expectedHash;
    detail = readyToDeployServer ? 'Key-based SSH, noninteractive scoped sudo, active non-root service and installed helper hash verified.'
      : 'The installed helper or service differs from this checkout. Review it before activation; never run an uploaded script through passwordless sudo.';
  } catch { /* Keep remote output and credential diagnostics out of the report. */ }
  checks.push({ name: 'Server deployment access', ready: readyToDeployServer, required: false, detail });
}
console.log(JSON.stringify({ readyToDevelop, ...(readyToDeployServer === undefined ? {} : { readyToDeployServer }), checks }, null, 2));
if (!readyToDevelop || readyToDeployServer === false) process.exitCode = 1;
