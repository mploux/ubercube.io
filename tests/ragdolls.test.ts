import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { Body, type World } from 'cannon-es';
import { Ragdolls } from '../src/client/ragdolls';
import type { RagdollPart } from '../src/client/ragdolls';
import { PlayerVisuals } from '../src/client/player-visuals';
import type { PlayerState } from '../src/shared/protocol';

const empty = { config: { seed: 1, size: 64, height: 64 }, get: () => 0 };
const floor = { ...empty, get: (_x: number, y: number, _z: number) => y === 0 ? 1 : 0 };
const zero = { x: 0, y: 0, z: 0 };
const center = (matrix: THREE.Matrix4, height: number) => new THREE.Vector3(0, height / 2, 0).applyMatrix4(matrix);
const box = (x = 16, y = 10, z = 16, size: RagdollPart['size'] = [1, 1, 1]): RagdollPart => ({
  parent: -1, size, matrix: new THREE.Matrix4().makeTranslation(x, y, z),
});
const advance = (ragdolls: Ragdolls, seconds: number, start = 0) => {
  for (let step = 1; step <= Math.round(seconds * 120); step++) ragdolls.update(1 / 120, start + step / 120);
};

function movingSkeleton(): RagdollPart[] {
  const player: PlayerState = {
    id: 1, name: 'Ragdoll', team: 1, kit: 'assault', weapon: 'ak47', aiming: true,
    position: { x: 16, y: 10, z: 16 }, velocity: { x: 6, y: 0, z: 0 }, yaw: .8, pitch: .6,
    grounded: false, alive: true, health: 100, kills: 0, deaths: 0, ammo: 30, grenades: 10, lastSeq: 0,
  };
  const scene = new THREE.Scene(), visuals = new PlayerVisuals(scene, 160, async () => new THREE.Group());
  visuals.update([player], -1, .75, new THREE.PerspectiveCamera());
  const mesh = scene.getObjectByName('UBERCUBE articulated bodies') as THREE.InstancedMesh;
  return [-1, 0, 0, 2, 0, 4, 0, 6, 0, 8].map((parent, i) => {
    const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
    mesh.getMatrixAt(i, matrix);
    matrix.decompose(position, rotation, scale);
    return { parent, size: scale.toArray() as [number, number, number], matrix: matrix.compose(position, rotation, new THREE.Vector3(1, 1, 1)) };
  });
}

test('opposite bullet impulses push the corpse in opposite directions while retaining movement and gravity', () => {
  for (const direction of [-1, 1]) {
    const ragdolls = new Ragdolls(empty);
    ragdolls.spawn([box()], { x: 0, y: 0, z: 3 }, { x: 16, y: 10.5, z: 16 }, { x: direction * 12, y: 0, z: 0 }, 0);
    advance(ragdolls, .2);
    const position = center(ragdolls.poses[0][0], 1);
    expect((position.x - 16) * direction).toBeGreaterThan(.35);
    expect(position.z).toBeGreaterThan(16.5);
    expect(position.y).toBeLessThan(10.1);
  }
});

test('the contact offset produces torque with the correct sign and a centered hit does not invent spin', () => {
  const rotations: number[] = [];
  for (const offset of [-.4, 0, .4]) {
    const ragdolls = new Ragdolls(empty);
    ragdolls.spawn([box()], zero, { x: 16 + offset, y: 10.5, z: 16 }, { x: 0, y: 0, z: 12 }, 0);
    advance(ragdolls, .1);
    rotations.push(new THREE.Vector3(0, 0, 1).transformDirection(ragdolls.poses[0][0]).x);
  }
  expect(rotations[0]).toBeGreaterThan(.1);
  expect(rotations[1]).toBeCloseTo(0, 8);
  expect(rotations[2]).toBeLessThan(-.1);
});

test('hit selection uses the oriented surface rather than the nearest body center', () => {
  const ragdolls = new Ragdolls(empty);
  const long = box(16, 10, 16, [1, 8, 1]);
  long.matrix.premultiply(new THREE.Matrix4().makeRotationY(.8));
  const hit = new THREE.Vector3(.5, 7.5, 0).applyMatrix4(long.matrix);
  const neighbor = box(hit.x + 1, hit.y - .5, hit.z);
  expect(center(long.matrix, 8).distanceTo(hit)).toBeGreaterThan(center(neighbor.matrix, 1).distanceTo(hit));
  ragdolls.spawn([long, neighbor], zero, hit, { x: 0, y: 0, z: 12 }, 0);
  advance(ragdolls, .025);
  expect(center(ragdolls.poses[0][0], 8).z - center(long.matrix, 8).z).toBeGreaterThan(.02);
  expect(center(ragdolls.poses[0][1], 1).z).toBeCloseTo(hit.z, 8);
});

test('the displayed aiming pose survives conversion and its initial twist causes no artificial kick', () => {
  const parts = movingSkeleton(), ragdolls = new Ragdolls(empty);
  ragdolls.spawn(parts, zero, { x: 16, y: 12, z: 16 }, zero, 0);
  for (let i = 0; i < parts.length; i++) expect(ragdolls.poses[0][i].equals(parts[i].matrix)).toBe(true);
  advance(ragdolls, .05);
  for (let i = 0; i < parts.length; i++) {
    const initial = new THREE.Quaternion().setFromRotationMatrix(parts[i].matrix);
    const actual = new THREE.Quaternion().setFromRotationMatrix(ragdolls.poses[0][i]);
    expect(initial.angleTo(actual)).toBeLessThan(.001);
  }
});

test('all nine joints keep their pivots attached during a localized head impact', () => {
  const parts = movingSkeleton(), ragdolls = new Ragdolls(empty);
  const pivots = parts.map(part => part.parent < 0 ? null
    : new THREE.Vector3().setFromMatrixPosition(part.matrix).applyMatrix4(parts[part.parent].matrix.clone().invert()));
  ragdolls.spawn(parts, { x: 3, y: 0, z: 0 }, center(parts[1].matrix, parts[1].size[1]), { x: 0, y: 0, z: 20 }, 0);
  for (let step = 1; step <= 120; step++) {
    ragdolls.update(1 / 120, step / 120);
    for (let i = 1; i < parts.length; i++) {
      const parentPoint = pivots[i]!.clone().applyMatrix4(ragdolls.poses[0][parts[i].parent]);
      const childPoint = new THREE.Vector3().setFromMatrixPosition(ragdolls.poses[0][i]);
      expect(parentPoint.distanceTo(childPoint)).toBeLessThan(.025);
    }
  }
});

test('a falling corpse contacts actual voxel ground and comes to rest above it', () => {
  const ragdolls = new Ragdolls(floor);
  ragdolls.spawn([box(16, 5, 16)], zero, { x: 16, y: 5.5, z: 16 }, zero, 0);
  advance(ragdolls, 3);
  const settled = center(ragdolls.poses[0][0], 1);
  expect(settled.y).toBeGreaterThan(1.48);
  expect(settled.y).toBeLessThan(1.52);
  advance(ragdolls, 1, 3);
  expect(center(ragdolls.poses[0][0], 1).distanceTo(settled)).toBeLessThan(.001);
});

test('the full moving skeleton falls under impact and settles without tunneling or detached joints', () => {
  const ragdolls = new Ragdolls(floor), parts = movingSkeleton();
  ragdolls.spawn(parts, { x: 3, y: 0, z: 0 }, center(parts[1].matrix, parts[1].size[1]), { x: 0, y: 0, z: 20 }, 0);
  advance(ragdolls, 6);
  for (let i = 0; i < parts.length; i++) {
    for (const x of [-.5, .5]) for (const y of [0, 1]) for (const z of [-.5, .5]) {
      const corner = new THREE.Vector3(x * parts[i].size[0], y * parts[i].size[1], z * parts[i].size[2]).applyMatrix4(ragdolls.poses[0][i]);
      expect(corner.y).toBeGreaterThan(.97);
      expect(corner.y).toBeLessThan(4);
    }
    if (parts[i].parent < 0) continue;
    const anchor = new THREE.Vector3().setFromMatrixPosition(parts[i].matrix).applyMatrix4(parts[parts[i].parent].matrix.clone().invert());
    const parentPoint = anchor.applyMatrix4(ragdolls.poses[0][parts[i].parent]);
    expect(parentPoint.distanceTo(new THREE.Vector3().setFromMatrixPosition(ragdolls.poses[0][i]))).toBeLessThan(.025);
  }
});

test('corpse budget, expiration and round reset remove their rigid bodies and joints', () => {
  const ragdolls = new Ragdolls(empty, 2);
  for (let i = 0; i < 3; i++) ragdolls.spawn([box(8 + i * 4)], zero, { x: 8 + i * 4, y: 10.5, z: 16 }, zero, i * .2);
  expect(ragdolls.poses).toHaveLength(2);
  expect(center(ragdolls.poses[0][0], 1).x).toBe(12);
  ragdolls.update(0, 12.3);
  expect(ragdolls.poses).toHaveLength(1);
  ragdolls.update(0, 12.5);
  expect(ragdolls.poses).toHaveLength(0);
  ragdolls.spawn(movingSkeleton(), zero, { x: 16, y: 12, z: 16 }, zero, 13);
  const physics = (ragdolls as unknown as { physics: World }).physics;
  expect(physics.bodies).toHaveLength(10);
  expect(physics.constraints).toHaveLength(9);
  ragdolls.clear();
  expect(physics.bodies).toHaveLength(0);
  expect(physics.constraints).toHaveLength(0);
  expect(ragdolls.poses).toHaveLength(0);
});

test('a later shot hits only the first intersected limb across all corpses', () => {
  const ragdolls = new Ragdolls(empty);
  ragdolls.spawn([box(16, 10, 21)], zero, zero, zero, 0);
  ragdolls.spawn([box(16, 10, 18), box(16, 10, 15)], zero, zero, zero, 0);
  const hit = ragdolls.hit({ x: 16, y: 10.5, z: 10 }, { x: 16, y: 10.5, z: 30 }, 12, .1);
  expect(hit).toEqual({ x: 16, y: 10.5, z: 14.5 });
  const bodies = (ragdolls as unknown as { physics: World }).physics.bodies;
  expect(bodies[0].velocity.length()).toBe(0);
  expect(bodies[1].velocity.length()).toBe(0);
  expect(bodies[2].velocity.x).toBe(0);
  expect(bodies[2].velocity.y).toBe(0);
  expect(bodies[2].velocity.z).toBeCloseTo(12 / bodies[2].mass, 8);
});

test('later shots use oriented surfaces and stop at the confirmed segment endpoint', () => {
  const ragdolls = new Ragdolls(empty), part = box(16, 10, 16, [4, 1, .2]);
  part.matrix.makeRotationY(Math.PI / 4).setPosition(16, 10, 16);
  ragdolls.spawn([part], zero, zero, zero, 0);
  const origin = new THREE.Vector3(0, .5, -3).applyMatrix4(part.matrix);
  const beforeSurface = new THREE.Vector3(0, .5, -.11).applyMatrix4(part.matrix);
  expect(ragdolls.hit(origin, beforeSurface, 12, .1)).toBeNull();
  expect(ragdolls.hit({ x: 17.2, y: 12, z: 17.2 }, { x: 17.2, y: 9, z: 17.2 }, 12, .1)).toBeNull();
  expect(ragdolls.hit(origin, origin.clone().add(new THREE.Vector3(0, 0, -1)), 12, .1)).toBeNull();
  const end = new THREE.Vector3(0, .5, 3).applyMatrix4(part.matrix);
  const hit = ragdolls.hit(origin, end, 12, .1);
  const expected = new THREE.Vector3(0, .5, -.1).applyMatrix4(part.matrix);
  expect(hit).not.toBeNull();
  expect(new THREE.Vector3(hit!.x, hit!.y, hit!.z).distanceTo(expected)).toBeLessThan(1e-8);
});

test('later impacts retain bullet direction and create torque only from the hit offset', () => {
  for (const direction of [-1, 1]) for (const offset of [-.4, 0, .4]) {
    const ragdolls = new Ragdolls(empty);
    ragdolls.spawn([box()], zero, zero, zero, 0);
    ragdolls.hit({ x: 16 + offset, y: 10.5, z: 16 - direction * 3 }, { x: 16 + offset, y: 10.5, z: 16 + direction * 3 }, 12, .1);
    const body = (ragdolls as unknown as { physics: World }).physics.bodies[0];
    expect(body.velocity.z).toBeCloseTo(direction * 2, 8);
    if (offset === 0) expect(body.angularVelocity.length()).toBeCloseTo(0, 8);
    else expect(body.angularVelocity.y * offset * direction).toBeLessThan(0);
  }
});

test('a muzzle inside a limb hits it even when the confirmed segment ends inside', () => {
  const ragdolls = new Ragdolls(empty);
  ragdolls.spawn([box()], zero, zero, zero, 0);
  const origin = { x: 16, y: 10.5, z: 16 };
  expect(ragdolls.hit(origin, { ...origin, z: 16.1 }, 12, .1)).toEqual(origin);
  const body = (ragdolls as unknown as { physics: World }).physics.bodies[0];
  expect(body.velocity.z).toBeCloseTo(2, 8);
  expect(body.angularVelocity.length()).toBeCloseTo(0, 8);
});

test('a later hit wakes every member of a sleeping corpse and preserves its joints', () => {
  const ragdolls = new Ragdolls(floor), parts = movingSkeleton();
  ragdolls.spawn(parts, zero, zero, zero, 0);
  advance(ragdolls, 6);
  const physics = (ragdolls as unknown as { physics: World }).physics;
  const bodies = physics.bodies.filter(body => body.mass > 0);
  for (const body of bodies) body.sleep();
  expect(bodies.every(body => body.sleepState === Body.SLEEPING)).toBe(true);
  const point = center(ragdolls.poses[0][0], parts[0].size[1]);
  const hit = ragdolls.hit(point.clone().add(new THREE.Vector3(0, 5, 0)), point.clone().add(new THREE.Vector3(0, -5, 0)), 12, 6);
  expect(hit).not.toBeNull();
  expect(bodies.every(body => body.sleepState === Body.AWAKE)).toBe(true);
  expect(physics.constraints).toHaveLength(9);
});

test('interpolated hit detection maps the visible contact onto the current physics body', () => {
  const ragdolls = new Ragdolls(empty);
  ragdolls.spawn([box()], { x: 120, y: 0, z: 0 }, zero, zero, 0);
  ragdolls.update(1 / 120, 1 / 120);
  const pose = ragdolls.poses[0][0], point = center(pose, 1);
  const body = (ragdolls as unknown as { physics: World }).physics.bodies[0];
  expect(body.position.x - point.x).toBeGreaterThan(.9);
  const hit = ragdolls.hit(point.clone().add(new THREE.Vector3(0, 0, -3)), point.clone().add(new THREE.Vector3(0, 0, 3)), 12, .01);
  expect(hit).toEqual({ x: point.x, y: point.y, z: point.z - .5 });
  expect(body.velocity.z).toBeCloseTo(2, 8);
  expect(body.angularVelocity.length()).toBeCloseTo(0, 8);
});

test('invalid shots, expired corpses and reset cannot receive an impulse or extend lifetime', () => {
  const ragdolls = new Ragdolls(empty);
  ragdolls.spawn([box()], zero, zero, zero, 0);
  const origin = { x: 16, y: 10.5, z: 10 }, end = { x: 16, y: 10.5, z: 20 };
  expect(ragdolls.hit(origin, origin, 12, 1)).toBeNull();
  expect(ragdolls.hit({ ...origin, x: NaN }, end, 12, 1)).toBeNull();
  expect(ragdolls.hit(origin, { ...end, z: Infinity }, 12, 1)).toBeNull();
  for (const strength of [0, -12, NaN, Infinity]) expect(ragdolls.hit(origin, end, strength, 1)).toBeNull();
  expect(ragdolls.hit(origin, end, 12, NaN)).toBeNull();
  expect((ragdolls as unknown as { physics: World }).physics.bodies[0].velocity.length()).toBe(0);
  expect(ragdolls.hit(origin, end, 12, 11.99)).not.toBeNull();
  expect(ragdolls.hit(origin, end, 12, 12)).toBeNull();
  ragdolls.update(0, 12);
  expect(ragdolls.poses).toHaveLength(0);
  ragdolls.spawn([box()], zero, zero, zero, 12);
  ragdolls.clear();
  expect(ragdolls.hit(origin, end, 12, 12)).toBeNull();
});
