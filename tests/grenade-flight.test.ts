import { describe, expect, test } from 'bun:test';
import { GameServer } from '../src/server/game';
import { grenadeLaunch, stepGrenade, type GrenadeFlight } from '../src/shared/grenade';
import type { MotionState } from '../src/shared/protocol';
import { packBlock, VoxelWorld } from '../src/shared/voxel';

const world = () => new VoxelWorld({ seed: 12345, size: 256, height: 128 });
const player = (): MotionState => ({ position: { x: 64.5, y: 90, z: 64.5 },
  velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, grounded: false });
const muzzle = { position: { x: .4, y: -.3, z: 1 }, direction: { x: 0, y: 0, z: 1 } };

describe('shared grenade prediction rules', () => {
  test('launch uses the charged muzzle, forward clearance, camera orientation and force without mutating inputs', () => {
    const state = player();
    const initial = structuredClone({ state, muzzle });
    const launch = grenadeLaunch(world(), state, muzzle, 2);
    expect(launch.position.x).toBeCloseTo(64.9, 10);
    expect(launch.position.y).toBeCloseTo(92.1, 10);
    expect(launch.position.z).toBe(62);
    expect(launch.velocity).toEqual({ x: 0, y: 0, z: -120 });
    expect({ state, muzzle }).toEqual(initial);
    state.yaw = Math.PI / 2;
    state.pitch = Math.PI / 6;
    const rotated = grenadeLaunch(world(), state, muzzle, 2);
    expect(rotated.position.x).toBeCloseTo(64.5 - .15 - Math.sqrt(3) * 1.25, 10);
    expect(rotated.position.y).toBeCloseTo(92.4 - Math.sqrt(3) * .15 + 1.25, 10);
    expect(rotated.position.z).toBeCloseTo(64.1, 10);
    expect(rotated.velocity.x).toBeCloseTo(-60 * Math.sqrt(3), 10);
    expect(rotated.velocity.y).toBeCloseTo(60, 10);
    expect(rotated.velocity.z).toBeCloseTo(0, 10);
  });

  test('launch against a wall starts in front of it and flight cannot pass through it', () => {
    const terrain = world();
    terrain.set(64, 92, 63, packBlock(80, 80, 80));
    const flight = grenadeLaunch(terrain, player(), muzzle, 2);
    expect(flight.position.z).toBeCloseTo(64.001, 10);
    expect(flight.position.x).toBeCloseTo(64.58, 10);
    expect(flight.position.y).toBeCloseTo(92.34, 10);
    stepGrenade(flight, terrain);
    expect(flight.position.z).toBeCloseTo(64.02, 10);
    expect(flight.velocity.z).toBe(0);
  });

  test('one second of free flight matches the original per-frame velocity units and accumulated gravity', () => {
    const terrain = world();
    const flight: GrenadeFlight = { position: { x: 128, y: 100, z: 128 }, velocity: { x: 30, y: 50, z: -100 } };
    const expected = structuredClone(flight.position);
    const frameVelocity = { x: .5, y: 50 / 60, z: -100 / 60 };
    let gravity = 0;
    for (let substep = 0; substep < 600; substep++) {
      gravity += 2.5 / 10;
      frameVelocity.y -= gravity / 60 / 60 / 10;
      for (const axis of ['x', 'y', 'z'] as const) {
        expected[axis] += frameVelocity[axis] / 10;
        frameVelocity[axis] *= .906 + .09;
      }
    }
    for (let tick = 0; tick < 60; tick++) stepGrenade(flight, terrain);
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(flight.position[axis]).toBeCloseTo(expected[axis], 9);
      expect(flight.velocity[axis]).toBeCloseTo(frameVelocity[axis] * 60, 9);
    }
    expect(flight.gravity).toBe(150);
  });

  test('cosmetic flight and authority keep identical floor contacts while only authority expires the grenade', () => {
    const game = new GameServer({ world: { seed: 12345, size: 256, height: 128 } });
    for (let x = 64; x < 70; x++) game.world.set(x, 90, 64, packBlock(80, 80, 80));
    const initial = { position: { x: 64.5, y: 92, z: 64.5 }, velocity: { x: 6, y: -12, z: 0 } };
    const visual: GrenadeFlight = structuredClone(initial);
    game.projectiles.set(1, { ...structuredClone(initial), id: 1, owner: 99, weapon: 'grenade', damage: 100, expires: 120 });
    let bounced = false;
    for (let tick = 1; tick < 120; tick++) {
      stepGrenade(visual, game.world);
      game.step();
      const authority = game.projectiles.get(1)!;
      expect(visual.position).toEqual(authority.position);
      expect(visual.velocity).toEqual(authority.velocity);
      expect(visual.position.y).toBeGreaterThanOrEqual(91);
      bounced ||= visual.velocity.y > 0;
    }
    expect(bounced).toBe(true);
    expect(game.world.getEdits()).toHaveLength(6);
    game.step();
    expect(game.projectiles.has(1)).toBe(false);
    expect(game.world.get(64, 90, 64)).toBe(0);
  });
});
