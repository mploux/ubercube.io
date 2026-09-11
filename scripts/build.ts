import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serverEndpoints } from '../src/client/server-endpoints';

const root = resolve(import.meta.dir, '..');
const output = resolve(root, 'dist/client');
const gameServerOrigin = process.env.PUBLIC_GAME_SERVER_URL?.trim() || (process.env.VERCEL === '1' ? null : '');
if (gameServerOrigin === null) console.warn('PUBLIC_GAME_SERVER_URL is not configured: publishing with singleplayer available.');
serverEndpoints(process.env.VERCEL === '1' ? 'https://deployment.invalid' : 'http://localhost', gameServerOrigin);
await mkdir(output, { recursive: true });
const result = await Bun.build({
  entrypoints: [resolve(root, 'src/client/main.ts'), resolve(root, 'src/client/terrain.worker.ts'), resolve(root, 'src/client/solo.worker.ts')],
  outdir: output,
  target: 'browser',
  format: 'esm',
  splitting: true,
  define: { 'process.env.PUBLIC_GAME_SERVER_URL': JSON.stringify(gameServerOrigin) },
  external: ['/assets/*'],
  minify: !process.argv.includes('--development'),
  sourcemap: 'linked',
  naming: { entry: '[name].[ext]', chunk: 'chunks/[name]-[hash].[ext]', asset: 'assets/[name]-[hash].[ext]' },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
await cp(resolve(root, 'public'), output, { recursive: true });
console.log(`Client compilé : ${result.outputs.length} fichiers → dist/client`);
