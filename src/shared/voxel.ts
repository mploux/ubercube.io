import type { Vec3, VoxelEdit, WorldConfig } from './protocol';

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

function hash(x: number, z: number, seed: number): number {
  let n = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ seed;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return (n ^ (n >>> 16)) >>> 0;
}

function noise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  let u = x - ix, v = z - iz;
  u *= u * (3 - 2 * u); v *= v * (3 - 2 * v);
  const a = hash(ix, iz, seed) / 4294967295;
  const b = hash(ix + 1, iz, seed) / 4294967295;
  const c = hash(ix, iz + 1, seed) / 4294967295;
  const d = hash(ix + 1, iz + 1, seed) / 4294967295;
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

const GRASS = [packBlock(44, 102, 43), packBlock(48, 112, 45), packBlock(53, 119, 48), packBlock(46, 107, 42)];
const STONE = [packBlock(115, 121, 126), packBlock(119, 125, 130), packBlock(122, 128, 133), packBlock(117, 123, 128)];
const LEAF = [packBlock(30, 78, 32), packBlock(33, 86, 35), packBlock(36, 91, 37), packBlock(29, 81, 32)];
const WOOD = packBlock(80, 61, 31);
const BEDROCK = packBlock(72, 76, 82);

interface Columns {
  ground: Uint16Array;
  wood: Uint16Array;
  leafBottom: Uint16Array;
  leafTop: Uint16Array;
  rock: Uint16Array;
}

export class VoxelWorld {
  private configuration: WorldConfig;
  private readonly columns = new Map<number, Columns>();
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

  private ground(x: number, z: number): number {
    const h = 7 + noise(x / 62, z / 62, this.config.seed) * 15
      + noise(x / 23, z / 23, this.config.seed ^ 173) * 5;
    return Math.max(2, Math.min(this.config.height - 12, Math.floor(h)));
  }

  private getColumns(cx: number, cz: number): Columns {
    const key = cx + cz * Math.ceil(this.config.size / CHUNK_SIZE);
    const cached = this.columns.get(key);
    if (cached) return cached;
    const data: Columns = {
      ground: new Uint16Array(256), wood: new Uint16Array(256),
      leafBottom: new Uint16Array(256), leafTop: new Uint16Array(256), rock: new Uint16Array(256),
    };
    const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) data.ground[x + z * CHUNK_SIZE] = this.ground(ox + x, oz + z);
    }
    // Each feature has one stable origin; neighboring chunks generate only their intersection.
    for (let fz = cz - 1; fz <= cz + 1; fz++) {
      for (let fx = cx - 1; fx <= cx + 1; fx++) {
        const h = hash(fx, fz, this.config.seed ^ 0x731af);
        const ax = fx * CHUNK_SIZE + 4 + ((h >>> 8) % 8);
        const az = fz * CHUNK_SIZE + 4 + ((h >>> 16) % 8);
        if (ax < 18 || az < 8 || ax >= this.config.size - 18 || az >= this.config.size - 8
          || Math.hypot(ax - this.config.size / 2, az - this.config.size / 2) < 14) continue;
        const choice = h % 10;
        if (choice >= 6) continue;
        const base = this.ground(ax, az);
        const radius = choice < 4 ? 3 + ((h >>> 25) & 1) : 2;
        const top = base + 5 + ((h >>> 22) % 3);
        for (let z = Math.max(oz, az - radius); z <= Math.min(oz + 15, az + radius); z++) {
          for (let x = Math.max(ox, ax - radius); x <= Math.min(ox + 15, ax + radius); x++) {
            const distance = (x - ax) ** 2 + (z - az) ** 2;
            if (distance > radius * radius) continue;
            const i = x - ox + (z - oz) * CHUNK_SIZE;
            if (choice < 4) {
              const thickness = Math.floor(Math.sqrt(radius * radius - distance) * 0.7);
              data.leafBottom[i] = top - thickness;
              data.leafTop[i] = Math.min(this.config.height - 1, top + thickness);
              if (x === ax && z === az) data.wood[i] = top;
            } else data.rock[i] = Math.max(data.rock[i]!, base + Math.floor(Math.sqrt(5 - distance)) + 1);
          }
        }
      }
    }
    if (this.columns.size >= COLUMN_CACHE_LIMIT) this.columns.delete(this.columns.keys().next().value!);
    this.columns.set(key, data);
    return data;
  }

  private base(x: number, y: number, z: number): number {
    if (y === 0) return BEDROCK;
    const column = this.getColumns(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE));
    const i = (x % CHUNK_SIZE) + (z % CHUNK_SIZE) * CHUNK_SIZE;
    const ground = column.ground[i]!;
    if (y < ground) return STONE[((x >> 1) + (z >> 1) + (y >> 1)) & 3]!;
    if (y === ground) return GRASS[hash(x >> 2, z >> 2, this.config.seed) & 3]!;
    if (y <= column.rock[i]!) return STONE[(x + z) & 3]!;
    if (y <= column.wood[i]!) return WOOD;
    if (column.leafTop[i] && y >= column.leafBottom[i]! && y <= column.leafTop[i]!) {
      return LEAF[((x >> 1) + (z >> 1) + (y >> 1)) & 3]!;
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
