import { describe, expect, test } from 'bun:test';
import { meshChunk } from '../src/client/terrain.worker';
import { packBlock, VoxelWorld } from '../src/shared/voxel';

const job = { type: 'mesh' as const, x: 0, y: 2, z: 0, version: 0, epoch: 0 };
const channels = (value: number) => [(value >>> 16) & 255, (value >>> 8) & 255, value & 255];

describe('Java terrain palette', () => {
  test('changes color without moving a voxel or changing the seed layout', () => {
    const world = new VoxelWorld({ seed: 42042, size: 64, height: 64 });
    const occupancy = new Uint8Array(64 ** 3);
    let offset = 0;
    for (let z = 0; z < 64; z++) for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      occupancy[offset++] = world.get(x, y, z) ? 1 : 0;
    }
    // Captured from the unchanged terrain before the palette correction.
    expect(new Bun.CryptoHasher('sha256').update(occupancy).digest('hex'))
      .toBe('db7bda55d9979422cd6ff3ca4611384728992e0dbf6778aaaecdfe91a9ce82aa');
  });

  test('grass follows the Java height gradient and stone is neutral gray', () => {
    const world = new VoxelWorld({ seed: 42042, size: 64, height: 64 });
    for (const [x, z] of [[2, 2], [8, 12], [12, 35], [60, 53]]) {
      const height = world.surfaceY(x, z) - 1;
      const [r, g, b] = channels(world.get(x, height, z));
      expect(r).toBe(b);
      expect(Math.abs((g - r) - (0.05 + 0.35 * height / 30) * 255)).toBeLessThan(1.01);
      expect(r).toBeGreaterThanOrEqual(Math.floor((0.05 + 0.05 * height / 30 - 0.02) * 255));
      expect(r).toBeLessThanOrEqual(Math.floor((0.05 + 0.05 * height / 30 + 0.02) * 255));
      const stone = channels(world.get(x, height - 2, z));
      expect(stone[0]).toBe(stone[1]);
      expect(stone[1]).toBe(stone[2]);
      expect(stone[0]).toBeGreaterThanOrEqual(122);
      expect(stone[0]).toBeLessThanOrEqual(132);
    }
  });

  test('oak canopies use the original saturated green rather than a blue gray palette', () => {
    const world = new VoxelWorld({ seed: 42042, size: 128, height: 64 });
    for (const [x, z] of [[73, 38], [74, 38], [73, 39]]) {
      const height = world.surfaceY(x, z) - 1;
      expect(height).toBeGreaterThanOrEqual(27);
      const [r, g, b] = channels(world.get(x, height, z));
      expect(r).toBe(b);
      expect(r).toBeGreaterThanOrEqual(25);
      expect(r).toBeLessThanOrEqual(38);
      expect(g).toBeGreaterThanOrEqual(102);
      expect(g).toBeLessThanOrEqual(114);
    }
  });
});

describe('raw display RGB passed to the world shader', () => {
  test('keeps identical raw RGB for all six face normals before shader lighting', () => {
    const world = new VoxelWorld({ seed: 42, size: 16, height: 64 });
    world.set(5, 40, 5, packBlock(17, 129, 203));
    const result = meshChunk(world, job);
    expect(result.colors).toBeInstanceOf(Float32Array);
    expect(result.indices.length).toBe(36);
    const normals = new Set<string>();
    for (let vertex = 0; vertex < result.positions.length / 3; vertex++) {
      const n = Array.from(result.normals.slice(vertex * 3, vertex * 3 + 3));
      normals.add(n.join(','));
      const rgb = [17, 129, 203];
      for (let component = 0; component < 3; component++) {
        expect(result.colors[vertex * 3 + component]).toBeCloseTo(rgb[component] / 255, 6);
      }
    }
    expect(normals).toEqual(new Set(['-127,0,0', '127,0,0', '0,-127,0', '0,127,0', '0,0,-127', '0,0,127']));
  });

  test('ambient occlusion multiplies by 0.87 per occupied neighbor, including two without a corner', () => {
    const world = new VoxelWorld({ seed: 42, size: 16, height: 64 });
    const value = packBlock(100, 150, 200);
    world.set(5, 40, 5, value);
    world.set(4, 41, 5, value);
    world.set(5, 41, 4, value);
    for (const neighbors of [2, 3]) {
      if (neighbors === 3) world.set(4, 41, 4, value);
      const result = meshChunk(world, job);
      let index = -1;
      for (let i = 0; i < result.positions.length; i += 3) {
        if (result.positions[i] === 5 && result.positions[i + 1] === 9 && result.positions[i + 2] === 5
          && result.normals[i + 1] === 127) { index = i; break; }
      }
      expect(index).toBeGreaterThanOrEqual(0);
      expect(result.colors[index]).toBeCloseTo(100 / 255 * 0.87 ** neighbors, 6);
      expect(result.colors[index + 1]).toBeCloseTo(150 / 255 * 0.87 ** neighbors, 6);
      expect(result.colors[index + 2]).toBeCloseTo(200 / 255 * 0.87 ** neighbors, 6);
    }
  });
});
