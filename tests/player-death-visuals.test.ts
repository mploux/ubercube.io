import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { PlayerVisuals } from '../src/client/player-visuals';
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
