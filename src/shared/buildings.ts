import type { WorldConfig } from './protocol';
import { RUIN_VOXELS } from './ruin-model';

const SPACING = 64;
const APRON = 3;
const FOUNDATION = 0x7f707474;
const GRAVEL = 0x7f9a9b94;
const WALL = 0x7fbbc0b7;
const TIMBER = 0x7f574533;
const ROOF = 0x7f697c80;
const SNOW = 0x7fe9e9fa;

export interface Building {
  x: number; z: number; width: number; depth: number; floorY: number; bottom: number;
  kind: 'ruin' | 'hangar'; rotation: number; pad: Int16Array;
}

export function buildingsForChunk(config: WorldConfig, cx: number, cz: number,
  groundHeight: (x: number, z: number) => number): Building[] {
  if (config.size < 96 || config.height < 32) return [];
  const buildings: Building[] = [];
  const ox = cx * 16, oz = cz * 16;
  for (let sz = Math.floor((oz - 16) / SPACING); sz <= Math.floor((oz + 31) / SPACING); sz++) {
    for (let sx = Math.floor((ox - 16) / SPACING); sx <= Math.floor((ox + 31) / SPACING); sx++) {
      if (sx < 0 || sz < 0) continue;
      let hash = Math.imul(sx, 374761393) ^ Math.imul(sz, 668265263) ^ config.seed ^ 0x71b49;
      hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
      hash = (hash ^ (hash >>> 16)) >>> 0;
      const kind = ((sx + sz) & 1) ? 'hangar' : 'ruin';
      const rotation = (hash >>> 3) & 3;
      const width = kind === 'ruin' ? 16 : rotation % 2 ? 14 : 18;
      const depth = kind === 'ruin' ? 16 : rotation % 2 ? 18 : 14;
      const x = sx * SPACING + 24 + (hash % 13) - Math.floor(width / 2);
      const z = sz * SPACING + 24 + ((hash >>> 12) % 13) - Math.floor(depth / 2);
      if (x - APRON < 4 || z - APRON < 4 || x + width + APRON >= config.size - 4 || z + depth + APRON >= config.size - 4
        || x - APRON > ox + 15 || z - APRON > oz + 15 || x + width + APRON <= ox || z + depth + APRON <= oz) continue;
      // Leave the existing TDM arrival areas clear in the shared map, also used by FFA.
      if ([0.2, 0.8].some(t => Math.hypot(x + width / 2 - config.size * t, z + depth / 2 - config.size * t) < 32)) continue;
      let low = config.height, high = 0;
      const pad = new Int16Array((width + APRON * 2) * (depth + APRON * 2));
      for (let pz = z - APRON; pz < z + depth + APRON; pz++) {
        for (let px = x - APRON; px < x + width + APRON; px++) {
          const h = groundHeight(px, pz);
          pad[px - x + APRON + (pz - z + APRON) * (width + APRON * 2)] = h;
          low = Math.min(low, h); high = Math.max(high, h);
        }
      }
      if (high - low > 4 || high + 12 >= config.height) continue;
      const floorY = Math.round((low + high) / 2);
      for (let pz = -APRON; pz < depth + APRON; pz++) {
        for (let px = -APRON; px < width + APRON; px++) {
          const distance = Math.max(0, -px, px - width + 1, -pz, pz - depth + 1);
          const index = px + APRON + (pz + APRON) * (width + APRON * 2);
          pad[index] = Math.max(floorY - distance, Math.min(floorY + distance, pad[index]));
        }
      }
      buildings.push({ x, z, width, depth, floorY, bottom: low - 1, kind, rotation, pad });
    }
  }
  return buildings;
}

export function buildingBlock(building: Building, x: number, y: number, z: number): number | undefined {
  const dx = x - building.x, dz = z - building.z;
  if (dx < -APRON || dz < -APRON || dx >= building.width + APRON || dz >= building.depth + APRON
    || y < building.bottom || y > building.floorY + 11) return undefined;
  const padHeight = building.pad[dx + APRON + (dz + APRON) * (building.width + APRON * 2)];
  if (y < padHeight) return FOUNDATION;
  if (dx < 0 || dz < 0 || dx >= building.width || dz >= building.depth) return y === padHeight ? GRAVEL : 0;
  if (y === building.floorY) return FOUNDATION;
  const u = building.rotation === 0 ? dx : building.rotation === 1 ? dz
    : building.rotation === 2 ? building.width - 1 - dx : building.depth - 1 - dz;
  const v = building.rotation === 0 ? dz : building.rotation === 1 ? building.width - 1 - dx
    : building.rotation === 2 ? building.depth - 1 - dz : dx;
  const h = y - building.floorY;
  if (building.kind === 'ruin') {
    // Bury the historic model's five-voxel plinth; add usable entrances and stairs.
    if ((v === 0 || v === 15) && u >= 6 && u <= 9 && h <= 3) return 0;
    if (u >= 2 && u <= 3 && v >= 3 && v <= 6) {
      const step = v - 2;
      if (h <= step) return FOUNDATION;
      if (h <= step + 3) return 0;
    }
    return h <= 9 ? RUIN_VOXELS[u + 16 * (v + 16 * (h + 4))] : 0;
  }
  // A low hangar has two exits, side windows and a clear interior wide enough for combat.
  const roofHeight = 7 + Math.min(v, 13 - v, 3);
  if (h === roofHeight) return ROOF;
  if (h === roofHeight + 1) return SNOW;
  if (h > roofHeight) return 0;
  if (u === 0 || u === 17) {
    if (v >= 5 && v <= 8 && h <= 4) return 0;
    return h === 1 || v === 0 || v === 13 || h === 6 ? TIMBER : WALL;
  }
  if (v === 0 || v === 13) {
    if (h >= 3 && h <= 4 && ((u >= 4 && u <= 6) || (u >= 11 && u <= 13))) return 0;
    return h === 1 || u % 6 === 0 || h === 6 ? TIMBER : WALL;
  }
  return 0;
}
