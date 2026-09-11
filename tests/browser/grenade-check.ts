import * as THREE from 'three';
import { GrenadeVisuals } from '../../src/client/grenade-visuals';
import { loadWeaponModel } from '../../src/client/weapon-model';
import type { ProjectileState } from '../../src/shared/protocol';
import { VoxelWorld } from '../../src/shared/voxel';

export async function checkGrenadeVisuals(renderer: THREE.WebGLRenderer): Promise<string[]> {
  const scene = new THREE.Scene();
  let loaded = false;
  const visuals = new GrenadeVisuals(scene, 160, 4, async () => {
    const model = await loadWeaponModel('grenade');
    loaded = true;
    return model;
  });
  const width = 256, height = 128;
  const target = new THREE.WebGLRenderTarget(width, height);
  const camera = new THREE.OrthographicCamera(-2, 2, 1, -1, .1, 1000);
  camera.position.set(0, 0, 3); camera.lookAt(0, 0, 0);
  const previousTarget = renderer.getRenderTarget();
  const previousViewport = renderer.getViewport(new THREE.Vector4());
  const previousScissor = renderer.getScissor(new THREE.Vector4());
  const previousScissorTest = renderer.getScissorTest();
  const previousColor = renderer.getClearColor(new THREE.Color());
  const previousAlpha = renderer.getClearAlpha();
  const previousAutoClear = renderer.autoClear;
  const messages: string[] = [];
  const sheet = document.createElement('section');
  sheet.id = 'grenade-check-captures';
  sheet.setAttribute('aria-label', 'Grenades : modèle original, interpolation et lancer immédiat');
  sheet.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;max-width:1100px;margin-top:24px';
  document.getElementById(sheet.id)?.remove(); document.body.append(sheet);

  function projectile(id: number, x: number): ProjectileState {
    return { id, weapon: 'grenade', owner: 1, position: { x, y: 0, z: 0 }, velocity: { x: 24, y: 0, z: 0 } };
  }

  function capture(label?: string) {
    renderer.setRenderTarget(target);
    renderer.setViewport(0, 0, width, height); renderer.setScissorTest(false);
    renderer.render(scene, camera);
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    let occupied = 0, green = 0, gray = 0, left = 0, right = 0, middle = 0, totalX = 0, fog = 0, fingerprint = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const [r, g, b] = pixels.subarray(index, index + 3);
      fingerprint = (Math.imul(fingerprint, 31) + ((r << 16) | (g << 8) | b)) | 0;
      if (!r && !g && !b) continue;
      const x = (index / 4) % width;
      occupied++; totalX += x;
      if (g > r * 1.5 && g > b * 1.5) green++;
      if (r > 20 && Math.max(r, g, b) - Math.min(r, g, b) <= 2) gray++;
      if (x < 112) left++;
      else if (x > 144) right++;
      else middle++;
      if (Math.abs(r - 221) <= 2 && Math.abs(g - 232) <= 2 && Math.abs(b - 255) <= 2) fog++;
    }
    if (label) {
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.style.cssText = 'display:block;width:100%;height:auto;border:1px solid #46505a';
      const image = new ImageData(width, height);
      for (let row = 0; row < height; row++) image.data.set(pixels.subarray(row * width * 4, (row + 1) * width * 4), (height - row - 1) * width * 4);
      canvas.getContext('2d')!.putImageData(image, 0, 0);
      const figure = document.createElement('figure'); figure.style.margin = '0';
      const caption = document.createElement('figcaption'); caption.textContent = label;
      figure.append(canvas, caption); sheet.append(figure);
    }
    return { occupied, green, gray, left, right, middle, fog, fingerprint, centerX: occupied ? totalX / occupied : -1 };
  }

  try {
    await visuals.ready;
    const mesh = scene.getObjectByName('UBERCUBE thrown grenades') as THREE.InstancedMesh | undefined;
    if (!loaded || !mesh?.isInstancedMesh || mesh.geometry.getAttribute('position').count !== 306) {
      throw new Error('Grenade lancée : géométrie OBJ originale absente');
    }
    renderer.setClearColor(0x000000, 1); renderer.autoClear = true;
    visuals.snapshot([projectile(1, -.65), projectile(2, .65)], 0, 1);
    visuals.update(1.1);
    const twins = capture('Deux grenades : corps vert et pièces grises');
    if (twins.green < 16 || twins.gray < 8) throw new Error(`Palette grenade absente : ${twins.green} pixels verts / ${twins.gray} gris`);
    messages.push(`OK Grenade : OBJ/MTL original, ${twins.green} pixels verts et ${twins.gray} gris`);
    if (twins.left < 16 || twins.right < 16 || twins.middle !== 0) throw new Error(`Instances grenade superposées ou absentes : ${JSON.stringify(twins)}`);
    messages.push('OK Grenade : deux instances distinctes aux positions serveur');

    visuals.event({ type: 'event', roundId: 1, event: 'explosion', weapon: 'grenade', projectileId: 1, tick: 1,
      position: { x: -.65, y: 0, z: 0 } }, 1.11);
    visuals.update(1.11);
    const exploded = capture('Explosion : seule la deuxième grenade reste');
    if (exploded.left !== 0 || exploded.right < 16) throw new Error('Explosion : mauvaise instance retirée');
    messages.push('OK Grenade : disparition immédiate de la seule grenade explosée');
    visuals.clear();
    if (capture().occupied !== 0) throw new Error('Grenade encore visible après reset');
    messages.push('OK Grenade : aucun pixel après reset');

    visuals.snapshot([projectile(3, -1.2)], 0, 2);
    visuals.snapshot([projectile(3, 0)], 3, 2.05);
    visuals.snapshot([projectile(3, 1.2)], 6, 2.1);
    const centers: number[] = [];
    for (let frame = 0; frame < 3; frame++) {
      visuals.update(2.1 + frame / 60);
      const flight = capture(`Trajet interpolé : image ${frame + 1}/3 sans nouveau snapshot`);
      if (flight.occupied < 16) throw new Error(`Grenade invisible pendant l'interpolation : image ${frame}`);
      centers.push(flight.centerX);
    }
    if (centers[1] - centers[0] < 20 || centers[2] - centers[1] < 20) throw new Error(`Grenade saccadée entre snapshots : centres ${centers}`);
    messages.push(`OK Grenade : animation 60 Hz entre snapshots 20 Hz, centres X ${centers.map(x => x.toFixed(1)).join(' → ')}`);
    camera.position.z = 160; camera.updateMatrixWorld();
    const distant = capture('Grenade distante : brouillard du monde');
    if (distant.occupied < 16 || distant.fog !== distant.occupied) throw new Error(`Brouillard grenade incorrect : ${distant.fog}/${distant.occupied} pixels`);
    messages.push('OK Grenade : couleur du brouillard RGB 221,232,255 à distance');
    visuals.clear(); visuals.update(2.2);
    if (capture().occupied !== 0) throw new Error('Grenade interpolée encore visible après reset');

    const world = new VoxelWorld({ size: 64, height: 64, seed: 17 });
    const launch = { position: { x: 31, y: 48, z: 32 }, velocity: { x: 4, y: 0, z: 0 } };
    camera.position.set(32, 48, 35); camera.lookAt(32, 48, 32); camera.updateMatrixWorld();
    visuals.predict(1, 41, launch, world, 3);
    visuals.update(3);
    const released = capture('Lancer local : visible dès le relâchement, sans message réseau');
    if (Number(mesh.count) !== 1 || released.occupied < 16 || released.green < 8) throw new Error('Grenade locale invisible au relâchement');
    messages.push('OK Grenade : modèle visible à la première image du lancer, sans confirmation serveur');

    visuals.update(3.12);
    const beforeReply = capture('Lancer local : vol après 120 ms, toujours sans réponse serveur');
    if (beforeReply.occupied < 16 || beforeReply.centerX - released.centerX < 12) throw new Error('Grenade locale immobile en attendant le serveur');
    messages.push('OK Grenade : déplacement visible pendant les 120 ms précédant la réponse serveur');
    const beforeMatrix = new THREE.Matrix4(); mesh.getMatrixAt(0, beforeMatrix);
    visuals.event({ type: 'event', roundId: 1, event: 'shot', weapon: 'grenade', shooterId: 1,
      inputSeq: 41, projectileId: 31, tick: 180, position: { x: 31.35, y: 48.05, z: 32 },
      velocity: { x: 5, y: 0, z: 0 } }, 3.12);
    visuals.acknowledge(1, 41);
    visuals.update(3.12);
    const afterReply = capture('Confirmation à 120 ms : même image, une seule grenade');
    const afterMatrix = new THREE.Matrix4(); mesh.getMatrixAt(0, afterMatrix);
    if (Number(mesh.count) !== 1 || !beforeMatrix.equals(afterMatrix) || beforeReply.fingerprint !== afterReply.fingerprint) {
      throw new Error('Confirmation du lancer : saut visuel ou grenade dupliquée');
    }
    messages.push('OK Grenade : confirmation tardive sans saut de matrice/pixels ni duplication');

    visuals.predict(1, 42, { position: { x: 33, y: 48, z: 32 }, velocity: launch.velocity }, world, 3.12);
    visuals.update(3.12);
    if (Number(mesh.count) !== 2) throw new Error('Grenades confirmée et en attente absentes avant reset');
    visuals.clear(); visuals.update(3.13);
    if (Number(mesh.count) !== 0 || capture().occupied !== 0) throw new Error('Prédiction de grenade encore visible après reset');
    messages.push('OK Grenade : reset retire les lancers locaux confirmés et en attente');

    visuals.predict(1, 43, launch, world, 4); visuals.update(4);
    if (capture().occupied < 16) throw new Error('Prédiction absente avant refus du lancer');
    visuals.acknowledge(1, 43); visuals.update(4);
    if (Number(mesh.count) !== 0 || capture().occupied !== 0) throw new Error('Lancer refusé encore visible');
    messages.push('OK Grenade : refus serveur retire immédiatement le lancer prédit');
    return messages;
  } finally {
    visuals.dispose(); target.dispose();
    renderer.setRenderTarget(previousTarget);
    renderer.setViewport(previousViewport); renderer.setScissor(previousScissor); renderer.setScissorTest(previousScissorTest);
    renderer.setClearColor(previousColor, previousAlpha); renderer.autoClear = previousAutoClear;
  }
}
