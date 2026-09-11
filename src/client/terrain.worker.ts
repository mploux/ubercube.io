import type { VoxelEdit, WorldConfig } from '../shared/protocol';
import { CHUNK_SIZE, VoxelWorld } from '../shared/voxel';

export type TerrainWorkerRequest =
  | { type: 'init'; config: WorldConfig; edits: VoxelEdit[]; epoch: number }
  | { type: 'edits'; edits: VoxelEdit[]; epoch: number }
  | { type: 'mesh'; x: number; y: number; z: number; version: number; epoch: number };

export interface TerrainMesh {
  type: 'mesh'; x: number; y: number; z: number; version: number; epoch: number;
  positions: Float32Array; normals: Int8Array; colors: Float32Array | Uint8Array; indices: Uint32Array;
}

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<TerrainWorkerRequest>) => void) | null;
  postMessage(message: TerrainMesh, transfer: ArrayBuffer[]): void;
};
let world: VoxelWorld;
let epoch = 0;

if (typeof self !== 'undefined' && typeof window === 'undefined' && typeof self.postMessage === 'function') scope.onmessage = ({ data }) => {
  if (data.type === 'init') {
    world = new VoxelWorld(data.config);
    world.applyEdits(data.edits);
    epoch = data.epoch;
  } else if (data.epoch === epoch && data.type === 'edits') world.applyEdits(data.edits);
  else if (data.epoch === epoch && data.type === 'mesh') {
    const result = meshChunk(world, data);
    scope.postMessage(result, [result.positions.buffer, result.normals.buffer,
      result.colors.buffer, result.indices.buffer] as ArrayBuffer[]);
  }
};

export function meshChunk(world: VoxelWorld, job: Extract<TerrainWorkerRequest, { type: 'mesh' }>): TerrainMesh {
  const span = CHUNK_SIZE + 2;
  const cells = new Uint32Array(span ** 3);
  const ox = job.x * CHUNK_SIZE, oy = job.y * CHUNK_SIZE, oz = job.z * CHUNK_SIZE;
  for (let z = -1; z <= CHUNK_SIZE; z++) {
    for (let y = -1; y <= CHUNK_SIZE; y++) {
      for (let x = -1; x <= CHUNK_SIZE; x++) {
        cells[x + 1 + span * (y + 1 + span * (z + 1))] = world.get(ox + x, oy + y, oz + z);
      }
    }
  }
  const sample = (p: number[]) => cells[p[0] + 1 + span * (p[1] + 1 + span * (p[2] + 1))];
  const positions: number[] = [], normals: number[] = [], colors: number[] = [], indices: number[] = [];
  const mask = new Uint32Array(CHUNK_SIZE ** 2);
  const lighting = new Uint8Array(CHUNK_SIZE ** 2);
  const p = [0, 0, 0], side = [0, 0, 0];
  const cornerU = [-1, 1, 1, -1], cornerV = [-1, -1, 1, 1];
  const shade = [1, 0.87, 0.87 ** 2, 0.87 ** 3];

  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    for (const sign of [-1, 1]) {
      for (let slice = 0; slice < CHUNK_SIZE; slice++) {
        mask.fill(0);
        for (let j = 0; j < CHUNK_SIZE; j++) {
          for (let i = 0; i < CHUNK_SIZE; i++) {
            p[axis] = slice; p[u] = i; p[v] = j;
            const value = sample(p);
            if (!value) continue;
            p[axis] += sign;
            if (sample(p)) continue;
            let ao = 0;
            for (let corner = 0; corner < 4; corner++) {
              side[axis] = p[axis]; side[u] = i + cornerU[corner]; side[v] = j;
              const a = sample(side) ? 1 : 0;
              side[u] = i; side[v] = j + cornerV[corner];
              const b = sample(side) ? 1 : 0;
              side[u] = i + cornerU[corner];
              const c = sample(side) ? 1 : 0;
              ao |= (a + b + c) << (corner * 2);
            }
            mask[i + j * CHUNK_SIZE] = value;
            lighting[i + j * CHUNK_SIZE] = ao;
          }
        }

        for (let j = 0; j < CHUNK_SIZE; j++) {
          for (let i = 0; i < CHUNK_SIZE;) {
            const offset = i + j * CHUNK_SIZE;
            const value = mask[offset];
            if (!value) { i++; continue; }
            const ao = lighting[offset];
            const uniform = ao === (ao & 3) * 85;
            let width = 1, height = 1;
            if (uniform) {
              while (i + width < CHUNK_SIZE && mask[offset + width] === value && lighting[offset + width] === ao) width++;
              outer: while (j + height < CHUNK_SIZE) {
                for (let x = 0; x < width; x++) {
                  const next = offset + x + height * CHUNK_SIZE;
                  if (mask[next] !== value || lighting[next] !== ao) break outer;
                }
                height++;
              }
            }
            const first = positions.length / 3;
            for (let corner = 0; corner < 4; corner++) {
              p[axis] = slice + (sign > 0 ? 1 : 0);
              p[u] = i + (cornerU[corner] > 0 ? width : 0);
              p[v] = j + (cornerV[corner] > 0 ? height : 0);
              positions.push(p[0], p[1], p[2]);
              normals.push(axis === 0 ? sign * 127 : 0, axis === 1 ? sign * 127 : 0, axis === 2 ? sign * 127 : 0);
              const brightness = shade[(ao >>> (corner * 2)) & 3] / 255;
              colors.push(((value >>> 16) & 255) * brightness,
                ((value >>> 8) & 255) * brightness, (value & 255) * brightness);
            }
            if (sign > 0) indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
            else indices.push(first, first + 2, first + 1, first, first + 3, first + 2);
            for (let row = 0; row < height; row++) mask.fill(0, offset + row * CHUNK_SIZE, offset + row * CHUNK_SIZE + width);
            i += width;
          }
        }
      }
    }
  }
  return { ...job, positions: new Float32Array(positions), normals: new Int8Array(normals),
    colors: new Float32Array(colors), indices: new Uint32Array(indices) };
}
