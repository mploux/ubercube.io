import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { PlayerVisuals } from '../src/client/player-visuals';
import { parseWeaponModel, WEAPON_MODEL_FILES } from '../src/client/weapon-model';
import type { PlayerState, WeaponId } from '../src/shared/protocol';

const player = (overrides: Partial<PlayerState> = {}): PlayerState => ({
  id: 1, name: 'Reference', team: 1, kit: 'assault', weapon: 'ak47', aiming: false,
  position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0,
  grounded: true, alive: true, health: 100, kills: 0, deaths: 0, ammo: 30, grenades: 10, lastSeq: 0, ...overrides,
});
const camera = new THREE.PerspectiveCamera();
const emptyLoader = async () => new THREE.Group();
const realLoader = async (weapon: WeaponId) => {
  const path = `public/assets/weapons/${WEAPON_MODEL_FILES[weapon]}`;
  return parseWeaponModel(readFileSync(`${path}.obj`, 'utf8'), readFileSync(`${path}.mtl`, 'utf8'));
};
const bodies = (scene: THREE.Scene) => scene.getObjectByName('UBERCUBE articulated bodies') as THREE.InstancedMesh;
const matrix = (mesh: THREE.InstancedMesh, index: number) => {
  const result = new THREE.Matrix4(); mesh.getMatrixAt(index, result); return result;
};
const point = (mesh: THREE.InstancedMesh, index: number, x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z).applyMatrix4(matrix(mesh, index));

test('the active Java player is ten articulated cuboids, with the original dimensions and raw palette in both teams and FFA', () => {
  const scene = new THREE.Scene(), visuals = new PlayerVisuals(scene, 160, emptyLoader);
  visuals.update([player(), player({ id: 2, team: 2 }), player({ id: 3, team: 0 })], -1, 0, camera);
  const mesh = bodies(scene);
  expect(mesh.count).toBe(30);
  const dimensions = [[.65, 1.1, .3], [.5, .5, .5], [.25, .5, .25], [.2, .5, .2], [.25, .5, .25], [.2, .5, .2], [.3, .65, .3], [.3, .65, .3], [.3, .65, .3], [.3, .65, .3]];
  const palette = [[6, 46, 6], [208, 164, 134], [3, 34, 3], [208, 164, 134], [3, 34, 3], [208, 164, 134], [3, 34, 3], [3, 34, 3], [3, 34, 3], [3, 34, 3]];
  for (let i = 0; i < 30; i++) {
    const scale = new THREE.Vector3().setFromMatrixScale(matrix(mesh, i));
    scale.toArray().forEach((value, axis) => expect(value).toBeCloseTo(dimensions[i % 10][axis], 6));
    const color = new THREE.Color(); mesh.getColorAt(i, color);
    color.toArray().forEach((value, channel) => expect(value).toBeCloseTo(palette[i % 10][channel] / 255, 6));
    expect(matrix(mesh, i).determinant()).toBeGreaterThan(0);
  }
  expect(point(mesh, 0).y).toBeCloseTo(1.25, 6);
  expect(point(mesh, 1).y).toBeCloseTo(2.4, 6);
  expect(point(mesh, 1, 0, 1).y).toBeCloseTo(2.9, 6);
  const positions = mesh.geometry.getAttribute('position'), normals = mesh.geometry.getAttribute('normal'), shade = mesh.geometry.getAttribute('legacyShade');
  for (let i = 0; i < positions.count; i++) {
    expect(positions.getY(i)).toBeOneOf([0, 1]);
    const expected = normals.getY(i) > 0 ? 1 : normals.getY(i) < 0 ? .6 : normals.getX(i) ? .7 : .8;
    expect(shade.getX(i)).toBeCloseTo(expected, 6);
  }
});

test.each(['ak47', 'awp', 'shovel', 'grenade', 'medic'] as const)('%s elbows and knees remain attached while moving, looking and aiming', weapon => {
  const scene = new THREE.Scene(), visuals = new PlayerVisuals(scene, 160, emptyLoader);
  for (const aiming of [false, true]) {
    visuals.update([player({ weapon, aiming, yaw: .8, pitch: .6, velocity: { x: 6, y: 12, z: 0 } })], -1, .75, camera);
    const mesh = bodies(scene);
    for (const [parent, child] of [[2, 3], [4, 5], [6, 7], [8, 9]]) {
      expect(point(mesh, parent, 0, 1).distanceTo(point(mesh, child))).toBeLessThan(.000001);
    }
  }
});

test('the head follows Java sin(pitch) × 90 and rotates around its neck without pitching the torso', () => {
  const scene = new THREE.Scene(), visuals = new PlayerVisuals(scene, 160, emptyLoader);
  visuals.update([player({ pitch: Math.PI / 6 })], -1, 0, camera);
  const mesh = bodies(scene);
  expect(point(mesh, 0, 0, 1).y).toBeCloseTo(2.35, 6);
  expect(point(mesh, 1).y).toBeCloseTo(2.4, 6);
  const tip = point(mesh, 1, 0, 1);
  expect(tip.y).toBeCloseTo(2.4 + .5 * Math.SQRT1_2, 6);
  expect(tip.z).toBeCloseTo(.5 * Math.SQRT1_2, 6);
});

test('animation depends on elapsed time, not render rate, entity count, input order or stale positions', () => {
  const scene = new THREE.Scene(), visuals = new PlayerVisuals(scene, 160, emptyLoader);
  const moving = player({ velocity: { x: 0, y: 0, z: -9 } });
  visuals.update([moving], -1, 1, camera);
  const first = Array.from(bodies(scene).instanceMatrix.array.slice(0, 160));
  for (let i = 0; i < 100; i++) visuals.update([moving, player({ id: 2 })], -1, 1, camera);
  expect(Array.from(bodies(scene).instanceMatrix.array.slice(0, 160))).toEqual(first);
  moving.position = { x: 200, y: 42, z: -60 };
  visuals.update([moving], -1, 1, camera);
  expect(point(bodies(scene), 0).toArray()).toEqual([200, 43.25, -60]);
  const beforeJump = Array.from(bodies(scene).instanceMatrix.array.slice(0, 160));
  moving.grounded = false; moving.velocity.y = 12;
  visuals.update([moving], -1, 1, camera);
  expect(Array.from(bodies(scene).instanceMatrix.array.slice(0, 160))).toEqual(beforeJump);
});

test('ADS changes both firearm arms and head pitch survives a weapon change; tools do not invent an ADS pose', () => {
  const scene = new THREE.Scene(), visuals = new PlayerVisuals(scene, 160, emptyLoader);
  visuals.update([player()], -1, 0, camera);
  const hipfire = matrix(bodies(scene), 4).clone();
  visuals.update([player({ aiming: true })], -1, 0, camera);
  expect(matrix(bodies(scene), 4).equals(hipfire)).toBe(false);
  visuals.update([player({ weapon: 'shovel' })], -1, 0, camera);
  const tool = Array.from(bodies(scene).instanceMatrix.array.slice(0, 160));
  visuals.update([player({ weapon: 'shovel', aiming: true })], -1, 0, camera);
  expect(Array.from(bodies(scene).instanceMatrix.array.slice(0, 160))).toEqual(tool);
});

test('the moving ADS skeleton matches matrices emitted by the compiled original Java classes', () => {
  // PlayerSkeleton + Bone + Quat + Mat4, frame 60, pvel .6, pitch .6, yaw -.7 in Java coordinates.
  const java = [
    [.4971474,0,.41874146,0,0,1.1,0,0,-.1932653,0,.22945267,0,0,1.25,0,1],
    [.3824211,0,.32210883,0,.2496798,.31589407,-.29643032,0,-.20350453,.38757056,.24160911,0,0,2.4,0,1],
    [.16033883,-9.313226e-10,.19181101,0,-.2200677,.40954763,.18395919,0,-.15711148,-.14341441,.13133277,0,-.26769477,2.25,-.22547618,1],
    [-.07423794,-.10781238,.15121253,0,.29861432,.2424367,.31945884,0,-.14220217,.13774039,.028392632,0,-.48776245,2.6595476,-.04151699,1],
    [.19121055,0,.16105442,0,-.26659527,.280618,.31651306,0,-.09038954,-.20691396,.10731425,0,.26769477,2.25,.22547618,1],
    [.15372014,.12680425,.017053027,0,-.11913629,.2037057,-.4408067,0,-.11873992,.13145846,.09284132,0,.0010994971,2.530618,.5419892,1],
    [.22913821,-.015700791,.19300045,0,-.14094439,-.62373114,.11659391,0,.18238428,-.08295147,-.22328243,0,-.15296845,1.25,-.12884353,1],
    [.22913821,-.015700791,.19300045,0,-.12555356,-.6302164,.09779369,0,.18476403,-.07175411,-.22519687,0,-.29391283,.62626886,-.012249619,1],
    [.22913821,.01570079,.19300045,0,.055704787,-.64746875,-.013462801,0,.19192365,.021285985,-.22959144,0,.15296845,1.25,.12884353,1],
    [.22913821,.01570079,.19300045,0,.33687833,-.4184745,-.36591277,0,.11541637,.22901888,-.15565807,0,.20867324,.60253125,.11538073,1],
  ];
  const scene = new THREE.Scene(), visuals = new PlayerVisuals(scene, 160, emptyLoader);
  visuals.update([player({ aiming: true, pitch: .6, yaw: .7, velocity: { x: 4.8, y: 0, z: 0 } })], -1, 1, camera);
  for (let bone = 0; bone < 10; bone++) {
    matrix(bodies(scene), bone).elements.forEach((actual, field) => {
      const expected = java[bone][field] * (field % 4 === 2 ? -1 : 1) * (Math.floor(field / 4) === 2 ? -1 : 1);
      expect(actual).toBeCloseTo(expected, 6);
    });
  }
});

test('all five original weapon meshes preserve their faces/palettes and anchor at the actual hands through ADS', async () => {
  const scene = new THREE.Scene(), visuals = new PlayerVisuals(scene, 160, realLoader);
  await visuals.ready;
  for (const weapon of Object.keys(WEAPON_MODEL_FILES) as WeaponId[]) {
    for (const aiming of [false, true]) {
      visuals.update([player({ weapon, aiming, yaw: 1, pitch: .4 })], -1, .25, camera);
      const weaponMesh = scene.getObjectByName(`UBERCUBE remote ${weapon}`) as THREE.InstancedMesh;
      const source = (await realLoader(weapon)).children[0] as THREE.Mesh;
      expect(weaponMesh.count).toBe(1);
      expect(weaponMesh.geometry.getAttribute('color').array).toEqual(source.geometry.getAttribute('color').array);
      expect(weaponMesh.geometry.getAttribute('normal').array).toEqual(source.geometry.getAttribute('normal').array);
      expect(weaponMesh.geometry.getAttribute('position').count).toBe(source.geometry.getAttribute('position').count);
      const gunMatrix = matrix(weaponMesh, 0);
      const offsetY = weapon === 'ak47' ? 10 : weapon === 'awp' ? 5 : -5;
      const offsetZ = weapon === 'ak47' ? 34 : weapon === 'awp' ? 17 : 0;
      const grip = new THREE.Vector3(0, -offsetY, -offsetZ).applyMatrix4(gunMatrix);
      const right = point(bodies(scene), 5, 0, 1);
      expect(grip.distanceTo(right)).toBeLessThan(.000001);
      if (weapon === 'ak47' || weapon === 'awp') {
        const forward = new THREE.Vector3(0, 0, -1).transformDirection(gunMatrix);
        const handDirection = point(bodies(scene), 3, 0, 1).sub(right).normalize();
        expect(forward.dot(handDirection)).toBeCloseTo(1, 6);
      }
    }
  }
});

test('100 players share one body draw and weapon batches; local/dead/cleared players leave no rendered instances', async () => {
  const scene = new THREE.Scene(), visuals = new PlayerVisuals(scene, 160, realLoader);
  await visuals.ready;
  const players = Array.from({ length: 100 }, (_, id) => player({ id }));
  visuals.update(players, -1, 0, camera);
  expect(bodies(scene).count).toBe(1000);
  expect((scene.getObjectByName('UBERCUBE remote ak47') as THREE.InstancedMesh).count).toBe(100);
  players[1].alive = false;
  visuals.update(players, 0, 0, camera);
  expect(bodies(scene).count).toBe(980);
  visuals.setFogDistance(96);
  expect((bodies(scene).material as THREE.ShaderMaterial).uniforms.fogDistance.value).toBe(96);
  expect(((scene.getObjectByName('UBERCUBE remote ak47') as THREE.InstancedMesh).material as THREE.ShaderMaterial).uniforms.fogDistance.value).toBe(96);
  visuals.clear();
  scene.traverse(object => { if (object instanceof THREE.InstancedMesh) expect(object.count).toBe(0); });
  visuals.update([player({ weapon: 'grenade', grenades: 0 })], -1, 1, camera);
  expect(bodies(scene).count).toBe(10);
  expect((scene.getObjectByName('UBERCUBE remote grenade') as THREE.InstancedMesh).count).toBe(0);
});
