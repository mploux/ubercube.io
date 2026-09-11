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
});
