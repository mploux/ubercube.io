import * as THREE from 'three';
import { PlayerVisuals } from '../../src/client/player-visuals';
import type { RemotePlayerState, WeaponId } from '../../src/shared/protocol';

export async function checkPlayers(renderer: THREE.WebGLRenderer): Promise<string[]> {
  const messages: string[] = [];
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0, 0, 0);
  const camera = new THREE.OrthographicCamera(-2, 2, 3.5, -.5, .1, 300);
  camera.position.set(0, 0, -10); camera.lookAt(0, 0, 0);
  const visuals = new PlayerVisuals(scene, 160);
  await visuals.ready;
  const target = new THREE.WebGLRenderTarget(256, 256);
  const pixels = new Uint8Array(256 * 256 * 4);
  const size = renderer.getSize(new THREE.Vector2());
  renderer.setSize(256, 256);
  const gallery = document.createElement('section');
  gallery.setAttribute('aria-label', 'Personnages Java : captures GPU');
  gallery.style.cssText = 'display:grid;grid-template-columns:repeat(3,256px);gap:16px';
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
  const player: RemotePlayerState = {
    id: 1, name: '', team: 1, weapon: 'ak47', aiming: false,
    position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, z: 0 }, yaw: 0, pitch: 0,
    alive: true, kills: 0, deaths: 0, hasGrenades: true,
  };
  const read = () => {
    renderer.setRenderTarget(target); renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels);
    renderer.setRenderTarget(null);
    return pixels.slice();
  };
  const verify = (condition: boolean, description: string) => {
    if (!condition) throw new Error(description);
    messages.push(`OK Personnages : ${description}`);
  };
  visuals.update([player], -1, 0, camera);
  const idle = read();
  const head = new THREE.Vector3(0, 2.65, -.25).project(camera);
  const offset = (Math.floor((head.y + 1) * 128) * 256 + Math.floor((head.x + 1) * 128)) * 4;
  verify([166, 131, 107].every((value, channel) => Math.abs(idle[offset + channel] - value) <= 2), 'palette de peau Java dans le framebuffer, sans ACES');
  for (const weapon of ['ak47', 'awp', 'shovel', 'grenade', 'medic'] as WeaponId[]) {
    player.weapon = weapon;
    visuals.update([player], -1, 0, camera);
    const equipped = read();
    capture(weapon);
    scene.traverse(object => { if (object.name.startsWith('UBERCUBE remote ')) object.visible = false; });
    const empty = read();
    scene.traverse(object => { if (object.name.startsWith('UBERCUBE remote ')) object.visible = true; });
    let changed = 0;
    for (let i = 0; i < equipped.length; i += 4) if (equipped[i] !== empty[i] || equipped[i + 1] !== empty[i + 1] || equipped[i + 2] !== empty[i + 2]) changed++;
    verify(changed > 10, `${weapon} visible dans la main (${changed} pixels)`);
  }
  player.weapon = 'ak47'; player.aiming = true; player.pitch = .3;
  player.velocity.z = -9;
  visuals.update([player], -1, .7, camera);
  const moving = read();
  player.yaw = -.65;
  visuals.update([player], -1, .7, camera);
  capture('Course et visée');
  player.yaw = 0;
  verify(moving.some((value, index) => value !== idle[index]), 'course et visée modifient la pose rendue');
  visuals.setFogDistance(5);
  player.pitch = 0; player.aiming = false; player.velocity.z = 0;
  visuals.update([player], -1, 0, camera);
  const fog = read();
  verify([221, 232, 255].every((value, channel) => Math.abs(fog[offset + channel] - value) <= 2), 'brouillard des corps et armes');
  visuals.setFogDistance(160);
  visuals.update([player], -1, 0, camera);
  renderer.render(scene, camera);
  renderer.setSize(size.x, size.y);
  target.dispose();
  return messages;
}
