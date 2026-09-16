import { expect, spyOn, test } from 'bun:test';
import * as THREE from 'three';
import { PlayerVisuals } from '../src/client/player-visuals';
import { Ragdolls } from '../src/client/ragdolls';
import type { GameEvent, RemotePlayerState } from '../src/shared/protocol';

const player = (overrides: Partial<RemotePlayerState> = {}): RemotePlayerState => ({
  sampleTick: 0, sampleInterval: 3,
  id: 1, name: '', team: 1, weapon: 'ak47', aiming: true,
  position: { x: 20, y: 1, z: 20 }, velocity: { x: 0, z: 0 }, yaw: .7, pitch: .3,
  alive: true, kills: 0, deaths: 0, hasGrenades: true, ...overrides,
});
const death = (victim: RemotePlayerState): GameEvent => ({
  type: 'event', event: 'death', roundId: 1, tick: 60, targetId: victim.id,
  position: { ...victim.position }, weapon: 'ak47',
  death: { player: { id: victim.id, weapon: victim.weapon, aiming: victim.aiming,
    position: { ...victim.position }, velocity: { x: 4, y: 7, z: -2 }, yaw: victim.yaw, pitch: victim.pitch,
    alive: false, deaths: victim.deaths + 1 },
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
  const displayed = player({ velocity: { x: 4, z: 0 } });
  visuals.update([displayed], -1, 1, camera);
  const before = Array.from(mesh.instanceMatrix.array.slice(0, 160));
  const authoritative = player({ position: { x: 20.4, y: 1, z: 20 }, yaw: .8 });
  const event = death(authoritative);
  visuals.death(event, 1);
  visuals.update([displayed], -1, 1, camera);
  expect(mesh.count).toBe(10);
  Array.from(mesh.instanceMatrix.array.slice(0, 160)).forEach((value, i) => expect(value).toBeCloseTo(before[i], 5));
  visuals.death(event, 1);
  visuals.update([player({ alive: false, deaths: 1 })], -1, 1, camera);
  expect(mesh.count).toBe(10);
  visuals.clear();
});

test('respawning the same player leaves their corpse and a repeated old death does not remove the new life', () => {
  const { visuals, camera, mesh } = setup();
  const victim = player(), event = death(victim);
  visuals.update([victim], -1, 1, camera);
  visuals.death(event, 1);
  const respawned = player({ deaths: 1, position: { x: 30, y: 1, z: 20 } });
  visuals.update([respawned], -1, 1, camera);
  expect(mesh.count).toBe(20);
  visuals.death(event, 1);
  visuals.update([respawned], -1, 1, camera);
  expect(mesh.count).toBe(20);
  const transform = new THREE.Matrix4(); mesh.getMatrixAt(0, transform);
  expect(new THREE.Vector3().setFromMatrixPosition(transform).x).toBe(30);
  visuals.clear();
});

test('a death before any rendered snapshot has a complete pose, including the local player corpse', () => {
  const { visuals, camera, mesh } = setup();
  const event = death(player());
  visuals.death(event, 1);
  visuals.update([player({ alive: false, deaths: 1 })], 1, 1, camera);
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
  visuals.death(event, 1);
  visuals.update([player({ alive: false, deaths: 1 })], -1, 1, camera);
  expect(mesh.count).toBe(10);
  visuals.setWorld(ground);
  expect(mesh.count).toBe(0);
  visuals.death({ ...event, roundId: 2 }, 2);
  visuals.update([player({ alive: false, deaths: 1 })], -1, 2, camera);
  expect(mesh.count).toBe(10);
  visuals.clear();
  expect(mesh.count).toBe(0);
});

test('death without its authoritative fatal pose is ignored without consuming the death generation', () => {
  const { visuals, camera, mesh } = setup();
  const victim = player();
  const { death: _payload, ...event } = death(victim);
  visuals.update([victim], -1, 1, camera);
  visuals.death(event, 1);
  visuals.update([player({ alive: false, deaths: 1 })], -1, 1, camera);
  expect(mesh.count).toBe(0);
  visuals.death(death(victim), 1);
  visuals.update([player({ alive: false, deaths: 1 })], -1, 1, camera);
  expect(mesh.count).toBe(10);
  visuals.clear();
});

test('fatal vertical momentum, localized hit and directional impulse reach physics unchanged', () => {
  const { visuals } = setup();
  const spawn = spyOn(Ragdolls.prototype, 'spawn');
  const event = death(player());
  const original = structuredClone(event);
  try {
    visuals.death(event, 1);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [, velocity, hitPoint, impulse] = spawn.mock.calls[0];
    expect(velocity).toEqual({ x: 4, y: 7, z: -2 });
    expect(hitPoint).toEqual(new THREE.Vector3(20, 3.6, 20));
    expect(impulse).toEqual({ x: 12, y: 0, z: 0 });
    expect(event).toEqual(original);
  } finally { spawn.mockRestore(); visuals.clear(); }
});
