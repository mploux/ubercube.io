import * as THREE from 'three';
import { BulletVisuals } from '../../src/client/bullet-visuals';
import type { GameEvent } from '../../src/shared/protocol';

export function checkBulletVisuals(renderer: THREE.WebGLRenderer): string[] {
  const scene = new THREE.Scene();
  const visuals = new BulletVisuals(scene, 160, 4);
  const target = new THREE.WebGLRenderTarget(128, 128);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 10);
  camera.position.set(0, 0, 3);
  camera.lookAt(0, 0, 0);
  const previousTarget = renderer.getRenderTarget();
  const previousColor = renderer.getClearColor(new THREE.Color());
  const previousAlpha = renderer.getClearAlpha();
  const previousAutoClear = renderer.autoClear;
  const messages: string[] = [];

  function read(): { pixels: Uint8Array; yellow: number; centerX: number } {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const pixels = new Uint8Array(128 * 128 * 4);
    renderer.readRenderTargetPixels(target, 0, 0, 128, 128, pixels);
    let yellow = 0, totalX = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] >= 253 && pixels[index + 1] >= 253 && pixels[index + 2] <= 2) {
        yellow++;
        totalX += (index / 4) % 128;
      }
    }
    return { pixels, yellow, centerX: yellow ? totalX / yellow : -1 };
  }

  try {
    renderer.setClearColor(0x000000, 1);
    renderer.autoClear = true;
    const shot: GameEvent = { type: 'event', roundId: 1, event: 'shot', projectileId: 1, tick: 10,
      weapon: 'ak47', shooterId: 1, position: { x: -1, y: 0, z: 0 }, velocity: { x: 300, y: 0, z: 0 } };
    visuals.event(shot, 1);
    visuals.event({ ...shot, event: 'impact', position: { x: 1, y: 0, z: 0 } }, 1);
    visuals.update(1.02);
    const impactFrame = read();
    const center = Array.from(impactFrame.pixels.slice((64 + 64 * 128) * 4, (64 + 64 * 128) * 4 + 3));
    if (!impactFrame.yellow || center[0] < 253 || center[1] < 253 || center[2] > 2) {
      throw new Error(`Balle impactée avant la frame invisible ou mal colorée : RGB ${center}`);
    }
    messages.push(`OK Balle : tir et impact pré-frame, ${impactFrame.yellow} pixels jaunes, RGB ${center}`);
    visuals.update(1.04);
    if (read().yellow !== 0) throw new Error('Balle encore dessinée après son impact');
    messages.push('OK Balle : disparition effective après impact');

    visuals.clear();
    visuals.event({ ...shot, position: { x: -3, y: 0, z: 0 } }, 2);
    visuals.update(2.0085);
    const first = read();
    visuals.update(2.0105);
    const second = read();
    if (!first.yellow || !second.yellow || second.centerX - first.centerX < 30) {
      throw new Error(`Trajet de balle non dessiné entre snapshots : pixels ${first.yellow}/${second.yellow}, centres ${first.centerX}/${second.centerX}`);
    }
    messages.push(`OK Balle : trajet animé sans nouveau snapshot, centres X ${first.centerX.toFixed(1)} → ${second.centerX.toFixed(1)}`);
    return messages;
  } finally {
    visuals.dispose();
    target.dispose();
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousColor, previousAlpha);
    renderer.autoClear = previousAutoClear;
  }
}
