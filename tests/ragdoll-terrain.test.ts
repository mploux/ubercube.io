import { describe, expect, test } from 'bun:test';
import * as CANNON from 'cannon-es';
import { RagdollTerrain } from '../src/client/ragdoll-terrain';
import type { VoxelEdit } from '../src/shared/protocol';

function scene(solid: (x: number, y: number, z: number) => boolean) {
  const edits = new Map<string, number>();
  let reads = 0;
  const world = { config: { seed: 1, size: 512, height: 64 },
    get(x: number, y: number, z: number) {
      reads++;
      return edits.get(`${x},${y},${z}`) ?? (solid(x, y, z) ? 0x7fffffff : 0);
    } };
  const physics = new CANNON.World({ gravity: new CANNON.Vec3(0, -28, 0), allowSleep: true });
  physics.defaultContactMaterial.friction = 0.65;
  physics.defaultContactMaterial.restitution = 0;
  const terrain = new RagdollTerrain(physics, world);
  const bodies: CANNON.Body[] = [];
  return { physics, terrain, bodies, reads: () => reads,
    body(x: number, y: number, z: number) {
      const body = new CANNON.Body({ mass: 1, collisionFilterGroup: 2, collisionFilterMask: 1,
        position: new CANNON.Vec3(x, y, z), shape: new CANNON.Box(new CANNON.Vec3(0.25, 0.25, 0.25)) });
      physics.addBody(body);
      bodies.push(body);
      return body;
    },
    step(seconds: number) {
      for (let i = 0; i < Math.ceil(seconds * 120); i++) {
        terrain.update(bodies);
        physics.step(1 / 120);
      }
    },
    edit(values: VoxelEdit[]) {
      for (const [x, y, z, value] of values) edits.set(`${x},${y},${z}`, value);
      terrain.applyEdits(values);
    },
  };
}

describe('local ragdoll terrain', () => {
  test('retains separate floors and the empty space under an overhang', () => {
    const state = scene((x, y, z) => x >= 10 && x <= 13 && z >= 10 && z <= 13 && (y === 1 || y === 6));
    const above = state.body(11.5, 9, 11.5);
    const below = state.body(11.5, 4, 11.5);
    state.step(3);
    expect(above.position.y).toBeCloseTo(7.25, 2);
    expect(below.position.y).toBeCloseTo(2.25, 2);
    expect(above.sleepState).toBe(CANNON.Body.SLEEPING);
    const reads = state.reads();
    state.step(1);
    expect(state.reads()).toBe(reads);
    expect(above.position.y).toBeCloseTo(7.25, 2);
  });

  test('stops lateral momentum at a voxel wall', () => {
    const state = scene((x, y, z) => x === 14 && y < 8 && z >= 10 && z <= 14);
    state.physics.gravity.set(0, 0, 0);
    const body = state.body(11.5, 3.5, 11.5);
    body.velocity.x = 6;
    let farthest = body.position.x;
    for (let i = 0; i < 120; i++) {
      state.step(1 / 120);
      farthest = Math.max(farthest, body.position.x);
    }
    expect(farthest).toBeGreaterThan(13.7);
    expect(farthest).toBeLessThan(13.81);
    expect(body.velocity.x).toBeLessThan(0.1);
  });

  test('keeps each stair tread at its voxel height', () => {
    const state = scene((x, y, z) => x >= 10 && x <= 12 && z >= 10 && z <= 12 && y <= x - 10);
    const bodies = [10, 11, 12].map(x => state.body(x + 0.5, 6, 11.5));
    state.step(3);
    for (const [index, body] of bodies.entries()) expect(body.position.y).toBeCloseTo(index + 1.25, 2);
  });

  test('ignores damage shading and wakes a resting body when its platform is destroyed', () => {
    const state = scene((x, y, z) => x >= 7 && x <= 10 && z >= 7 && z <= 10 && (y === 0 || y === 3));
    const body = state.body(8.5, 6, 8.5);
    const besideHole = state.body(9.5, 6, 8.5);
    state.step(3);
    expect(body.position.y).toBeCloseTo(4.25, 2);
    expect(body.sleepState).toBe(CANNON.Body.SLEEPING);
    const colliderIds = state.physics.bodies.map(body => body.id);
    state.edit([[8, 3, 8, 0x3fffffff]]);
    expect(body.sleepState).toBe(CANNON.Body.SLEEPING);
    expect(state.physics.bodies.map(body => body.id)).toEqual(colliderIds);
    state.edit([[8, 3, 8, 0]]);
    expect(body.sleepState).toBe(CANNON.Body.AWAKE);
    state.step(2);
    expect(body.position.y).toBeCloseTo(1.25, 2);
    expect(besideHole.position.y).toBeCloseTo(4.25, 2);
  });

  test('adds a newly built platform before a falling body reaches it', () => {
    const state = scene(() => false);
    const body = state.body(8.5, 5, 8.5);
    state.terrain.update(state.bodies);
    state.edit([[8, 3, 8, 0x7fffffff]]);
    state.step(2);
    expect(body.position.y).toBeCloseTo(4.25, 2);
  });

  test('wakes connected sleeping limbs beyond the edited block region', () => {
    const state = scene(() => false);
    const lower = state.body(8.5, 2, 8.5);
    const middle = state.body(8.5, 4, 8.5);
    const upper = state.body(8.5, 6, 8.5);
    const distant = state.body(100, 6, 100);
    state.physics.addConstraint(new CANNON.DistanceConstraint(middle, upper, 2));
    state.physics.addConstraint(new CANNON.DistanceConstraint(lower, middle, 2));
    state.terrain.update(state.bodies);
    for (const body of state.bodies) body.sleep();
    state.edit([[8, 0, 8, 0x7fffffff]]);
    expect([lower.sleepState, middle.sleepState, upper.sleepState]).toEqual([
      CANNON.Body.AWAKE, CANNON.Body.AWAKE, CANNON.Body.AWAKE]);
    expect(distant.sleepState).toBe(CANNON.Body.SLEEPING);
  });

  test('keeps voxel reads and statics local, releases abandoned regions and clears only its own bodies', () => {
    const state = scene(() => true);
    const body = state.body(8.5, 3, 8.5);
    state.terrain.update(state.bodies);
    const initialReads = state.reads();
    const initialCount = state.physics.bodies.length;
    expect(initialReads).toBeLessThan(100);
    expect(initialCount).toBeLessThan(100);
    state.terrain.update(state.bodies);
    expect(state.reads()).toBe(initialReads);
    body.position.set(400.5, 3, 400.5);
    body.aabbNeedsUpdate = true;
    state.terrain.update(state.bodies);
    expect(state.physics.bodies.length).toBe(initialCount);
    expect(state.physics.bodies.every(body => body.position.x > 390 && body.position.z > 390)).toBe(true);
    state.edit([[8, 1, 8, 0]]);
    expect(state.reads()).toBe(initialReads * 2);
    state.terrain.clear();
    expect(state.physics.bodies).toEqual([body]);
    state.terrain.update(state.bodies);
    state.terrain.update([]);
    expect(state.physics.bodies).toEqual([body]);
  });
});
