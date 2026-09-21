import { describe, expect, test } from 'bun:test';
import { aimDirection, movePlayer, playerCollides } from '../src/shared/movement';
import { DT, type InputFrame, type MotionState } from '../src/shared/protocol';
import type { VoxelWorld } from '../src/shared/voxel';

const input = (changes: Partial<InputFrame> = {}): InputFrame => ({
  seq: 1, roundId: 1, moveX: 0, moveZ: 0, yaw: 0, pitch: 0,
  jump: false, sprint: false, fire: false, alt: false, weapon: 'ak47', ...changes,
});
const state = (): MotionState => ({ position: { x: 8, y: 1, z: 8 }, velocity: { x: 0, y: 0, z: 0 }, grounded: true, yaw: 0, pitch: 0 });
const flat = (wall = false): Pick<VoxelWorld, 'get' | 'config'> => ({
  config: { seed: 0, size: 64, height: 32 },
  get: (x: number, y: number) => y === 0 || (wall && x === 12 && y < 10) ? 1 : 0,
});

describe('shared movement', () => {
  test('standing settles on the floor without penetrating it', () => {
    const player = state();
    for (let i = 0; i < 600; i++) movePlayer(player, input(), flat());
    expect(player.position.y).toBeCloseTo(1, 3);
    expect(player.grounded).toBe(true);
    expect(playerCollides(flat(), player.position)).toBe(false);
  });
  test('diagonal input has the same speed as axial input', () => {
    const axial = state();
    const diagonal = state();
    for (let i = 0; i < 60; i++) {
      movePlayer(axial, input({ moveX: 1 }), flat());
      movePlayer(diagonal, input({ moveX: 1, moveZ: -1 }), flat());
    }
    expect(Math.hypot(axial.position.x - 8, axial.position.z - 8)).toBeCloseTo(Math.hypot(diagonal.position.x - 8, diagonal.position.z - 8), 5);
  });
  test('sprinting cannot cross a wall or the world boundary', () => {
    const player = state();
    for (let i = 0; i < 300; i++) movePlayer(player, input({ moveX: 1, sprint: true }), flat(true));
    expect(player.position.x).toBeLessThanOrEqual(11.7001);
    expect(playerCollides(flat(true), player.position)).toBe(false);
    for (let i = 0; i < 600; i++) movePlayer(player, input({ moveX: -1, sprint: true }), flat());
    expect(player.position.x).toBeGreaterThanOrEqual(0.3);
  });
  test('jump requires ground and lands again', () => {
    const player = state();
    movePlayer(player, input({ jump: true }), flat());
    const launchedVelocity = player.velocity.y;
    movePlayer(player, input({ jump: true }), flat());
    expect(player.velocity.y).toBeLessThan(launchedVelocity);
    for (let i = 0; i < 180; i++) movePlayer(player, input(), flat(), DT);
    expect(player.position.y).toBeCloseTo(1, 3);
  });
  test('replaying unacknowledged commands produces the same state', () => {
    const client = state();
    let acknowledged = state();
    const frames = Array.from({ length: 90 }, (_, seq) => input({ seq, moveZ: 1, yaw: seq / 150, jump: seq === 8 }));
    for (let i = 0; i < frames.length; i++) {
      movePlayer(client, frames[i], flat());
      if (i === 30) acknowledged = structuredClone(client);
    }
    for (const frame of frames.slice(31)) movePlayer(acknowledged, frame, flat());
    expect(acknowledged).toEqual(client);
  });
  test('aim coordinates agree with forward movement', () => {
    expect(aimDirection(0, 0)).toEqual({ x: -0, y: 0, z: -1 });
    expect(aimDirection(Math.PI / 2, 0).x).toBeCloseTo(-1);
    expect(aimDirection(0, Math.PI / 4).y).toBeGreaterThan(0);
  });

  test('sneaking halves walking speed and takes priority over sprint', () => {
    const walking = state(), sneaking = state();
    for (let tick = 0; tick < 60; tick++) {
      movePlayer(walking, input({ moveX: 1 }), flat());
      movePlayer(sneaking, input({ moveX: 1, sneak: true, sprint: true }), flat());
    }
    expect(sneaking.position.x - 8).toBeCloseTo((walking.position.x - 8) / 2, 6);
  });

  test.each([{ moveX: 1 }, { moveX: 1, moveZ: -1 }])('sneaking holds the edge of one block with %j and release allows falling', movement => {
    const ledge: Pick<VoxelWorld, 'get' | 'config'> = { ...flat(), get: (x, y, z) => x === 8 && y === 0 && z === 8 ? 1 : 0 };
    const player = state();
    player.position = { x: 8.5, y: 1, z: 8.5 };
    player.velocity.x = 9;
    for (let tick = 0; tick < 120; tick++) movePlayer(player, input({ ...movement, sneak: true }), ledge);
    expect(player.grounded).toBe(true);
    expect(player.position.y).toBeCloseTo(1, 3);
    expect(player.position.x).toBeLessThan(9.3);
    expect(player.position.z).toBeLessThan(9.3);
    for (let tick = 0; tick < 30; tick++) movePlayer(player, input(movement), ledge);
    expect(player.grounded).toBe(false);
    expect(player.position.y).toBeLessThan(1);
  });

  test('sneaking does not stop a jump, an airborne player or a destroyed support', () => {
    let support = true;
    const ledge: Pick<VoxelWorld, 'get' | 'config'> = { ...flat(), get: (x, y, z) => support && x === 8 && y === 0 && z === 8 ? 1 : 0 };
    const jumping = state();
    jumping.position = { x: 8.5, y: 1, z: 8.5 };
    movePlayer(jumping, input({ jump: true, moveX: 1, sneak: true }), ledge);
    for (let tick = 0; tick < 30; tick++) movePlayer(jumping, input({ moveX: 1, sneak: true }), ledge);
    expect(jumping.position.x).toBeGreaterThan(9.3);
    expect(jumping.grounded).toBe(false);
    const unsupported = state();
    support = false;
    movePlayer(unsupported, input({ sneak: true }), ledge);
    expect(unsupported.position.y).toBeLessThan(1);
    expect(unsupported.grounded).toBe(false);
  });

  test('sneaking climbs a voxel stair but remains blocked by a low ceiling', () => {
    const stairs = { ...flat(), get: (x: number, y: number) => y === 0 || x >= 9 && y === 1 ? 1 : 0 };
    const player = state();
    for (let tick = 0; tick < 60; tick++) movePlayer(player, input({ moveX: 1, sneak: true }), stairs);
    expect(player.position.x).toBeGreaterThan(9);
    expect(player.position.y).toBeCloseTo(2, 3);
    const blocked = state();
    const low = { ...stairs, get: (x: number, y: number) => y === 4 ? 1 : stairs.get(x, y) };
    for (let tick = 0; tick < 60; tick++) movePlayer(blocked, input({ moveX: 1, sneak: true }), low);
    expect(blocked.position.x).toBeLessThan(8.701);
    expect(blocked.position.y).toBeCloseTo(1, 3);
  });

  test('reconciliation reproduces sneak transitions at an edge', () => {
    const ledge: Pick<VoxelWorld, 'get' | 'config'> = { ...flat(), get: (x, y) => x <= 9 && y === 0 ? 1 : 0 };
    const client = state();
    let acknowledged = state();
    const frames = Array.from({ length: 90 }, (_, seq) => input({ seq, moveX: 1, sneak: seq < 70 }));
    for (let tick = 0; tick < frames.length; tick++) {
      movePlayer(client, frames[tick], ledge);
      if (tick === 30) acknowledged = structuredClone(client);
    }
    for (const frame of frames.slice(31)) movePlayer(acknowledged, frame, ledge);
    expect(acknowledged).toEqual(client);
    expect(client.position.y).toBeLessThan(1);
  });
});
