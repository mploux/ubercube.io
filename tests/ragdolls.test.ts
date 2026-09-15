import { expect, test } from 'bun:test';
import * as THREE from 'three';
import type { World } from 'cannon-es';
import { Ragdolls } from '../src/client/ragdolls';
import type { RagdollPart } from '../src/client/ragdolls';
import { PlayerVisuals } from '../src/client/player-visuals';
import type { RemotePlayerState } from '../src/shared/protocol';

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
  const player: RemotePlayerState = {
    id: 1, name: 'Ragdoll', team: 1, weapon: 'ak47', aiming: true,
    position: { x: 16, y: 10, z: 16 }, velocity: { x: 6, z: 0 }, yaw: .8, pitch: .6,
    alive: true, kills: 0, deaths: 0, hasGrenades: true,
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
