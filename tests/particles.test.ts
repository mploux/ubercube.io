import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { Effects } from '../src/client/presentation';
import { particleColor } from '../src/client/particle-material';
import { GameServer, type Peer } from '../src/server/game';
import { PROTOCOL_VERSION, type GameEvent, type InputFrame, type ServerMessage, type WeaponId } from '../src/shared/protocol';
import { packBlock } from '../src/shared/voxel';
import { decodeServerMessage } from '../src/shared/wire';
import { parseWeaponModel } from '../src/client/weapon-model';

const grenadeOBJ = await Bun.file('public/assets/weapons/grenade/GRENADE.obj').text();
const grenadeMTL = await Bun.file('public/assets/weapons/grenade/GRENADE.mtl').text();
const grenadeLoader = async () => parseWeaponModel(grenadeOBJ, grenadeMTL);

function shotFixture(weapon: WeaponId, rgb: number, health = 1) {
  const game = new GameServer({ world: { seed: 12345, size: 64, height: 64 } });
  const messages: ServerMessage[] = [];
  const peer: Peer = {
    send(data) { messages.push(decodeServerMessage(data)); return typeof data === 'string' ? data.length : data.byteLength; },
    bufferedAmount: () => 0,
    close() {},
  };
  const connection = game.connect(peer)!;
  game.receive(connection, JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: 'ParticleTest' }));
  game.receive(connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: weapon === 'awp' ? 'sniper' : 'assault' }));
  // Let the original draw animation settle before aiming its muzzle at one voxel.
  if (weapon !== 'shovel') for (let seq = 1; seq <= 20; seq++) {
    game.receive(connection, JSON.stringify({ type: 'input', frames: [{ seq, roundId: game.roundId, moveX: 0, moveZ: 0,
      yaw: 0, pitch: 0, jump: false, sprint: false, fire: false, alt: true, weapon }] }));
    game.step();
  }
  connection.player!.position = { x: 32.5, y: 45, z: 32.5 };
  connection.player!.velocity = { x: 0, y: 0, z: 0 };
  for (let x = 31; x <= 33; x++) for (let y = 45; y <= 49; y++) for (let z = 29; z <= 33; z++) game.world.set(x, y, z, 0);
  game.world.set(32, 47, 30, packBlock((rgb >>> 16) & 255, (rgb >>> 8) & 255, rgb & 255, health));
  const frame: InputFrame = { seq: connection.highestSeq + 1, roundId: game.roundId, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, sprint: false, fire: true, alt: weapon !== 'shovel', weapon };
  return { game, messages, connection, frame };
}

test.each(['ak47', 'awp', 'shovel'] as const)('%s transports the impacted surface palette even after destruction and delayed delivery', weapon => {
  for (const rgb of [0x2c662b, 0x503d1f, 0x73797e]) {
    const { game, messages, connection, frame } = shotFixture(weapon, rgb);
    game.receive(connection, JSON.stringify({ type: 'input', frames: [frame] }));
    game.step();
    const event = messages.find(message => message.type === 'event' && message.event === 'impact') as GameEvent;
    expect(event).toBeDefined();
    expect(event.blockColor).toBe(rgb);
    expect(event.roundId).toBe(game.roundId);
    expect(game.world.get(32, 47, 30)).toBe(0);
    game.world.set(32, 47, 30, packBlock(255, 0, 255));

    const scene = new THREE.Scene();
    const effects = new Effects(scene, 128, grenadeLoader);
    effects.event(event, 0);
    effects.update(0, 0);
    const mesh = scene.getObjectByName('UBERCUBE impact particles') as THREE.InstancedMesh;
    expect(mesh.count).toBeGreaterThan(0);
    const actual = new THREE.Color();
    const base = particleColor(event, .5)!;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getColorAt(i, actual);
      const variation = actual.r - base.r;
      expect(Math.abs(variation)).toBeLessThanOrEqual(.050001);
      expect(actual.g - base.g).toBeCloseTo(variation, 6);
      expect(actual.b - base.b).toBeCloseTo(variation, 6);
    }
    effects.setFogDistance(256);
    expect((mesh.material as THREE.ShaderMaterial).uniforms.fogDistance.value).toBe(256);
    expect((mesh.material as THREE.ShaderMaterial).toneMapped).toBe(false);
  }
});

test('an impact captures the surface before damage darkens its RGB', () => {
  const { game, messages, connection, frame } = shotFixture('ak47', 0xe08020, 127);
  game.receive(connection, JSON.stringify({ type: 'input', frames: [frame] }));
  game.step();
  const event = messages.find(message => message.type === 'event' && message.event === 'impact') as GameEvent;
  expect(event.blockColor).toBe(0xe08020);
  expect(game.world.get(32, 47, 30)).not.toBe(0);
  expect(game.world.get(32, 47, 30) & 0xffffff).not.toBe(event.blockColor!);
});

test('a client cannot choose or inject an impact palette', () => {
  const { game, messages, connection, frame } = shotFixture('ak47', 0x2c662b);
  game.receive(connection, JSON.stringify({ type: 'input', frames: [{ ...frame, blockColor: 0xff00ff }] }));
  game.step();
  expect(connection.queue).toHaveLength(0);
  expect(messages.some(message => message.type === 'event' && message.event === 'impact')).toBe(false);
  expect(game.world.get(32, 47, 30) & 0xffffff).toBe(0x2c662b);
});

test('blood and explosions retain Java base colors and shared channel variation', () => {
  const base: GameEvent = { type: 'event', roundId: 1, event: 'impact', position: { x: 0, y: 0, z: 0 }, targetId: 5 };
  expect(particleColor(base, .5)!.toArray()).toEqual([.8, 0, 0]);
  expect(particleColor(base, 0)!.toArray()).toEqual([.75, -.05, -.05]);
  expect(particleColor({ ...base, event: 'explosion' }, .5)!.toArray()).toEqual([.5, .5, .5]);
  expect(particleColor({ ...base, event: 'explosion' }, 0)!.toArray()).toEqual([.45, .45, .45]);
});

test('invalid or missing block palettes never become arbitrary debris colors, and bursts remain bounded', () => {
  const event: GameEvent = { type: 'event', roundId: 1, event: 'impact', position: { x: 0, y: 0, z: 0 } };
  for (const blockColor of [undefined, NaN, Infinity, -.1, -1, 0x1000000, 1.5]) expect(particleColor({ ...event, blockColor }, .5)).toBeNull();
  for (const kind of ['heal', 'build', 'shot'] as const) expect(particleColor({ ...event, event: kind }, .5)).toBeNull();
  const scene = new THREE.Scene();
  const effects = new Effects(scene, 160, grenadeLoader);
  for (let i = 0; i < 100; i++) effects.event({ ...event, event: 'explosion' }, 0);
  effects.update(0, 0);
  const mesh = scene.getObjectByName('UBERCUBE impact particles') as THREE.InstancedMesh;
  expect(mesh.count).toBe(384);
});

test('corpse blood reuses living-hit particles at the contact without creating gameplay events or traces', () => {
  const scene = new THREE.Scene(), effects = new Effects(scene, 160, grenadeLoader);
  const point = { x: 12, y: 1.4, z: 18 };
  const livingHit: GameEvent = { type: 'event', event: 'impact', roundId: 1, position: point, targetId: 1 };
  for (const random of [0, .5, 1]) {
    expect(particleColor({ event: 'blood' }, random)).toEqual(particleColor(livingHit, random));
  }
  effects.blood(point);
  effects.update(0, 0);
  const mesh = scene.getObjectByName('UBERCUBE impact particles') as THREE.InstancedMesh;
  const matrix = new THREE.Matrix4(), color = new THREE.Color();
  expect(mesh.count).toBe(8);
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, matrix); mesh.getColorAt(i, color);
    expect(new THREE.Vector3().setFromMatrixPosition(matrix).distanceTo(new THREE.Vector3(point.x, point.y, point.z))).toBeLessThan(.000001);
    expect(color.r - color.g).toBeCloseTo(.8, 6);
    expect(color.g).toBeCloseTo(color.b, 6);
  }
  expect((scene.getObjectByName('UBERCUBE bullets') as THREE.InstancedMesh).count).toBe(0);
  effects.update(1, 1);
  expect(mesh.count).toBe(0);
  for (let i = 0; i < 100; i++) effects.blood(point);
  effects.update(0, 1);
  expect(mesh.count).toBe(384);
  effects.clear();
  expect(mesh.count).toBe(0);
});
