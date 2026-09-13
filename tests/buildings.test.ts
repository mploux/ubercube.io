import { describe, expect, test } from 'bun:test';
import { buildingBlock, buildingsForChunk, type Building } from '../src/shared/buildings';
import { playerCollides } from '../src/shared/movement';
import { terrainHeight } from '../src/shared/terrain-generation';
import { RUIN_VOXELS } from '../src/shared/ruin-model';
import { blockHealth, damageBlock, VoxelWorld } from '../src/shared/voxel';

const config = { seed: 12345, size: 256, height: 64 };

function plans(): Building[] {
  const found = new Map<string, Building>();
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    for (const building of buildingsForChunk(config, x, z, (x, z) => Math.floor(terrainHeight(config, x, z)))) {
      found.set(`${building.x},${building.z}`, building);
    }
  }
  return [...found.values()];
}

describe('destructible generated buildings', () => {
  test('historic ruin retains all 1800 source voxels and full block health', () => {
    const occupied = [...RUIN_VOXELS].filter(Boolean);
    expect(RUIN_VOXELS.length).toBe(16 * 14 * 16);
    expect(occupied.length).toBe(1800);
    expect(occupied.every(value => blockHealth(value) === 127)).toBe(true);
  });

  test('default map has both building types on bounded sites that agree across chunks', () => {
    const buildings = plans();
    expect(buildings.length).toBeGreaterThanOrEqual(4);
    expect(new Set(buildings.map(building => building.kind))).toEqual(new Set(['ruin', 'hangar']));
    for (const building of buildings) {
      expect(building.floorY + 11).toBeLessThan(config.height);
      const copy = buildingsForChunk(config, Math.floor((building.x + building.width - 1) / 16), Math.floor(building.z / 16),
        (x, z) => Math.floor(terrainHeight(config, x, z))).find(other => other.x === building.x && other.z === building.z);
      expect(copy).toEqual(building);
    }
    expect(buildingsForChunk({ ...config, size: 32 }, 0, 0, () => 10)).toEqual([]);
    expect(buildingsForChunk(config, 4, 0, (x, z) => (x + z) % 12 + 6)).toEqual([]);
  });

  test.each(['ruin', 'hangar'] as const)('%s has two traversable entrances in every orientation', kind => {
    for (let rotation = 0; rotation < 4; rotation++) {
      const width = kind === 'ruin' ? 16 : rotation % 2 ? 14 : 18;
      const depth = kind === 'ruin' ? 16 : rotation % 2 ? 18 : 14;
      const building: Building = { x: 40, z: 40, floorY: 10, bottom: 8, kind, rotation, width, depth,
        pad: new Int16Array((width + 6) * (depth + 6)).fill(10) };
      const world = { get: (x: number, y: number, z: number) => buildingBlock(building, x, y, z) ?? (y <= 10 ? 0x7f707474 : 0) };
      const point = (u: number, v: number) => ({
        x: building.x + (rotation === 0 ? u : rotation === 1 ? width - v : rotation === 2 ? width - u : v),
        y: 11.01,
        z: building.z + (rotation === 0 ? v : rotation === 1 ? u : rotation === 2 ? depth - v : depth - u),
      });
      for (const end of kind === 'ruin' ? [0, 16] : [0, 18]) {
        for (let offset = -1; offset <= 1; offset += 0.2) {
          const position = kind === 'ruin' ? point(8, end + offset) : point(end + offset, 7);
          expect(playerCollides(world, position)).toBe(false);
        }
      }
      if (kind === 'ruin') {
        for (let step = 1; step <= 4; step++) {
          const position = point(3, step + 2.5);
          position.y = 11.01 + step;
          expect(playerCollides(world, position)).toBe(false);
        }
      }
    }
  });

  test('walls use normal voxel damage, late-join edits and round reset', () => {
    const building = plans().find(building => building.kind === 'hangar')!;
    expect(building).toBeDefined();
    const world = new VoxelWorld(config);
    const x = building.x, z = building.z, y = building.floorY + 2;
    const intact = world.get(x, y, z);
    expect(intact).not.toBe(0);
    expect(world.set(x, y, z, damageBlock(intact, 0.5))).toBe(true);
    expect(blockHealth(world.get(x, y, z))).toBeLessThan(127);
    world.set(x, y, z, 0);
    const lateJoin = new VoxelWorld(config);
    lateJoin.applyEdits(world.getEdits());
    expect(lateJoin.get(x, y, z)).toBe(0);
    expect(lateJoin.get(x, y + 1, z)).toBe(world.get(x, y + 1, z));
    world.reset();
    expect(world.get(x, y, z)).toBe(intact);
    expect(world.getEdits()).toEqual([]);
  });
});
