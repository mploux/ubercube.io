import type { Vec3, VoxelEdit, WorldConfig } from './protocol';
import { terrainHash, terrainHeight } from './terrain-generation';
import { vegetationForChunk } from './vegetation';
import { buildingBlock, buildingsForChunk } from './buildings';
import type { Building } from './buildings';

export const CHUNK_SIZE = 16;
const COLUMN_CACHE_LIMIT = 256;

export function packBlock(r: number, g: number, b: number, health = 127): number {
  const h = Math.max(0, Math.min(127, Math.floor(health)));
  if (!h) return 0;
  return ((h << 24) | (Math.max(0, Math.min(255, r)) << 16)
    | (Math.max(0, Math.min(255, g)) << 8) | Math.max(0, Math.min(255, b))) >>> 0;
}

export function blockHealth(value: number): number { return (value >>> 24) & 127; }

export function damageBlock(value: number, amount: number): number {
  if (!value || !Number.isFinite(amount) || amount <= 0) return value;
  const health = Math.max(0, Math.floor(blockHealth(value) - Math.min(1, amount) * 127));
  if (!health) return 0;
  const shade = 0.7 + (health / 127) * 0.3;
  return packBlock(((value >>> 16) & 255) * shade, ((value >>> 8) & 255) * shade,
    (value & 255) * shade, health);
}

const BEDROCK = packBlock(127, 127, 127);

interface Columns {
  ground: Float32Array;
  vegetation: Map<number, number>;
  buildings: Building[];
}

export class VoxelWorld {
  private configuration: WorldConfig;
  private readonly columns = new Map<number, Columns>();
  private readonly heights = new Map<number, Float32Array>();
  private readonly buildings = new Map<number, Building[]>();
  private readonly edits = new Map<number, number>();

  constructor(config: WorldConfig) {
    this.configuration = this.validate(config);
  }

  get config(): WorldConfig { return this.configuration; }

  private validate(config: WorldConfig): WorldConfig {
    if (!Number.isInteger(config.size) || config.size < 16 || !Number.isInteger(config.height)
      || config.height < 16 || config.height > 32767 || !Number.isFinite(config.seed)
      || !Number.isSafeInteger(config.size * config.size * config.height)) {
      throw new Error('Invalid voxel world configuration');
    }
    return Object.freeze({ seed: config.seed >>> 0, size: config.size, height: config.height });
  }

  private inside(x: number, y: number, z: number): boolean {
    return Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z)
      && x >= 0 && z >= 0 && y >= 0 && x < this.config.size && z < this.config.size && y < this.config.height;
  }

  groundY(x: number, z: number): number {
    x = Math.floor(x); z = Math.floor(z);
    if (!Number.isFinite(x) || !Number.isFinite(z) || x < 0 || z < 0 || x >= this.config.size || z >= this.config.size) return 0;
    return Math.floor(this.heightAt(x, z)) + 1;
  }

  private heightAt(x: number, z: number): number {
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
    const key = cx + cz * Math.ceil(this.config.size / CHUNK_SIZE);
    let heights = this.heights.get(key);
    if (!heights) {
      heights = new Float32Array(256);
      for (let z = 0; z < CHUNK_SIZE; z++) for (let x = 0; x < CHUNK_SIZE; x++) {
        heights[x + z * CHUNK_SIZE] = terrainHeight(this.config, cx * CHUNK_SIZE + x, cz * CHUNK_SIZE + z);
      }
      if (this.heights.size >= COLUMN_CACHE_LIMIT) this.heights.delete(this.heights.keys().next().value!);
      this.heights.set(key, heights);
    }
    return heights[x - cx * CHUNK_SIZE + (z - cz * CHUNK_SIZE) * CHUNK_SIZE];
  }

  private buildingsAt(cx: number, cz: number): Building[] {
    const key = cx + cz * Math.ceil(this.config.size / CHUNK_SIZE);
    const cached = this.buildings.get(key);
    if (cached) return cached;
    const buildings = buildingsForChunk(this.config, cx, cz, (x, z) => Math.floor(this.heightAt(x, z)));
    if (this.buildings.size >= COLUMN_CACHE_LIMIT) this.buildings.delete(this.buildings.keys().next().value!);
    this.buildings.set(key, buildings);
    return buildings;
  }

  private getColumns(cx: number, cz: number): Columns {
    const key = cx + cz * Math.ceil(this.config.size / CHUNK_SIZE);
    const cached = this.columns.get(key);
    if (cached) return cached;
    const data: Columns = {
      ground: new Float32Array(256), vegetation: vegetationForChunk(this.config, cx, cz,
        (x, z) => this.heightAt(x, z), (x, z) => this.buildingsAt(x, z)),
      buildings: this.buildingsAt(cx, cz),
    };
    const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) data.ground[x + z * CHUNK_SIZE] = this.heightAt(ox + x, oz + z);
    }
    if (this.columns.size >= COLUMN_CACHE_LIMIT) this.columns.delete(this.columns.keys().next().value!);
    this.columns.set(key, data);
    return data;
  }

  private base(x: number, y: number, z: number): number {
    if (y === 0) return BEDROCK;
    const column = this.getColumns(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE));
    const i = (x % CHUNK_SIZE) + (z % CHUNK_SIZE) * CHUNK_SIZE;
    for (const building of column.buildings) {
      const value = buildingBlock(building, x, y, z);
      if (value !== undefined) return value;
    }
    const vegetation = column.vegetation.get(i + y * 256);
    if (vegetation !== undefined) return vegetation;
    const height = column.ground[i]!, ground = Math.floor(height);
    const variation = terrainHash(x + y * 31, z, this.config.seed ^ 0x52a83) / 0x100000000;
    if (y < ground) {
      const gray = (0.48 + variation * 0.04) * 255;
      return packBlock(gray, gray, gray);
    }
    if (y === ground) {
      const snow = Math.min(1, (y - 10) / 6);
      if (snow > terrainHash(x, z, this.config.seed ^ 0x9e37) / 0x100000000) {
        return packBlock((0.9 + variation * 0.02) * 255, (0.9 + variation * 0.02) * 255,
          (0.98 + variation * 0.02) * 255);
      }
      const noise = variation * 0.04 - 0.02;
      const t = height / 30;
      return packBlock((0.05 + 0.05 * t + noise) * 255,
        (0.1 + 0.4 * t + noise) * 255, (0.05 + 0.05 * t + noise) * 255);
    }
    return 0;
  }

  get(x: number, y: number, z: number): number {
    if (!this.inside(x, y, z)) return 0;
    const key = x + this.config.size * (z + this.config.size * y);
    return this.edits.get(key) ?? this.base(x, y, z);
  }

  set(x: number, y: number, z: number, value: number): boolean {
    if (!this.inside(x, y, z) || y === 0 || !Number.isInteger(value) || value < 0 || value > 0xffffffff) return false;
    value = blockHealth(value) ? value >>> 0 : 0;
    if (this.get(x, y, z) === value) return false;
    const key = x + this.config.size * (z + this.config.size * y);
    if (value === this.base(x, y, z)) this.edits.delete(key);
    else this.edits.set(key, value);
    return true;
  }

  applyEdits(edits: VoxelEdit[]): void {
    for (const [x, y, z, value] of edits) this.set(x, y, z, value);
  }

  getEdits(): VoxelEdit[] {
    const size = this.config.size;
    return Array.from(this.edits, ([key, value]): VoxelEdit => [key % size,
      Math.floor(key / (size * size)), Math.floor(key / size) % size, value]);
  }

  surfaceY(x: number, z: number): number {
    x = Math.floor(x); z = Math.floor(z);
    if (x < 0 || z < 0 || x >= this.config.size || z >= this.config.size) return 0;
    for (let y = this.config.height - 1; y >= 0; y--) if (this.get(x, y, z)) return y + 1;
    return 0;
  }

  reset(config: WorldConfig = this.config): void {
    this.configuration = this.validate(config);
    this.columns.clear();
    this.heights.clear();
    this.buildings.clear();
    this.edits.clear();
  }
}

export interface VoxelHit {
  x: number; y: number; z: number; normal: Vec3; distance: number; point: Vec3; value: number;
}

export function raycast(world: VoxelWorld, origin: Vec3, direction: Vec3, maxDistance: number): VoxelHit | null {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(length) || !length || !Number.isFinite(maxDistance) || maxDistance < 0
    || ![origin.x, origin.y, origin.z].every(Number.isFinite)) return null;
  const d = [direction.x / length, direction.y / length, direction.z / length];
  const o = [origin.x, origin.y, origin.z];
  const bounds = [world.config.size, world.config.height, world.config.size];
  let entry = 0, exit = maxDistance;
  let normal = { x: 0, y: 0, z: 0 };
  for (let axis = 0; axis < 3; axis++) {
    if (d[axis] === 0) {
      if (o[axis]! < 0 || o[axis]! >= bounds[axis]!) return null;
      continue;
    }
    const a = -o[axis]! / d[axis]!, b = (bounds[axis]! - o[axis]!) / d[axis]!;
    const near = Math.min(a, b), far = Math.max(a, b);
    if (near > entry) {
      entry = near;
      normal = { x: 0, y: 0, z: 0 };
      if (axis === 0) normal.x = -Math.sign(d[axis]!);
      if (axis === 1) normal.y = -Math.sign(d[axis]!);
      if (axis === 2) normal.z = -Math.sign(d[axis]!);
    }
    exit = Math.min(exit, far);
    if (entry > exit) return null;
  }
  const step = d.map(Math.sign);
  const cell = o.map((v, axis) => {
    const p = v + entry * d[axis]!;
    return Math.floor(p) - (d[axis]! < 0 && Number.isInteger(p) ? 1 : 0);
  });
  if (entry === 0) {
    for (let axis = 0; axis < 3; axis++) {
      if (!d[axis] || !Number.isInteger(o[axis])) continue;
      if (axis === 0) normal.x = -step[axis];
      if (axis === 1) normal.y = -step[axis];
      if (axis === 2) normal.z = -step[axis];
      break;
    }
  }
  const delta = d.map(v => v ? Math.abs(1 / v) : Infinity);
  const next = cell.map((v, axis) => d[axis] ? ((v + (step[axis]! > 0 ? 1 : 0)) - o[axis]!) / d[axis]! : Infinity);
  let distance = entry;
  while (distance <= exit + 1e-9) {
    const [x, y, z] = cell as [number, number, number];
    if (x < 0 || y < 0 || z < 0 || x >= bounds[0]! || y >= bounds[1]! || z >= bounds[2]!) return null;
    const value = world.get(x, y, z);
    if (value) return { x, y, z, normal, distance, value,
      point: { x: origin.x + d[0]! * distance, y: origin.y + d[1]! * distance, z: origin.z + d[2]! * distance } };
    distance = Math.min(...next);
    normal = { x: 0, y: 0, z: 0 };
    let first = true;
    for (let axis = 0; axis < 3; axis++) {
      if (Math.abs(next[axis]! - distance) > 1e-9) continue;
      cell[axis]! += step[axis]!;
      next[axis]! += delta[axis]!;
      if (first) {
        if (axis === 0) normal.x = -step[axis]!;
        if (axis === 1) normal.y = -step[axis]!;
        if (axis === 2) normal.z = -step[axis]!;
        first = false;
      }
    }
  }
  return null;
}
