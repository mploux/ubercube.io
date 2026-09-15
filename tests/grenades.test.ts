import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { GrenadeVisuals } from '../src/client/grenade-visuals';
import { Effects } from '../src/client/presentation';
import { parseWeaponModel } from '../src/client/weapon-model';
import type { GameEvent, RemoteProjectileState } from '../src/shared/protocol';
import { stepGrenade, type GrenadeFlight } from '../src/shared/grenade';
import { packBlock, VoxelWorld } from '../src/shared/voxel';

const obj = await Bun.file('public/assets/weapons/grenade/GRENADE.obj').text();
const mtl = await Bun.file('public/assets/weapons/grenade/GRENADE.mtl').text();
const loader = async () => parseWeaponModel(obj, mtl);
const grenade = (x: number, id = 1, y = 3): RemoteProjectileState => ({ id, owner: 7, weapon: 'grenade',
  position: { x, y, z: 0 } });
const event = (kind: GameEvent['event'], tick: number, id = 1): GameEvent => ({ type: 'event', event: kind,
  roundId: 1, tick, weapon: 'grenade', projectileId: id, position: { x: 0, y: 3, z: 0 } });

async function setup(capacity = 256) {
  const scene = new THREE.Scene();
  const visuals = new GrenadeVisuals(scene, 160, capacity, loader);
  await visuals.ready;
  const mesh = scene.getObjectByName('UBERCUBE thrown grenades') as THREE.InstancedMesh;
  const matrix = (index = 0) => { const value = new THREE.Matrix4(); mesh.getMatrixAt(index, value); return value; };
  const position = (index = 0) => new THREE.Vector3().setFromMatrixPosition(matrix(index));
  return { scene, visuals, mesh, matrix, position };
}

test('thrown grenade uses all original OBJ faces, palette and raw normals with the same model scale', async () => {
  const { visuals, mesh, matrix } = await setup();
  try {
    expect(mesh.geometry.getAttribute('position').count).toBe(306);
    const source = parseWeaponModel(obj, mtl).getObjectByProperty('isMesh', true) as THREE.Mesh;
    for (const attribute of ['position', 'normal', 'color']) {
      expect(Array.from(mesh.geometry.getAttribute(attribute).array)).toEqual(Array.from(source.geometry.getAttribute(attribute).array));
    }
    source.geometry.dispose(); (source.material as THREE.Material).dispose();
    visuals.snapshot([grenade(0)], 0, 1); visuals.update(1.1);
    const scale = new THREE.Vector3().setFromMatrixScale(matrix());
    for (const value of scale.toArray()) expect(value).toBeCloseTo(1 / 16, 7);
    expect((mesh.material as THREE.Material).depthFunc).toBe(THREE.LessDepth);
    expect((mesh.material as THREE.Material).side).toBe(THREE.DoubleSide);
    visuals.setFogDistance(200);
    expect((mesh.material as THREE.ShaderMaterial).uniforms.fogDistance.value).toBe(200);
  } finally { visuals.dispose(); }
});

test('20 Hz snapshots produce continuous intermediate positions rather than latest-state jumps', async () => {
  const { visuals, position } = await setup();
  try {
    visuals.snapshot([grenade(0)], 0, 1);
    visuals.snapshot([grenade(3)], 3, 1.05);
    visuals.snapshot([grenade(6)], 6, 1.1);
    const positions: number[] = [];
    for (const time of [1.1, 1.116666667, 1.133333333]) { visuals.update(time); positions.push(position().x); }
    positions.forEach((x, i) => expect(x).toBeCloseTo(i, 5));
    visuals.snapshot([grenade(9)], 9, 1.15); visuals.update(1.15);
    expect(position().x).toBeCloseTo(3, 5);
  } finally { visuals.dispose(); }
});

test('rendering at 30, 60 and 144 Hz yields the same trajectory and spin at equal times', async () => {
  const results: number[][] = [];
  for (const fps of [30, 60, 144]) {
    const { visuals, matrix } = await setup();
    try {
      let tick = 0;
      for (let frame = 0; frame <= fps; frame++) {
        const time = frame / fps;
        while (tick / 60 <= time + 1e-8) { visuals.snapshot([grenade(tick)], tick, 1 + tick / 60); tick += 3; }
        visuals.update(1 + time);
      }
      results.push(matrix().toArray());
    } finally { visuals.dispose(); }
  }
  for (const result of results.slice(1)) result.forEach((value, i) => expect(value).toBeCloseTo(results[0][i], 5));
});

test('packet jitter does not rewind the server timeline and an underrun never extrapolates', async () => {
  const { visuals, position } = await setup();
  try {
    visuals.snapshot([grenade(0)], 0, 1);
    visuals.snapshot([grenade(3)], 3, 1.08);
    visuals.snapshot([grenade(6)], 6, 1.11);
    visuals.update(1.12); expect(position().x).toBeCloseTo(1.2, 5);
    visuals.update(1.14); expect(position().x).toBeCloseTo(2.4, 5);
    visuals.snapshot([grenade(9)], 9, 1.2);
    visuals.update(1.2); expect(position().x).toBeCloseTo(6, 5);
    visuals.update(1.8); expect(position().x).toBeCloseTo(9, 5);
  } finally { visuals.dispose(); }
});

test('a bounce follows the confirmed path without overshooting its turning point', async () => {
  const { visuals, position } = await setup();
  try {
    visuals.snapshot([grenade(0)], 0, 1);
    visuals.snapshot([grenade(3)], 3, 1.05);
    visuals.snapshot([grenade(0)], 6, 1.1);
    visuals.update(1.125); expect(position().x).toBeCloseTo(1.5, 5);
    visuals.update(1.15); expect(position().x).toBeCloseTo(3, 5);
    visuals.update(1.175); expect(position().x).toBeCloseTo(1.5, 5);
    visuals.update(1.2); expect(position().x).toBeCloseTo(0, 5);
  } finally { visuals.dispose(); }
});

test('interpolation recovers after a server stall drops ticks, without rewinding the grenade', async () => {
  const { visuals, position } = await setup();
  try {
    visuals.snapshot([grenade(0)], 0, 1);
    visuals.snapshot([grenade(3)], 3, 1.05);
    visuals.snapshot([grenade(6)], 6, 1.1);
    visuals.update(1.125); expect(position().x).toBeCloseTo(1.5, 5);
    visuals.update(1.3); expect(position().x).toBeCloseTo(6, 5);
    visuals.snapshot([grenade(9)], 9, 1.35);
    visuals.update(1.35); expect(position().x).toBeCloseTo(6, 5);
    visuals.snapshot([grenade(12)], 12, 1.4);
    visuals.update(1.4); expect(position().x).toBeCloseTo(6, 5);
    visuals.snapshot([grenade(15)], 15, 1.45);
    for (const [time, expected] of [[1.45, 9], [1.466666667, 10], [1.483333333, 11]]) {
      visuals.update(time); expect(position().x).toBeCloseTo(expected, 5);
    }
  } finally { visuals.dispose(); }
});

test('grenades keep their identity when snapshot order changes, and explosions cannot resurrect', async () => {
  const { visuals, mesh, position } = await setup();
  try {
    visuals.snapshot([grenade(0, 1), grenade(20, 2)], 0, 1);
    visuals.snapshot([grenade(23, 2), grenade(3, 1)], 3, 1.05);
    visuals.update(1.125);
    expect(position(0).x).toBeCloseTo(1.5, 5); expect(position(1).x).toBeCloseTo(21.5, 5);
    visuals.event(event('explosion', 4, 1), 1.13); visuals.update(1.13);
    expect(mesh.count).toBe(1);
    visuals.snapshot([grenade(100, 1), grenade(26, 2)], 6, 1.14);
    visuals.snapshot([grenade(-100, 2)], 3, 1.15);
    visuals.update(1.16); expect(mesh.count).toBe(1); expect(position().x).toBeGreaterThan(20);
    visuals.event(event('projectile-end', 7, 2), 1.17); visuals.update(1.17); expect(mesh.count).toBe(0);
  } finally { visuals.dispose(); }
});

test('shot before same-tick snapshot has a distinct start sample, and resets remove old paths', async () => {
  const { visuals, mesh, position } = await setup();
  try {
    visuals.snapshot([], 0, 1);
    visuals.event(event('shot', 3), 1.05);
    visuals.snapshot([grenade(1)], 3, 1.05);
    visuals.update(1 + .1 + 2.5 / 60); expect(position().x).toBeCloseTo(.5, 5);
    visuals.clear(); expect(mesh.count).toBe(0);
    visuals.snapshot([grenade(40)], 0, 2); visuals.update(2.1); expect(position().x).toBeCloseTo(40, 5);
    visuals.snapshot([], 3, 2.15); visuals.update(2.15); expect(mesh.count).toBe(0);
  } finally { visuals.dispose(); }
});

test('100 simultaneous grenades share one mesh; capacity and stalled connections bound visual work', async () => {
  const { visuals, scene, mesh } = await setup(100);
  visuals.snapshot(Array.from({ length: 120 }, (_, id) => grenade(id, id)), 0, 1);
  visuals.update(1.1); expect(mesh.count).toBe(100); expect(scene.children).toHaveLength(1);
  visuals.update(2.2); expect(mesh.count).toBe(0);
  visuals.snapshot([grenade(5, 99)], 3, 2.25);
  visuals.update(2.35); expect(mesh.count).toBe(1);
  visuals.dispose(); expect(scene.children).toHaveLength(0);
});

test('loading after disposal cannot add a model to the scene', async () => {
  const scene = new THREE.Scene();
  let finish!: (model: THREE.Group) => void;
  const visuals = new GrenadeVisuals(scene, 160, 1, () => new Promise(resolve => { finish = resolve; }));
  visuals.dispose(); finish(await loader()); await visuals.ready;
  expect(scene.children).toHaveLength(0);
});

test('Effects routes snapshots, rendered frames and explosion cleanup to the grenade renderer', async () => {
  const scene = new THREE.Scene();
  const effects = new Effects(scene, 160, loader); await effects.ready;
  effects.snapshot([grenade(0)], 0, 1);
  effects.snapshot([grenade(3)], 3, 1.05);
  effects.snapshot([grenade(6)], 6, 1.1);
  effects.update(1 / 60, 1.125);
  const mesh = scene.getObjectByName('UBERCUBE thrown grenades') as THREE.InstancedMesh;
  const matrix = new THREE.Matrix4(); mesh.getMatrixAt(0, matrix);
  expect(new THREE.Vector3().setFromMatrixPosition(matrix).x).toBeCloseTo(1.5, 5);
  effects.event(event('explosion', 7), 1.13); effects.update(1 / 60, 1.13);
  expect(mesh.count).toBe(0); effects.clear();
});

test('local release is visible before any server message and moves every frame using collision-aware flight', async () => {
  const { visuals, mesh, position } = await setup();
  const world = new VoxelWorld({ seed: 1, size: 256, height: 128 });
  const launch = { position: { x: 100, y: 80, z: 100 }, velocity: { x: 60, y: 0, z: 0 } };
  world.set(102, 79, 100, packBlock(100, 100, 100));
  world.set(102, 80, 100, packBlock(100, 100, 100));
  try {
    visuals.predict(7, 30, launch, world, 1); visuals.update(1);
    expect(mesh.count).toBe(1); expect(position().toArray()).toEqual([100, 80, 100]);
    visuals.update(1 + 1 / 144); const first = position().x;
    visuals.update(1 + 2 / 144); expect(position().x).toBeGreaterThan(first);
    visuals.update(1.2); expect(position().x).toBeLessThan(102); expect(position().x).toBeGreaterThan(101);
    expect(launch.position).toEqual({ x: 100, y: 80, z: 100 });
    expect(launch.velocity).toEqual({ x: 60, y: 0, z: 0 });
  } finally { visuals.dispose(); }
});

test.each([0, .05, .15, .3])('local prediction survives %s seconds of confirmation latency without a duplicate or rewind', async delay => {
  const { visuals, mesh, matrix, position } = await setup();
  const world = new VoxelWorld({ seed: 1, size: 256, height: 64 });
  const launch = { position: { x: 100, y: 100, z: 100 }, velocity: { x: 60, y: 10, z: 0 } };
  const authority: GrenadeFlight = structuredClone(launch);
  try {
    visuals.predict(7, 30, launch, world, 1); visuals.update(1 + delay);
    const before = matrix().toArray();
    const shot: GameEvent = { ...event('shot', 60), position: launch.position, velocity: launch.velocity, shooterId: 7, inputSeq: 30 };
    visuals.event(shot, 1 + delay); visuals.update(1 + delay);
    expect(mesh.count).toBe(1); expect(matrix().toArray()).toEqual(before);
    visuals.event(shot, 1 + delay); visuals.update(1 + delay); expect(mesh.count).toBe(1);
    let previous = position().x;
    for (let tick = 1; tick <= 36; tick++) {
      stepGrenade(authority, world);
      const time = 1 + delay + tick / 60;
      if (tick % 3 === 0) {
        visuals.update(time); const beforeSnapshot = position();
        visuals.snapshot([{ ...grenade(0), position: { ...authority.position } }], 59 + tick, time, [{ id: 1, velocity: { ...authority.velocity } }]);
        visuals.update(time);
        expect(position().distanceTo(beforeSnapshot)).toBeLessThan(.0001);
        visuals.acknowledge(7, 30);
      } else visuals.update(time);
      expect(mesh.count).toBe(1); expect(position().x).toBeGreaterThan(previous); previous = position().x;
    }
    visuals.event(event('explosion', 96), 1 + delay + .61); visuals.update(1 + delay + .61);
    expect(mesh.count).toBe(0);
    visuals.snapshot([{ ...grenade(0), position: launch.position }], 99, 1 + delay + .65);
    visuals.update(1 + delay + .65); expect(mesh.count).toBe(0);
  } finally { visuals.dispose(); }
});

test('server corrections are continuous and settle onto the authoritative launch trajectory', async () => {
  const { visuals, position } = await setup();
  const world = new VoxelWorld({ seed: 1, size: 256, height: 64 });
  const launch = { position: { x: 100, y: 100, z: 100 }, velocity: { x: 60, y: 10, z: 0 } };
  const authority: GrenadeFlight = structuredClone(launch);
  authority.position.z += 1;
  try {
    visuals.predict(7, 30, launch, world, 1); visuals.update(1.15); const before = position();
    visuals.event({ ...event('shot', 60), position: authority.position, velocity: authority.velocity, shooterId: 7, inputSeq: 30 }, 1.15);
    visuals.update(1.15); expect(position().distanceTo(before)).toBeLessThan(.0001);
    for (let tick = 0; tick < 30; tick++) stepGrenade(authority, world);
    visuals.update(1.5);
    expect(position().distanceTo(new THREE.Vector3(authority.position.x, authority.position.y, authority.position.z))).toBeLessThan(.002);
  } finally { visuals.dispose(); }
});

test('Effects reconciles a predicted grenade only with its matching owner velocity', async () => {
  const scene = new THREE.Scene(), effects = new Effects(scene, 160, loader);
  await effects.ready;
  const world = new VoxelWorld({ seed: 1, size: 256, height: 64 });
  const launch = { position: { x: 100, y: 100, z: 100 }, velocity: { x: 60, y: 10, z: 0 } };
  const projectile = { ...grenade(180), position: { x: 180, y: 100, z: 100 } };
  const velocity = { x: 0, y: 0, z: 0 };
  const original = structuredClone({ projectile, velocity });
  const mesh = scene.getObjectByName('UBERCUBE thrown grenades') as THREE.InstancedMesh;
  const position = () => {
    const matrix = new THREE.Matrix4(); mesh.getMatrixAt(0, matrix);
    return new THREE.Vector3().setFromMatrixPosition(matrix);
  };
  try {
    effects.predictGrenade(7, 30, launch, world, 1);
    effects.event({ ...event('shot', 60), position: launch.position, velocity: launch.velocity, shooterId: 7, inputSeq: 30 }, 1);
    effects.snapshot([projectile], 65, 1.1, [{ id: 999, velocity }]);
    effects.update(.1, 1.2);
    expect(mesh.count).toBe(1);
    const expected = structuredClone(launch);
    for (let tick = 0; tick < 12; tick++) stepGrenade(expected, world);
    expect(position().x).toBeCloseTo(expected.position.x, 4);
    effects.snapshot([projectile], 71, 1.2);
    effects.update(.1, 1.3);
    for (let tick = 0; tick < 6; tick++) stepGrenade(expected, world);
    expect(position().x).toBeCloseTo(expected.position.x, 4);
    const before = position();
    effects.snapshot([projectile], 77, 1.3, [{ id: 1, velocity }]);
    effects.update(0, 1.3);
    expect(position().distanceTo(before)).toBeLessThan(.0001);
    effects.update(.4, 1.7);
    expect(position().x).toBeCloseTo(180, 1);
    expect({ projectile, velocity }).toEqual(original);
  } finally { effects.clear(); }
});

test('input identity, acknowledgement, missing confirmation and reset bound local predictions', async () => {
  const { visuals, mesh } = await setup();
  const world = new VoxelWorld({ seed: 1, size: 256, height: 64 });
  const launch = { position: { x: 100, y: 100, z: 100 }, velocity: { x: 60, y: 10, z: 0 } };
  try {
    visuals.predict(7, 30, launch, world, 1); visuals.predict(7, 31, launch, world, 1);
    visuals.predict(7, 31, launch, world, 1);
    expect(visuals.pendingThrows(7, 29)).toBe(2); expect(visuals.pendingThrows(7, 30)).toBe(1);
    visuals.event({ ...event('shot', 60), position: launch.position, velocity: launch.velocity, shooterId: 8, inputSeq: 30 }, 1.1);
    visuals.acknowledge(7, 30); visuals.update(1.21); expect(mesh.count).toBe(2);
    expect(visuals.pendingThrows(7, 29)).toBe(1);
    visuals.acknowledge(7, 31); visuals.update(1.21); expect(mesh.count).toBe(1);
    visuals.clear(); visuals.predict(7, 30, launch, world, 2); visuals.update(2); expect(mesh.count).toBe(1);
    visuals.update(3.01); expect(mesh.count).toBe(0); expect(visuals.pendingThrows(7, 0)).toBe(0);
    visuals.predict(7, 32, launch, world, 4); visuals.clear(); visuals.update(4); expect(mesh.count).toBe(0);
  } finally { visuals.dispose(); }
});

test('local flight and reconciliation are identical at 30, 60 and 144 rendered frames per second', async () => {
  const results: number[][] = [];
  const world = new VoxelWorld({ seed: 1, size: 256, height: 64 });
  const launch = { position: { x: 100, y: 100, z: 100 }, velocity: { x: 60, y: 10, z: 0 } };
  for (const fps of [30, 60, 144]) {
    const { visuals, matrix } = await setup();
    try {
      visuals.predict(7, 30, launch, world, 1);
      for (let frame = 0; frame <= fps / 2; frame++) visuals.update(1 + frame / fps);
      visuals.event({ ...event('shot', 60), position: { ...launch.position, z: 101 }, velocity: launch.velocity, shooterId: 7, inputSeq: 30 }, 1.5);
      for (let frame = fps / 2; frame <= fps; frame++) visuals.update(1 + frame / fps);
      results.push(matrix().toArray());
    } finally { visuals.dispose(); }
  }
  for (const result of results.slice(1)) result.forEach((value, i) => expect(value).toBeCloseTo(results[0][i], 5));
});

test('visual capacity preserves local confirmation binding and explosions remove every predicted model', async () => {
  const { visuals, mesh } = await setup(1);
  const world = new VoxelWorld({ seed: 1, size: 256, height: 64 });
  const launch = { position: { x: 100, y: 100, z: 100 }, velocity: { x: 60, y: 10, z: 0 } };
  try {
    visuals.predict(7, 30, launch, world, 1);
    visuals.event({ ...event('shot', 60), position: launch.position, velocity: launch.velocity, shooterId: 7, inputSeq: 30 }, 1.1);
    visuals.event(event('shot', 61, 2), 1.12); visuals.update(1.15); expect(mesh.count).toBe(1);
    visuals.snapshot([grenade(0, 2), { ...grenade(0), position: launch.position }], 63, 1.2, [{ id: 1, velocity: launch.velocity }]);
    visuals.update(1.2); expect(mesh.count).toBe(1);
    visuals.event(event('explosion', 64), 1.21); visuals.event(event('explosion', 64, 2), 1.21);
    visuals.update(1.21); expect(mesh.count).toBe(0);
    expect(visuals.pendingThrows(7, 29)).toBe(1);
    visuals.acknowledge(7, 30); expect(visuals.pendingThrows(7, 29)).toBe(0);
  } finally { visuals.dispose(); }
});

test('death cancels unconfirmed throws and stock reservations while confirmed grenades keep flying', async () => {
  const { visuals, mesh } = await setup();
  const world = new VoxelWorld({ seed: 1, size: 256, height: 64 });
  const launch = { position: { x: 100, y: 100, z: 100 }, velocity: { x: 60, y: 10, z: 0 } };
  try {
    visuals.predict(7, 30, launch, world, 1); visuals.predict(7, 31, launch, world, 1);
    visuals.event({ ...event('shot', 60), position: launch.position, velocity: launch.velocity, shooterId: 7, inputSeq: 30 }, 1.1);
    visuals.acknowledge(7, 29, false); visuals.update(1.1);
    expect(mesh.count).toBe(1); expect(visuals.pendingThrows(7, 29)).toBe(0);
    visuals.predict(7, 32, launch, world, 1.2); visuals.update(1.2);
    expect(mesh.count).toBe(2); expect(visuals.pendingThrows(7, 31)).toBe(1);
  } finally { visuals.dispose(); }
});
