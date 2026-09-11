import * as THREE from 'three';
import { BulletVisuals } from '../../src/client/bullet-visuals';
import { loadWeaponModel } from '../../src/client/weapon-model';
import { WeaponView, type WeaponViewInput } from '../../src/client/weapon-view';
import { getWeaponMuzzle } from '../../src/shared/weapon-pose';
import type { WeaponId } from '../../src/shared/protocol';

export async function checkMuzzleAlignment(renderer: THREE.WebGLRenderer): Promise<string[]> {
  const models = new Map<WeaponId, THREE.Group>();
  const view = new WeaponView(async weapon => {
    const model = await loadWeaponModel(weapon);
    models.set(weapon, model);
    return model;
  });
  const width = 512, height = 288;
  const target = new THREE.WebGLRenderTarget(width, height);
  const scene = new THREE.Scene();
  const bullets = new BulletVisuals(scene, 160, 1);
  const camera = new THREE.PerspectiveCamera(70, width / height, .05, 1000);
  camera.position.set(21, 15, -13);
  camera.rotation.set(-.31, .57, 0, 'YXZ');
  camera.updateMatrixWorld();
  const input: WeaponViewInput = { moveX: 0, moveZ: 0, sprint: false, fire: false, alt: false,
    lookDeltaYaw: 0, lookDeltaPitch: 0, mouseDX: 0, mouseDY: 0, grenades: 10 };
  const previousTarget = renderer.getRenderTarget();
  const previousSize = renderer.getSize(new THREE.Vector2());
  const previousRatio = renderer.getPixelRatio();
  const previousStyle = { width: renderer.domElement.style.width, height: renderer.domElement.style.height };
  const previousViewport = renderer.getViewport(new THREE.Vector4());
  const previousScissor = renderer.getScissor(new THREE.Vector4());
  const previousScissorTest = renderer.getScissorTest();
  const previousColor = renderer.getClearColor(new THREE.Color());
  const previousAlpha = renderer.getClearAlpha();
  const previousAutoClear = renderer.autoClear;
  const messages: string[] = [];
  const sheet = document.createElement('section');
  sheet.id = 'muzzle-check-captures';
  sheet.setAttribute('aria-label', 'Gun muzzle and bullet alignment');
  sheet.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;max-width:1100px;margin-top:24px';
  document.getElementById(sheet.id)?.remove();
  document.body.append(sheet);

  function read(): Uint8Array {
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    return pixels;
  }

  function bulletFrame(weapon: WeaponId, origin: THREE.Vector3, direction: THREE.Vector3): Uint8Array {
    bullets.clear();
    bullets.event({ type: 'event', roundId: 1, event: 'shot', projectileId: 1, tick: 1,
      weapon, position: origin, velocity: direction.clone().multiplyScalar(weapon === 'ak47' ? 300 : 600) }, 0);
    bullets.update(0);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    return read();
  }

  function capture(label: string): void {
    const pixels = read();
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.style.cssText = 'display:block;width:100%;height:auto;border:1px solid #46505a';
    const image = new ImageData(width, height);
    for (let row = 0; row < height; row++) {
      image.data.set(pixels.subarray(row * width * 4, (row + 1) * width * 4), (height - row - 1) * width * 4);
    }
    canvas.getContext('2d')!.putImageData(image, 0, 0);
    const figure = document.createElement('figure');
    figure.style.margin = '0';
    const caption = document.createElement('figcaption');
    caption.textContent = label;
    figure.append(canvas, caption); sheet.append(figure);
  }

  try {
    await view.ready;
    renderer.setPixelRatio(1);
    renderer.setSize(width, height);
    renderer.setRenderTarget(target);
    renderer.setViewport(0, 0, width, height);
    renderer.setScissorTest(false);
    renderer.setClearColor(0x000000, 1);
    renderer.autoClear = false;

    for (const weapon of ['ak47', 'awp'] as const) {
      const model = models.get(weapon);
      if (!model) throw new Error(`Muzzle check: missing real ${weapon} OBJ`);
      // The frontmost OBJ plane is the barrel mouth, independent of the gameplay muzzle preset.
      let tipMesh: THREE.Mesh | undefined;
      let maxZ = -Infinity;
      const mouth = new THREE.Box3();
      const vertex = new THREE.Vector3();
      model.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const positions = object.geometry.getAttribute('position');
        for (let index = 0; index < positions.count; index++) {
          vertex.fromBufferAttribute(positions, index);
          if (vertex.z > maxZ + .00001) { maxZ = vertex.z; mouth.makeEmpty(); tipMesh = object; }
          if (Math.abs(vertex.z - maxZ) <= .00001) mouth.expandByPoint(vertex);
        }
      });
      if (!tipMesh || mouth.isEmpty()) throw new Error(`Muzzle check: ${weapon} has no barrel geometry`);
      const tip = mouth.getCenter(new THREE.Vector3());

      for (const state of ['idle', 'ADS', 'recoil'] as const) {
        view.reset(weapon);
        const controls = { ...input, alt: state === 'ADS' };
        for (let tick = 0; tick < 60; tick++) view.tick(controls, () => .5);
        if (state === 'recoil') {
          if (!view.tick({ ...controls, fire: true }, () => .5).fired) throw new Error(`${weapon}: recoil fixture did not fire`);
          view.tick(controls, () => .5);
        }
        renderer.clear(true, true, true);
        view.render(renderer, camera);
        camera.fov = view.fov;
        camera.updateProjectionMatrix();
        const weaponToWorld = new THREE.Matrix4().copy(camera.matrixWorld)
          .multiply(view.camera.matrixWorldInverse).multiply(tipMesh.matrixWorld);
        const expectedOrigin = tip.clone().applyMatrix4(weaponToWorld);
        const expectedDirection = new THREE.Vector3(0, 0, 1).transformDirection(weaponToWorld);
        const muzzle = getWeaponMuzzle(view.pose);
        const actualOrigin = new THREE.Vector3(muzzle.position.x, muzzle.position.y, -muzzle.position.z).applyMatrix4(camera.matrixWorld);
        const actualDirection = new THREE.Vector3(muzzle.direction.x, muzzle.direction.y, -muzzle.direction.z).transformDirection(camera.matrixWorld);
        const distance = actualOrigin.distanceTo(expectedOrigin);
        if (distance > .00001 || actualDirection.distanceTo(expectedDirection) > .00001) {
          throw new Error(`${weapon} ${state}: bullet origin is ${distance.toFixed(6)} world units from the rendered OBJ mouth`);
        }
        const expected = bulletFrame(weapon, expectedOrigin, expectedDirection);
        const actual = bulletFrame(weapon, actualOrigin, actualDirection);
        let yellow = 0, difference = 0;
        for (let index = 0; index < actual.length; index += 4) {
          if (actual[index] > 250 && actual[index + 1] > 250 && actual[index + 2] < 5) yellow++;
          if ([0, 1, 2].some(channel => Math.abs(actual[index + channel] - expected[index + channel]) > 2)) difference++;
        }
        if (!yellow || difference > 2) throw new Error(`${weapon} ${state}: barrel/bullet GPU mismatch (${yellow} yellow pixels, ${difference} differing pixels)`);
        view.render(renderer, camera);
        capture(`${weapon} ${state}: bullet starts at the OBJ barrel mouth`);
        messages.push(`OK Muzzle: ${weapon} ${state}, ${yellow} bullet pixels, ${difference} pixels differ from the OBJ mouth reference`);
      }
    }
    return messages;
  } finally {
    bullets.dispose(); view.dispose(); target.dispose();
    renderer.setPixelRatio(previousRatio);
    renderer.setSize(previousSize.x, previousSize.y);
    renderer.domElement.style.width = previousStyle.width;
    renderer.domElement.style.height = previousStyle.height;
    renderer.setRenderTarget(previousTarget);
    renderer.setViewport(previousViewport); renderer.setScissor(previousScissor); renderer.setScissorTest(previousScissorTest);
    renderer.setClearColor(previousColor, previousAlpha); renderer.autoClear = previousAutoClear;
  }
}
