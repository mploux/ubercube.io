import * as THREE from 'three';
import { RocketVisuals } from '../../src/client/rocket-visuals';
import { createParticleMaterial, createParticleSorter } from '../../src/client/particle-material';
import type { GameEvent, ProjectileState } from '../../src/shared/protocol';

export async function checkRocketVisuals(renderer: THREE.WebGLRenderer): Promise<string[]> {
  const scene = new THREE.Scene();
  const visuals = new RocketVisuals(scene, 160, 4, 256);
  await visuals.ready;
  const mesh = scene.getObjectByName('UBERCUBE rockets') as THREE.InstancedMesh;
  const smoke = scene.getObjectByName('UBERCUBE rocket smoke') as THREE.InstancedMesh;
  const target = new THREE.WebGLRenderTarget(128, 128);
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, .1, 1000);
  camera.position.set(0, 0, 3); camera.lookAt(0, 0, 0);
  const previousTarget = renderer.getRenderTarget();
  const previousColor = renderer.getClearColor(new THREE.Color());
  const previousAlpha = renderer.getClearAlpha();
  const previousAutoClear = renderer.autoClear;
  const messages: string[] = [];

  function read(): { green: number; centerX: number; grey: number; center: number[] } {
    renderer.setRenderTarget(target); renderer.render(scene, camera);
    const pixels = new Uint8Array(128 * 128 * 4);
    renderer.readRenderTargetPixels(target, 0, 0, 128, 128, pixels);
    let green = 0, totalX = 0, grey = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > 10 && pixels[index + 1] > pixels[index] * 1.1 && pixels[index + 2] < pixels[index] * .6) {
        green++; totalX += (index / 4) % 128;
      }
      if (pixels[index] > 8 && Math.abs(pixels[index] - pixels[index + 1]) <= 2 && Math.abs(pixels[index] - pixels[index + 2]) <= 2) grey++;
    }
    return { green, centerX: green ? totalX / green : -1, grey,
      center: Array.from(pixels.slice((64 + 64 * 128) * 4, (64 + 64 * 128) * 4 + 3)) };
  }

  try {
    renderer.setClearColor(0x000000, 1); renderer.autoClear = true;
    const shot: GameEvent = { type: 'event', roundId: 1, event: 'shot', projectileId: 1, tick: 10,
      weapon: 'rpg', shooterId: 1, position: { x: -.6, y: 0, z: 0 }, velocity: { x: 60, y: 0, z: 0 } };
    visuals.event(shot, 1); visuals.update(1, camera);
    smoke.visible = false;
    const first = read();
    visuals.update(1.015, camera);
    const second = read();
    if (!first.green || !second.green || Math.abs(second.centerX - first.centerX - 28.8) > 1) {
      throw new Error(`Roquette absente ou immobile : pixels ${first.green}/${second.green}, centres ${first.centerX}/${second.centerX}`);
    }
    messages.push(`OK RPG : roquette verte du modèle mobile à 60 blocs/s, déplacement ${(second.centerX - first.centerX).toFixed(1)} pixels`);

    smoke.visible = true;
    visuals.event({ ...shot, event: 'impact', tick: 12, position: { x: .3, y: 0, z: 0 } }, 1.03);
    visuals.update(1.035, camera);
    // The tail plume has drifted left of the narrow projectile-motion framing.
    camera.left = -4; camera.right = 4; camera.updateProjectionMatrix();
    const afterImpact = read();
    if (afterImpact.green || !afterImpact.grey) throw new Error(`Impact RPG : pixels projectile ${afterImpact.green}, fumée ${afterImpact.grey}, particules ${smoke.count}`);
    visuals.update(4.3, camera);
    if (read().grey) throw new Error('Fumée RPG présente après la fin de sa durée de vie');
    camera.left = -2; camera.right = 2; camera.updateProjectionMatrix();
    messages.push('OK RPG : impact retire le projectile et conserve la fumée jusqu’à sa dissipation');

    visuals.clear();
    const state: ProjectileState = { id: 2, owner: 1, weapon: 'rpg', position: { x: 0, y: 0, z: 0 }, velocity: { x: 60, y: 0, z: 0 } };
    visuals.snapshot([state], 30, 5); visuals.update(5, camera);
    mesh.visible = false;
    smoke.count = 1;
    smoke.setMatrixAt(0, new THREE.Matrix4()); smoke.setColorAt(0, new THREE.Color(.5, .5, .5));
    smoke.instanceMatrix.needsUpdate = true; smoke.instanceColor!.needsUpdate = true;
    const alpha = read().center;
    if (alpha.some(value => Math.abs(value - 116) > 2)) throw new Error(`Alpha/couleur fumée Java incorrect : RGB ${alpha}, attendu 116,116,116`);
    camera.position.z = 160; camera.updateMatrixWorld();
    const fog = read().center;
    if (fog.some((value, index) => Math.abs(value - [221, 232, 255][index]) > 2)) throw new Error(`Brouillard fumée RPG incorrect : RGB ${fog}`);
    messages.push(`OK RPG : fumée transparente Java RGB ${alpha}, brouillard RGB ${fog}`);

    camera.position.z = 3; camera.updateMatrixWorld(); mesh.visible = true;
    visuals.clear(); visuals.snapshot([state], 33, 6); visuals.update(6, camera);
    smoke.visible = false;
    if (!read().green) throw new Error('Roquette absente sur arrivée en cours de vol');
    visuals.snapshot([], 36, 6.05); visuals.update(6.05, camera);
    if (read().green) throw new Error('Roquette absente du snapshot encore dessinée');
    visuals.clear(); smoke.visible = true;
    if (read().green || read().grey) throw new Error('Reset RPG : effets encore présents');
    messages.push('OK RPG : arrivée en vol depuis snapshot, disparition autoritaire et reset');

    const geometry = new THREE.BoxGeometry(1, 1, .2);
    geometry.setAttribute('instanceOpacity', new THREE.InstancedBufferAttribute(new Float32Array([.4, .6]), 1));
    const overlap = new THREE.InstancedMesh(geometry, createParticleMaterial(160, true), 2);
    overlap.frustumCulled = false;
    overlap.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0, .6));
    overlap.setColorAt(0, new THREE.Color(0, .5, 0));
    overlap.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0, 0, -.6));
    overlap.setColorAt(1, new THREE.Color(.5, 0, 0));
    const sort = createParticleSorter(overlap);
    const occluder = new THREE.Mesh(new THREE.BoxGeometry(1, 1, .1), new THREE.MeshBasicMaterial({ color: 0x0000ff }));
    occluder.visible = false;
    scene.add(overlap, occluder);
    try {
      sort(camera);
      const front = read().center;
      camera.position.z = -3; camera.lookAt(0, 0, 0);
      sort(camera);
      const back = read().center;
      if (front.some((value, index) => Math.abs(value - [60, 66, 0][index]) > 2)
        || back.some((value, index) => Math.abs(value - [99, 27, 0][index]) > 2)) {
        throw new Error(`Tri alpha incorrect au premier rendu de chaque caméra : avant ${front}, arrière ${back}`);
      }
      camera.position.z = 3; camera.lookAt(0, 0, 0);
      occluder.visible = true;
      sort(camera);
      const occluded = read().center;
      if (occluded.some((value, index) => Math.abs(value - [0, 66, 153][index]) > 2)) {
        throw new Error(`Particules visibles à travers la géométrie opaque : RGB ${occluded}`);
      }
      messages.push(`OK particules : alpha de loin vers près après inversion caméra, RGB ${front} / ${back} ; occlusion opaque RGB ${occluded}`);
    } finally {
      scene.remove(overlap, occluder);
      geometry.dispose(); overlap.material.dispose(); occluder.geometry.dispose(); occluder.material.dispose();
    }
    return messages;
  } finally {
    visuals.dispose(); target.dispose();
    renderer.setRenderTarget(previousTarget); renderer.setClearColor(previousColor, previousAlpha);
    renderer.autoClear = previousAutoClear;
  }
}
