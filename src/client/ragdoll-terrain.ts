import * as CANNON from 'cannon-es';
import type { VoxelEdit } from '../shared/protocol';
import type { VoxelWorld } from '../shared/voxel';

type CellBounds = [number, number, number, number, number, number];

export class RagdollTerrain {
  private readonly cells = new Map<number, boolean>();
  private readonly colliders = new Map<string, CANNON.Body>();
  private regions = new Map<CANNON.Body, CellBounds>();

  constructor(private readonly physics: CANNON.World, private readonly world: Pick<VoxelWorld, 'get' | 'config'>) {}

  update(bodies: readonly CANNON.Body[]): void {
    const { size, height } = this.world.config;
    const regions = new Map<CANNON.Body, CellBounds>();
    let changed = bodies.length !== this.regions.size;
    for (const body of bodies) {
      if (body.aabbNeedsUpdate) body.updateAABB();
      const bounds: CellBounds = [0, 0, 0, 0, 0, 0];
      for (const [index, axis] of (['x', 'y', 'z'] as const).entries()) {
        // Cover the next 0.1 s, while keeping a diverging simulation's voxel queries local.
        const travel = Math.max(-4, Math.min(4, body.velocity[axis] * 0.1));
        bounds[index * 2] = Math.max(0, Math.floor(body.aabb.lowerBound[axis] - 1 + Math.min(0, travel)));
        bounds[index * 2 + 1] = Math.min((axis === 'y' ? height : size) - 1,
          Math.floor(body.aabb.upperBound[axis] + 1 + Math.max(0, travel)));
      }
      const previous = this.regions.get(body);
      if (!previous || bounds.some((value, index) => value !== previous[index])) changed = true;
      regions.set(body, bounds);
    }
    if (!changed) return;
    this.regions = regions;

    const needed = new Set<number>();
    let solidsChanged = false;
    for (const [x0, x1, y0, y1, z0, z1] of regions.values()) {
      for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const key = x + size * (z + size * y);
        needed.add(key);
        if (this.cells.has(key)) continue;
        const solid = !!this.world.get(x, y, z);
        this.cells.set(key, solid);
        solidsChanged ||= solid;
      }
    }
    for (const [key, solid] of this.cells) {
      if (needed.has(key)) continue;
      solidsChanged ||= solid;
      this.cells.delete(key);
    }
    if (solidsChanged) this.rebuildColliders();
  }

  applyEdits(edits: readonly VoxelEdit[]): void {
    const size = this.world.config.size;
    const wake = new Set<CANNON.Body>();
    for (const [x, y, z] of edits) {
      const key = x + size * (z + size * y);
      if (!this.cells.has(key)) continue;
      const previous = this.cells.get(key);
      const solid = !!this.world.get(x, y, z);
      if (previous === solid) continue;
      this.cells.set(key, solid);
      for (const [body, [x0, x1, y0, y1, z0, z1]] of this.regions) {
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1) wake.add(body);
      }
    }
    if (wake.size) this.rebuildColliders();
    // Sleeping limbs otherwise retain infinite solver mass when a connected limb loses its support.
    let expanded = true;
    while (wake.size && expanded) {
      expanded = false;
      for (const { bodyA, bodyB } of this.physics.constraints) {
        if (wake.has(bodyA) === wake.has(bodyB)) continue;
        const other = wake.has(bodyA) ? bodyB : bodyA;
        if (!this.regions.has(other)) continue;
        wake.add(other);
        expanded = true;
      }
    }
    for (const body of wake) body.wakeUp();
  }

  clear(): void {
    for (const collider of this.colliders.values()) this.physics.removeBody(collider);
    this.colliders.clear();
    this.cells.clear();
    this.regions.clear();
  }

  private rebuildColliders(): void {
    const size = this.world.config.size;
    const remaining = new Set([...this.cells].filter(([, solid]) => solid).map(([key]) => key).sort((a, b) => a - b));
    const needed = new Set<string>();
    // Cannon's collision matrix grows quadratically with bodies, so merge only fully solid boxes.
    for (const key of remaining) {
      const x = key % size, z = Math.floor(key / size) % size, y = Math.floor(key / (size * size));
      let width = 1, depth = 1, height = 1;
      while (x + width < size && remaining.has(key + width)) width++;
      extendDepth: while (z + depth < size) {
        for (let dx = 0; dx < width; dx++) if (!remaining.has(key + dx + depth * size)) break extendDepth;
        depth++;
      }
      extendHeight: while (y + height < this.world.config.height) {
        for (let dz = 0; dz < depth; dz++) for (let dx = 0; dx < width; dx++) {
          if (!remaining.has(key + dx + dz * size + height * size * size)) break extendHeight;
        }
        height++;
      }
      for (let dy = 0; dy < height; dy++) for (let dz = 0; dz < depth; dz++) for (let dx = 0; dx < width; dx++) {
        remaining.delete(key + dx + dz * size + dy * size * size);
      }
      const boxKey = `${x},${y},${z},${width},${height},${depth}`;
      needed.add(boxKey);
      if (this.colliders.has(boxKey)) continue;
      const body = new CANNON.Body({ mass: 0, collisionFilterGroup: 1, collisionFilterMask: 2,
        position: new CANNON.Vec3(x + width / 2, y + height / 2, z + depth / 2),
        shape: new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, depth / 2)) });
      this.physics.addBody(body);
      this.colliders.set(boxKey, body);
    }
    for (const [key, body] of this.colliders) {
      if (needed.has(key)) continue;
      this.physics.removeBody(body);
      this.colliders.delete(key);
    }
  }
}
