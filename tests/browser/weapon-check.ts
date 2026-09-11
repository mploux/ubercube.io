import * as THREE from 'three';
import { WeaponView, type WeaponViewInput } from '../../src/client/weapon-view';
import { loadWeaponModel } from '../../src/client/weapon-model';
import type { WeaponId } from '../../src/shared/protocol';

export async function checkWeaponView(renderer: THREE.WebGLRenderer): Promise<string[]> {
  const loaded = new Set<WeaponId>();
  const view = new WeaponView(async weapon => {
    const model = await loadWeaponModel(weapon);
    loaded.add(weapon);
    return model;
  });
  const input: WeaponViewInput = { moveX: 0, moveZ: 0, sprint: false, fire: false, alt: false,
    lookDeltaYaw: 0, lookDeltaPitch: 0, mouseDX: 0, mouseDY: 0, grenades: 10 };
  const width = 512, height = 288;
  const target = new THREE.WebGLRenderTarget(width, height);
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
  sheet.id = 'weapon-check-captures';
  sheet.setAttribute('aria-label', 'Armes : captures GPU des modèles Java');
  sheet.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;max-width:1100px;margin-top:24px';
  document.getElementById(sheet.id)?.remove();
  document.body.append(sheet);

  function tick(count: number, change: Partial<WeaponViewInput> = {}): void {
    for (let index = 0; index < count; index++) view.tick({ ...input, ...change }, () => .5);
  }

  function capture(label: string, preview?: WeaponId, time = 0): { pixels: Uint8Array; occupied: number } {
    renderer.setRenderTarget(target);
    renderer.setViewport(0, 0, width, height);
    renderer.setScissorTest(false);
    renderer.clear(true, true, true);
    if (preview) view.renderKitPreview(renderer, time, preview, renderer.domElement.getBoundingClientRect());
    else view.render(renderer);
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    let occupied = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] || pixels[index + 1] || pixels[index + 2]) occupied++;
    }
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
    caption.textContent = `${label} — ${occupied} pixels`;
    figure.append(canvas, caption); sheet.append(figure);
    return { pixels, occupied };
  }

  function visible(label: string, frame: { occupied: number }): void {
    if (frame.occupied < 16) throw new Error(`${label} : modèle absent du framebuffer (${frame.occupied} pixels)`);
    messages.push(`OK Arme : ${label}, ${frame.occupied} pixels`);
  }

  function changed(label: string, before: { pixels: Uint8Array; occupied: number }, after: { pixels: Uint8Array; occupied: number }): void {
    let difference = 0;
    for (let index = 0; index < before.pixels.length; index += 4) {
      if ([0, 1, 2].some(channel => Math.abs(before.pixels[index + channel] - after.pixels[index + channel]) > 4)) difference++;
    }
    if (difference < 16) throw new Error(`${label} : changement visuel absent (${difference} pixels)`);
    messages.push(`OK Arme : ${label}, ${difference} pixels changés`);
  }

  try {
    await view.ready;
    if (loaded.size !== 5) throw new Error(`Chargement OBJ/MTL incomplet : ${[...loaded].join(', ')}`);
    messages.push('OK Armes : les cinq OBJ/MTL Java sont chargés depuis les assets locaux');
    renderer.setPixelRatio(1);
    renderer.setSize(width, height);
    renderer.setClearColor(0x000000, 1);
    renderer.autoClear = false;

    for (const weapon of ['ak47', 'awp', 'shovel', 'grenade', 'medic'] as const) {
      view.reset(weapon);
      tick(60);
      const idle = capture(`${weapon} repos`);
      visible(`${weapon} repos`, idle);
      if (weapon === 'ak47' || weapon === 'awp') {
        const idleFov = view.fov;
        tick(60, { alt: true });
        const ads = capture(`${weapon} visée`);
        visible(`${weapon} visée`, ads);
        changed(`${weapon} repos → visée`, idle, ads);
        if (!(view.fov > 0 && view.fov < idleFov)) throw new Error(`${weapon} : FOV de visée invalide ${view.fov}`);
        view.reset(weapon); tick(60);
        const beforeRecoil = capture(`${weapon} avant tir`);
        const action = view.tick({ ...input, fire: true }, () => .5);
        if (!action.fired) throw new Error(`${weapon} : aucun tir produit par l’entrée réelle`);
        tick(1);
        const recoil = capture(`${weapon} recul`);
        visible(`${weapon} recul`, recoil);
        changed(`${weapon} recul`, beforeRecoil, recoil);
      } else if (weapon === 'shovel') {
        view.tick({ ...input, fire: true }, () => .5); tick(1);
        const swing = capture('pelle frappe');
        visible('pelle frappe', swing); changed('pelle frappe', idle, swing);
      } else if (weapon === 'grenade') {
        tick(30, { fire: true });
        const charge = capture('grenade chargée');
        visible('grenade chargée', charge); changed('grenade chargée', idle, charge);
        tick(1, { grenades: 0 });
        if (capture('grenade épuisée').occupied !== 0) throw new Error('Grenade visible avec inventaire vide');
        messages.push('OK Grenade : aucun pixel après épuisement');
      } else {
        tick(30, { alt: true });
        const alternate = capture('soins position alternative');
        visible('soins position alternative', alternate); changed('soins position alternative', idle, alternate);
      }
    }

    for (const weapon of ['ak47', 'awp', 'medic'] as const) {
      const first = capture(`${weapon} aperçu lobby`, weapon);
      const rotated = capture(`${weapon} aperçu lobby tourné`, weapon, 1);
      visible(`${weapon} aperçu lobby`, first); visible(`${weapon} aperçu lobby tourné`, rotated);
      changed(`${weapon} rotation aperçu lobby`, first, rotated);
    }
    view.reset('ak47'); tick(60);
    visible('AK-47 après les aperçus', capture('AK-47 retour jeu après aperçus'));
    return messages;
  } finally {
    view.dispose(); target.dispose();
    renderer.setPixelRatio(previousRatio);
    renderer.setSize(previousSize.x, previousSize.y);
    renderer.domElement.style.width = previousStyle.width;
    renderer.domElement.style.height = previousStyle.height;
    renderer.setRenderTarget(previousTarget);
    renderer.setViewport(previousViewport); renderer.setScissor(previousScissor); renderer.setScissorTest(previousScissorTest);
    renderer.setClearColor(previousColor, previousAlpha); renderer.autoClear = previousAutoClear;
  }
}
