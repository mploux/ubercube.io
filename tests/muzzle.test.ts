import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { WeaponView, type WeaponViewInput } from '../src/client/weapon-view';
import { parseWeaponModel, WEAPON_MODEL_FILES } from '../src/client/weapon-model';
import { getWeaponMuzzle } from '../src/shared/weapon-pose';
import { GameServer } from '../src/server/game';
import { EYE_HEIGHT } from '../src/shared/movement';
import { PROTOCOL_VERSION, type GameEvent, type InputFrame, type WeaponId } from '../src/shared/protocol';
import { decodeServerMessage } from '../src/shared/wire';

async function load(weapon: WeaponId): Promise<THREE.Group> {
  const path = `public/assets/weapons/${WEAPON_MODEL_FILES[weapon]}`;
  return parseWeaponModel(await Bun.file(`${path}.obj`).text(), await Bun.file(`${path}.mtl`).text());
}

function barrelTip(model: THREE.Object3D): THREE.Vector3 {
  const vertices: THREE.Vector3[] = [];
  model.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const positions = object.geometry.getAttribute('position');
    for (let index = 0; index < positions.count; index++) vertices.push(new THREE.Vector3().fromBufferAttribute(positions, index));
  });
  const front = vertices.reduce((max, vertex) => Math.max(max, vertex.z), -Infinity);
  return new THREE.Box3().setFromPoints(vertices.filter(vertex => Math.abs(vertex.z - front) < .00001)).getCenter(new THREE.Vector3());
}

const still: WeaponViewInput = { moveX: 0, moveZ: 0, sprint: false, fire: false, alt: false,
  lookDeltaYaw: 0, lookDeltaPitch: 0, grenades: 10 };

test.each(['ak47', 'awp'] as const)('%s muzzle coincides with the actual OBJ barrel through aiming and recoil', async weapon => {
  const view = new WeaponView(load);
  await view.ready;
  const renderer = { domElement: { clientWidth: 1280, clientHeight: 720 }, autoClear: false,
    clearDepth() {}, render(scene: THREE.Scene) { scene.updateMatrixWorld(true); } } as unknown as THREE.WebGLRenderer;
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, .05, 1000);
  camera.position.set(123, 41, 67);
  try {
    for (const alt of [false, true]) {
      view.reset(weapon);
      for (let tick = 0; tick < 80; tick++) view.tick({ ...still, alt });
      for (let tick = 0; tick < 16; tick++) {
        view.tick({ ...still, alt, fire: true, moveX: .5, moveZ: 1, lookDeltaYaw: .015, lookDeltaPitch: -.007 }, () => .4);
        camera.rotation.set(.25 + tick * .01, -.8 + tick * .02, 0, 'YXZ');
        camera.fov = view.fov;
        camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
        view.render(renderer, camera);
        const root = view.scene.getObjectByName('first-person weapon')!;
        const tip = root.localToWorld(barrelTip(root.children[0])).project(view.camera);
        const muzzle = getWeaponMuzzle(view.pose);
        const emitted = new THREE.Vector3(muzzle.position.x, muzzle.position.y, -muzzle.position.z)
          .applyMatrix4(camera.matrixWorld).project(camera);
        expect(emitted.distanceTo(tip)).toBeLessThan(.00001);
      }
    }
  } finally { view.dispose(); }
});

test.each(['ak47', 'awp'] as const)('%s authoritative shot starts at the mesh barrel under world yaw and pitch', async weapon => {
  const view = new WeaponView(load);
  await view.ready;
  const game = new GameServer();
  const shots: GameEvent[] = [];
  const connection = game.connect({ bufferedAmount: () => 0, close() {}, send(data) {
    const message = decodeServerMessage(data);
    if (message.type === 'event' && message.event === 'shot') shots.push(message);
    return data.length;
  } })!;
  game.receive(connection, JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: 'Muzzle' }));
  game.receive(connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: weapon === 'ak47' ? 'assault' : 'sniper' }));
  const player = connection.player!;
  view.reset(weapon);
  try {
    for (let tick = 1; tick <= 82; tick++) {
      player.position = { x: 100, y: 45, z: 100 }; player.velocity = { x: 0, y: 0, z: 0 };
      const input: InputFrame = { ...still, seq: tick, roundId: game.roundId, yaw: .9, pitch: .2,
        jump: false, alt: true, fire: tick === 82, weapon };
      // Only protocol fields cross this boundary; model coordinates are never supplied by the client.
      const { moveX, moveZ, sprint, fire, alt, seq, roundId, yaw, pitch, jump } = input;
      game.receive(connection, JSON.stringify({ type: 'input', frames: [{ moveX, moveZ, sprint, fire, alt, seq, roundId, yaw, pitch, jump, weapon }] }));
      game.step();
      view.tick({ ...still, alt: true, fire: tick === 82 });
    }
    expect(shots).toHaveLength(1);
    view.scene.updateMatrixWorld(true);
    const root = view.scene.getObjectByName('first-person weapon')!;
    const tip = root.localToWorld(barrelTip(root.children[0]));
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(player.position.x, player.position.y + EYE_HEIGHT, player.position.z);
    camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ'); camera.updateMatrixWorld(true);
    tip.applyMatrix4(camera.matrixWorld);
    const origin = shots[0].position;
    expect(tip.distanceTo(new THREE.Vector3(origin.x, origin.y, origin.z))).toBeLessThan(.00001);
  } finally { view.dispose(); }
});
