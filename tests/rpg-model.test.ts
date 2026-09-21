import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createRpgModel } from '../scripts/model-rpg';
import { parseWeaponModel } from '../src/client/weapon-model';
import { WEAPON_POSES } from '../src/shared/weapon-pose';

const path = 'public/assets/weapons/rpg/';
const obj = readFileSync(`${path}RPG.obj`, 'utf8'), mtl = readFileSync(`${path}RPG.mtl`, 'utf8');

test('the authored RPG asset can be regenerated without external modeling dependencies', () => {
  expect(createRpgModel()).toEqual({ obj, mtl });
});

test('the RPG nose matches the launch point without recentering the approved model', () => {
  const model = parseWeaponModel(obj, mtl);
  const bounds = new THREE.Box3().setFromObject(model);
  expect(bounds.min.z).toBe(WEAPON_POSES.rpg.muzzle!.z);
  const nose = new THREE.Box3();
  let volume = 0;
  model.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const position = object.geometry.getAttribute('position');
    for (let index = 0; index < position.count; index += 3) {
      const a = new THREE.Vector3().fromBufferAttribute(position, index);
      const b = new THREE.Vector3().fromBufferAttribute(position, index + 1);
      const c = new THREE.Vector3().fromBufferAttribute(position, index + 2);
      volume += a.dot(b.clone().cross(c)) / 6;
      for (const point of [a, b, c]) if (point.z === bounds.min.z) nose.expandByPoint(point);
    }
    object.geometry.dispose();
    (object.material as THREE.Material).dispose();
  });
  const center = nose.getCenter(new THREE.Vector3());
  expect(center.x).toBe(WEAPON_POSES.rpg.muzzle!.x);
  expect(center.y).toBeCloseTo(WEAPON_POSES.rpg.muzzle!.y, 6);
  expect(volume).toBeGreaterThan(0);
});

test('the original loaded round is independently removable and the optic has an unobstructed transparent bore', () => {
  const model = parseWeaponModel(obj, mtl);
  const rocket = model.getObjectByName('RPG_rocket') as THREE.Mesh;
  expect(rocket).toBeInstanceOf(THREE.Mesh);
  expect(rocket.geometry.getAttribute('position').count / 3).toBe(280);
  const bounds = new THREE.Box3().setFromObject(rocket);
  expect(bounds.min.z).toBe(-24);
  expect(bounds.max.z).toBe(-18);
  const lens = model.getObjectByName('RPG_lens') as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  expect(lens.material.transparent).toBe(true);
  expect(lens.material.depthWrite).toBe(false);
  expect(lens.material.uniforms.weaponOpacity.value).toBe(.12);
  model.updateMatrixWorld(true);
  for (const [x, y] of [[-.72, -.44], [-.82, -.44], [-.62, -.44], [-.72, -.54], [-.72, -.34]]) {
    const ray = new THREE.Raycaster(new THREE.Vector3(x, y, -5), new THREE.Vector3(0, 0, -1), 0, 10);
    const hits = ray.intersectObject(model, true);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(hit => hit.object === lens)).toBe(true);
  }
  const rim = new THREE.Raycaster(new THREE.Vector3(-.72, -.13, -5), new THREE.Vector3(0, 0, -1));
  expect(rim.intersectObject(model, true).some(hit => hit.object !== lens)).toBe(true);
  model.remove(rocket);
  expect(new THREE.Box3().setFromObject(model).min.z).toBeCloseTo(-18.1, 5);
});

test('RPG uses faceted normals and the same unbaked palette shader as the AK and AWP', () => {
  const model = parseWeaponModel(obj, mtl);
  let oblique = 0;
  model.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const normals = object.geometry.getAttribute('normal');
    for (let index = 0; index < normals.count; index++) {
      const normal = new THREE.Vector3().fromBufferAttribute(normals, index);
      expect(normal.length()).toBeCloseTo(1, 5);
      if (Math.max(Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)) < .99) oblique++;
    }
    expect(object.geometry.getAttribute('color').count).toBe(object.geometry.getAttribute('position').count);
    object.geometry.dispose(); (object.material as THREE.Material).dispose();
  });
  expect(oblique).toBeGreaterThan(100);
  const ak = parseWeaponModel(readFileSync('public/assets/weapons/ak47/AK47.obj', 'utf8'), readFileSync('public/assets/weapons/ak47/AK47.mtl', 'utf8'));
  const material = (model.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;
  expect(material.fragmentShader).toBe(((ak.children[0] as THREE.Mesh).material as THREE.ShaderMaterial).fragmentShader);
  expect(mtl).toContain('Kd 0.25 0.09 0.03');
  ak.traverse(object => { if (object instanceof THREE.Mesh) { object.geometry.dispose(); (object.material as THREE.Material).dispose(); } });
});
