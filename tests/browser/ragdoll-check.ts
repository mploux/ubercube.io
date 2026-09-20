import * as THREE from 'three';
import { PlayerVisuals } from '../../src/client/player-visuals';
import { Effects } from '../../src/client/presentation';
import type { GameEvent, PlayerState } from '../../src/shared/protocol';

export async function checkRagdolls(renderer: THREE.WebGLRenderer): Promise<string[]> {
  const messages: string[] = [];
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#b9c9db');
  const camera = new THREE.PerspectiveCamera(45, 1, .1, 100);
  camera.position.set(25, 5, 28); camera.lookAt(20, 1.5, 20);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(20, 1, 20), new THREE.MeshBasicMaterial({ color: '#6d7b69' }));
  floor.position.set(20, .5, 20); scene.add(floor);
  const grid = new THREE.GridHelper(20, 20, 0x56654f, 0x778870);
  grid.position.set(20, 1.001, 20); scene.add(grid);
  const visuals = new PlayerVisuals(scene, 160);
  await visuals.ready;
  const world = { config: { size: 64, height: 64, seed: 1 }, get: (_x: number, y: number, _z: number) => y === 0 ? 1 : 0 };
  visuals.setWorld(world);
  const mesh = scene.getObjectByName('UBERCUBE articulated bodies') as THREE.InstancedMesh;
  const size = renderer.getSize(new THREE.Vector2());
  renderer.setSize(256, 256);
  const gallery = document.createElement('section');
  gallery.setAttribute('aria-label', 'Ragdolls : impacts et chute');
  gallery.style.cssText = 'display:grid;grid-template-columns:repeat(4,256px);gap:16px';
  document.body.prepend(gallery);
  const capture = (label: string) => {
    renderer.render(scene, camera);
    const figure = document.createElement('figure'); figure.style.margin = '0';
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    canvas.style.cssText = 'width:256px;height:256px';
    canvas.getContext('2d')!.drawImage(renderer.domElement, 0, 0);
    const caption = document.createElement('figcaption'); caption.textContent = label;
    figure.append(canvas, caption); gallery.append(figure);
  };
  const position = (index: number) => {
    const matrix = new THREE.Matrix4(); mesh.getMatrixAt(index, matrix);
    return new THREE.Vector3(0, .5, 0).applyMatrix4(matrix);
  };
  const outcomes: number[] = [];
  for (const sign of [-1, 1]) {
    visuals.clear();
    const player: PlayerState = {
      id: 1, name: '', team: 1, kit: 'assault', weapon: 'ak47', aiming: false,
      position: { x: 20, y: 1, z: 20 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0,
      grounded: true, alive: true, health: 100, kills: 0, deaths: 0, ammo: 30, grenades: 10, lastSeq: 0,
    };
    visuals.update([player], -1, 0, camera);
    const start = position(1);
    const event: GameEvent = { type: 'event', event: 'death', roundId: 1, tick: 1, targetId: 1,
      position: { ...player.position }, weapon: 'ak47', headshot: true,
      death: { player: { ...player, alive: false, health: 0, deaths: 1 },
        hitPoint: { x: 20 - sign * .25, y: 3.7, z: 20.1 }, impulse: { x: sign * 12, y: 0, z: 0 } } };
    visuals.death(event, player, 0);
    visuals.update([event.death!.player], -1, 0, camera);
    capture(`${sign < 0 ? '←' : '→'} Impact tête · 0 s`);
    let previous = 0;
    for (const frame of [12, 36, 180]) {
      for (let i = previous + 1; i <= frame; i++) visuals.update([event.death!.player], -1, i / 120, camera);
      previous = frame;
      if (mesh.count !== 10) throw new Error('Le cadavre doit conserver dix membres visibles');
      if (frame === 12) {
        if ((position(1).x - start.x) * sign <= .02) throw new Error('La tête ne suit pas le sens du projectile');
        outcomes.push(position(1).x - start.x);
      }
      capture(`${sign < 0 ? '←' : '→'} Impact tête · ${(frame / 120).toFixed(1)} s`);
    }
    if (position(0).y >= 2) throw new Error('Le torse ne s’effondre pas sur le sol');
    for (let i = 0; i < 10; i++) {
      const p = position(i);
      if (![p.x, p.y, p.z].every(Number.isFinite) || p.y < .8 || p.y > 5) throw new Error('Corps instable ou passé sous le terrain');
    }
  }
  messages.push(`OK Ragdolls : impulsions opposées au point touché (${outcomes.map(x => x.toFixed(3)).join(' / ')} blocs à 0,1 s)`);
  messages.push('OK Ragdolls : dix membres rendus, corps au sol, huit captures de la chute');
  const effects = new Effects(scene, 160);
  await effects.ready;
  const particles = scene.getObjectByName('UBERCUBE impact particles') as THREE.InstancedMesh;
  const displacements: number[] = [];
  for (const weapon of ['ak47', 'awp'] as const) {
    visuals.clear(); effects.clear();
    const player: PlayerState = {
      id: 2, name: '', team: 1, kit: 'assault', weapon, aiming: false,
      position: { x: 20, y: 1, z: 20 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0,
      grounded: true, alive: true, health: 100, kills: 0, deaths: 0, ammo: 30, grenades: 10, lastSeq: 0,
    };
    visuals.update([player], -1, 0, camera);
    visuals.death({ type: 'event', event: 'death', roundId: 1, tick: 1, targetId: player.id,
      position: { ...player.position }, weapon,
      death: { player: { ...player, alive: false, health: 0, deaths: 1 },
        hitPoint: { x: 20, y: 2, z: 20 }, impulse: { x: 0, y: 0, z: 0 } } }, player, 0);
    const dead = { ...player, alive: false, deaths: 1 };
    for (let i = 0; i <= 480; i++) visuals.update([dead], -1, i / 120, camera);
    const before = Array.from({ length: 10 }, (_, i) => position(i));
    const head = before[1];
    const outward = head.clone().sub(before[0]).setY(0).normalize();
    if (outward.lengthSq() < .5) outward.set(0, 0, 1);
    // A lateral hit shows the joint reaction; an axial hit mostly compresses the grounded body.
    outward.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    const origin = head.clone().addScaledVector(outward, 4);
    const end = head.clone().addScaledVector(outward, -.5);
    const shot: GameEvent = { type: 'event', event: 'shot', roundId: 1, tick: 241, shooterId: 3,
      projectileId: weapon === 'ak47' ? 10 : 11, weapon, position: origin, endPosition: end };
    const misses: GameEvent[] = [
      { ...shot, projectileId: 100, position: origin.clone().add(new THREE.Vector3(0, 3, 0)), endPosition: end.clone().add(new THREE.Vector3(0, 3, 0)) },
      { ...shot, projectileId: 101, endPosition: origin.clone().lerp(end, .25) },
    ];
    for (const miss of misses) {
      effects.event(miss, 4);
      const hit = visuals.shot(miss, 4);
      if (hit) throw new Error('Un tir manqué ou arrêté avant le cadavre ne doit pas le toucher');
    }
    effects.update(0, 4);
    if (particles.count !== 0) throw new Error('Un tir manqué ne doit pas produire de sang');
    effects.clear();
    camera.position.copy(before[0]).add(new THREE.Vector3(3, 3, 4)); camera.lookAt(before[0]);
    capture(`${weapon.toUpperCase()} · cadavre au repos`);
    effects.event(shot, 4);
    const hit = visuals.shot(shot, 4);
    if (!hit) throw new Error(`${weapon} ne touche pas la tête visible du cadavre`);
    if (head.distanceTo(hit) > .5) throw new Error('L’impact ne correspond pas au membre visible visé');
    effects.blood(hit);
    effects.update(0, 4);
    if (Number(particles.count) !== 8) throw new Error('Un impact sur cadavre doit produire huit particules de sang');
    for (let i = 0; i < particles.count; i++) {
      const color = new THREE.Color(); particles.getColorAt(i, color);
      const matrix = new THREE.Matrix4(); particles.getMatrixAt(i, matrix);
      if (color.r < .75 || Math.abs(color.g) > .051 || Math.abs(color.b) > .051) throw new Error('Les particules du cadavre doivent utiliser le sang rouge existant');
      if (new THREE.Vector3().setFromMatrixPosition(matrix).distanceTo(hit) > .001) throw new Error('Le sang doit apparaître au point touché');
    }
    capture(`${weapon.toUpperCase()} · impact ×4 et sang`);
    for (let i = 1; i <= 24; i++) {
      visuals.update([dead], -1, 4 + i / 120, camera);
      effects.update(1 / 120, 4 + i / 120);
    }
    const displacement = Math.max(...before.map((p, i) => p.distanceTo(position(i))));
    if (displacement < .025) throw new Error('Le cadavre au repos ne réagit pas au nouvel impact');
    displacements.push(displacement);
    capture(`${weapon.toUpperCase()} · réaction à 0,2 s`);
    const gl = renderer.getContext();
    const pixels = new Uint8Array(256 * 256 * 4);
    gl.readPixels(0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let redPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 120 && pixels[i + 1] < 70 && pixels[i + 2] < 70) redPixels++;
    if (redPixels === 0) throw new Error('Le sang du cadavre n’apparaît pas dans le rendu WebGL');
  }
  messages.push(`OK Ragdolls : nouveaux impacts AK/AWP ×4 sur cadavres au repos (${displacements.map(x => x.toFixed(3)).join(' / ')} blocs à 0,2 s)`);
  messages.push('OK Ragdolls : tirs manqués et arrêtés exclus, huit particules au contact, sang rouge confirmé dans le rendu WebGL');
  effects.clear();
  visuals.clear();
  renderer.setSize(size.x, size.y);
  floor.geometry.dispose(); floor.material.dispose(); grid.geometry.dispose();
  (grid.material as THREE.Material).dispose();
  return messages;
}
