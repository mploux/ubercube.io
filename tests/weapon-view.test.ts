import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { WeaponView, type WeaponViewInput } from '../src/client/weapon-view';
import { parseWeaponModel, WEAPON_MODEL_FILES } from '../src/client/weapon-model';
import { createWeaponPose, getWeaponMuzzle, hideWeaponPose, stepWeaponMotion, stepWeaponPose,
  type WeaponPoseInput } from '../src/shared/weapon-pose';
import type { WeaponId } from '../src/shared/protocol';

const still: WeaponPoseInput = { fire: false, alt: false, sprint: false, localVelocity: { x: 0, y: 0, z: 0 },
  lookDeltaYaw: 0, lookDeltaPitch: 0, mouseDX: 0, mouseDY: 0, grenades: 10 };
const viewInput: WeaponViewInput = { ...still, moveX: 0, moveZ: 0 };
const loader = async (weapon: WeaponId): Promise<THREE.Group> => {
  const path = `public/assets/weapons/${WEAPON_MODEL_FILES[weapon]}`;
  return parseWeaponModel(readFileSync(`${path}.obj`, 'utf8'), readFileSync(`${path}.mtl`, 'utf8'));
};

test.each([['ak47', [0, 8, 16]], ['awp', [0, 62, 124]], ['rpg', [0, 62, 124]]] as const)('%s keeps the actual Java held-trigger cadence', (weapon, expected) => {
  const pose = createWeaponPose(weapon), shots: number[] = [];
  for (let tick = 0; tick <= expected[2]; tick++) if (stepWeaponPose(pose, { ...still, fire: true }, () => .5).fired) shots.push(tick);
  expect(shots).toEqual([...expected]);
});

test('release and cancellation never reset weapon cooldown or turn a held grenade into a throw', () => {
  const pose = createWeaponPose('ak47');
  expect(stepWeaponPose(pose, { ...still, fire: true }).fired).toBe(true);
  for (let tick = 0; tick < 20; tick++) stepWeaponPose(pose, { ...still, cancelActions: true });
  expect(pose.shot).toBe(true);
  expect(stepWeaponPose(pose, { ...still, fire: true }).fired).toBe(false);
  expect(stepWeaponPose(pose, { ...still, fire: true }).fired).toBe(true);
  const grenade = createWeaponPose('grenade');
  for (let tick = 0; tick < 20; tick++) stepWeaponPose(grenade, { ...still, fire: true });
  expect(stepWeaponPose(grenade, { ...still, fire: true, cancelActions: true }).thrown).toBe(false);
  expect(grenade.charge).toBe(0);
  expect(stepWeaponPose(grenade, still).thrown).toBe(false);
});

test('gun pushback is applied before position damping and angular recoil affects the next pose', () => {
  const pose = createWeaponPose('ak47');
  for (let tick = 0; tick < 80; tick++) stepWeaponPose(pose, { ...still, alt: true });
  let randomCalls = 0;
  stepWeaponPose(pose, { ...still, fire: true, alt: true }, () => { randomCalls++; return .5; });
  expect(pose.position.z).toBeCloseTo(-1.0006, 8);
  expect(pose.quaternion.x).toBe(0);
  expect(pose.rotationFactor.x).toBeCloseTo(-.01, 8);
  stepWeaponPose(pose, { ...still, alt: true });
  expect(pose.quaternion.x).toBeCloseTo(Math.sin(-.007 / 2), 8);
  expect(pose.position.z).toBeCloseTo(-1.00036, 8);
  expect(randomCalls).toBe(0);
});

test('RPG launch point follows the optic-aligned pose, with AWP zoom and its existing kick', () => {
  const pose = createWeaponPose('rpg');
  for (let tick = 0; tick < 80; tick++) stepWeaponPose(pose, { ...still, alt: true });
  const muzzle = getWeaponMuzzle(pose);
  expect(muzzle.position.x).toBeCloseTo(.09, 8);
  expect(muzzle.position.y).toBeCloseTo(-.145, 8);
  expect(muzzle.position.z).toBeCloseTo(2, 8);
  expect(muzzle.direction).toEqual({ x: 0, y: 0, z: 1 });
  expect(70 - pose.zoom).toBeCloseTo(11.655, 7);
  stepWeaponPose(pose, { ...still, fire: true, alt: true }, () => .5);
  expect(pose.position.z).toBeCloseTo(-1.12, 8);
  expect(pose.rotationFactor.x).toBeCloseTo(-.1, 8);
  expect(pose.quaternion.x).toBe(0);
});

test('idle shot randomness feeds the current orientation, distinct from next-tick recoil', () => {
  const pose = createWeaponPose('ak47');
  stepWeaponPose(pose, { ...still, fire: true }, () => .5);
  expect(pose.quaternion.y).toBeCloseTo(Math.sin(-.0175 / 2), 8);
  expect(pose.quaternion.x).toBe(0);
  expect(pose.rotationFactor.x).toBeCloseTo(-.15, 8);
});

test('RPG fires its attached round, keeps the tube visible, and replenishes before the next shot', async () => {
  const view = new WeaponView(loader);
  await view.ready;
  try {
    view.reset('rpg');
    for (let tick = 0; tick < 80; tick++) view.tick(viewInput);
    const round = view.scene.getObjectByName('RPG_rocket')!;
    expect(round).toBeDefined();
    expect(round.visible).toBe(true);
    expect(view.tick({ ...viewInput, fire: true }, () => .5).fired).toBe(true);
    expect(round.visible).toBe(false);
    const body = view.scene.getObjectByName('RPG')!;
    expect(body.visible).toBe(true);
    for (let tick = 0; tick < 30; tick++) view.tick(viewInput);
    expect(round.visible).toBe(false);
    for (let tick = 0; tick < 32; tick++) view.tick(viewInput);
    expect(round.visible).toBe(true);
    view.reset('rpg');
    expect(round.visible).toBe(true);
  } finally { view.dispose(); }
});

test('RPG aimed camera looks through the transparent optic, without a solid cap on its sight line', async () => {
  const view = new WeaponView(loader);
  await view.ready;
  try {
    view.reset('rpg');
    for (let tick = 0; tick < 120; tick++) view.tick({ ...viewInput, alt: true });
    view.scene.updateMatrixWorld(true);
    const lens = view.scene.getObjectByName('RPG_lens') as THREE.Mesh;
    expect(lens).toBeDefined();
    expect(view.scene.getObjectByName('RPG_sights')!.visible).toBe(false);
    const center = new THREE.Vector3(-.72, -.44, -12.11).applyMatrix4(lens.matrixWorld);
    expect(center.x).toBeCloseTo(0, 7);
    expect(center.y).toBeCloseTo(0, 7);
    expect(center.z).toBeLessThan(-.05);
    const hits = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, 0, -1)).intersectObject(view.scene, true);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      const material = (hit.object as THREE.Mesh).material as THREE.Material;
      expect(material.transparent).toBe(true);
      expect(material.depthWrite).toBe(false);
    }
    view.tick(viewInput);
    expect(view.scene.getObjectByName('RPG_sights')!.visible).toBe(true);
  } finally { view.dispose(); }
});

test.each([['ak47', 54.44133333333333], ['awp', 11.655], ['rpg', 11.655]] as const)('%s follows the original ADS recurrence and returns to FOV70', (weapon, expectedFov) => {
  const pose = createWeaponPose(weapon);
  for (let tick = 0; tick < 120; tick++) stepWeaponPose(pose, { ...still, alt: true });
  expect(70 - pose.zoom).toBeCloseTo(expectedFov, 7);
  for (let tick = 0; tick < 120; tick++) stepWeaponPose(pose, still);
  expect(70 - pose.zoom).toBeCloseTo(70, 7);
});

test('visual movement retains the Java local intent filter and produces next-tick sway', () => {
  const velocity = { x: 0, y: 0, z: 0 }, pose = createWeaponPose('ak47');
  for (let tick = 0; tick < 120; tick++) stepWeaponMotion(velocity, { moveX: 1, moveZ: 1, sprint: false });
  expect(velocity.x).toBeCloseTo(-.1, 6);
  expect(velocity.z).toBeCloseTo(.1, 6);
  stepWeaponPose(pose, { ...still, localVelocity: velocity });
  expect(pose.quaternion).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  expect(pose.rotationFactor.x).toBeGreaterThan(0);
  expect(pose.rotationFactor.z).toBeCloseTo(-.02, 6);
  stepWeaponPose(pose, { ...still, localVelocity: velocity });
  expect(Math.abs(pose.quaternion.z)).toBeGreaterThan(.001);
  const sprint = createWeaponPose('ak47');
  stepWeaponPose(sprint, { ...still, sprint: true });
  expect(sprint.rotationFactor).toEqual({ x: .1, y: -.2, z: 0 });
});

test('look sway uses angular mouse motion for guns and raw pixels for the shovel', () => {
  const gun = createWeaponPose('ak47');
  stepWeaponPose(gun, { ...still, lookDeltaYaw: -.01, lookDeltaPitch: .02 });
  expect(gun.rotationFactor.x).toBeCloseTo(-.02 * 180 / Math.PI * 4 * .0008, 8);
  expect(gun.rotationFactor.y).toBeCloseTo(.01 * 180 / Math.PI * 4 * .0008, 8);
  const shovel = createWeaponPose('shovel');
  stepWeaponPose(shovel, { ...still, mouseDX: 10, mouseDY: -5 });
  expect(shovel.rotationFactor).toEqual({ x: -.004, y: .008, z: -.008 });
});

test('shovel swings for five ticks per press, while holding does not create another swing', () => {
  const pose = createWeaponPose('shovel');
  let attacks = 0;
  for (let tick = 0; tick < 12; tick++) if (stepWeaponPose(pose, { ...still, fire: true }).melee) attacks++;
  expect(attacks).toBe(1);
  expect(pose.attacking).toBe(false);
  expect(pose.attackTime).toBe(0);
  stepWeaponPose(pose, still);
  expect(stepWeaponPose(pose, { ...still, fire: true }).melee).toBe(true);
  expect(pose.attackTime).toBe(1);
  expect(stepWeaponPose(pose, { ...still, alt: true }).build).toBe(true);
  expect(stepWeaponPose(pose, { ...still, alt: true }).build).toBe(false);
});

test('grenade charge pulls the model back and emits only a release intent with the source force', () => {
  const pose = createWeaponPose('grenade');
  for (let tick = 0; tick < 60; tick++) expect(stepWeaponPose(pose, { ...still, fire: true }).thrown).toBe(false);
  const charge = 2.7 * (1 - .9 ** 60);
  expect(pose.charge).toBeCloseTo(charge, 8);
  expect(pose.position.z).toBeCloseTo(1 - charge * .15, 8);
  const release = stepWeaponPose(pose, still);
  expect(release.thrown).toBe(true);
  expect(release.force).toBeCloseTo(charge * .9, 8);
  expect(pose.position.z).toBe(1);
  expect(stepWeaponPose(pose, still).thrown).toBe(false);
  stepWeaponPose(pose, { ...still, fire: true, grenades: 0 });
  expect(stepWeaponPose(pose, { ...still, grenades: 0 }).thrown).toBe(false);
});

test('medic emits a heal press without invented swing, bobbing or rotation', () => {
  const pose = createWeaponPose('medic');
  expect(stepWeaponPose(pose, { ...still, fire: true, sprint: true, localVelocity: { x: 1, y: 0, z: 1 } }).heal).toBe(true);
  expect(stepWeaponPose(pose, { ...still, fire: true }).heal).toBe(false);
  for (let tick = 0; tick < 80; tick++) stepWeaponPose(pose, { ...still, alt: true });
  expect(pose.position.x).toBeCloseTo(0, 8);
  expect(pose.position.y).toBeCloseTo(0, 8);
  expect(pose.position.z).toBeCloseTo(0, 8);
  expect(pose.quaternion).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  expect(pose.zoom).toBe(0);
});

test('outgoing hide preserves fire cadence and adds the Java hide translation', () => {
  const pose = createWeaponPose('ak47');
  stepWeaponPose(pose, { ...still, fire: true });
  const previous = { ...pose.position }, timer = pose.shootTimer;
  hideWeaponPose(pose);
  expect(pose.position.x).toBeCloseTo(previous.x + .2, 8);
  expect(pose.position.y).toBeCloseTo(previous.y - 1.05, 8);
  expect(pose.position.z).toBe(previous.z);
  expect(pose.shootTimer).toBe(timer);
  expect(pose.shot).toBe(true);
});

test('all six first-person models keep their original vertices and exact raw transform/pivot', async () => {
  const view = new WeaponView(loader);
  await view.ready;
  const expected: Record<WeaponId, { scale: number[]; idle: number[] }> = {
    ak47: { scale: [-.35, .35, .35], idle: [.2, -.05, -.3] }, awp: { scale: [.65, .65, .65], idle: [.2, 0, -.3] },
    shovel: { scale: [.3, .3, .3], idle: [.1, -.2, .2] }, grenade: { scale: [1, 1, 1], idle: [.4, -.3, 1] },
    medic: { scale: [3, 3, 3], idle: [.09, -.4, .85] },
    rpg: { scale: [2, 2, -2], idle: [.3, 0, -1.1] },
  };
  try {
    for (const weapon of Object.keys(expected) as WeaponId[]) {
      view.reset(weapon);
      for (let tick = 0; tick < 80; tick++) view.tick(viewInput);
      view.scene.updateMatrixWorld(true);
      const root = view.scene.getObjectByName('first-person weapon')!;
      const model = root.children[0];
      expect(model.position.toArray()).toEqual([0, 0, 0]);
      expect(model.scale.toArray()).toEqual([1, 1, 1]);
      let measured = false;
      model.traverse(object => {
        if (!(object instanceof THREE.Mesh) || measured) return;
        const vertex = new THREE.Vector3().fromBufferAttribute(object.geometry.getAttribute('position'), 0);
        const { scale, idle } = expected[weapon];
        const target = [vertex.x * scale[0] / 16 + idle[0], vertex.y * scale[1] / 16 + idle[1], -(vertex.z * scale[2] / 16 + idle[2])];
        const transformed = object.localToWorld(vertex);
        transformed.toArray().forEach((value, index) => expect(value).toBeCloseTo(target[index], 7));
        expect((object.material as THREE.Material).depthFunc).toBe(THREE.LessDepth);
        measured = true;
      });
      expect(measured).toBe(true);
    }
  } finally { view.dispose(); }
});

test('weapon changes preserve inactive animation/cadence and rendering cannot advance simulation', async () => {
  const view = new WeaponView(loader);
  await view.ready;
  try {
    view.tick({ ...viewInput, fire: true });
    const ak = view.pose, timer = ak.shootTimer;
    view.setWeapon('awp');
    for (let tick = 0; tick < 10; tick++) view.tick(viewInput);
    expect(ak.shootTimer).toBe(timer);
    view.setWeapon('ak47');
    expect(view.pose).toBe(ak);
    const before = JSON.stringify(ak);
    const renderer = { domElement: { clientWidth: 800, clientHeight: 600 }, autoClear: true, clearDepth() {}, render() {} } as unknown as THREE.WebGLRenderer;
    const worldCamera = new THREE.PerspectiveCamera();
    worldCamera.rotation.set(.2, -.5, 0, 'YXZ');
    for (let frame = 0; frame < 20; frame++) view.render(renderer, worldCamera);
    expect(JSON.stringify(ak)).toBe(before);
    expect(renderer.autoClear).toBe(true);
    expect(view.camera.near).toBe(.05);
    view.reset('awp');
    expect(view.pose.shot).toBe(false);
    expect(view.fov).toBe(70);
  } finally { view.dispose(); }
});

test('switching while holding does not invent clicks or preserve an abandoned grenade charge', async () => {
  const view = new WeaponView(loader);
  await view.ready;
  try {
    view.tick({ ...viewInput, fire: true, alt: true });
    view.setWeapon('shovel');
    const shovel = view.tick({ ...viewInput, fire: true, alt: true });
    expect(shovel.melee).toBe(false);
    expect(shovel.build).toBe(false);
    view.setWeapon('medic');
    expect(view.tick({ ...viewInput, fire: true }).heal).toBe(false);
    view.tick(viewInput);
    expect(view.tick({ ...viewInput, fire: true }).heal).toBe(true);
    view.setWeapon('grenade');
    for (let tick = 0; tick < 20; tick++) view.tick({ ...viewInput, fire: true });
    const grenade = view.pose;
    expect(grenade.charge).toBeGreaterThan(0);
    view.setWeapon('ak47');
    expect(grenade.charge).toBe(0);
    view.tick(viewInput);
    view.setWeapon('grenade');
    expect(view.tick(viewInput).thrown).toBe(false);
    expect(view.pose.charge).toBe(0);
  } finally { view.dispose(); }
});

test('releasing the old gun while switching cannot throw a grenade, including multiple wheel events before a tick', async () => {
  const view = new WeaponView(loader);
  await view.ready;
  try {
    for (const intermediary of [false, true]) {
      view.reset('ak47');
      view.tick({ ...viewInput, fire: true, alt: true });
      if (intermediary) view.setWeapon('medic');
      view.setWeapon('grenade');
      const released = view.tick(viewInput);
      expect(released.thrown).toBe(false);
      expect(view.pose.charge).toBe(0);
      expect(view.pose.fireHeld).toBe(false);
      expect(view.pose.altHeld).toBe(false);
      view.tick({ ...viewInput, fire: true });
      const legitimate = view.tick(viewInput);
      expect(legitimate.thrown).toBe(true);
      expect(legitimate.force).toBeGreaterThan(0);
    }
  } finally { view.dispose(); }
});
