import { afterEach, describe, expect, test, spyOn } from 'bun:test';
import * as THREE from 'three';
import { TerrainRenderer } from '../src/client/terrain';
import { meshChunk } from '../src/client/terrain.worker';
import type { TerrainMesh, TerrainWorkerRequest } from '../src/client/terrain.worker';
import { blockHealth, damageBlock, packBlock, raycast, VoxelWorld } from '../src/shared/voxel';

const config = { seed: 42042, size: 64, height: 64 };
const white = packBlock(220, 225, 230);

describe('voxel state', () => {
  test('preserves the full unsigned seed received from the server', () => {
    const config = { seed: 0xffffffff, size: 64, height: 48 };
    const world = new VoxelWorld(config);
    expect(world.config).toEqual(config);
    world.reset();
    expect(world.config).toEqual(config);
  });
  test('generation is independent of access order and cache eviction', () => {
    const a = new VoxelWorld({ ...config, size: 512 });
    const b = new VoxelWorld({ ...config, size: 512 });
    const samples = Array.from({ length: 100 }, (_, i) => [i * 37 % 512, 4 + i % 34, i * 73 % 512] as const);
    const expected = samples.map(([x, y, z]) => a.get(x, y, z));
    for (let z = 0; z < 512; z += 16) for (let x = 0; x < 512; x += 16) a.get(x, 20, z);
    for (const [x, y, z] of [...samples].reverse()) b.get(x, y, z);
    expect(samples.map(([x, y, z]) => a.get(x, y, z))).toEqual(expected);
    expect(samples.map(([x, y, z]) => b.get(x, y, z))).toEqual(expected);
  });

  test('edits survive eviction, serialize and restore the current surface', () => {
    const world = new VoxelWorld({ ...config, size: 512 });
    const originalSurface = world.surfaceY(12, 12);
    expect(world.set(12, 50, 12, white)).toBe(true);
    expect(world.set(12, 50, 12, white)).toBe(false);
    for (let z = 0; z < 512; z += 16) for (let x = 0; x < 512; x += 16) world.get(x, 20, z);
    expect(world.surfaceY(12, 12)).toBe(51);
    const copy = new VoxelWorld(world.config);
    copy.applyEdits(world.getEdits());
    expect(copy.get(12, 50, 12)).toBe(white);
    world.set(12, 50, 12, 0);
    expect(world.surfaceY(12, 12)).toBe(originalSurface);
    expect(world.getEdits()).toEqual([]);
    world.set(12, originalSurface - 1, 12, 0);
    expect(world.surfaceY(12, 12)).toBe(originalSurface - 1);
  });

  test('map bounds and bedrock cannot be edited, reset removes round mutations', () => {
    const world = new VoxelWorld(config);
    for (const point of [[-1, 10, 5], [64, 10, 5], [5, -1, 5], [5, 64, 5], [5, 10, 64], [1.5, 5, 5]]) {
      expect(world.get(point[0], point[1], point[2])).toBe(0);
      expect(world.set(point[0], point[1], point[2], white)).toBe(false);
    }
    expect(world.get(0, 0, 0)).not.toBe(0);
    expect(world.set(0, 0, 0, 0)).toBe(false);
    world.set(3, 55, 3, white);
    world.reset({ ...config, seed: 9, size: 32 });
    expect(world.config.seed).toBe(9);
    expect(world.getEdits()).toEqual([]);
    expect(world.get(3, 55, 3)).toBe(0);
    expect(world.surfaceY(-1, 10)).toBe(0);
  });

  test('block resistance and darkening are independent of display transparency', () => {
    expect(blockHealth(white)).toBe(127);
    const damaged = damageBlock(white, 0.25);
    expect(blockHealth(damaged)).toBe(95);
    expect((damaged >>> 16) & 255).toBeLessThan((white >>> 16) & 255);
    expect(damageBlock(damaged, 1)).toBe(0);
    expect(damageBlock(0, 0.1)).toBe(0);
    expect(damageBlock(white, -1)).toBe(white);
  });
});

describe('grid raycast', () => {
  test('normalized distances, face normals, range and an exact negative boundary', () => {
    const world = new VoxelWorld(config);
    world.set(32, 45, 30, white);
    const hit = raycast(world, { x: 30.5, y: 45.5, z: 30.5 }, { x: 2, y: 0, z: 0 }, 10)!;
    expect([hit.x, hit.y, hit.z]).toEqual([32, 45, 30]);
    expect(hit.distance).toBeCloseTo(1.5);
    expect(hit.normal).toEqual({ x: -1, y: 0, z: 0 });
    expect(hit.point.x).toBe(32);
    expect(raycast(world, { x: 30.5, y: 45.5, z: 30.5 }, { x: 1, y: 0, z: 0 }, 1)).toBeNull();
    const reverse = raycast(world, { x: 33, y: 45.5, z: 30.5 }, { x: -1, y: 0, z: 0 }, 10)!;
    expect(reverse.x).toBe(32);
    expect(reverse.distance).toBe(0);
    expect(reverse.normal.x).toBe(1);
  });

  test('corner ties do not hit a voxel merely touched at its edge', () => {
    const world = new VoxelWorld(config);
    world.set(31, 45, 30, white);
    world.set(32, 45, 32, white);
    const hit = raycast(world, { x: 30.5, y: 45.5, z: 30.5 }, { x: 1, y: 0, z: 1 }, 10)!;
    expect([hit.x, hit.y, hit.z]).toEqual([32, 45, 32]);
    expect(hit.distance).toBeCloseTo(Math.sqrt(4.5));
  });

  test('clips rays from outside the world and rejects invalid input', () => {
    const world = new VoxelWorld(config);
    world.set(0, 45, 3, white);
    expect(raycast(world, { x: -5, y: 45.5, z: 3.5 }, { x: 1, y: 0, z: 0 }, 20)?.distance).toBe(5);
    expect(raycast(world, { x: -5, y: 45.5, z: 3.5 }, { x: -1, y: 0, z: 0 }, 20)).toBeNull();
    expect(raycast(world, { x: 2, y: 45, z: 3 }, { x: 0, y: 0, z: 0 }, 20)).toBeNull();
    expect(raycast(world, { x: NaN, y: 45, z: 3 }, { x: 1, y: 0, z: 0 }, 20)).toBeNull();
  });
});

const job = { type: 'mesh' as const, x: 0, y: 2, z: 0, version: 0, epoch: 0 };

describe('terrain mesh', () => {
  test('merges equal colors, preserves distinct colors and orients every triangle outward', () => {
    const world = new VoxelWorld({ ...config, size: 16 });
    world.set(5, 40, 5, white);
    world.set(6, 40, 5, white);
    const result = meshChunk(world, job);
    expect(result.indices.length).toBe(36);
    for (let i = 0; i < result.indices.length; i += 3) {
      const vertices = [0, 1, 2].map(offset => new THREE.Vector3().fromArray(result.positions, result.indices[i + offset] * 3));
      const cross = vertices[1].clone().sub(vertices[0]).cross(vertices[2].clone().sub(vertices[0]));
      const normal = new THREE.Vector3().fromArray(result.normals, result.indices[i] * 3);
      expect(cross.dot(normal)).toBeGreaterThan(0);
    }
    world.set(6, 40, 5, packBlock(150, 60, 40));
    expect(meshChunk(world, job).indices.length).toBe(60);
  });

  test('neighbor halo hides shared faces and reveals them after destruction', () => {
    const world = new VoxelWorld({ ...config, size: 32 });
    world.set(15, 40, 5, white);
    world.set(16, 40, 5, white);
    expect(meshChunk(world, job).indices.length).toBe(30);
    expect(meshChunk(world, { ...job, x: 1 }).indices.length).toBe(30);
    world.set(16, 40, 5, 0);
    expect(meshChunk(world, job).indices.length).toBe(36);
  });
});

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<TerrainMesh>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: TerrainWorkerRequest[] = [];
  constructor() { FakeWorker.instances.push(this); }
  postMessage(message: TerrainWorkerRequest): void { this.messages.push(message); }
  terminate(): void {}
}
const originalWorker = globalThis.Worker;
afterEach(() => { globalThis.Worker = originalWorker; });

test('border edits invalidate the neighbor job and reject its old mesh', () => {
  FakeWorker.instances = [];
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const world = new VoxelWorld({ ...config, size: 32 });
  const renderer = new TerrainRenderer(new THREE.Scene(), world);
  renderer.update({ x: 15.5, y: 40, z: 5 });
  const worker = FakeWorker.instances[0];
  const initial = worker.messages.find(message => message.type === 'mesh')! as Extract<TerrainWorkerRequest, { type: 'mesh' }>;
  expect(initial.x).toBe(0);
  renderer.applyEdits([[16, 40, 5, white]]);
  worker.onmessage!({ data: { ...initial, positions: new Float32Array(), normals: new Int8Array(), colors: new Uint8Array(), indices: new Uint32Array() } } as MessageEvent<TerrainMesh>);
  const remesh = worker.messages.filter(message => message.type === 'mesh').at(-1)!;
  expect(remesh.type === 'mesh' && remesh.x === 0 && remesh.version === 1).toBe(true);
  renderer.dispose();
});

test('a worker failure retries once and then exposes a visible error state', () => {
  FakeWorker.instances = [];
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const silence = spyOn(console, 'error').mockImplementation(() => {});
  const renderer = new TerrainRenderer(new THREE.Scene(), new VoxelWorld(config));
  const before = FakeWorker.instances.length;
  FakeWorker.instances[0].onerror!({ message: 'fixture failure' } as ErrorEvent);
  expect(FakeWorker.instances.length).toBe(before + 1);
  FakeWorker.instances.at(-1)!.onerror!({ message: 'fixture failure again' } as ErrorEvent);
  expect(renderer.stats.error).not.toBeNull();
  renderer.dispose();
  silence.mockRestore();
});
