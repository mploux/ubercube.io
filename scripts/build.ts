import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const output = resolve(root, 'dist/client');
await mkdir(output, { recursive: true });
const result = await Bun.build({
  entrypoints: [resolve(root, 'src/client/main.ts'), resolve(root, 'src/client/terrain.worker.ts')],
  outdir: output,
  target: 'browser',
  format: 'esm',
  splitting: true,
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
