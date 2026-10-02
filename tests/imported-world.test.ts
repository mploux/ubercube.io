import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { encodeImportedMap, type ImportedMap } from '../src/shared/imported-map';
import { packBlock, VoxelWorld } from '../src/shared/voxel';
import { loadImportedMap, mapSha256 } from '../src/client/map-loader';
import { meshChunk } from '../src/client/terrain.worker';
import { minimapTilePixels } from '../src/client/minimap';

function fixture() {
  const size = 64, height = 32;
  const offsets = new Uint32Array(size * size + 1);
  const runs = new Uint32Array(size * size * 4);
  const dirt = packBlock(140, 80, 30), roof = packBlock(230, 240, 250);
  for (let column = 0; column < size * size; column++) {
    offsets[column] = column * 4;
    runs.set([4 << 16, dirt, 8 | (9 << 16), roof], column * 4);
  }
  offsets[size * size] = runs.length;
  const map: ImportedMap = { size, height, offsets, runs };
  const bytes = encodeImportedMap(map);
  const hash = createHash('sha256').update(bytes).digest('hex');
  return { map, bytes, dirt, roof, config: { size, height, seed: 0, map: { id: 'test-map', hash } } };
}

test('HTTP LAN checksum fallback matches SHA256 including padding boundaries and map-sized data', () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 127, 128, 4096, 3 * 1024 * 1024]) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 71 + i % 11) & 255);
    expect(mapSha256(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  }
});

test('imported geometry is shared by collisions, meshes, minimap and reset; edits remain deltas', () => {
  const { map, config, dirt, roof } = fixture();
  const world = new VoxelWorld(config, map);
  expect(world.get(5, 2, 5)).toBe(dirt);
  expect(world.get(5, 6, 5)).toBe(0);
  expect(world.get(5, 8, 5)).toBe(roof);
  expect(world.getEdits()).toEqual([]);
  expect(world.groundY(5, 5)).toBe(9);
  const pixels = minimapTilePixels(world, 0, 0);
  expect(Array.from(pixels.slice(0, 4))).toEqual([230, 240, 250, 255]);
  const mesh = meshChunk(world, { type: 'mesh', x: 0, y: 0, z: 0, version: 0, epoch: 1 });
  expect(mesh.indices.length).toBeGreaterThan(0);
  expect(Array.from(mesh.positions).some((value, i) => i % 3 === 1 && value === 8)).toBe(true);
  world.set(5, 8, 5, 0);
  expect(world.groundY(5, 5)).toBe(4);
  expect(world.getEdits()).toEqual([[5, 8, 5, 0]]);
  world.reset();
  expect(world.get(5, 8, 5)).toBe(roof);
  expect(world.getEdits()).toEqual([]);
  expect(() => new VoxelWorld(config)).toThrow('Imported map');
  world.reset({ seed: 12, size: 64, height: 32 });
  expect(world.importedMap).toBeUndefined();
  expect(world.config.map).toBeUndefined();
});

test('browser map loading verifies server-selected bytes and dimensions before use', async () => {
  const { config, bytes } = fixture();
  const requested: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    requested.push(new URL(request.url).pathname);
    return new Response(new Uint8Array(bytes));
  } });
  try {
    const signal = new AbortController().signal;
    const map = await loadImportedMap(config, server.url.href, signal);
    expect(map?.size).toBe(64);
    expect(requested).toEqual([`/maps/${config.map.hash}.ucmap`]);
    await expect(loadImportedMap({ ...config, map: { id: 'test-map', hash: '0'.repeat(64) } }, server.url.href, signal)).rejects.toThrow('checksum');
    await expect(loadImportedMap({ ...config, size: 80 }, server.url.href, signal)).rejects.toThrow('dimensions');
    await expect(loadImportedMap({ ...config, map: { id: 'test-map', hash: '../escape' } }, server.url.href, signal)).rejects.toThrow('hash');
    const controller = new AbortController(); controller.abort();
    await expect(loadImportedMap(config, server.url.href, controller.signal)).rejects.toThrow();
    expect(await loadImportedMap({ seed: 0, size: 64, height: 32 }, server.url.href, signal)).toBeUndefined();
  } finally { server.stop(true); }
});
