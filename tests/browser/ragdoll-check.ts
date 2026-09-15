import * as THREE from 'three';
import { PlayerVisuals } from '../../src/client/player-visuals';
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
  visuals.clear();
  renderer.setSize(size.x, size.y);
  floor.geometry.dispose(); floor.material.dispose(); grid.geometry.dispose();
  (grid.material as THREE.Material).dispose();
  return messages;
}
