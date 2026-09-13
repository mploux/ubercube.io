import type { WorldConfig } from './protocol';
import { JavaRandom, terrainHash, terrainHeight } from './terrain-generation';
import type { Building } from './buildings';

interface Point { x: number; y: number; z: number }

export interface Tree {
  x: number; y: number; z: number;
  big: boolean;
  leaves: Point[];
  branches: number[];
}

export function treesForChunk(config: WorldConfig, cx: number, cz: number,
  heightAt: (x: number, z: number) => number = (x, z) => terrainHeight(config, x, z)): Tree[] {
  const trees: Tree[] = [];
  const random = new JavaRandom(terrainHash(cx, cz, config.seed ^ 0x731af));
  for (let i = 0; i < 4; i++) {
    if (random.nextFloat() > 0.5) continue;
    const x = cx * 16 + (i % 2) * 8 + Math.trunc(random.nextFloat() * 5);
    const z = cz * 16 + Math.floor(i / 2) * 8 + Math.trunc(random.nextFloat() * 5);
    if (x < 0 || z < 0 || x >= config.size || z >= config.size) continue;
    const height = heightAt(x, z);
    if (height >= 13 + random.nextFloat() * 2 || random.nextFloat() <= 0.9) continue;
    const big = random.nextFloat() <= 0.05;
    const range = big ? 10 : 5, minHeight = big ? 15 : 5;
    const count = Math.round(random.nextFloat() * (big ? 4 : 2) + (big ? 6 : 4));
    const leaves = Array.from({ length: count }, () => ({
      x: Math.round(random.nextFloat() * range * 2 - range),
      y: Math.round(random.nextFloat() * 5) + minHeight,
      z: Math.round(random.nextFloat() * range * 2 - range),
    }));
    const branches = leaves.map(() => 5 + Math.round(random.nextFloat() * 6 - 3));
    trees.push({ x, y: Math.floor(height), z, big, leaves, branches });
  }
  return trees;
}

export function vegetationForChunk(config: WorldConfig, cx: number, cz: number,
  heightAt: (x: number, z: number) => number,
  buildingsAt: (cx: number, cz: number) => Building[]): Map<number, number> {
  const blocks = new Map<number, number>();
  // Big-oak crowns reach at most 15 cells from their single stable origin.
  for (let fz = cz - 1; fz <= cz + 1; fz++) for (let fx = cx - 1; fx <= cx + 1; fx++) {
    for (const tree of treesForChunk(config, fx, fz, heightAt)) {
      if (buildingsAt(fx, fz).some(building => tree.x >= building.x - 3 && tree.x < building.x + building.width + 3
        && tree.z >= building.z - 3 && tree.z < building.z + building.depth + 3)) continue;
      writeTree(tree, config, cx, cz, blocks);
    }
  }
  return blocks;
}

export function writeTree(tree: Tree, config: WorldConfig, cx: number, cz: number, blocks: Map<number, number>): void {
  const ox = cx * 16, oz = cz * 16;
  const add = (x: number, y: number, z: number, wood: boolean) => {
    if (x < ox || x >= ox + 16 || z < oz || z >= oz + 16 || y < 1 || y >= config.height) return;
    const shade = terrainHash(x + y * 31, z, config.seed ^ 0x52a83) / 0x100000000 * 0.05;
    const red = wood ? (tree.big ? 0.21 : 0.252) : (tree.big ? 0 : 0.1);
    const green = wood ? (tree.big ? 0.16 : 0.192) : (tree.big ? 0.3 : 0.4);
    const blue = wood ? (tree.big ? 0.07 : 0.084) : (tree.big ? 0.05 : 0.1);
    blocks.set(x - ox + (z - oz) * 16 + y * 256,
      (0x7f000000 | ((red + shade) * 255 << 16) | ((green + shade) * 255 << 8) | ((blue + shade) * 255)) >>> 0);
  };
  const sphere = (center: Point, radius: number, trim: number) => {
    for (let x = Math.max(-radius, ox - center.x); x < Math.min(radius, ox + 16 - center.x); x++) {
      for (let z = Math.max(-radius, oz - center.z); z < Math.min(radius, oz + 16 - center.z); z++) {
        for (let y = -radius; y < radius; y++) if (x * x + y * y + z * z <= radius * radius - trim) {
          add(center.x + x, center.y + y, center.z + z, false);
        }
      }
    }
  };
  const trunkHeight = tree.big ? 20 : 10, trunkSize = tree.big ? 3 : 2;
  sphere({ x: tree.x, y: tree.y + trunkHeight, z: tree.z }, tree.big ? 7 : 4, 0);
  for (const leaf of tree.leaves) {
    sphere({ x: tree.x + leaf.x, y: tree.y + leaf.y, z: tree.z + leaf.z }, tree.big ? 5 : 2, 2);
  }
  for (let z = 0; z < trunkSize; z++) for (let x = 0; x < trunkSize; x++) {
    for (let y = 0; y < trunkHeight; y++) add(tree.x + x - 1, tree.y + y, tree.z + z - 1, true);
  }
  for (let i = 0; i < tree.leaves.length; i++) {
    const start = { x: tree.x, y: tree.y + tree.branches[i], z: tree.z };
    const leaf = tree.leaves[i], dx = leaf.x, dy = tree.y + leaf.y - start.y, dz = leaf.z;
    const distance = Math.fround(Math.sqrt(dx * dx + dy * dy + dz * dz));
    for (let step = 0; step < distance; step++) {
      const t = Math.fround(step / distance);
      const bx = Math.trunc(Math.fround(start.x + Math.fround(dx * t)));
      const by = Math.trunc(Math.fround(start.y + Math.fround(dy * t)));
      const bz = Math.trunc(Math.fround(start.z + Math.fround(dz * t)));
      const width = tree.big ? 2 : 1;
      for (let x = 0; x < width; x++) for (let y = 0; y < width; y++) for (let z = 0; z < width; z++) {
        add(bx + x, by + y, bz + z, true);
      }
    }
  }
}
