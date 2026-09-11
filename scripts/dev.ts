import { watch } from 'node:fs';

const build = Bun.spawn([process.execPath, 'scripts/build.ts', '--development'], { stdout: 'inherit', stderr: 'inherit' });
if (await build.exited !== 0) process.exit(1);
const server = Bun.spawn([process.execPath, '--watch', 'src/server/index.ts', ...process.argv.slice(2)], { stdout: 'inherit', stderr: 'inherit' });
let building = false;
let pending = false;
let timer: ReturnType<typeof setTimeout> | undefined;
async function rebuild() {
  if (building) { pending = true; return; }
  building = true;
  do {
    pending = false;
    const task = Bun.spawn([process.execPath, 'scripts/build.ts', '--development'], { stdout: 'inherit', stderr: 'inherit' });
    await task.exited;
  } while (pending);
  building = false;
}
const watchers = ['src/client', 'src/shared', 'public'].map(path => watch(path, { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(rebuild, 150);
}));
function stop() {
  for (const watcher of watchers) watcher.close();
  server.kill();
  process.exit();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.exit(await server.exited);
