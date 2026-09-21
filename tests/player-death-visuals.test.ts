import { expect, spyOn, test } from 'bun:test';
import * as THREE from 'three';
import { PlayerVisuals } from '../src/client/player-visuals';
import { Ragdolls } from '../src/client/ragdolls';
import type { GameEvent, PlayerState } from '../src/shared/protocol';

const player = (overrides: Partial<PlayerState> = {}): PlayerState => ({
  id: 1, name: '', team: 1, kit: 'assault', weapon: 'ak47', aiming: true,
  position: { x: 20, y: 1, z: 20 }, velocity: { x: 0, y: 0, z: 0 }, yaw: .7, pitch: .3,
  grounded: true, alive: true, health: 100, kills: 0, deaths: 0, ammo: 30, grenades: 10, lastSeq: 0, ...overrides,
});
const death = (victim: PlayerState): GameEvent => ({
  type: 'event', event: 'death', roundId: 1, tick: 60, targetId: victim.id,
  position: { ...victim.position }, weapon: 'ak47',
  death: { player: { ...victim, alive: false, health: 0, deaths: victim.deaths + 1 },
    hitPoint: { ...victim.position, y: victim.position.y + 2.6 }, impulse: { x: 12, y: 0, z: 0 } },
});
const ground = { config: { size: 64, height: 64, seed: 1 }, get: (_x: number, y: number, _z: number) => y === 0 ? 1 : 0 };
function setup() {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const visuals = new PlayerVisuals(scene, 160, async () => new THREE.Group());
  visuals.setWorld(ground);
  const mesh = scene.getObjectByName('UBERCUBE articulated bodies') as THREE.InstancedMesh;
  return { visuals, camera, mesh };
}

test('a fatal event preserves the last rendered ADS pose and replaces the stale live snapshot once', () => {
  const { visuals, camera, mesh } = setup();
  const displayed = player({ velocity: { x: 4, y: 0, z: 0 } });
  visuals.update([displayed], -1, 1, camera);
  const before = Array.from(mesh.instanceMatrix.array.slice(0, 160));
  const authoritative = player({ position: { x: 20.4, y: 1, z: 20 }, yaw: .8 });
  const event = death(authoritative);
  visuals.death(event, displayed, 1);
  visuals.update([displayed], -1, 1, camera);
  expect(mesh.count).toBe(10);
  Array.from(mesh.instanceMatrix.array.slice(0, 160)).forEach((value, i) => expect(value).toBeCloseTo(before[i], 5));
  visuals.death(event, displayed, 1);
  visuals.update([event.death!.player], -1, 1, camera);
  expect(mesh.count).toBe(10);
  visuals.clear();
});

test('respawning the same player leaves their corpse and a repeated old death does not remove the new life', () => {
  const { visuals, camera, mesh } = setup();
  const victim = player(), event = death(victim);
  visuals.update([victim], -1, 1, camera);
  visuals.death(event, victim, 1);
  const respawned = player({ deaths: 1, position: { x: 30, y: 1, z: 20 } });
  visuals.update([respawned], -1, 1, camera);
  expect(mesh.count).toBe(20);
  visuals.death(event, respawned, 1);
  visuals.update([respawned], -1, 1, camera);
  expect(mesh.count).toBe(20);
  const transform = new THREE.Matrix4(); mesh.getMatrixAt(0, transform);
  expect(new THREE.Vector3().setFromMatrixPosition(transform).x).toBe(30);
  visuals.clear();
});

test('a death before any rendered snapshot has a complete pose, including the local player corpse', () => {
  const { visuals, camera, mesh } = setup();
  const event = death(player());
  visuals.death(event, undefined, 1);
  visuals.update([event.death!.player], 1, 1, camera);
  expect(mesh.count).toBe(10);
  const transform = new THREE.Matrix4(); mesh.getMatrixAt(0, transform);
  expect(new THREE.Vector3().setFromMatrixPosition(transform).x).toBeCloseTo(20, 5);
  expect(mesh.castShadow).toBe(true);
  visuals.setFogDistance(80);
  expect((mesh.material as THREE.ShaderMaterial).uniforms.fogDistance.value).toBe(80);
  visuals.clear();
});

test('historical dead snapshots and disconnected players never create a new corpse', () => {
  const { visuals, camera, mesh } = setup();
  visuals.update([player({ alive: false, deaths: 2 })], -1, 1, camera);
  expect(mesh.count).toBe(0);
  visuals.update([player()], -1, 2, camera);
  expect(mesh.count).toBe(10);
  visuals.update([], -1, 3, camera);
  expect(mesh.count).toBe(0);
  visuals.clear();
});

test('world reset clears the corpse and death deduplication before the next round', () => {
  const { visuals, camera, mesh } = setup();
  const event = death(player());
  visuals.death(event, undefined, 1);
  visuals.update([event.death!.player], -1, 1, camera);
  expect(mesh.count).toBe(10);
  visuals.setWorld(ground);
  expect(mesh.count).toBe(0);
  visuals.death({ ...event, roundId: 2 }, undefined, 2);
  visuals.update([event.death!.player], -1, 2, camera);
  expect(mesh.count).toBe(10);
  visuals.clear();
  expect(mesh.count).toBe(0);
});

test('corpse camera focus follows the rendered torso while the dead player snapshot stays still', () => {
  const { visuals, camera, mesh } = setup();
  const victim = player({ position: { x: 20, y: 10, z: 20 }, velocity: { x: 3, y: 0, z: 0 } });
  const event = death(victim);
  try {
    expect(visuals.corpsePosition(victim.id)).toBeNull();
    visuals.death(event, undefined, 1);
    const initial = visuals.corpsePosition(victim.id)!;
    expect(initial).not.toBeNull();
    visuals.update([event.death!.player], victim.id, 1, camera);
    for (let tick = 1; tick <= 20; tick++) visuals.update([event.death!.player], victim.id, 1 + tick / 60, camera);
    const current = visuals.corpsePosition(victim.id)!;
    expect(current.x).toBeGreaterThan(initial.x + .5);
    expect(current.y).toBeLessThan(initial.y);
    const rendered = new THREE.Matrix4();
    mesh.getMatrixAt(0, rendered);
    const torso = new THREE.Vector3().setFromMatrixPosition(rendered);
    expect(current.x).toBeCloseTo(torso.x, 5);
    expect(current.y).toBeCloseTo(torso.y, 5);
    expect(current.z).toBeCloseTo(torso.z, 5);
    current.x = -100;
    expect(visuals.corpsePosition(victim.id)!.x).toBeCloseTo(torso.x, 5);
    expect(victim.position).toEqual({ x: 20, y: 10, z: 20 });
  } finally { visuals.clear(); }
});

test('corpse focus selects the latest death for the owner and disappears after expiration or reset', () => {
  const { visuals, camera } = setup();
  const first = player(), second = player({ deaths: 1, position: { x: 30, y: 1, z: 20 } });
  try {
    visuals.death(death(first), undefined, 1);
    expect(visuals.corpsePosition(first.id)!.x).toBe(20);
    visuals.death(death(second), undefined, 2);
    expect(visuals.corpsePosition(first.id)!.x).toBe(30);
    expect(visuals.corpsePosition(999)).toBeNull();
    visuals.update([], -1, 14, camera);
    expect(visuals.corpsePosition(first.id)).toBeNull();
    visuals.death({ ...death(first), roundId: 2 }, undefined, 15);
    expect(visuals.corpsePosition(first.id)).not.toBeNull();
    visuals.setWorld(ground);
    expect(visuals.corpsePosition(first.id)).toBeNull();
    visuals.death({ ...death(first), roundId: 3 }, undefined, 16);
    expect(visuals.corpsePosition(first.id)).not.toBeNull();
    visuals.clear();
    expect(visuals.corpsePosition(first.id)).toBeNull();
  } finally { visuals.clear(); }
});

test('the corpse budget evicts the old camera focus without confusing surviving owners', () => {
  const { visuals } = setup();
  try {
    for (let id = 1; id <= 16; id++) visuals.death(death(player({ id })), undefined, 1);
    expect(visuals.corpsePosition(1)).not.toBeNull();
    expect(visuals.corpsePosition(16)).not.toBeNull();
    visuals.death(death(player({ id: 17, position: { x: 30, y: 1, z: 20 } })), undefined, 1);
    expect(visuals.corpsePosition(1)).toBeNull();
    expect(visuals.corpsePosition(2)!.x).toBe(20);
    expect(visuals.corpsePosition(16)!.x).toBe(20);
    expect(visuals.corpsePosition(17)!.x).toBe(30);
  } finally { visuals.clear(); }
});

test('older death events still produce a falling corpse from the available player state', () => {
  const { visuals, camera, mesh } = setup();
  const victim = player();
  const { death: _payload, ...event } = death(victim);
  visuals.update([victim], -1, 1, camera);
  visuals.death(event, victim, 1);
  visuals.update([victim], -1, 1, camera);
  expect(mesh.count).toBe(10);
  visuals.clear();
});

test.each(['ak47', 'awp'] as const)('%s subsequent shots use the reviewed fourfold impulse while the fatal hit stays fourfold', weapon => {
  const { visuals } = setup();
  const event = death(player({ yaw: 0, pitch: 0 }));
  event.death!.impulse = { x: weapon === 'awp' ? 80 : 48, y: 0, z: 0 };
  const shot: GameEvent = { type: 'event', event: 'shot', roundId: 1, tick: 61, projectileId: 2,
    weapon, position: { x: 20, y: 2.8, z: 24 }, endPosition: { x: 20, y: 2.8, z: 16 } };
  const original = structuredClone(shot);
  const spawn = spyOn(Ragdolls.prototype, 'spawn'), hit = spyOn(Ragdolls.prototype, 'hit');
  try {
    expect(visuals.shot({ ...shot, projectileId: 1 }, 1)).toBeNull();
    visuals.death(event, undefined, 1);
    expect(spawn.mock.calls[0][3]).toEqual(event.death!.impulse);
    // Replaying the fatal shot after the death must not add a second impulse.
    expect(visuals.shot({ ...shot, projectileId: 1 }, 1)).toBeNull();
    const point = visuals.shot(shot, 1);
    expect(point).not.toBeNull();
    expect(point!.z).toBeGreaterThan(20);
    expect(point!.y).toBeCloseTo(2.8);
    expect(hit.mock.calls.at(-1)![2]).toBe(weapon === 'awp' ? 80 : 48);
    expect(visuals.shot(shot, 1)).toBeNull();
    expect(hit).toHaveBeenCalledTimes(2);
    expect(shot).toEqual(original);
    visuals.setWorld(ground);
    visuals.death({ ...event, roundId: 2 }, undefined, 2);
    expect(visuals.shot({ ...shot, roundId: 2 }, 2)).not.toBeNull();
  } finally { spawn.mockRestore(); hit.mockRestore(); visuals.clear(); }
});

test('corpse reactions require a confirmed firearm segment and stop at its endpoint', () => {
  const { visuals } = setup();
  visuals.death(death(player({ yaw: 0, pitch: 0 })), undefined, 1);
  const shot: GameEvent = { type: 'event', event: 'shot', roundId: 1, tick: 61, projectileId: 1,
    weapon: 'ak47', position: { x: 20, y: 2.8, z: 24 }, endPosition: { x: 20, y: 2.8, z: 16 } };
  for (const change of [{ event: 'impact' }, { event: 'death' }, { weapon: 'shovel' }, { weapon: 'grenade' },
    { endPosition: undefined }, { projectileId: undefined }] as Partial<GameEvent>[]) {
    expect(visuals.shot({ ...shot, ...change }, 1)).toBeNull();
  }
  expect(visuals.shot({ ...shot, projectileId: 2, endPosition: { x: 20, y: 2.8, z: 21 } }, 1)).toBeNull();
  expect(visuals.shot(shot, 1)).not.toBeNull();
  expect(visuals.shot({ ...shot, projectileId: 3 }, 13)).toBeNull();
  visuals.clear();
});
