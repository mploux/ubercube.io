import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { convertVxl, encodeImportedMap } from '../src/shared/imported-map';

async function vxlFiles(path: string): Promise<string[]> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) return [];
  if (entry.isFile()) return extname(path).toLowerCase() === '.vxl' ? [path] : [];
  if (!entry.isDirectory()) return [];
  const files: string[] = [];
  for (const name of (await readdir(path)).sort()) files.push(...await vxlFiles(join(path, name)));
  return files;
}

export async function importVxl(args: string[]): Promise<void> {
  const input = args.filter(arg => !arg.startsWith('--'));
  const outputArgs = args.filter(arg => arg.startsWith('--output='));
  if (input.length !== 1 || outputArgs.length !== 1 || args.length !== 2 || !outputArgs[0].slice(9)) {
    throw new Error('Usage: bun scripts/import-vxl.ts <file.vxl|directory> --output=<directory>');
  }
  const source = resolve(input[0]), output = resolve(outputArgs[0].slice(9));
  const files = await vxlFiles(source);
  if (!files.length) throw new Error('No .vxl files found');
  await mkdir(output, { recursive: true });
  const maps = [], failed = [];
  for (const file of files) {
    try {
      const stat = await lstat(file);
      if (stat.size > 512 * 512 * 64 * 8) throw new Error('VXL file exceeds the native format size limit');
      const bytes = await Bun.file(file).bytes();
      const converted = convertVxl(bytes), encoded = encodeImportedMap(converted);
      const hash = createHash('sha256').update(encoded).digest('hex');
      const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
      const name = basename(file, extname(file));
      const id = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'map';
      await writeFile(join(output, `${hash}.ucmap`), encoded);
      maps.push({ id: `${id}-${hash.slice(0, 12)}`, name, file: `${hash}.ucmap`, size: converted.size,
        height: converted.height, hash, sourceSha256, sourceFile: relative(source, file) || basename(file),
        sourceBytes: bytes.length, bytes: encoded.length });
      console.log(`Converted ${basename(file)} -> ${hash}.ucmap (${encoded.length} bytes)`);
    } catch (error) {
      failed.push({ file: relative(source, file) || basename(file), error: error instanceof Error ? error.message : String(error) });
    }
  }
  await writeFile(join(output, 'import-report.json'), `${JSON.stringify({ version: 1, maps, failed }, null, 2)}\n`);
  if (failed.length) throw new Error(`${failed.length} map(s) rejected; see ${join(output, 'import-report.json')}`);
}

if (import.meta.main) {
  try { await importVxl(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
