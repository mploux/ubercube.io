import { expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

test('the real build supports singleplayer without a server and validates configured origins', async () => {
  const temporaryRoot = resolve(tmpdir());
  const fixture = await mkdtemp(join(temporaryRoot, 'ubercube-build-'));
  try {
    for (const directory of ['scripts', 'src/client', 'public']) await mkdir(join(fixture, directory), { recursive: true });
    await cp(new URL('../scripts/build.ts', import.meta.url), join(fixture, 'scripts/build.ts'));
    await cp(new URL('../src/client/server-endpoints.ts', import.meta.url), join(fixture, 'src/client/server-endpoints.ts'));
    await Bun.write(join(fixture, 'src/client/main.ts'), 'console.log(JSON.stringify(process.env.PUBLIC_GAME_SERVER_URL));');
    await Bun.write(join(fixture, 'src/client/terrain.worker.ts'), 'console.log("worker");');
    await Bun.write(join(fixture, 'src/client/solo.worker.ts'), 'console.log("solo worker");');
    await Bun.write(join(fixture, 'public/index.html'), '<title>Build fixture</title>');
    for (const [vercel, origin, expected] of [
      ['1', undefined, null], ['1', '  ', null], ['0', undefined, ''],
      ['1', ' https://game.example ', 'https://game.example'],
    ] as const) {
      const build = Bun.spawn([process.execPath, 'scripts/build.ts'], {
        cwd: fixture, env: { ...process.env, VERCEL: vercel, PUBLIC_GAME_SERVER_URL: origin }, stdout: 'pipe', stderr: 'pipe',
      });
      expect(await build.exited).toBe(0);
      const client = Bun.spawn([process.execPath, 'dist/client/main.js'], { cwd: fixture, stdout: 'pipe' });
      expect((await new Response(client.stdout).text()).trim()).toBe(JSON.stringify(expected));
      expect(await client.exited).toBe(0);
    }
    for (const origin of ['http://game.example', 'https://game.example/path']) {
      const build = Bun.spawn([process.execPath, 'scripts/build.ts'], {
        cwd: fixture, env: { ...process.env, VERCEL: '1', PUBLIC_GAME_SERVER_URL: origin }, stdout: 'pipe', stderr: 'pipe',
      });
      expect(await build.exited).not.toBe(0);
      expect(await new Response(build.stderr).text()).toContain('PUBLIC_GAME_SERVER_URL');
    }
  } finally {
    if (!resolve(fixture).startsWith(temporaryRoot + sep)) throw new Error('Build fixture escaped temporary directory');
    await rm(fixture, { recursive: true, force: true });
  }
});
