import { describe, expect, spyOn, test } from 'bun:test';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { parseWeaponModel } from '../src/client/weapon-model';
import { RocketVisuals } from '../src/client/rocket-visuals';
import { Effects } from '../src/client/presentation';
import { createParticleMaterial } from '../src/client/particle-material';
import type { GameEvent, ProjectileState } from '../src/shared/protocol';

const shot = (id = 1): GameEvent => ({ type: 'event', roundId: 1, event: 'shot', projectileId: id, tick: 10,
  weapon: 'rpg', shooterId: 7, position: { x: 0, y: 3, z: 0 }, velocity: { x: 30, y: 0, z: 0 } });
const state = (x = 0, id = 1): ProjectileState => ({ id, owner: 7, weapon: 'rpg',
  position: { x, y: 3, z: 0 }, velocity: { x: 30, y: 0, z: 0 } });

async function setup(capacity = 8, smokeCapacity = 2048) {
  const scene = new THREE.Scene();
  const visuals = new RocketVisuals(scene, 160, capacity, smokeCapacity, async () => parseWeaponModel(
    readFileSync('public/assets/weapons/rpg/RPG.obj', 'utf8'), readFileSync('public/assets/weapons/rpg/RPG.mtl', 'utf8')));
  await visuals.ready;
  const mesh = scene.getObjectByName('UBERCUBE rockets') as THREE.InstancedMesh;
  const smoke = scene.getObjectByName('UBERCUBE rocket smoke') as THREE.InstancedMesh;
  const matrix = (target = mesh, index = 0) => { const result = new THREE.Matrix4(); target.getMatrixAt(index, result); return result; };
  const position = (target = mesh, index = 0) => new THREE.Vector3().setFromMatrixPosition(matrix(target, index));
  return { scene, visuals, mesh, smoke, matrix, position };
}

describe('authoritative RPG visuals', () => {
  test('asset loading preserves pending authoritative flight and the most recent fog distance', async () => {
    let resolve!: (model: THREE.Group) => void;
    const scene = new THREE.Scene();
    const visuals = new RocketVisuals(scene, 160, 8, 2048, () => new Promise(done => { resolve = done; }));
    try {
      visuals.event(shot(), 1); visuals.update(1);
      expect(scene.getObjectByName('UBERCUBE rockets')).toBeUndefined();
      visuals.setFogDistance(320);
      resolve(parseWeaponModel(readFileSync('public/assets/weapons/rpg/RPG.obj', 'utf8'), readFileSync('public/assets/weapons/rpg/RPG.mtl', 'utf8')));
      await visuals.ready;
      visuals.update(1.1);
      const mesh = scene.getObjectByName('UBERCUBE rockets') as THREE.InstancedMesh;
      expect(mesh.count).toBe(1);
      const matrix = new THREE.Matrix4(); mesh.getMatrixAt(0, matrix);
      expect(matrix.elements[12]).toBeCloseTo(3, 5);
      expect((mesh.material as THREE.ShaderMaterial).uniforms.fogDistance.value).toBe(320);
    } finally { visuals.dispose(); }
  });

  test('disposal during model loading never adds a late projectile mesh', async () => {
    let resolve!: (model: THREE.Group) => void;
    const scene = new THREE.Scene();
    const visuals = new RocketVisuals(scene, 160, 8, 2048, () => new Promise(done => { resolve = done; }));
    visuals.dispose();
    resolve(parseWeaponModel(readFileSync('public/assets/weapons/rpg/RPG.obj', 'utf8'), readFileSync('public/assets/weapons/rpg/RPG.mtl', 'utf8')));
    await visuals.ready;
    expect(scene.children).toHaveLength(0);
  });

  test('flies the same green round as the loaded RPG, with its nose on the authoritative position', async () => {
    const { visuals, mesh, smoke, matrix, position } = await setup();
    try {
      visuals.event(shot(), 1); visuals.update(1);
      expect(mesh.count).toBe(1);
      mesh.geometry.computeBoundingBox();
      const bounds = mesh.geometry.boundingBox!.clone().applyMatrix4(matrix());
      const size = bounds.getSize(new THREE.Vector3());
      expect(size.x).toBeCloseTo(.75, 6);
      expect(bounds.max.x).toBeCloseTo(0, 6);
      expect(size.y).toBeGreaterThan(.19);
      expect(size.z).toBeGreaterThan(.19);
      const model = parseWeaponModel(readFileSync('public/assets/weapons/rpg/RPG.obj', 'utf8'), readFileSync('public/assets/weapons/rpg/RPG.mtl', 'utf8'));
      const loaded = model.getObjectByName('RPG_rocket') as THREE.Mesh;
      const expected = loaded.geometry.clone().translate(0, 1.6, 24).scale(2 / 16, 2 / 16, 2 / 16);
      expect(mesh.geometry.getAttribute('position').array).toEqual(expected.getAttribute('position').array);
      expect(mesh.geometry.getAttribute('color').array).toEqual(loaded.geometry.getAttribute('color').array);
      expect(mesh.geometry.getAttribute('normal').array).toEqual(expected.getAttribute('normal').array);
      expect(mesh.instanceColor).toBeNull();
      const rear = new THREE.Vector3(0, 0, mesh.geometry.boundingBox!.max.z).applyMatrix4(matrix());
      expect(position(smoke).distanceTo(rear)).toBeLessThan(1e-6);
      expect((mesh.material as THREE.Material).transparent).toBe(false);
      expect((mesh.material as THREE.Material).depthWrite).toBe(true);
    } finally { visuals.dispose(); }
  });

  test('moves continuously at the confirmed velocity between snapshots and ignores duplicate shots', async () => {
    const { visuals, mesh, position } = await setup();
    try {
      visuals.event(shot(), 1); visuals.update(1.02);
      expect(position().x).toBeCloseTo(.6, 5);
      visuals.event(shot(), 1.025); visuals.update(1.04);
      expect(position().x).toBeCloseTo(1.2, 5);
      visuals.snapshot([state(1.5)], 12, 1.05); visuals.update(1.075);
      expect(position().x).toBeCloseTo(2.25, 5);
      visuals.update(1.3);
      expect(mesh.count).toBe(1);
      expect(position().x).toBeCloseTo(9, 5);
      visuals.update(2.051);
      expect(mesh.count).toBe(0);
    } finally { visuals.dispose(); }
  });

  test('a remote launch starts at its rendered nose and smoothly rejoins the authoritative trajectory without restarting on snapshots', async () => {
    const { visuals, smoke, position } = await setup();
    try {
      visuals.event(shot(), 1, { x: 2, y: 3, z: 0 }); visuals.update(1);
      expect(position().toArray()).toEqual([2, 3, 0]);
      expect(position(smoke).distanceTo(new THREE.Vector3(1.25, 3, 0))).toBeLessThan(1e-6);
      visuals.update(1.05);
      expect(position().x).toBeCloseTo(2.5, 5);
      visuals.snapshot([state(1.5)], 12, 1.05); visuals.update(1.05);
      expect(position().x).toBeCloseTo(2.5, 5);
      visuals.event(shot(), 1.06, { x: -2, y: 3, z: 0 });
      visuals.update(1.1);
      expect(position().x).toBeCloseTo(3, 5);
      visuals.update(1.2);
      expect(position().x).toBeCloseTo(6, 5);
      visuals.clear(); visuals.snapshot([state(9)], 30, 2); visuals.update(2);
      expect(position().x).toBeCloseTo(9, 5);
    } finally { visuals.dispose(); }
  });

  test('unbounded or nonfinite cosmetic origins cannot move a confirmed projectile', async () => {
    for (const origin of [{ x: 4, y: 3, z: 0 }, { x: NaN, y: 3, z: 0 }, { x: 0, y: Infinity, z: 0 }]) {
      const { visuals, position } = await setup();
      try {
        visuals.event(shot(), 1, origin); visuals.update(1);
        expect(position().distanceTo(new THREE.Vector3(0, 3, 0))).toBeLessThan(1e-6);
      } finally { visuals.dispose(); }
    }
  });

  test('late arrivals render active snapshots, while old snapshots and delayed shots cannot rewind them', async () => {
    const { visuals, mesh, position } = await setup();
    try {
      visuals.snapshot([state(12)], 34, 1); visuals.update(1);
      expect(position().x).toBeCloseTo(12, 5);
      visuals.snapshot([state(1)], 12, 1.01);
      visuals.event(shot(), 1.01); visuals.update(1.02);
      expect(position().x).toBeCloseTo(12.6, 5);
      visuals.snapshot([], 37, 1.05); visuals.update(1.05);
      expect(mesh.count).toBe(0);
      visuals.event(shot(2), 1.06);
      visuals.snapshot([state(15)], 36, 1.06); visuals.update(1.06);
      expect(mesh.count).toBe(0);
    } finally { visuals.dispose(); }
  });

  test('each authoritative terminal event prevents both delayed shots and snapshots from reviving a rocket', async () => {
    for (const kind of ['impact', 'explosion', 'projectile-end'] as const) {
      for (const endFirst of [false, true]) {
        const { visuals, mesh } = await setup();
        try {
          const ended: GameEvent = { ...shot(), event: kind, tick: 13 };
          for (const event of endFirst ? [ended, shot()] : [shot(), ended]) visuals.event(event, 1);
          visuals.snapshot([state(1.5)], 12, 1.05); visuals.update(1.05);
          expect(mesh.count).toBe(0);
        } finally { visuals.dispose(); }
      }
    }
  });

  test('an old termination cannot erase newer authoritative flight state', async () => {
    const { visuals, mesh } = await setup();
    try {
      visuals.snapshot([state(10)], 30, 1);
      visuals.event({ ...shot(), event: 'projectile-end', tick: 20 }, 1);
      visuals.update(1.02);
      expect(mesh.count).toBe(1);
    } finally { visuals.dispose(); }
  });

  test('Java smoke emits ten cubes per tick, with the same opacity, color, scale and damped drift', async () => {
    const random = spyOn(Math, 'random').mockReturnValue(.5);
    const { visuals, smoke, matrix, position } = await setup();
    try {
      visuals.event(shot(), 1); visuals.update(1);
      expect(smoke.count).toBe(10);
      expect(new THREE.Vector3().setFromMatrixScale(matrix(smoke)).x).toBeCloseTo(.22, 6);
      expect(smoke.geometry.getAttribute('instanceOpacity').getX(0)).toBeCloseTo(.7, 6);
      const color = new THREE.Color(); smoke.getColorAt(0, color);
      expect(color.toArray()).toEqual([.5, .5, .5]);
      visuals.update(1 + 1 / 60);
      expect(smoke.count).toBe(20);
      expect(position(smoke).x).toBeCloseTo(-.75 - .95 * .8, 5);
      expect(position(smoke).y).toBeCloseTo(3 + .0008, 5);
      visuals.update(1 + 2 / 60);
      expect(position(smoke).x).toBeCloseTo(-.75 - .95 * (.8 + .64), 5);
      expect(position(smoke).y).toBeCloseTo(3 + .0008 + .00144, 5);
      visuals.setFogDistance(320);
      const material = smoke.material as THREE.ShaderMaterial;
      expect(material.transparent).toBe(true);
      expect(material.depthWrite).toBe(false);
      expect(material.uniforms.fogDistance.value).toBe(320);
    } finally { random.mockRestore(); visuals.dispose(); }
  });

  test('impact stops emission while the existing smoke lives out its remaining Java lifetime', async () => {
    const random = spyOn(Math, 'random').mockReturnValue(.5);
    const { visuals, mesh, smoke } = await setup();
    try {
      visuals.event(shot(), 1); visuals.update(1);
      visuals.event({ ...shot(), event: 'impact', tick: 11 }, 1.02);
      visuals.update(1.1);
      expect(mesh.count).toBe(0);
      expect(smoke.count).toBe(10);
      visuals.update(2.5); expect(smoke.count).toBe(10);
      visuals.update(1 + 100.5 / 60); expect(smoke.count).toBe(10);
      visuals.update(2.7); expect(smoke.count).toBe(0);
    } finally { random.mockRestore(); visuals.dispose(); }
  });

  test('smoke follows camera rotation each frame without changing emission storage, travel or expiry', async () => {
    const random = spyOn(Math, 'random').mockReturnValue(.5);
    const { visuals, smoke, position } = await setup();
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(-10, 3, 0); camera.lookAt(0, 3, 0);
    try {
      visuals.event(shot(), 1);
      visuals.event({ ...shot(2), position: { x: 10, y: 3, z: 0 } }, 1);
      visuals.update(1, camera);
      expect(smoke.count).toBe(20);
      expect(position(smoke).x).toBeCloseTo(9.25, 5);
      expect(position(smoke, 10).x).toBeCloseTo(-.75, 5);
      camera.rotation.y += Math.PI;
      visuals.update(1, camera);
      expect(position(smoke).x).toBeCloseTo(-.75, 5);
      expect(position(smoke, 10).x).toBeCloseTo(9.25, 5);
      visuals.update(1);
      expect(position(smoke).x).toBeCloseTo(-.75, 5);
      expect(position(smoke, 10).x).toBeCloseTo(9.25, 5);
      for (const id of [1, 2]) visuals.event({ ...shot(id), event: 'impact', tick: 11 }, 1);
      visuals.update(1 + 100.5 / 60, camera); expect(smoke.count).toBe(20);
      visuals.update(2.7, camera); expect(smoke.count).toBe(0);
    } finally { random.mockRestore(); visuals.dispose(); }
  });

  test('frame rates do not change projectile travel or smoke emission at equal times', async () => {
    const random = spyOn(Math, 'random').mockReturnValue(.5);
    const results: number[][] = [];
    try {
      for (const fps of [30, 60, 144]) {
        const { visuals, position, smoke } = await setup();
        try {
          visuals.event(shot(), 1);
          for (let frame = 0; frame <= fps / 2; frame++) visuals.update(1 + frame / fps);
          results.push([...position().toArray(), smoke.count, ...position(smoke).toArray()]);
        } finally { visuals.dispose(); }
      }
      for (const result of results.slice(1)) result.forEach((value, i) => expect(value).toBeCloseTo(results[0][i], 5));
    } finally { random.mockRestore(); }
  });

  test('capacity and inactivity bound visual work, and clear removes smoke and accepts reused round IDs', async () => {
    const { visuals, mesh, smoke, scene } = await setup(2, 24);
    try {
      for (let id = 1; id <= 20; id++) visuals.event(shot(id), 1);
      visuals.update(1.5);
      expect(mesh.count).toBe(2);
      expect(smoke.count).toBe(24);
      visuals.update(2.01); expect(mesh.count).toBe(0);
      visuals.update(6); expect(smoke.count).toBe(0);
      visuals.clear(); visuals.event(shot(), 7); visuals.update(7);
      expect(mesh.count).toBe(1); expect(smoke.count).toBe(10);
      visuals.clear();
      expect(mesh.count).toBe(0); expect(smoke.count).toBe(0);
      visuals.dispose();
      expect(scene.children.length).toBe(0);
      visuals.event(shot(), 8); visuals.update(8); expect(mesh.count).toBe(0);
    } finally { visuals.dispose(); }
  });

  test('ignores other weapons and malformed launch data', async () => {
    const { visuals, mesh, smoke } = await setup();
    try {
      visuals.event({ ...shot(), weapon: 'ak47' }, 1);
      visuals.event({ ...shot(), weapon: 'grenade' }, 1);
      visuals.event({ ...shot(), tick: undefined }, 1);
      visuals.event({ ...shot(), projectileId: undefined }, 1);
      visuals.event({ ...shot(), velocity: undefined }, 1);
      visuals.event({ ...shot(), position: { x: NaN, y: 0, z: 0 } }, 1);
      visuals.event({ ...shot(), velocity: { x: Infinity, y: 0, z: 0 } }, 1);
      visuals.event({ ...shot(), velocity: { x: 0, y: 0, z: 0 } }, 1);
      visuals.event(shot(), NaN);
      visuals.snapshot([{ ...state(), weapon: 'grenade' }], 12, 1);
      visuals.update(1.1);
      expect(mesh.count).toBe(0); expect(smoke.count).toBe(0);
    } finally { visuals.dispose(); }
  });

  test('Effects routes snapshots, termination and reset to rockets independently of hitscan', async () => {
    const scene = new THREE.Scene();
    const effects = new Effects(scene, 160,
      async () => new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), createParticleMaterial(160))),
      async () => parseWeaponModel(readFileSync('public/assets/weapons/rpg/RPG.obj', 'utf8'), readFileSync('public/assets/weapons/rpg/RPG.mtl', 'utf8')));
    await effects.ready;
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(-10, 3, 0); camera.lookAt(0, 3, 0);
    effects.snapshot([state(), state(10, 2)], 12, 1); effects.update(0, 1, camera);
    const rockets = scene.getObjectByName('UBERCUBE rockets') as THREE.InstancedMesh;
    const smoke = scene.getObjectByName('UBERCUBE rocket smoke') as THREE.InstancedMesh;
    const bullets = scene.getObjectByName('UBERCUBE bullets') as THREE.InstancedMesh;
    expect(rockets.count).toBe(2); expect(bullets.count).toBe(0); expect(smoke.count).toBeGreaterThan(0);
    const matrix = new THREE.Matrix4(); smoke.getMatrixAt(0, matrix);
    expect(matrix.elements[12]).toBeCloseTo(9.25, 5);
    for (const id of [1, 2]) effects.event({ ...shot(id), event: 'explosion', tick: 13 }, 1.02);
    effects.update(.01, 1.02, camera);
    expect(rockets.count).toBe(0); expect(smoke.count).toBeGreaterThan(0);
    effects.clear(); expect(smoke.count).toBe(0);
  });
});
