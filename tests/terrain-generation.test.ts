import { describe, expect, test } from 'bun:test';
import { JavaRandom, terrainHeight } from '../src/shared/terrain-generation';
import { treesForChunk, vegetationForChunk, writeTree } from '../src/shared/vegetation';
import type { Tree } from '../src/shared/vegetation';
import { VoxelWorld } from '../src/shared/voxel';

describe('Java snowy terrain reference', () => {
  test('matches the original compiled NoisePass over seeds and octave boundaries', () => {
    // Captured by TerrainProbe.java against the original target/classes on 2026-09-13.
    const points = [[0, 0], [1, 1], [19, 39], [40, 40], [61, 17], [127, 255], [511, 511], [2047, 8191]];
    const reference = [
      [0, [10.309677, 10.3121195, 11.55623, 10.65835, 13.223129, 9.654198, 10.959568, 11.250916]],
      [42, [10.275637, 10.278058, 11.505686, 10.61759, 13.101834, 9.7051525, 11.059021, 11.250916]],
      [42042, [12.680142, 12.668825, 26.160408, 28.649166, 19.405317, 19.542282, 9.7215185, 12.152136]],
      [4294967295, [11.30867, 11.310099, 12.04881, 11.339554, 11.717597, 20.749832, 9.38273, 20.0676]],
    ] as const;
    for (const [seed, values] of reference) for (let i = 0; i < points.length; i++) {
      expect(terrainHeight({ seed, size: 16384, height: 64 }, points[i][0], points[i][1])).toBe(Math.fround(values[i]));
    }
  });

  test('uses Java Random without losing unsigned or negative seed bits', () => {
    const reference = [
      [0, 0.730967787376657, 0.24053639, 0.6063452159973596],
      [42, 0.7275636800328681, 0.6832234, 0.047939305137387644],
      [42042, 0.9680142670686769, 0.12244642, 0.3853267513350265],
      [-1, 0.26894263088050496, 0.012269974, 0.5480346480322552],
      [4294967295, 0.17005042563190176, 0.46452522, 0.6329192954648007],
    ];
    for (const [seed, first, second, third] of reference) {
      const random = new JavaRandom(seed);
      expect(random.nextDouble()).toBe(first);
      expect(random.nextFloat()).toBe(Math.fround(second));
      expect(random.nextDouble()).toBe(third);
    }
  });

  test('keeps a valid solid floor on the minimum world height', () => {
    const world = new VoxelWorld({ seed: 42042, size: 16, height: 16 });
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const y = world.groundY(x, z);
      expect(y).toBeGreaterThanOrEqual(3);
      expect(y).toBeLessThanOrEqual(5);
      expect(world.get(x, y - 1, z)).not.toBe(0);
    }
    expect(world.groundY(-1, 5)).toBe(0);
    expect(world.groundY(16, 5)).toBe(0);
  });
});

describe('Java oak geometry', () => {
  // Original Tree/OakTree/BigOakTree sources compiled unchanged with an isolated
  // world recorder and controlled RNG; colors classified as leaf=1, wood=2.
  const fixtures = [
    { big: false, leaves: [[-3, 10, -2], [-2, 8, 1], [-2, 9, 1], [4, 8, 2], [-3, 5, 2]],
      branches: [7, 4, 5, 3, 7], count: 334, digest: '0835bff72d9cd2765a9916a37a4cd376f3eb9ef3e146eaa5579a603e40b67975' },
    { big: true, leaves: [[-5, 20, -4], [-5, 18, 2], [-5, 19, 2], [8, 18, 4], [-7, 15, 4], [6, 16, 2], [-5, 20, 2], [-7, 16, 10], [-1, 15, -8]],
      branches: [2, 3, 3, 4, 5, 8, 7, 6, 5], count: 3841, digest: 'ee84438f35f5557234aaf05512f490f6df02a71c86c909b8f118d6a80a2c3370' },
  ];
  for (const fixture of fixtures) test(`${fixture.big ? 'big oak' : 'oak'} trunk, branches and crowns match Java across chunk edges`, () => {
    const config = { seed: 42, size: 64, height: 64 };
    const tree: Tree = { x: 32, y: 8, z: 32, big: fixture.big, branches: fixture.branches,
      leaves: fixture.leaves.map(([x, y, z]) => ({ x, y, z })) };
    const voxels = new Uint8Array(64 ** 3);
    let count = 0;
    for (let cz = 0; cz < 4; cz++) for (let cx = 0; cx < 4; cx++) {
      const blocks = new Map<number, number>();
      writeTree(tree, config, cx, cz, blocks);
      count += blocks.size;
      for (const [key, value] of blocks) {
        const x = cx * 16 + key % 16, z = cz * 16 + Math.floor(key / 16) % 16, y = Math.floor(key / 256);
        voxels[x + 64 * (z + 64 * y)] = ((value >>> 8) & 255) > ((value >>> 16) & 255) ? 1 : 2;
      }
    }
    expect(count).toBe(fixture.count);
    expect(new Bun.CryptoHasher('sha256').update(voxels).digest('hex')).toBe(fixture.digest);
  });

  test('tree origins and their full cross-chunk footprints ignore generation order', () => {
    const config = { seed: 42, size: 512, height: 64 };
    const heightAt = (x: number, z: number) => terrainHeight(config, x, z);
    const trees = treesForChunk(config, 2, 2);
    expect(trees.some(tree => tree.big && tree.x === 44 && tree.z === 33)).toBe(true);
    const chunks = [[1, 1], [2, 1], [3, 1], [1, 2], [2, 2], [3, 2], [1, 3], [2, 3], [3, 3]];
    const first = chunks.map(([x, z]) => vegetationForChunk(config, x, z, heightAt, () => []));
    for (const [x, z] of [...chunks].reverse()) vegetationForChunk(config, x, z, heightAt, () => []);
    expect(chunks.map(([x, z]) => vegetationForChunk(config, x, z, heightAt, () => []))).toEqual(first);
    expect(first[1].size).toBeGreaterThan(0);
    expect(first[4].size).toBeGreaterThan(0);
  });

  test('a building site removes the whole rooted tree, including leaves above its roof', () => {
    const config = { seed: 42, size: 512, height: 64 };
    const natural = vegetationForChunk(config, 30, 6, (x, z) => terrainHeight(config, x, z), () => []);
    const crown = 8 + 16 + 19 * 256;
    expect(natural.get(crown)).toBeGreaterThan(0);
    const world = new VoxelWorld(config);
    expect(world.get(488, 19, 97)).toBe(0);
  });
});
